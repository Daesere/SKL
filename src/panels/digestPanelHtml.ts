/**
 * digestPanelHtml.ts — Pure HTML generation for the Digest webview.
 *
 * No VSCode imports. Receives a DigestReport and returns a complete
 * HTML document string with inline CSS only.
 *
 * Consumed by DigestPanel.ts which sets enableScripts: true on the webview.
 */

import type { DigestReport } from "../services/DigestService.js";
import type { StateRecord } from "../types/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function uncertaintyLabel(level: number): string {
  switch (level) {
    case 0: return "U0 Verified";
    case 1: return "U1 Reviewed";
    case 2: return "U2 Proposed";
    case 3: return "U3 Contested";
    default: return `U${level}`;
  }
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderEntryCard(
  entry: StateRecord,
  borderColor: string,
  showMarkReviewedButton: boolean,
): string {
  const truncatedResp = truncate(escapeHtml(entry.responsibilities), 100);
  const markBtn = showMarkReviewedButton
    ? `<button data-record-id="${escapeHtml(entry.id)}" onclick="vscode.postMessage({command:'mark_reviewed',record_id:'${escapeHtml(entry.id)}'})">Mark Reviewed</button>`
    : "";
  return `
    <div class="entry-card" style="border-left: 4px solid ${borderColor}; padding: 10px 14px; margin: 8px 0; background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px;">
      <div><strong>${escapeHtml(entry.id)}</strong> — <code>${escapeHtml(entry.path)}</code></div>
      <div style="margin-top:4px;">
        <span class="scope-badge">${escapeHtml(entry.semantic_scope)}</span>
        <span class="uncertainty-badge u${entry.uncertainty_level}">${uncertaintyLabel(entry.uncertainty_level)}</span>
      </div>
      <p style="margin:6px 0;">${truncatedResp}</p>
      <div style="font-size:0.85em;color:var(--vscode-descriptionForeground,#888);">${entry.change_count_since_review} changes since review</div>
      ${markBtn}
    </div>`;
}

function renderSection1(report: DigestReport): string {
  const entries = report.state_entries_for_review;
  if (entries.length === 0) return "";
  const cards = entries.map((e) => renderEntryCard(e, "var(--color-neutral)", true)).join("");
  return `
  <section>
    <h2>Entries Pending Review (${entries.length})</h2>
    <button onclick="vscode.postMessage({command:'mark_all_reviewed'})">Mark All Reviewed</button>
    ${cards}
  </section>`;
}

function renderSection2(report: DigestReport): string {
  // Exclude level-2 entries — they already appear in Section 1.
  const entries = report.state_entries_flagged.filter((r) => r.uncertainty_level !== 2);
  if (entries.length === 0) return "";
  const cards = entries.map((e) => renderEntryCard(e, "var(--color-flagged)", true)).join("");
  return `
  <section>
    <h2>Flagged for Drift (${entries.length})</h2>
    ${cards}
  </section>`;
}

function renderSection3(report: DigestReport): string {
  const entries = report.contested_entries;
  if (entries.length === 0) return "";
  const cards = entries.map((e) => `
    <div class="entry-card" style="border-left: 4px solid var(--color-contested); padding: 10px 14px; margin: 8px 0; background: var(--vscode-editor-background, #1e1e1e); border-radius: 4px;">
      <div><strong>${escapeHtml(e.id)}</strong> — <code>${escapeHtml(e.path)}</code></div>
      <div style="margin-top:4px;">
        <span class="scope-badge">${escapeHtml(e.semantic_scope)}</span>
        <span class="uncertainty-badge u3">U3 Contested</span>
      </div>
      <p class="contested-note">⚠ Requires explicit resolution. Use 'SKL: Resolve RFC' or manually reduce uncertainty_level.</p>
    </div>`).join("");
  return `
  <section>
    <h2>Contested Entries (${entries.length})</h2>
    ${cards}
  </section>`;
}

function renderSection4(report: DigestReport): string {
  const decisions = report.architectural_decisions_since_last_digest;
  const content = decisions.length === 0
    ? "<p>No architectural decisions since last digest.</p>"
    : decisions.map((d) => `
      <div class="decision-card">
        <strong>${escapeHtml(d.proposal_id)}</strong> — <code>${escapeHtml(d.path)}</code>
        <p>${escapeHtml(truncate(d.rationale_text, 200))}</p>
        <span>${escapeHtml(d.decision)} · ${escapeHtml(d.recorded_at)}</span>
      </div>`).join("");
  return `
  <section>
    <h2>Recent Architectural Decisions</h2>
    ${content}
  </section>`;
}

function renderSection5(report: DigestReport): string {
  const rfcIds = report.open_rfc_ids;
  if (rfcIds.length === 0) return "";
  const items = rfcIds.map((id) => `<li>${escapeHtml(id)}</li>`).join("");
  return `
  <section>
    <h2>Open RFCs (${rfcIds.length})</h2>
    <ul>${items}</ul>
    <p>Resolve via command palette: 'SKL: Resolve RFC'.</p>
  </section>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a complete HTML document for the SKL Digest panel.
 *
 * @param report  The DigestReport produced by DigestService.generateDigest.
 * @returns       Full HTML document string (UTF-8).
 */
export function generateDigestHtml(report: DigestReport): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SKL Digest</title>
<style>
  :root {
    --color-reviewed: #4caf50;
    --color-flagged: #f0a030;
    --color-contested: #e04040;
    --color-neutral: #555;
  }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    margin: 0;
    padding: 16px 20px;
  }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  h2 { font-size: 1.1em; margin: 20px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; }
  .summary { font-size: 0.9em; color: var(--vscode-descriptionForeground, #888); margin: 2px 0; }
  .generated { font-size: 0.8em; color: var(--vscode-descriptionForeground, #888); margin-bottom: 16px; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; background: #2d2d2d; padding: 1px 4px; border-radius: 2px; }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
    margin-top: 6px;
  }
  button:hover { opacity: 0.85; }
  .scope-badge {
    display: inline-block;
    background: #333;
    color: #aaa;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 0.8em;
    margin-right: 4px;
  }
  .uncertainty-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 0.8em;
    font-weight: 600;
    margin-right: 4px;
    color: #fff;
  }
  .uncertainty-badge.u0 { background: #555; }
  .uncertainty-badge.u1 { background: #4caf50; }
  .uncertainty-badge.u2 { background: #f0a030; }
  .uncertainty-badge.u3 { background: #e04040; }
  .decision-card {
    border-left: 3px solid var(--color-reviewed);
    padding: 8px 12px;
    margin: 6px 0;
    background: #252525;
    border-radius: 3px;
  }
  .decision-card p { margin: 6px 0; font-size: 0.9em; }
  .decision-card span { font-size: 0.8em; color: var(--vscode-descriptionForeground, #888); }
  .contested-note { color: var(--color-contested); font-style: italic; font-size: 0.9em; }
  ul { padding-left: 20px; }
  li { margin: 3px 0; }
</style>
</head>
<body>

<h1>SKL Digest</h1>
<p class="summary">${escapeHtml(report.summary)}</p>
<p class="generated">Generated: ${escapeHtml(report.generated_at)}</p>

${renderSection1(report)}
${renderSection2(report)}
${renderSection3(report)}
${renderSection4(report)}
${renderSection5(report)}

<script>
const vscode = acquireVsCodeApi();
window.addEventListener('message', event => {
  if (event.data.command === 'mark_confirmed') {
    const btn = document.querySelector('[data-record-id="' + event.data.record_id + '"]');
    if (btn) btn.textContent = '\\u2713 Reviewed';
  }
});
</script>
</body>
</html>`;
}
