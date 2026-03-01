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
  checkRFCDeadlines,
  CICheckService,
  shouldTriggerDigest,
  DIGEST_INTERVAL,
} from "./services/index.js";
import type { Rfc, KnowledgeFile } from "./types/index.js";
import { DEFAULT_SESSION_BUDGET, DEFAULT_HOOK_CONFIG } from "./types/index.js";
import { SKLDiagnosticsProvider } from "./diagnostics/index.js";
import { SKLWriteError, SKLFileNotFoundError } from "./errors/index.js";
import { QueuePanel, OrchestratorPanel, DigestPanel, RFCResolutionPanel, generateProposalCount } from "./panels/index.js";
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
          vscode.commands.registerCommand("skl.resolveRFC", async () => {
            const ids = await skl.listRFCs();
            const settled = await Promise.allSettled(
              ids.map(async (id) => ({ id, rfc: await skl.readRFC(id) })),
            );
            const openIds = settled
              .filter((r): r is PromiseFulfilledResult<{ id: string; rfc: Rfc }> =>
                r.status === "fulfilled" && r.value.rfc.status === "open",
              )
              .map((r) => r.value.id);
            if (openIds.length === 0) {
              void vscode.window.showInformationMessage("No open RFCs to resolve.");
              return;
            }
            const pick = await vscode.window.showQuickPick(
              openIds.map((id) => ({ label: id })),
              { title: "Select RFC to Resolve" },
            );
            if (!pick) return;
            RFCResolutionPanel.createOrShow(pick.label, skl, context);
          }),
          vscode.commands.registerCommand("skl.openOrchestratorPanel", () => {
            OrchestratorPanel.createOrShow(
              context.extensionUri,
              orchestratorService,
              skl,
              context,
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

          vscode.commands.registerCommand("skl.initPhase0", async () => {
            // Check if already initialized
            try {
              await skl.readKnowledge();
              void vscode.window.showWarningMessage(
                "SKL is already initialised in this repo. To start fresh, delete the .skl/ directory and try again.",
              );
              return;
            } catch (err) {
              if (!(err instanceof SKLFileNotFoundError)) throw err;
              // knowledge.json not found — proceed with initialization
            }

            const detectedStack = await skl.detectTechStack();
            const techStackInput = await vscode.window.showInputBox({
              prompt: "Tech stack (optional — helps SKL understand your codebase)",
              value: detectedStack,
              placeHolder: "e.g. FastAPI, PostgreSQL, React",
            });
            if (techStackInput === undefined) return; // dismissed

            const confirm = await vscode.window.showInformationMessage(
              "SKL Phase 0 will be initialised. This creates .skl/, installs the enforcement hook, and starts logging agent activity. No scope definitions required. You can upgrade to full SKL later.",
              "Initialise",
              "Cancel",
            );
            if (confirm !== "Initialise") return;

            const techStackArr = techStackInput
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);

            const initKnowledge: KnowledgeFile = {
              invariants: {
                tech_stack: techStackArr,
                auth_model: "",
                data_storage: "",
                security_patterns: [],
              },
              state: [],
              queue: [],
            };
            await skl.writeKnowledge(initKnowledge);

            const phase0Config = { ...DEFAULT_HOOK_CONFIG, skl_mode: "phase_0" as const, queue_max: 50 };
            await skl.writeHookConfig(phase0Config);
            await skl.ensureSKLStructure();

            // Install hook — warn but do not abort if Python is not found
            try {
              const exe = phase0Config.python_executable;
              const version = await hookInstaller.getPythonVersion(exe);
              if (version === null) {
                void vscode.window.showWarningMessage(
                  "Python 3 not found. The enforcement hook was not installed. Install Python 3.8+ and run 'SKL: Install Hook' to complete setup.",
                );
              } else {
                await hookInstaller.install(skl.repoRoot, exe);
              }
            } catch {
              void vscode.window.showWarningMessage(
                "Python 3 not found. The enforcement hook was not installed. Install Python 3.8+ and run 'SKL: Install Hook' to complete setup.",
              );
            }

            const action = await vscode.window.showInformationMessage(
              "SKL Phase 0 ready. Set SKL_AGENT_ID=Agent-1 in your agent's terminal and push to start logging activity.",
              "Copy export command",
            );
            if (action === "Copy export command") {
              await vscode.env.clipboard.writeText("export SKL_AGENT_ID=Agent-1");
            }
          }),

          vscode.commands.registerCommand("skl.upgradeToFull", async () => {
            const config = await skl.readHookConfig();
            if (config.skl_mode === "full") {
              void vscode.window.showInformationMessage("Already running full SKL.");
              return;
            }
            try {
              await skl.readScopeDefinitions();
            } catch (err) {
              if (err instanceof SKLFileNotFoundError) {
                void vscode.window.showWarningMessage(
                  "Scope definitions are required for full SKL. Run 'SKL: Generate Scope Definitions' first, then run this command again.",
                );
                return;
              }
              throw err;
            }
            const updated = { ...config, skl_mode: "full" as const };
            await skl.writeHookConfig(updated);
            void vscode.window.showInformationMessage(
              "SKL upgraded to full mode. Scope enforcement, RFCs, and the Orchestrator are now active.",
            );
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
