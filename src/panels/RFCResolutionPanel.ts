/**
 * RFCResolutionPanel — webview panel for resolving an RFC.
 *
 * Renders rfcResolutionPanelHtml.ts and handles confirm_resolution / cancel
 * messages from the webview.
 *
 * A separate panel instance may exist for each RFC ID that is being resolved
 * simultaneously.
 */

import * as vscode from "vscode";
import type { SKLFileSystem } from "../services/SKLFileSystem.js";
import { promoteRFCtoADR } from "../services/index.js";
import type { Rfc, DraftAcceptanceCriterion } from "../types/index.js";
import { generateRFCResolutionHtml } from "./rfcResolutionPanelHtml.js";

const VIEW_TYPE = "sklRFCResolutionPanel";
const VALID_OPTIONS = new Set(["option_a", "option_b", "option_c"]);

export class RFCResolutionPanel {
  private static readonly _instances: Map<string, RFCResolutionPanel> = new Map();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _skl: SKLFileSystem;
  private readonly _rfcId: string;
  private readonly _disposables: vscode.Disposable[] = [];
  private _rfc: Rfc;
  /** Resolves once the RFC has been loaded and rendered. */
  readonly _ready: Promise<void>;

  // ── Factory ──────────────────────────────────────────────────────

  /**
   * Reveal an existing panel for the given RFC ID, or create a new one.
   */
  static createOrShow(
    rfcId: string,
    sklFileSystem: SKLFileSystem,
    context: vscode.ExtensionContext,
  ): RFCResolutionPanel {
    const existing = RFCResolutionPanel._instances.get(rfcId);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `RFC ${rfcId}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const instance = new RFCResolutionPanel(rfcId, panel, sklFileSystem);
    RFCResolutionPanel._instances.set(rfcId, instance);
    context.subscriptions.push(instance);
    return instance;
  }

  // ── Constructor ──────────────────────────────────────────────────

  /**
   * Package-accessible constructor (not private) so tests can instantiate
   * directly without going through createOrShow.
   */
  constructor(
    rfcId: string,
    panel: vscode.WebviewPanel,
    skl: SKLFileSystem,
  ) {
    this._rfcId = rfcId;
    this._panel = panel;
    this._skl = skl;
    // Placeholder RFC until async init resolves
    this._rfc = { id: rfcId } as unknown as Rfc;

    // Panel disposed externally (user clicks X)
    this._disposables.push(
      this._panel.onDidDispose(() => { this.dispose(); }),
    );

    // Message handler
    this._disposables.push(
      this._panel.webview.onDidReceiveMessage(
        (message: {
          command: string;
          option?: string;
          rationale?: string;
          criteria?: DraftAcceptanceCriterion[];
        }) => {
          void this._handleMessage(message);
        },
      ),
    );

    // Async init: read RFC and render
    this._ready = this._init();
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async _init(): Promise<void> {
    try {
      this._rfc = await this._skl.readRFC(this._rfcId);
      this._panel.webview.html = generateRFCResolutionHtml(this._rfc);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `SKL: Could not load RFC ${this._rfcId} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.dispose();
    }
  }

  private async _handleMessage(message: {
    command: string;
    option?: string;
    rationale?: string;
    criteria?: DraftAcceptanceCriterion[];
  }): Promise<void> {
    switch (message.command) {
      case "select_option":
        // Selection is purely client-side; no server action needed.
        break;

      case "confirm_resolution": {
        // ── Validation ──────────────────────────────────────────────
        const option = message.option ?? "";
        const rationale = (message.rationale ?? "").trim();
        const criteria = message.criteria ?? [];

        if (!VALID_OPTIONS.has(option)) {
          void this._panel.webview.postMessage({
            command: "validation_error",
            message: "Invalid option selected.",
          });
          return;
        }
        if (rationale.length === 0) {
          void this._panel.webview.postMessage({
            command: "validation_error",
            message: "Rationale is required.",
          });
          return;
        }
        if (criteria.length === 0) {
          void this._panel.webview.postMessage({
            command: "validation_error",
            message: "At least one acceptance criterion is required.",
          });
          return;
        }

        // ── Build resolved RFC ──────────────────────────────────────
        const resolvedRfc: Rfc = {
          ...this._rfc,
          resolution: option,
          human_rationale: rationale,
          acceptance_criteria: (criteria as DraftAcceptanceCriterion[]).map(
            (c) => `${c.description} | ${c.check_type} | ${c.check_reference}`,
          ),
        };

        // ── Promote to ADR ──────────────────────────────────────────
        try {
          const knowledge = await this._skl.readKnowledge();
          const { adr } = await promoteRFCtoADR(
            resolvedRfc,
            rationale,
            knowledge,
            this._skl,
          );
          void vscode.window.showInformationMessage(
            `RFC ${this._rfc.id} resolved. ADR ${adr.id} created.`,
          );
          this.dispose();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `SKL: Failed to resolve RFC — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          // Do not dispose on error.
        }
        break;
      }

      case "cancel":
        this.dispose();
        break;

      default:
        break;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  dispose(): void {
    RFCResolutionPanel._instances.delete(this._rfcId);
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    this._panel.dispose();
  }
}
