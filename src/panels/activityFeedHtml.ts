/**
 * activityFeedHtml.ts — Pure HTML generation for the Activity Feed webview.
 *
 * No VSCode imports. Receives typed proposal and state data and returns
 * a complete HTML document string with inline CSS only.
 * All field values are translated to plain English — no JSON field names
 * are visible in the rendered output.
 */

import type { QueueProposal, StateRecord } from "../types/index.js";

/**
 * Extended proposal type to accommodate the optional blocking_reasons field
 * that the enforcement hook may attach at runtime.
 */
type ProposalWithBlocking = QueueProposal & { blocking_reasons?: string[] };

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Compute a human-readable relative time string from an ISO 8601 timestamp.
 */
export function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const deltaS = Math.floor((now - then) / 1000);
  if (deltaS < 60) return "just now";
  const deltaM = Math.floor(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.floor(deltaM / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  const d = new Date(isoString);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function changeTypeLabel(ct: string): string {
  switch (ct) {
    case "mechanical":    return "Mechanical change (comments, formatting)";
    case "behavioral":    return "Behavioral change";
    case "architectural": return "Architectural change";
    default:              return escHtml(ct);
  }
}

function statusPill(status: string): string {
  let cls = "grey";
  let label = "Pending review";
  switch (status) {
    case "approved":     cls = "green"; label = "Approved";       break;
    case "rejected":     cls = "red";   label = "Rejected";       break;
    case "rfc":          cls = "amber"; label = "RFC opened";     break;
    case "escalated":    cls = "red";   label = "Escalated";      break;
    case "auto_approve": cls = "green"; label = "Auto-approved";  break;
  }
  return `<span class="status-pill ${cls}">${label}</span>`;
}

function badgeHtml(proposal: ProposalWithBlocking): string {
  if (proposal.out_of_scope) {
    return `<span class="badge out-of-scope">Out of scope</span>`;
  }
  const blocking = proposal.blocking_reasons ?? [];
  if (blocking.length > 0) {
    return `<span class="badge blocked">Blocked</span>`;
  }
  if (proposal.cross_scope_flag) {
    return `<span class="badge cross-scope">Cross-scope</span>`;
  }
  return "";
}

function entryClasses(proposal: ProposalWithBlocking): string {
  const classes = ["activity-entry"];
  if (proposal.out_of_scope) classes.push("is-out-of-scope");
  const blocking = proposal.blocking_reasons ?? [];
  if (blocking.length > 0) classes.push("is-blocked");
  if (proposal.status === "approved" || proposal.status === "auto_approve") classes.push("is-approved");
  if (proposal.status === "rejected") classes.push("is-rejected");
  return classes.join(" ");
}

function riskSignalsHtml(rs: QueueProposal["risk_signals"]): string {
  const warnings: string[] = [];
  if (rs.touched_auth_or_permission_patterns) {
    warnings.push(`<span class="signal warn">⚠ Touches security-sensitive code</span>`);
  }
  if (rs.public_api_signature_changed) {
    warnings.push(`<span class="signal warn">⚠ Public API signature changed</span>`);
  }
  if (rs.invariant_referenced_file_modified) {
    warnings.push(`<span class="signal warn">⚠ Modifies a file tied to a system invariant</span>`);
  }
  if (rs.high_fan_in_module_modified) {
    warnings.push(`<span class="signal warn">⚠ Many modules depend on this file</span>`);
  }
  if (rs.mechanical_only) {
    warnings.push(`<span class="signal ok">✓ AST confirms mechanical-only change</span>`);
  }
  if (warnings.length === 0) return "";
  return `<div class="risk-signals">${warnings.join(" ")}</div>`;
}

function reasoningHtml(summary: string): string {
  if (!summary.trim()) return "";
  return `<details class="reasoning">
  <summary>Agent reasoning</summary>
  <p>${escHtml(summary)}</p>
</details>`;
}

function entryHtml(proposal: ProposalWithBlocking): string {
  const classes = entryClasses(proposal);
  const badge = badgeHtml(proposal);
  const ts = proposal.submitted_at ? relativeTime(proposal.submitted_at) : "";
  const ctLabel = changeTypeLabel(proposal.change_type ?? "behavioral");
  const rsHtml = riskSignalsHtml(proposal.risk_signals);
  const reasonHtml = reasoningHtml(proposal.agent_reasoning_summary ?? "");
  const pill = statusPill(proposal.status);
  return `<div class="${classes}">
  <div class="activity-header">
    <span class="agent-id">${escHtml(proposal.agent_id)}</span>
    <span class="arrow">→</span>
    <code class="file-path">${escHtml(proposal.path)}</code>
    ${badge}
    <span class="timestamp">${escHtml(ts)}</span>
    ${pill}
  </div>
  <div class="activity-detail">
    <span class="change-type">${ctLabel}</span>
    ${rsHtml}
    ${reasonHtml}
  </div>
</div>`;
}

/**
 * Generate a complete HTML document for the Activity Feed panel.
 *
 * @param proposals   - All queue proposals from knowledge.json.
 * @param _stateRecords - State records (reserved for future use).
 * @param sklMode     - Current SKL operating mode.
 */
export function generateActivityFeedHtml(
  proposals: QueueProposal[],
  _stateRecords: StateRecord[],
  sklMode: "phase_0" | "full",
): string {
  const sortedProposals = [...proposals]
    .sort((a, b) => {
      const ta = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
      const tb = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
      return tb - ta;
    }) as ProposalWithBlocking[];

  const modeBadge =
    sklMode === "phase_0"
      ? `<span class="mode-badge phase0">Phase 0</span>`
      : `<span class="mode-badge full">Full SKL</span>`;

  const upgradeHint =
    sklMode === "phase_0"
      ? `<p class="upgrade-hint">Upgrade to full SKL to enable scope enforcement and RFC governance. ` +
        `<a href="#" onclick="vscode.postMessage({command:'upgrade'})">Upgrade now →</a></p>`
      : "";

  const timelineHtml =
    sortedProposals.length === 0
      ? `<div class="empty-state">
  <p>No agent activity yet.</p>
  <p>Set <code>SKL_AGENT_ID=Agent-1</code> in your agent's terminal
     and push a branch to start logging activity.</p>
</div>`
      : sortedProposals.map(entryHtml).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SKL Activity Feed</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px;
         color: var(--vscode-foreground, #ccc);
         background: var(--vscode-editor-background, #1e1e1e);
         padding: 16px; margin: 0; }
  h1 { font-size: 1.4em; margin-bottom: 8px; }
  a { color: var(--vscode-textLink-foreground, #4fc3f7); }
  .mode-badge { border-radius: 4px; padding: 2px 8px; font-size: 0.8em;
                margin-left: 8px; vertical-align: middle; }
  .mode-badge.phase0 { background: #f0a030; color: #000; }
  .mode-badge.full   { background: #4caf50; color: #000; }
  .upgrade-hint { font-size: 0.9em; margin: 8px 0 16px;
                  color: var(--vscode-descriptionForeground, #aaa); }
  .empty-state { margin: 32px 0; color: var(--vscode-descriptionForeground, #aaa); }
  .activity-entry { border-left: 3px solid var(--vscode-panel-border, #444);
                    padding: 8px 12px; margin: 8px 0; }
  .is-out-of-scope { border-left-color: #e04040; }
  .is-blocked      { border-left-color: #e04040; }
  .is-approved     { border-left-color: #4caf50; opacity: 0.7; }
  .is-rejected     { border-left-color: #888; opacity: 0.6; }
  .activity-header { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .agent-id  { font-weight: bold;
               color: var(--vscode-symbolIcon-functionForeground, #ddd); }
  .arrow     { color: var(--vscode-descriptionForeground, #888); }
  .file-path { font-size: 0.9em;
               color: var(--vscode-textLink-foreground, #4fc3f7); }
  .timestamp { font-size: 0.8em;
               color: var(--vscode-descriptionForeground, #888); margin-left: auto; }
  .badge { font-size: 0.75em; padding: 2px 6px; border-radius: 10px; }
  .badge.out-of-scope { background: #e04040; color: #fff; }
  .badge.blocked      { background: #e04040; color: #fff; }
  .badge.cross-scope  { background: #f0a030; color: #000; }
  .status-pill { font-size: 0.75em; padding: 2px 8px; border-radius: 10px;
                 margin-left: 4px; }
  .status-pill.grey  { background: #555; color: #ddd; }
  .status-pill.green { background: #2e7d32; color: #e8f5e9; }
  .status-pill.red   { background: #b71c1c; color: #ffebee; }
  .status-pill.amber { background: #e65100; color: #fff3e0; }
  .activity-detail { margin-top: 4px; font-size: 0.9em; }
  .change-type { color: var(--vscode-descriptionForeground, #aaa); }
  .risk-signals { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 6px; }
  .signal { font-size: 0.8em; padding: 2px 6px; border-radius: 4px; }
  .signal.warn { background: rgba(240, 160, 48, 0.15); color: #f0a030; }
  .signal.ok   { background: rgba(76, 175, 80, 0.15);  color: #4caf50; }
  .reasoning   { margin-top: 6px; font-size: 0.85em;
                 color: var(--vscode-descriptionForeground, #aaa); }
  .reasoning summary { cursor: pointer; }
</style>
</head>
<body>
<h1>SKL Activity Feed ${modeBadge}</h1>
${upgradeHint}
<div id="timeline">
${timelineHtml}
</div>
</body>
</html>`;
}
