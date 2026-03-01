/**
 * orchestratorPanelHtml.ts — Pure HTML generation for the Orchestrator webview.
 *
 * No VSCode imports. No side effects. Receives typed data and returns
 * complete HTML document strings or HTML fragments with inline CSS only.
 *
 * Compatible with VS Code's webview Content Security Policy when
 * the panel supplies a nonce; inline onclick handlers reference the
 * `vscode` object initialised by `acquireVsCodeApi()` in the injected
 * script block.
 */

// ── Local view interfaces (no imports from ../types) ──────────────

interface SessionView {
  session_id: string;
  session_start: string;
  proposals_reviewed: number;
  escalations: string[];
  rfcs_opened: string[];
  uncertain_decisions: string[];
  circuit_breakers_triggered: string[];
  recurring_patterns_flagged: string[];
  consecutive_uncertain: number;
}

interface ReviewResultView {
  proposal_id: string;
  decision: string;
  rationale: string;
  rfc_id: string | null;
  state_updated: boolean;
  branch_merged: boolean;
  merge_conflict: boolean;
}

interface RfcView {
  id: string;
  decision_required: string;
  human_response_deadline?: string;
  status: string;
}

// ── Shared helpers ────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

/** Compute a relative-time string from an ISO deadline to now. */
function relativeDeadline(isoDeadline: string | undefined): string {
  if (!isoDeadline) return "";
  const deadline = Date.parse(isoDeadline);
  if (isNaN(deadline)) return "";
  const diffMs = deadline - Date.now();
  if (diffMs <= 0) {
    return '<span style="color:#e04040;font-weight:bold;">OVERDUE</span>';
  }
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `Due in ${parts.join(" ")}`;
}

// ── Budget bar ────────────────────────────────────────────────────

function budgetBarColor(pct: number): string {
  if (pct < 0.7) return "#40a040";
  if (pct < 0.9) return "#f0a000";
  return "#e04040";
}

function renderBudgetBar(
  session: SessionView,
  maxProposals: number,
  budgetStatus: string,
): string {
  const pct = maxProposals > 0
    ? Math.min(session.proposals_reviewed / maxProposals, 1)
    : 0;
  const pctPx = Math.round(pct * 100);
  const color = budgetBarColor(pct);

  // Elapsed time
  const startMs = Date.parse(session.session_start);
  const elapsedMs = isNaN(startMs) ? 0 : Date.now() - startMs;
  const elapsedMin = Math.floor(elapsedMs / 60_000);
  const elapsedSec = Math.floor((elapsedMs % 60_000) / 1_000);
  const elapsedLabel = elapsedMin > 0
    ? `${elapsedMin}m ${elapsedSec}s elapsed`
    : `${elapsedSec}s elapsed`;

  return `
    <div style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="color:#ccc;font-size:0.9em;">
          ${escapeHtml(session.session_id)} &nbsp;·&nbsp;
          <strong style="color:#e0e0e0;">${session.proposals_reviewed} / ${maxProposals}</strong> proposals reviewed
        </span>
        <span style="color:#888;font-size:0.85em;">${escapeHtml(elapsedLabel)}</span>
      </div>
      <div style="background:#333;border-radius:4px;height:8px;overflow:hidden;">
        <div style="width:${pctPx}%;height:100%;background:${color};transition:width 0.3s;"></div>
      </div>
      <div style="margin-top:4px;font-size:0.8em;color:#888;">${escapeHtml(budgetStatus)}</div>
    </div>`;
}

// ── Review result row ─────────────────────────────────────────────

function decisionIcon(decision: string): string {
  switch (decision) {
    case "auto_approve": return "✅";
    case "approve":      return "✅";
    case "reject":       return "❌";
    case "escalate":     return "⚠️";
    case "rfc":          return "📋";
    default:             return "•";
  }
}

function renderResultRow(r: ReviewResultView): string {
  const icon = decisionIcon(r.decision);
  const shortRationale = truncate(r.rationale, 120);
  const mergeNote = r.merge_conflict
    ? `<div style="margin-top:4px;color:#f0a000;font-size:0.8em;">⚠️ Merge conflict — resolve manually</div>`
    : "";
  const rfcNote = r.rfc_id
    ? `<span style="margin-left:8px;background:#2a2d5e;color:#9db0ff;padding:1px 6px;border-radius:3px;font-size:0.8em;">RFC ${escapeHtml(r.rfc_id)}</span>`
    : "";

  return `
    <div style="background:#1e1e1e;border-left:4px solid #333;padding:10px 14px;margin:6px 0;border-radius:4px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:1.1em;">${icon}</span>
        <strong style="color:#4fc1ff;">${escapeHtml(r.proposal_id)}</strong>
        <span style="color:#aaa;font-size:0.85em;">${escapeHtml(r.decision)}</span>
        ${rfcNote}
      </div>
      <div style="margin-top:6px;color:#ccc;font-size:0.875em;">${escapeHtml(shortRationale)}</div>
      ${mergeNote}
    </div>`;
}

// ── Open RFCs panel ───────────────────────────────────────────────

function renderOpenRFCsPanel(rfcs: RfcView[]): string {
  const open = rfcs.filter((r) => r.status === "open");
  if (open.length === 0) return "";

  const rows = open
    .map((rfc) => {
      const deadline = relativeDeadline(rfc.human_response_deadline);
      const deadlineHtml = deadline
        ? `<span style="margin-left:auto;font-size:0.8em;color:#aaa;">${deadline}</span>`
        : "";
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #3a3a3a;">
          <strong style="color:#9db0ff;">${escapeHtml(rfc.id)}</strong>
          <span style="color:#ccc;font-size:0.875em;flex:1;">${escapeHtml(truncate(rfc.decision_required, 80))}</span>
          ${deadlineHtml}
        </div>`;
    })
    .join("\n");

  return `
    <div style="margin:16px 0;padding:12px 16px;border:1px solid #f0a000;border-radius:6px;background:#2a2100;">
      <div style="color:#f0c000;font-weight:600;margin-bottom:8px;">⚠️ Open RFCs Requiring Response</div>
      ${rows}
    </div>`;
}

// ── Action buttons ────────────────────────────────────────────────

function renderActionButtons(): string {
  return `
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">
      <button
        onclick="vscode.postMessage({command:'start_session'})"
        style="padding:8px 18px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.9em;">
        Start New Session
      </button>
      <button
        onclick="vscode.postMessage({command:'start_task_assignment'})"
        style="padding:8px 18px;background:#3a3d41;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:0.9em;">
        Assign Tasks
      </button>
    </div>`;
}

// ── Shared page shell ─────────────────────────────────────────────

function pageShell(bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e;
      color: #ccc;
    }
    button:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <script>
    var vscode;
    try {
      vscode = acquireVsCodeApi();
    } catch (_) {
      vscode = { postMessage: function(m) { console.log('postMessage:', JSON.stringify(m)); } };
    }
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.command === 'progress') {
        var el = document.getElementById('progress-status');
        if (el) { el.textContent = msg.status; }
      }
    });
  </script>
  ${bodyContent}
</body>
</html>`;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Generate a full HTML document for the Orchestrator webview.
 *
 * @param session       Active/completed session, or `null` for the start screen.
 * @param recentResults Proposal review results in order of processing.
 * @param budgetStatus  Human-readable budget string from `getBudgetStatus()`.
 * @param openRFCs      All RFCs currently open (status === "open").
 * @param maxProposals  Budget cap — used to size the progress bar (default 15).
 */
export function generateOrchestratorHtml(
  session: SessionView | null,
  recentResults: ReviewResultView[],
  budgetStatus: string,
  openRFCs: RfcView[],
  maxProposals = 15,
): string {
  // ── Start screen ──────────────────────────────────────────────
  if (session === null) {
    const body = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center;opacity:0.9;">
        <div style="font-size:2em;font-weight:700;color:#e0e0e0;margin-bottom:8px;">SKL</div>
        <div style="color:#aaa;font-size:0.95em;max-width:400px;margin-bottom:28px;line-height:1.5;">
          Orchestrator processes pending Queue proposals and writes decisions to knowledge.json
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">
          <button
            onclick="vscode.postMessage({command:'start_session'})"
            style="padding:10px 22px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.95em;">
            Start Orchestrator Session
          </button>
          <button
            onclick="vscode.postMessage({command:'start_task_assignment'})"
            style="padding:10px 22px;background:#3a3d41;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:0.95em;">
            Assign Tasks
          </button>
        </div>
      </div>`;
    return pageShell(body);
  }

  // ── Active / completed session ────────────────────────────────
  const bar = renderBudgetBar(session, maxProposals, budgetStatus);
  const rfcPanel = renderOpenRFCsPanel(openRFCs);

  const resultRows =
    recentResults.length > 0
      ? recentResults.map(renderResultRow).join("\n")
      : `<div style="color:#555;font-size:0.9em;margin:12px 0;">No proposals reviewed yet this session.</div>`;

  const escalationNote =
    session.escalations.length > 0
      ? `<div style="margin-top:8px;color:#aaa;font-size:0.8em;">
           ${session.escalations.length} escalation(s): ${session.escalations.map(escapeHtml).join(", ")}
         </div>`
      : "";

  const body = `
    ${bar}
    ${rfcPanel}
    <div id="progress-status" style="min-height:1.4em;padding:6px 10px;margin:8px 0;background:#252526;border-radius:4px;font-size:0.875em;color:#ccc;"></div>
    <div style="margin-bottom:8px;">
      <span style="font-size:0.9em;color:#888;font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Reviews</span>
    </div>
    ${resultRows}
    ${escalationNote}
    ${renderActionButtons()}`;

  return pageShell(body);
}

/**
 * Generate a lightweight HTML fragment for incremental panel updates.
 *
 * Returns a `<div>` containing the current status string and a count
 * badge showing completed reviews. Used to update a specific DOM region
 * without re-rendering the full page.
 *
 * @param status  Status string emitted by `onProgress`.
 * @param results The current list of processed results.
 */
export function generateProgressUpdate(
  status: string,
  results: ReviewResultView[],
): string {
  const count = results.length;
  return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:#252526;border-radius:4px;font-size:0.875em;">
  <span style="color:#ccc;flex:1;">${escapeHtml(status)}</span>
  <span style="background:#0e639c;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.8em;white-space:nowrap;">
    ${count} reviewed
  </span>
</div>`;
}
