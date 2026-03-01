/**
 * ActivityFeedPanel — Read-only webview panel for the SKL Activity Feed.
 *
 * Primary UI for Phase 0 users. Renders a plain-English timeline of
 * agent activity from knowledge.json. Reacts to knowledge file changes
 * in real time. Shows an upgrade prompt when in Phase 0 mode.
 */

import * as vscode from "vscode";
import type { SKLFileSystem } from "../services/SKLFileSystem.js";
import { generateActivityFeedHtml } from "./activityFeedHtml.js";

const VIEW_TYPE = "sklActivityFeedPanel";
const PANEL_TITLE = "SKL Activity Feed";
const DEBOUNCE_MS = 300;

export class ActivityFeedPanel {
  private static _instance: ActivityFeedPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _disposables: vscode.Disposable[] = [];
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Factory ──────────────────────────────────────────────────────

  /**
   * Reveal an existing Activity Feed panel or create a new one.
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    sklFileSystem: SKLFileSystem,
  ): ActivityFeedPanel {
    if (ActivityFeedPanel._instance) {
      ActivityFeedPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      return ActivityFeedPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const instance = new ActivityFeedPanel(panel, sklFileSystem);
    ActivityFeedPanel._instance = instance;

    // Initial async render
    void instance._render();

    return instance;
  }

  /**
   * Returns true if the panel is currently open. Used to prevent double auto-open.
   */
  static isOpen(): boolean {
    return ActivityFeedPanel._instance !== undefined;
  }

  // ── Constructor ──────────────────────────────────────────────────

  constructor(panel: vscode.WebviewPanel, skl: SKLFileSystem) {
    this._panel = panel;
    this._skl = skl;

    // Handle upgrade message from the webview
    const messageSub = this._panel.webview.onDidReceiveMessage(
      (message: { command: string }) => {
        if (message.command === "upgrade") {
          void vscode.commands.executeCommand("skl.upgradeToFull");
        }
      },
    );
    this._disposables.push(messageSub);

    // Debounced re-render on knowledge changes
    const knowledgeSub = this._skl.onKnowledgeChanged(() => {
      if (this._debounceTimer !== undefined) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined;
        void this._render();
      }, DEBOUNCE_MS);
    });
    this._disposables.push(knowledgeSub);

    // Clean up on panel close
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async _render(): Promise<void> {
    let queue: Parameters<typeof generateActivityFeedHtml>[0] = [];
    let state: Parameters<typeof generateActivityFeedHtml>[1] = [];
    let sklMode: "phase_0" | "full" = "full";

    try {
      const knowledge = await this._skl.readKnowledge();
      queue = knowledge.queue ?? [];
      state = knowledge.state ?? [];
    } catch {
      // knowledge.json not yet created — render empty state
    }

    try {
      const config = await this._skl.readHookConfig();
      if (config.skl_mode === "phase_0") sklMode = "phase_0";
    } catch {
      // hook_config not yet created — default to full
    }

    this._panel.webview.html = generateActivityFeedHtml(queue, state, sklMode);
  }

  // ── Public API ───────────────────────────────────────────────────

  dispose(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
    ActivityFeedPanel._instance = undefined;
    for (const d of this._disposables) d.dispose();
    this._disposables.length = 0;
  }
}
