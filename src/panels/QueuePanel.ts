/**
 * QueuePanel — webview panel for displaying the SKL proposal queue.
 *
 * Reads proposals from knowledge.json via SKLFileSystem and renders
 * them using the pure HTML helpers in queuePanelHtml.ts.
 */

import * as vscode from "vscode";
import type { SKLFileSystem } from "../services/index.js";
import { generateQueueHtml } from "./queuePanelHtml.js";

const VIEW_TYPE = "sklQueuePanel";
const PANEL_TITLE = "SKL Queue";
const DEBOUNCE_MS = 300;

export class QueuePanel {
  private static _instance: QueuePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _disposables: vscode.Disposable[] = [];
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Factory ──────────────────────────────────────────────────────

  /**
   * Reveal an existing Queue panel or create a new one.
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    sklFileSystem: SKLFileSystem,
  ): QueuePanel {
    if (QueuePanel._instance) {
      QueuePanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      return QueuePanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );

    QueuePanel._instance = new QueuePanel(panel, sklFileSystem);
    return QueuePanel._instance;
  }

  // ── Constructor ──────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    skl: SKLFileSystem,
  ) {
    this._panel = panel;
    this._skl = skl;

    // Initial render
    void this.render();

    // Re-render on knowledge changes (debounced)
    const knowledgeSub = this._skl.onKnowledgeChanged(() => {
      this.debouncedRender();
    });
    this._disposables.push(knowledgeSub);

    // Reveal panel when operator opens knowledge.json
    const editorSub = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (
          editor &&
          editor.document.uri.fsPath.endsWith(
            ".skl" + "/" + "knowledge.json",
          )
        ) {
          this._panel.reveal(vscode.ViewColumn.Beside, true);
        }
      },
    );
    this._disposables.push(editorSub);

    // Cleanup on dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Render ───────────────────────────────────────────────────────

  private async render(): Promise<void> {
    try {
      const knowledge = await this._skl.readKnowledge();
      const proposals = knowledge.queue ?? [];
      this._panel.webview.html = generateQueueHtml(proposals);
    } catch {
      this._panel.webview.html = generateQueueHtml([]);
    }
  }

  private debouncedRender(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      void this.render();
    }, DEBOUNCE_MS);
  }

  // ── Disposal ─────────────────────────────────────────────────────

  private dispose(): void {
    QueuePanel._instance = undefined;

    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }

    for (const d of this._disposables) {
      d.dispose();
    }

    this._panel.dispose();
  }
}
