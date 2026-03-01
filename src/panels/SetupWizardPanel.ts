/**
 * SetupWizardPanel — 5-step setup wizard for first-run SKL configuration.
 *
 * Walks the user through:
 *   Step 1 — Welcome
 *   Step 2 — Define invariants
 *   Step 3 — Generate and review scope definitions
 *   Step 4 — Install pre-push hook
 *   Step 5 — Configure first agent
 */

import * as vscode from "vscode";
import type { SKLFileSystem } from "../services/index.js";
import type { HookInstaller } from "../services/index.js";
import type { AgentContext, ScopeDefinition } from "../types/index.js";
import { ScopeDefinitionSchema } from "../types/index.js";
import { SYSTEM_PROMPT } from "../commands/generateScopeDefinitions.js";
import { generateSetupWizardHtml } from "./setupWizardHtml.js";
import type { WizardState } from "./setupWizardHtml.js";

const VIEW_TYPE = "sklSetupWizard";
const PANEL_TITLE = "SKL Setup";

// ── Types ─────────────────────────────────────────────────────────

type WizardInvariants = {
  tech_stack: string;
  architectural_style: string;
  performance_constraints: string;
  non_negotiable_conventions: string;
};

type WizardScope = {
  name: string;
  description: string;
  allowed_path_prefixes: string[];
  forbidden_path_prefixes: string[];
  permitted_responsibilities: string[];
  forbidden_responsibilities: string[];
};

// ── Panel class ───────────────────────────────────────────────────

export class SetupWizardPanel {
  private static _instance: SetupWizardPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _hookInstaller: HookInstaller;
  private readonly _disposables: vscode.Disposable[] = [];

  private _state: WizardState;
  private _invariants: WizardInvariants | undefined;

  // ── Factory ──────────────────────────────────────────────────────

  static createOrShow(
    context: vscode.ExtensionContext,
    sklFileSystem: SKLFileSystem,
    hookInstaller: HookInstaller,
  ): SetupWizardPanel {
    if (SetupWizardPanel._instance) {
      SetupWizardPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      return SetupWizardPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] },
    );

    SetupWizardPanel._instance = new SetupWizardPanel(
      panel,
      sklFileSystem,
      hookInstaller,
      context,
    );
    return SetupWizardPanel._instance;
  }

  // ── Constructor ──────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    skl: SKLFileSystem,
    hookInstaller: HookInstaller,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    __context: vscode.ExtensionContext,
  ) {
    this._panel = panel;
    this._skl = skl;
    this._hookInstaller = hookInstaller;

    this._state = { step: 1 };

    // Detect tech stack asynchronously, then render
    void this._initTechStack();

    const msgSub = this._panel.webview.onDidReceiveMessage(
      (msg: { command: string }) => {
        void this._handleMessage(msg);
      },
    );
    this._disposables.push(msgSub);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Tech stack detection ──────────────────────────────────────────

  private async _initTechStack(): Promise<void> {
    const checks: Array<[string, string]> = [
      ["package.json", "Node.js"],
      ["requirements.txt", "Python"],
      ["pyproject.toml", "Python"],
      ["Gemfile", "Ruby"],
      ["go.mod", "Go"],
    ];

    const results = await Promise.all(
      checks.map(([file]) => this._skl.fileExistsInRepo(file)),
    );

    const found: string[] = [];
    for (let i = 0; i < checks.length; i++) {
      if (results[i]) {
        const tech = checks[i]![1];
        if (!found.includes(tech)) {
          found.push(tech);
        }
      }
    }

    if (found.length > 0) {
      this._state.detectedTechStack = found.join(", ");
    }

    this._render();
  }

  // ── Message handler ──────────────────────────────────────────────

  private async _handleMessage(msg: { command: string }): Promise<void> {
    const m = msg as Record<string, unknown>;

    try {
      switch (msg.command) {
        case "start_phase0": {
          // Delegate to the dedicated Phase 0 init command; close wizard
          this._panel.dispose();
          await vscode.commands.executeCommand("skl.initPhase0");
          break;
        }

        case "start_full_setup": {
          this._state.step = 2;
          this._render();
          break;
        }

        case "step2_next": {
          this._invariants = m["invariants"] as WizardInvariants;
          this._state.step = 3;
          this._render();
          break;
        }

        case "generate_scopes": {
          this._state.scopeGenerationStatus = "generating";
          this._render();

          const tree = await this._skl.buildDirectoryTree(this._skl.repoRoot);

          const models = await vscode.lm.selectChatModels();
          if (models.length === 0) {
            this._state.scopeGenerationStatus = "error";
            this._render();
            return;
          }
          const model = models[0]!;

          const messages = [
            vscode.LanguageModelChatMessage.User(
              `${SYSTEM_PROMPT}\n\nDirectory tree:\n${tree}`,
            ),
          ];

          let responseText = "";
          try {
            const response = await model.sendRequest(messages, {});
            for await (const chunk of response.text) {
              responseText += chunk;
            }
          } catch {
            this._state.scopeGenerationStatus = "error";
            this._render();
            return;
          }

          // Strip markdown fences if present
          let jsonText = responseText.trim();
          if (jsonText.startsWith("```")) {
            jsonText = jsonText
              .replace(/^```(?:json)?\s*\n?/, "")
              .replace(/\n?\s*```\s*$/, "");
          }

          try {
            const parsed = ScopeDefinitionSchema.parse(JSON.parse(jsonText));
            const scopes = Object.entries(
              parsed.scope_definitions.scopes,
            ).map(([name, entry]) => ({
              name,
              description: entry.description,
              allowed_path_prefixes: entry.allowed_path_prefixes,
              forbidden_path_prefixes: entry.forbidden_path_prefixes,
              permitted_responsibilities:
                entry.permitted_responsibilities ?? [],
              forbidden_responsibilities:
                entry.forbidden_responsibilities ?? [],
            }));

            this._state.scopeGenerationStatus = "done";
            this._state.generatedScopes = scopes;
          } catch {
            this._state.scopeGenerationStatus = "error";
          }
          this._render();
          break;
        }

        case "step3_complete": {
          const scopes = m["scopes"] as WizardScope[] | undefined;
          if (!scopes || scopes.length === 0) {
            void this._panel.webview.postMessage({
              command: "validation_error",
              message: "At least one scope is required.",
            });
            return;
          }

          const sd: ScopeDefinition = {
            scope_definitions: {
              version: "1.0",
              scopes: Object.fromEntries(
                scopes.map((s: WizardScope) => [
                  s.name,
                  {
                    description: s.description,
                    allowed_path_prefixes: s.allowed_path_prefixes,
                    forbidden_path_prefixes: s.forbidden_path_prefixes,
                    permitted_responsibilities:
                      s.permitted_responsibilities ?? [],
                    forbidden_responsibilities:
                      s.forbidden_responsibilities ?? [],
                    owner: "human-operator",
                  },
                ]),
              ),
            },
          };

          await this._skl.writeScopeDefinitions(sd);
          this._state.step = 4;
          this._render();
          break;
        }

        case "install_hook": {
          try {
            const config = await this._skl.readHookConfig();
            await this._hookInstaller.install(
              this._skl.repoRoot,
              config.python_executable,
            );
            this._state.hookInstallStatus = "installed";
          } catch (err) {
            this._state.hookInstallStatus = "error";
            this._state.hookInstallError =
              err instanceof Error ? err.message : String(err);
          }
          this._render();
          break;
        }

        case "step4_next": {
          this._state.step = 5;
          this._render();
          break;
        }

        case "step5_apply": {
          const agentId = (m["agent_id"] as string | undefined) ?? "";
          const semanticScope = (m["semantic_scope"] as string | undefined) ?? "";
          const fileScope = (m["file_scope"] as string | undefined) ?? "";

          if (!agentId || !semanticScope) {
            void this._panel.webview.postMessage({
              command: "validation_error",
              message: "Agent ID and scope are required.",
            });
            return;
          }

          const ctx: AgentContext = {
            agent_id: agentId,
            semantic_scope: semanticScope,
            file_scope: fileScope
              ? fileScope
                  .split("\n")
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              : [],
            session_start: new Date().toISOString(),
            circuit_breaker_count: 0,
          };

          await this._skl.writeAgentContext(ctx);
          void vscode.window.showInformationMessage(
            `SKL is configured. Agent context saved for ${agentId}.`,
          );
          this._panel.dispose();
          break;
        }

        case "step5_skip": {
          void vscode.window.showWarningMessage(
            "SKL: No agent configured. Run 'SKL: Configure Agent' before the first push.",
          );
          this._panel.dispose();
          break;
        }
      }
    } catch (err) {
      // Log to output channel if available
      console.error(
        `SetupWizardPanel handler error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Render ────────────────────────────────────────────────────────

  private _render(): void {
    this._panel.webview.html = generateSetupWizardHtml(this._state);
  }

  // ── Dispose ───────────────────────────────────────────────────────

  dispose(): void {
    SetupWizardPanel._instance = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}
