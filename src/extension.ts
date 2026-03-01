import * as vscode from "vscode";
import {
  initializeProject,
  generateScopeDefinitions,
  confirmScopeDefinitions,
  rejectScopeDefinitions,
} from "./commands/index.js";
import {
  SKLFileSystem,
  HookInstaller,
  OrchestratorService,
  promoteRFCtoADR,
  checkRFCDeadlines,
  CICheckService,
  shouldTriggerDigest,
  DIGEST_INTERVAL,
} from "./services/index.js";
import type { Rfc } from "./types/index.js";
import { DEFAULT_SESSION_BUDGET } from "./types/index.js";
import { SKLDiagnosticsProvider } from "./diagnostics/index.js";
import { SKLWriteError } from "./errors/index.js";
import { QueuePanel, OrchestratorPanel, DigestPanel, generateProposalCount } from "./panels/index.js";
import type { AgentContext } from "./types/index.js";

// ── Command: skl.installHook ─────────────────────────────────────

async function installHookCommand(
  skl: SKLFileSystem,
  hookInstaller: HookInstaller,
): Promise<void> {
  try {
    const config = await skl.readHookConfig();
    const exe = config.python_executable;

    const version = await hookInstaller.getPythonVersion(exe);
    if (version === null) {
      void vscode.window.showErrorMessage(
        `SKL: Python 3 not found at '${exe}'. Install Python 3.8+ and ` +
          "ensure it is on your PATH, or update the python_executable " +
          "setting via 'SKL: Configure Hook'.",
      );
      return;
    }

    const installed = await hookInstaller.isInstalled(skl.repoRoot);
    if (installed) {
      const choice = await vscode.window.showWarningMessage(
        "SKL: A pre-push hook is already installed.",
        "Reinstall",
        "Cancel",
      );
      if (choice !== "Reinstall") {
        return;
      }
    }

    await hookInstaller.install(skl.repoRoot, exe);
    void vscode.window.showInformationMessage(
      "SKL: Hook installed. Run 'SKL: Configure Agent' to set up an " +
        "agent context before the first push.",
    );
  } catch (err) {
    if (err instanceof SKLWriteError) {
      void vscode.window.showErrorMessage(
        `SKL: Hook installation failed — ${String(err.cause)}`,
      );
    } else {
      void vscode.window.showErrorMessage(
        `SKL: Hook installation failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ── Command: skl.configureAgent ──────────────────────────────────

async function configureAgentCommand(
  skl: SKLFileSystem,
): Promise<void> {
  // Step 1 — Agent ID
  const agentId = await vscode.window.showInputBox({
    prompt: "Agent ID (e.g. Agent-1)",
    validateInput: (v) =>
      /^[A-Za-z0-9_-]+$/.test(v)
        ? null
        : "Agent ID must be alphanumeric with underscores or hyphens only",
  });
  if (!agentId) {
    return;
  }

  // Step 2 — Semantic scope
  let scopeDefs;
  try {
    scopeDefs = await skl.readScopeDefinitions();
  } catch {
    void vscode.window.showErrorMessage(
      "SKL: Could not read scope_definitions.json. " +
        "Run 'SKL: Generate Scope Definitions' first.",
    );
    return;
  }

  const scopes = scopeDefs.scope_definitions.scopes;
  const items: vscode.QuickPickItem[] = Object.entries(scopes).map(
    ([key, entry]) => ({
      label: key,
      detail: entry.description,
    }),
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "Select semantic scope for this agent",
  });
  if (!picked) {
    return;
  }

  // Step 3 — File scope
  const fileScopeRaw = await vscode.window.showInputBox({
    prompt:
      "File scope (comma-separated relative paths, e.g. " +
      "app/routers/auth.py,app/utils/tokens.py)",
    placeHolder: "Leave empty to allow all files in the semantic scope",
  });
  if (fileScopeRaw === undefined) {
    return;
  }
  const fileScope = fileScopeRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Step 4 — Confirm
  const summary =
    `Agent: ${agentId}\nScope: ${picked.label}\nFiles: ${
      fileScope.length > 0 ? fileScope.join(", ") : "(all in scope)"
    }`;
  const confirm = await vscode.window.showInformationMessage(
    `SKL: Confirm agent configuration?\n\n${summary}`,
    "Confirm",
    "Cancel",
  );
  if (confirm !== "Confirm") {
    return;
  }

  // Write agent context
  const ctx: AgentContext = {
    agent_id: agentId,
    semantic_scope: picked.label,
    file_scope: fileScope,
    session_start: new Date().toISOString(),
    circuit_breaker_count: 0,
  };

  try {
    await skl.writeAgentContext(ctx);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `SKL: Failed to write agent context — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `SKL: Agent context saved. Set SKL_AGENT_ID=${agentId} in your ` +
      "terminal before pushing.",
    "Copy to Clipboard",
  );
  if (action === "Copy to Clipboard") {
    await vscode.env.clipboard.writeText(`export SKL_AGENT_ID=${agentId}`);
  }
}

// ── Command: skl.resolveRFC ──────────────────────────────────────

async function resolveRFCCommand(skl: SKLFileSystem): Promise<void> {
  // 1. Load all RFC IDs and read each file, skipping unreadable ones
  const ids = await skl.listRFCs();

  const settled = await Promise.allSettled(
    ids.map(async (id) => ({ id, rfc: await skl.readRFC(id) })),
  );

  const openMap = new Map<string, Rfc>();
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.rfc.status === "open") {
      openMap.set(result.value.id, result.value.rfc);
    }
  }

  if (openMap.size === 0) {
    void vscode.window.showInformationMessage("No open RFCs to resolve.");
    return;
  }

  // 2. Pick which RFC to resolve
  const rfcPick = await vscode.window.showQuickPick(
    [...openMap.entries()].map(([id, rfc]) => ({
      label: id,
      detail: rfc.decision_required,
    })),
    { title: "Select RFC to Resolve" },
  );
  if (!rfcPick) return;

  const selectedRfc = openMap.get(rfcPick.label)!;

  // 3. Pick resolution option (option_c is optional on the schema)
  const optionItems: vscode.QuickPickItem[] = [
    { label: "option_a", detail: selectedRfc.option_a.description },
    { label: "option_b", detail: selectedRfc.option_b.description },
  ];
  if (selectedRfc.option_c) {
    optionItems.push({
      label: "option_c",
      detail: selectedRfc.option_c.description,
    });
  }

  const optionPick = await vscode.window.showQuickPick(optionItems, {
    title: "Select resolution option",
  });
  if (!optionPick) return;

  // 4. Human rationale
  const rationale = await vscode.window.showInputBox({
    prompt: "Enter your rationale for this decision",
    validateInput: (v) =>
      v.trim().length > 0 ? null : "Rationale is required",
  });
  if (rationale === undefined || rationale.trim().length === 0) return;

  // 5. Acceptance criterion — at least one required (spec Section 9.3)
  const criterionRaw = await vscode.window.showInputBox({
    prompt:
      "Enter at least one acceptance criterion (format: description | check_type | check_reference)",
    placeHolder:
      "e.g. Auth query P95 < 150ms | performance_test | tests/load/auth.py",
    validateInput: (v) => {
      if (v.trim().length === 0) {
        return "At least one acceptance criterion is required";
      }
      const parts = v.split("|").map((p) => p.trim());
      if (parts.length < 3 || parts.some((p) => p.length === 0)) {
        return "Format: description | check_type | check_reference";
      }
      return null;
    },
  });
  if (criterionRaw === undefined || criterionRaw.trim().length === 0) return;

  // 6. Confirm — irreversible
  const confirm = await vscode.window.showWarningMessage(
    `Resolve RFC ${rfcPick.label} as ${optionPick.label}? This will promote to ADR and cannot be undone.`,
    "Confirm",
    "Cancel",
  );
  if (confirm !== "Confirm") return;

  // 7. Apply resolution + promote to ADR
  const resolvedRfc: Rfc = {
    ...selectedRfc,
    resolution: optionPick.label,
    human_rationale: rationale.trim(),
    acceptance_criteria: [criterionRaw.trim()],
  };

  try {
    const knowledge = await skl.readKnowledge();
    const { adr } = await promoteRFCtoADR(
      resolvedRfc,
      rationale.trim(),
      knowledge,
      skl,
    );
    void vscode.window.showInformationMessage(
      `RFC ${rfcPick.label} resolved. ADR ${adr.id} created.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `SKL: Failed to resolve RFC — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ── Activation ───────────────────────────────────────────────────

const DEBOUNCE_MS = 300;

/** Disposables that must be cleaned up on deactivation. */
const _activationDisposables: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "skl.initializeProject",
      initializeProject,
    ),
    vscode.commands.registerCommand(
      "skl.generateScopeDefinitions",
      generateScopeDefinitions,
    ),
    vscode.commands.registerCommand(
      "skl.confirmScopeDefinitions",
      confirmScopeDefinitions,
    ),
    vscode.commands.registerCommand(
      "skl.rejectScopeDefinitions",
      rejectScopeDefinitions,
    ),
  );

  // ── Status bar item ───────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "skl.openQueuePanel";
  statusBarItem.tooltip = "Open SKL Queue";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  _activationDisposables.push(statusBarItem);

  function updateStatusBar(pendingCount: number): void {
    statusBarItem.text = `$(list-unordered) SKL: ${pendingCount} pending`;
    if (pendingCount === 0) {
      statusBarItem.backgroundColor = undefined;
    } else if (pendingCount <= 10) {
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
    }
  }

  // Initialise with zero until knowledge.json is read
  updateStatusBar(0);

  // Track expired RFCs we've already notified about (per extension session)
  const shownExpiredRFCIds = new Set<string>();

  // ── Diagnostics + hook-dependent commands ──────────────────────
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    void SKLFileSystem.create(wsFolder.uri.fsPath)
      .then((skl) => {
        // Diagnostics
        const diagnostics = new SKLDiagnosticsProvider(skl);
        context.subscriptions.push(diagnostics);
        void diagnostics.validate();

        // Hook installer (needs extension context for bundled script path)
        const hookInstaller = new HookInstaller(context);

        // Orchestrator service — single instance per workspace session
        const orchestratorService = new OrchestratorService(
          skl,
          context,
          DEFAULT_SESSION_BUDGET,
        );

        // --- Stage 4: CI Integration and Human Review ---

        // CICheckService — sole path to uncertainty_level 0
        const ciOutputChannel = vscode.window.createOutputChannel("SKL — CI Checks");
        const ciCheckService = new CICheckService(skl, ciOutputChannel);
        context.subscriptions.push(ciOutputChannel);

        // Register CI file watchers for passive detection
        ciCheckService.registerFileWatchers(context);

        // Register commands that need SKLFileSystem / HookInstaller
        context.subscriptions.push(
          vscode.commands.registerCommand("skl.installHook", () =>
            installHookCommand(skl, hookInstaller),
          ),
          vscode.commands.registerCommand("skl.configureAgent", () =>
            configureAgentCommand(skl),
          ),
          vscode.commands.registerCommand("skl.openQueuePanel", () =>
            QueuePanel.createOrShow(context.extensionUri, skl),
          ),
          vscode.commands.registerCommand("skl.resolveRFC", () =>
            resolveRFCCommand(skl),
          ),
          vscode.commands.registerCommand("skl.openOrchestratorPanel", () => {
            OrchestratorPanel.createOrShow(
              context.extensionUri,
              orchestratorService,
              skl,
            );
          }),

          // --- Stage 4: CI Integration and Human Review ---

          vscode.commands.registerCommand("skl.reviewDigest", () => {
            DigestPanel.createOrShow(context.extensionUri, skl);
            // Update last_digest_at to reset the trigger counter
            void skl.readHookConfig().then(async (config) => {
              const updated = { ...config, last_digest_at: new Date().toISOString() };
              await skl.writeHookConfig(updated);
            });
          }),

          vscode.commands.registerCommand("skl.runCICheck", async () => {
            let knowledge;
            try {
              knowledge = await skl.readKnowledge();
            } catch {
              void vscode.window.showErrorMessage("SKL: Could not read knowledge.json.");
              return;
            }

            const eligible = knowledge.state.filter((r) => r.uncertainty_level > 0);
            if (eligible.length === 0) {
              void vscode.window.showInformationMessage(
                "All State entries are already at uncertainty_level 0.",
              );
              return;
            }

            const item = await vscode.window.showQuickPick(
              eligible.map((r) => ({
                label: `${r.id} — ${r.path} (level ${r.uncertainty_level})`,
                id: r.id,
              })),
              { canPickMany: false, placeHolder: "Select a State record to CI-check" },
            );
            if (!item) return;

            // Refresh knowledge after quick pick
            knowledge = await skl.readKnowledge();
            let record = knowledge.state.find((r) => r.id === item.id);
            if (!record) return;

            // If no test reference is set, prompt for one
            if (!record.uncertainty_reduced_by) {
              const testPath = await vscode.window.showInputBox({
                prompt: `No test reference set for ${record.path}. Enter the test file path.`,
                placeHolder: "e.g. tests/test_auth.py",
              });
              if (!testPath) return;

              // Write the updated record before running the check
              const updatedRecord = { ...record, uncertainty_reduced_by: testPath };
              const updatedKnowledge = {
                ...knowledge,
                state: knowledge.state.map((r) =>
                  r.id === item.id ? updatedRecord : r,
                ),
              };
              await skl.writeKnowledge(updatedKnowledge);
              record = updatedRecord;
            }

            void vscode.window.showInformationMessage(
              `Running CI check for ${record.id}...`,
            );

            const result = await ciCheckService.runCheck(record.id);
            if (result.passed) {
              void vscode.window.showInformationMessage(
                `✓ ${result.test_reference} passed. ${result.state_record_id} is now uncertainty_level 0.`,
              );
            } else {
              void vscode.window.showWarningMessage(
                `✗ Test failed (exit ${result.exit_code}). uncertainty_level unchanged. Check the SKL output channel for details.`,
              );
            }
          }),
        );

        // Initial status bar count from current knowledge
        void skl
          .readKnowledge()
          .then((k) => updateStatusBar(generateProposalCount(k.queue ?? [])))
          .catch(() => {
            /* no knowledge yet */
          });

        // Debounced status bar updates on knowledge changes
        let sbTimer: ReturnType<typeof setTimeout> | undefined;
        // Digest notification: fire once per session, reset when panel closes
        let digestNotificationShown = false;
        const knowledgeSub = skl.onKnowledgeChanged((k) => {
          if (sbTimer !== undefined) clearTimeout(sbTimer);
          sbTimer = setTimeout(() => {
            sbTimer = undefined;
            updateStatusBar(generateProposalCount(k.queue ?? []));

            // RFC deadline notifications — one per RFC per extension session
            void checkRFCDeadlines(skl).then((expired) => {
              for (const rfc of expired) {
                if (shownExpiredRFCIds.has(rfc.id)) continue;
                shownExpiredRFCIds.add(rfc.id);
                void vscode.window
                  .showErrorMessage(
                    `RFC ${rfc.id} response deadline has passed. Agent work in the affected scope is paused.`,
                    "Open Orchestrator",
                  )
                  .then((action) => {
                    if (action === "Open Orchestrator") {
                      void vscode.commands.executeCommand(
                        "skl.openOrchestratorPanel",
                      );
                    }
                  });
              }
            });

            // Digest trigger notification — fires once per session until panel is opened
            if (!digestNotificationShown) {
              void skl.readHookConfig().then((config) => {
                if (shouldTriggerDigest(k, config.last_digest_at ?? null)) {
                  digestNotificationShown = true;
                  void vscode.window
                    .showInformationMessage(
                      `SKL: ${DIGEST_INTERVAL} architectural decisions approved. Time to review the digest.`,
                      "Open Digest",
                    )
                    .then((action) => {
                      if (action === "Open Digest") {
                        void vscode.commands.executeCommand("skl.reviewDigest");
                      }
                    });
                }
              });
            }
          }, DEBOUNCE_MS);
        });
        context.subscriptions.push(knowledgeSub);

        // One-time nudge if hook is not installed
        void hookInstaller.isInstalled(skl.repoRoot).then((installed) => {
          if (!installed) {
            void vscode.window
              .showInformationMessage(
                "SKL is initialized but the enforcement hook is not " +
                  "installed. Run 'SKL: Install Hook' to enable " +
                  "push-time validation.",
                "Install Now",
              )
              .then((action) => {
                if (action === "Install Now") {
                  void vscode.commands.executeCommand("skl.installHook");
                }
              });
          }
        });
      })
      .catch(() => {
        // Not a Git repository — diagnostics not available.
      });
  }
}

export function deactivate(): void {
  for (const d of _activationDisposables) {
    d.dispose();
  }
  _activationDisposables.length = 0;
}
