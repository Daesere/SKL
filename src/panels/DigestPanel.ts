/**
 * DigestPanel — webview panel for the SKL human review digest.
 *
 * Renders the DigestReport via digestPanelHtml.ts. Handles mark_reviewed
 * and mark_all_reviewed messages from the webview.
 *
 * Safety contract (SPEC Section 3.2.3):
 *   - Level 0 (Verified): NEVER touched here — only CICheckService can set this.
 *   - Level 3 (Contested): NEVER reduced here — requires explicit resolution.
 *   - Level 2 → 1 is the ONLY transition permitted by digest review.
 */

import * as vscode from "vscode";
import type { SKLFileSystem } from "../services/SKLFileSystem.js";
import type { KnowledgeFile } from "../types/index.js";
import { generateDigest } from "../services/DigestService.js";
import { generateDigestHtml } from "./digestPanelHtml.js";

const VIEW_TYPE = "sklDigestPanel";
const PANEL_TITLE = "SKL Digest";
const DEBOUNCE_MS = 300;

export class DigestPanel {
  private static _instance: DigestPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _outputChannel: vscode.OutputChannel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private currentKnowledge: KnowledgeFile;

  // ── Factory ──────────────────────────────────────────────────────

  /**
   * Reveal an existing Digest panel or create a new one.
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    sklFileSystem: SKLFileSystem,
    outputChannel?: vscode.OutputChannel,
  ): DigestPanel {
    if (DigestPanel._instance) {
      DigestPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      return DigestPanel._instance;
    }

    const channel = outputChannel ?? vscode.window.createOutputChannel("SKL — Digest");

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );

    // Construct with empty knowledge — render() will populate asynchronously
    const emptyKnowledge: KnowledgeFile = {
      invariants: {
        tech_stack: [],
        auth_model: "",
        data_storage: "",
        security_patterns: [],
      },
      state: [],
      queue: [],
    };

    const instance = new DigestPanel(panel, sklFileSystem, channel, emptyKnowledge);
    DigestPanel._instance = instance;

    // Initial async render
    void instance.render();

    return instance;
  }

  // ── Constructor ──────────────────────────────────────────────────

  /**
   * Exposed as a package-level (not private) constructor to allow
   * direct construction in tests without going through createOrShow.
   * Production code uses createOrShow.
   */
  constructor(
    panel: vscode.WebviewPanel,
    skl: SKLFileSystem,
    outputChannel: vscode.OutputChannel,
    initialKnowledge: KnowledgeFile,
  ) {
    this._panel = panel;
    this._skl = skl;
    this._outputChannel = outputChannel;
    this.currentKnowledge = initialKnowledge;

    // Message handler
    const messageSub = this._panel.webview.onDidReceiveMessage(
      (message: { command: string; record_id?: string }) => {
        if (message.command === "mark_reviewed" && message.record_id) {
          void this.markReviewed(message.record_id).catch((err: Error) => {
            void vscode.window.showErrorMessage(err.message);
          });
        } else if (message.command === "mark_all_reviewed") {
          void this.markAllReviewed().catch((err: Error) => {
            void vscode.window.showErrorMessage(err.message);
          });
        }
      },
    );
    this._disposables.push(messageSub);

    // Re-render on knowledge changes (debounced)
    const knowledgeSub = this._skl.onKnowledgeChanged(() => {
      this.debouncedRender();
    });
    this._disposables.push(knowledgeSub);

    // Cleanup on dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Render ───────────────────────────────────────────────────────

  private async render(): Promise<void> {
    try {
      const knowledge = await this._skl.readKnowledge();
      this.currentKnowledge = knowledge;

      // Resolve open RFC IDs
      const allRfcIds = await this._skl.listRFCs();
      const rfcResults = await Promise.allSettled(
        allRfcIds.map((id) => this._skl.readRFC(id)),
      );
      const openRfcIds = rfcResults.flatMap((r) =>
        r.status === "fulfilled" && r.value.status === "open" ? [r.value.id] : [],
      );

      const report = generateDigest(knowledge, openRfcIds);
      this._panel.webview.html = generateDigestHtml(report);
    } catch {
      // On error render an empty digest
      this._panel.webview.html = generateDigestHtml(
        generateDigest(this.currentKnowledge, []),
      );
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

  // ── Mark reviewed ─────────────────────────────────────────────────

  /**
   * Reduce a single State record from uncertainty_level 2 → 1.
   *
   * Safety checks (in order):
   *   - Level 0: skip — CI proof; digest review must never override.
   *   - Level 3: skip — Contested; requires explicit resolution.
   *   - Level 1: skip — already reviewed.
   *   - Level 2: proceed — reduce to 1, reset change counter.
   */
  async markReviewed(recordId: string): Promise<void> {
    const idx = this.currentKnowledge.state.findIndex((r) => r.id === recordId);
    if (idx === -1) {
      this._outputChannel.appendLine(`DigestPanel: record ${recordId} not found.`);
      return;
    }

    const record = this.currentKnowledge.state[idx];

    switch (record.uncertainty_level) {
      case 0:
        this._outputChannel.appendLine(
          `Skipping ${recordId}: already at level 0 (Verified). CI proof cannot be overridden by digest review.`,
        );
        return;
      case 3:
        this._outputChannel.appendLine(
          `Skipping ${recordId}: at level 3 (Contested). Requires explicit resolution.`,
        );
        return;
      case 1:
        this._outputChannel.appendLine(
          `${recordId} already at level 1 (Reviewed). No change.`,
        );
        return;
      default:
        break; // level 2 — proceed
    }

    // Build updated record — do not mutate currentKnowledge
    const today = new Date().toISOString().split("T")[0];
    const updatedRecord = {
      ...record,
      uncertainty_level: 1 as const,
      last_reviewed_at: today,
      change_count_since_review: 0,
    };

    const updatedKnowledge: KnowledgeFile = {
      ...this.currentKnowledge,
      state: this.currentKnowledge.state.map((r, i) =>
        i === idx ? updatedRecord : r,
      ),
    };

    await this._skl.writeKnowledge(updatedKnowledge);
    this.currentKnowledge = updatedKnowledge;

    void this.render();
    void this._panel.webview.postMessage({ command: "mark_confirmed", record_id: recordId });
  }

  /**
   * Reduce all level-2 State records to level 1 in a single atomic write.
   * Records at levels 0, 1, and 3 are not touched.
   */
  async markAllReviewed(): Promise<void> {
    const level2 = this.currentKnowledge.state.filter(
      (r) => r.uncertainty_level === 2,
    );

    if (level2.length === 0) {
      this._outputChannel.appendLine("markAllReviewed: no level-2 entries.");
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const level2Ids = new Set(level2.map((r) => r.id));

    const updatedKnowledge: KnowledgeFile = {
      ...this.currentKnowledge,
      state: this.currentKnowledge.state.map((r) => {
        if (!level2Ids.has(r.id)) return r;
        return {
          ...r,
          uncertainty_level: 1 as const,
          last_reviewed_at: today,
          change_count_since_review: 0,
        };
      }),
    };

    // ONE atomic write for all records
    await this._skl.writeKnowledge(updatedKnowledge);
    this.currentKnowledge = updatedKnowledge;
    void this.render();
  }

  // ── Disposal ──────────────────────────────────────────────────────

  dispose(): void {
    DigestPanel._instance = undefined;

    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }

    for (const d of this._disposables) {
      d.dispose();
    }

    this._panel.dispose();
  }
}
