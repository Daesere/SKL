import * as vscode from "vscode";
import {
  initializeProject,
  generateScopeDefinitions,
  confirmScopeDefinitions,
  rejectScopeDefinitions,
} from "./commands/index.js";
import { SKLFileSystem, HookInstaller } from "./services/index.js";
import { SKLDiagnosticsProvider } from "./diagnostics/index.js";
import { SKLWriteError } from "./errors/index.js";
import { QueuePanel, generateProposalCount } from "./panels/index.js";
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
        const knowledgeSub = skl.onKnowledgeChanged((k) => {
          if (sbTimer !== undefined) clearTimeout(sbTimer);
          sbTimer = setTimeout(() => {
            sbTimer = undefined;
            updateStatusBar(generateProposalCount(k.queue ?? []));
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
