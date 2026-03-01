/**
 * TaskAssignmentPanel — webview panel for reviewing and applying orchestrator
 * task assignments. Replaces the old untitled-JSON-document approach.
 */

import * as vscode from "vscode";
import type { SKLFileSystem, OrchestratorService } from "../services/index.js";
import type { AgentContext, ScopeDefinition, TaskAssignment } from "../types/index.js";
import { TaskAssignmentSchema } from "../types/index.js";
import { generateTaskAssignmentHtml } from "./taskAssignmentPanelHtml.js";

const VIEW_TYPE = "sklTaskAssignmentPanel";
const PANEL_TITLE = "Task Assignment Review";

// ── Panel class ───────────────────────────────────────────────────

export class TaskAssignmentPanel {
  private static _instance: TaskAssignmentPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _orchestratorService: OrchestratorService;
  private readonly _disposables: vscode.Disposable[] = [];

  private _assignments: TaskAssignment[];
  private readonly _scopeNames: string[];

  // ── Factory ──────────────────────────────────────────────────────

  static createOrShow(
    assignments: TaskAssignment[],
    sklFileSystem: SKLFileSystem,
    orchestratorService: OrchestratorService,
    scopeDefinitions: ScopeDefinition,
    _context: vscode.ExtensionContext,
  ): TaskAssignmentPanel {
    if (TaskAssignmentPanel._instance) {
      TaskAssignmentPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      return TaskAssignmentPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] },
    );

    TaskAssignmentPanel._instance = new TaskAssignmentPanel(
      panel,
      assignments,
      sklFileSystem,
      orchestratorService,
      scopeDefinitions,
    );
    return TaskAssignmentPanel._instance;
  }

  // ── Constructor ──────────────────────────────────────────────────

  /**
   * Package-accessible constructor (not private) so tests can instantiate
   * directly without going through the factory.
   */
  constructor(
    panel: vscode.WebviewPanel,
    assignments: TaskAssignment[],
    skl: SKLFileSystem,
    orchestratorService: OrchestratorService,
    scopeDefinitions: ScopeDefinition,
  ) {
    this._panel = panel;
    this._assignments = assignments;
    this._skl = skl;
    this._orchestratorService = orchestratorService;
    this._scopeNames = Object.keys(scopeDefinitions.scope_definitions.scopes);

    this._panel.webview.html = generateTaskAssignmentHtml(
      this._assignments,
      this._scopeNames,
    );

    const msgSub = this._panel.webview.onDidReceiveMessage(
      (msg: { command: string }) => {
        void this._handleMessage(msg);
      },
    );
    this._disposables.push(msgSub);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Message handler ──────────────────────────────────────────────

  private async _handleMessage(msg: { command: string }): Promise<void> {
    const typedMsg = msg as Record<string, unknown>;

    switch (msg.command) {
      case "apply_assignment": {
        await this._applyAssignment(
          typedMsg["index"] as number,
          typedMsg["assignment"] as TaskAssignment,
        );
        break;
      }

      case "apply_all_assignments": {
        await this._applyAllAssignments(
          typedMsg["assignments"] as TaskAssignment[],
        );
        break;
      }

      case "regenerate": {
        const input = await vscode.window.showInputBox({
          prompt: "Enter a new feature request for regeneration",
        });
        if (!input) return;
        try {
          const newAssignments =
            await this._orchestratorService.runTaskAssignment(input);
          this._assignments = newAssignments;
          this._panel.webview.html = generateTaskAssignmentHtml(
            newAssignments,
            this._scopeNames,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `SKL: Regeneration failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        break;
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async _applyAssignment(
    _index: number,
    assignment: TaskAssignment,
  ): Promise<void> {
    const result = TaskAssignmentSchema.safeParse(assignment);
    if (!result.success) {
      void this._panel.webview.postMessage({
        command: "validation_error",
        message: result.error.message,
      });
      return;
    }

    // Explicit non-empty checks (schema allows empty strings)
    if (!assignment.agent_id || !assignment.semantic_scope) {
      void this._panel.webview.postMessage({
        command: "validation_error",
        message: "Agent ID and scope are required.",
      });
      return;
    }

    const ctx: AgentContext = {
      agent_id: assignment.agent_id,
      semantic_scope: assignment.semantic_scope,
      file_scope: assignment.file_scope
        ? assignment.file_scope
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      session_start: new Date().toISOString(),
      circuit_breaker_count: 0,
    };

    try {
      await this._skl.writeAgentContext(ctx);
      void vscode.window.showInformationMessage(
        `Agent context written for ${assignment.agent_id}.`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `SKL: Failed to write agent context — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async _applyAllAssignments(
    assignments: TaskAssignment[],
  ): Promise<void> {
    const n = assignments.length;
    for (const a of assignments) {
      await this._applyAssignment(-1, a);
    }
    void vscode.window.showInformationMessage(
      `${n} agent contexts applied.`,
    );
  }

  // ── Dispose ───────────────────────────────────────────────────────

  dispose(): void {
    TaskAssignmentPanel._instance = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}
