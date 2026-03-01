/**
 * OrchestratorPanel — webview panel for driving SKL orchestrator sessions.
 *
 * Hosts the start screen and active-session views produced by
 * orchestratorPanelHtml.ts. Receives postMessage commands from the
 * webview to start sessions and task assignments, and sends back live
 * progress updates during a running session.
 */

import * as vscode from "vscode";
import type { SKLFileSystem, OrchestratorService } from "../services/index.js";
import type { ProposalReviewResult, DecisionType } from "../types/index.js";
import { generateOrchestratorHtml } from "./orchestratorPanelHtml.js";
import { TaskAssignmentPanel } from "./TaskAssignmentPanel.js";

const VIEW_TYPE = "sklOrchestratorPanel";
const PANEL_TITLE = "SKL Orchestrator";
const DEBOUNCE_MS = 300;

// ── Helpers ───────────────────────────────────────────────────────

/** Map a processed queue-item status to its DecisionType equivalent. */
function statusToDecision(status: string): DecisionType {
  switch (status) {
    case "approved":  return "approve";
    case "rejected":  return "reject";
    case "escalated": return "escalate";
    case "rfc":       return "rfc";
    default:          return "approve";
  }
}

// ── Panel class ───────────────────────────────────────────────────

export class OrchestratorPanel {
  private static _instance: OrchestratorPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _orchestratorService: OrchestratorService;
  private readonly _context: vscode.ExtensionContext;
  private readonly _disposables: vscode.Disposable[] = [];

  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _recentResults: ProposalReviewResult[] = [];

  // ── Factory ──────────────────────────────────────────────────────

  /**
   * Reveal the existing Orchestrator panel or create a new one.
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    orchestratorService: OrchestratorService,
    sklFileSystem: SKLFileSystem,
    context: vscode.ExtensionContext,
  ): OrchestratorPanel {
    // Suppress unused parameter lint — extensionUri reserved for future
    // local resource roots (icons, stylesheets).
    void extensionUri;

    if (OrchestratorPanel._instance) {
      OrchestratorPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      return OrchestratorPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,    // buttons post messages; progress listener needed
        localResourceRoots: [], // no local resources required
      },
    );

    OrchestratorPanel._instance = new OrchestratorPanel(
      panel,
      orchestratorService,
      sklFileSystem,
      context,
    );
    return OrchestratorPanel._instance;
  }

  // ── Constructor ──────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    orchestratorService: OrchestratorService,
    skl: SKLFileSystem,
    context: vscode.ExtensionContext,
  ) {
    this._panel = panel;
    this._orchestratorService = orchestratorService;
    this._skl = skl;
    this._context = context;

    // Show start screen immediately
    this._panel.webview.html = generateOrchestratorHtml(null, [], "", []);

    // Webview → extension messages
    const msgSub = this._panel.webview.onDidReceiveMessage(
      (msg: { command: string }) => {
        void this._handleMessage(msg);
      },
    );
    this._disposables.push(msgSub);

    // Re-render when knowledge.json changes (debounced)
    const knowledgeSub = this._skl.onKnowledgeChanged(() => {
      this._debouncedRender();
    });
    this._disposables.push(knowledgeSub);

    // Clean up on close
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Message handler ──────────────────────────────────────────────

  private async _handleMessage(msg: { command: string }): Promise<void> {
    switch (msg.command) {
      case "start_session": {
        void vscode.window.showInformationMessage(
          "Starting Orchestrator session...",
        );
        try {
          await this._orchestratorService.runSession((status) => {
            // Send live status to the webview progress-status div
            void this._panel.webview.postMessage({
              command: "progress",
              status,
            });
          });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `SKL Orchestrator: Session error — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // Re-render with final session state
        await this._render();
        break;
      }

      case "start_task_assignment": {
        const featureRequest = await vscode.window.showInputBox({
          prompt: "Describe the feature to implement",
          placeHolder: "e.g. Add password reset endpoint",
        });
        if (!featureRequest) return;

        const assignments =
          await this._orchestratorService.runTaskAssignment(featureRequest);
        const scopeDefs = await this._skl.readScopeDefinitions();
        TaskAssignmentPanel.createOrShow(
          assignments,
          this._skl,
          this._orchestratorService,
          scopeDefs,
          this._context,
        );
        break;
      }
    }
  }

  // ── Render ───────────────────────────────────────────────────────

  private async _render(): Promise<void> {
    try {
      const knowledge = await this._skl.readKnowledge();

      // Build display records from all processed (non-pending) queue items
      this._recentResults = knowledge.queue
        .filter((p) => p.status !== "pending")
        .map(
          (p): ProposalReviewResult => ({
            proposal_id: p.proposal_id,
            decision: statusToDecision(p.status),
            rationale: p.rationale ?? "",
            rfc_id: null,
            state_updated: p.status === "approved",
            branch_merged: false,
            merge_conflict: false,
          }),
        );

      // Gather open RFCs (skip unreadable files)
      const rfcIds = await this._skl.listRFCs();
      const rfcResults = await Promise.allSettled(
        rfcIds.map((id) => this._skl.readRFC(id)),
      );
      const openRfcs = rfcResults.flatMap((r) =>
        r.status === "fulfilled" && r.value.status === "open" ? [r.value] : [],
      );

      // Derive session view from the most recent log
      const sessionLog = await this._skl.readMostRecentSessionLog();
      if (sessionLog === null) {
        this._panel.webview.html = generateOrchestratorHtml(
          null,
          [],
          "",
          openRfcs,
        );
        return;
      }

      const budgetStatus = `${sessionLog.proposals_reviewed} proposal(s) reviewed in last session.`;

      // Construct a minimal session view — consecutive_uncertain is not
      // persisted in the log, so we default it to 0.
      const sessionView = {
        session_id:                 sessionLog.session_id,
        session_start:              sessionLog.session_start,
        proposals_reviewed:         sessionLog.proposals_reviewed,
        escalations:                sessionLog.escalations,
        rfcs_opened:                sessionLog.rfcs_opened,
        uncertain_decisions:        sessionLog.uncertain_decisions,
        circuit_breakers_triggered: sessionLog.circuit_breakers_triggered,
        recurring_patterns_flagged: sessionLog.recurring_patterns_flagged,
        consecutive_uncertain:      0,
      };

      this._panel.webview.html = generateOrchestratorHtml(
        sessionView,
        this._recentResults,
        budgetStatus,
        openRfcs,
      );
    } catch {
      // Fallback to start screen on any read failure
      this._panel.webview.html = generateOrchestratorHtml(null, [], "", []);
    }
  }

  private _debouncedRender(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      void this._render();
    }, DEBOUNCE_MS);
  }

  // ── Disposal ─────────────────────────────────────────────────────

  dispose(): void {
    OrchestratorPanel._instance = undefined;

    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }

    for (const d of this._disposables) {
      d.dispose();
    }

    this._panel.dispose();
  }
}
