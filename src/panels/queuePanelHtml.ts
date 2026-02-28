/**
 * queuePanelHtml.ts — Pure HTML generation for the Queue webview.
 *
 * No VSCode imports. Receives typed proposal data and returns
 * complete HTML document strings with inline CSS only.
 */

/**
 * Minimal proposal shape consumed by the HTML renderer.
 *
 * We define a local interface rather than importing the Zod-inferred
 * QueueProposal because the hook produces a subset of the full schema
 * and we must render both gracefully.
 */
interface ProposalView {
  proposal_id: string;
  agent_id: string;
  path: string;
  semantic_scope?: string;
  status: string;
  submitted_at?: string;
  out_of_scope?: boolean;
  cross_scope_flag?: boolean;
  change_type?: string;
  blocking_reasons?: string[];
  risk_signals?: {
    touched_auth_or_permission_patterns?: boolean;
    public_api_signature_changed?: boolean;
    invariant_referenced_file_modified?: boolean;
    high_fan_in_module_modified?: boolean;
    ast_change_type?: string;
    mechanical_only?: boolean;
  };
  classification_verification?: {
    stage1_override?: boolean;
  };
  dependency_scan?: {
    undeclared_imports?: string[];
    stale_declared_deps?: string[];
    cross_scope_undeclared?: string[];
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cardBorder(p: ProposalView): string {
  const blocking = p.blocking_reasons && p.blocking_reasons.length > 0;
  if (blocking) return "border-left: 4px solid #e04040;";
  if (p.out_of_scope) return "border-left: 4px solid #f0c040;";
  if (p.status === "approved") return "border-left: 4px solid #40a040;";
  if (p.status === "rejected") return "border-left: 4px solid #888; opacity: 0.55;";
  return "border-left: 4px solid #555;";
}

function statusBadge(p: ProposalView): string {
  const labels: string[] = [];
  if (p.blocking_reasons && p.blocking_reasons.length > 0) {
    labels.push('<span style="background:#e04040;color:#fff;padding:2px 6px;border-radius:3px;font-size:0.8em;margin-right:4px;">BLOCKED</span>');
  }
  if (p.out_of_scope) {
    labels.push('<span style="background:#f0c040;color:#333;padding:2px 6px;border-radius:3px;font-size:0.8em;margin-right:4px;">OUT OF SCOPE</span>');
  }
  return labels.join("");
}

function riskSignalPills(rs: ProposalView["risk_signals"]): string {
  if (!rs) return "";
  const active: string[] = [];
  if (rs.touched_auth_or_permission_patterns)
    active.push("auth_pattern");
  if (rs.public_api_signature_changed)
    active.push("public_api_changed");
  if (rs.invariant_referenced_file_modified)
    active.push("invariant_ref");
  if (rs.high_fan_in_module_modified)
    active.push("high_fan_in");
  if (rs.mechanical_only)
    active.push("mechanical_only");
  if (active.length === 0) return "";
  const pills = active
    .map(
      (s) =>
        `<span style="display:inline-block;background:#3a3d41;color:#ccc;padding:1px 6px;border-radius:3px;font-size:0.75em;margin:1px 2px;">${escapeHtml(s)}</span>`,
    )
    .join("");
  return `<div style="margin-top:6px;">${pills}</div>`;
}

function changeTypeNote(p: ProposalView): string {
  const ct = p.risk_signals?.ast_change_type ?? p.change_type ?? "—";
  const override = p.classification_verification?.stage1_override;
  const overrideNote = override
    ? ' <span title="Overridden by AST analysis" style="cursor:help;">⚡ overridden by AST</span>'
    : "";
  return `${escapeHtml(ct)}${overrideNote}`;
}

function renderCard(p: ProposalView): string {
  const border = cardBorder(p);
  const badges = statusBadge(p);
  const pills = riskSignalPills(p.risk_signals);
  const ct = changeTypeNote(p);

  return `
    <div style="${border} background:#1e1e1e; padding:12px 16px; margin:8px 0; border-radius:4px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="color:#4fc1ff;">${escapeHtml(p.proposal_id)}</strong>
        <span style="font-size:0.85em;color:#999;">${escapeHtml(p.status)}</span>
      </div>
      ${badges ? `<div style="margin-top:4px;">${badges}</div>` : ""}
      <table style="margin-top:8px;font-size:0.9em;color:#ccc;border-collapse:collapse;">
        <tr><td style="padding:2px 10px 2px 0;color:#888;">agent</td><td>${escapeHtml(p.agent_id)}</td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#888;">path</td><td>${escapeHtml(p.path)}</td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#888;">change_type</td><td>${ct}</td></tr>
      </table>
      ${pills}
    </div>`;
}

/**
 * Generate a full HTML document for the Queue webview panel.
 */
export function generateQueueHtml(proposals: ProposalView[]): string {
  if (proposals.length === 0) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>body{margin:0;padding:40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1e1e1e;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:60vh;}</style>
</head>
<body>
  <div style="text-align:center;opacity:0.6;">
    <p style="font-size:1.2em;">Queue is empty. No pending proposals.</p>
  </div>
</body>
</html>`;
  }

  const cards = proposals.map(renderCard).join("\n");
  const pending = proposals.filter((p) => p.status === "pending").length;
  const total = proposals.length;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  body { margin:0; padding:16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#1e1e1e; color:#ccc; }
  h2 { margin:0 0 12px; color:#e0e0e0; font-weight:500; }
</style>
</head>
<body>
  <h2>SKL Queue — ${pending} pending / ${total} total</h2>
  ${cards}
</body>
</html>`;
}

/**
 * Count proposals with status === "pending".
 */
export function generateProposalCount(proposals: ProposalView[]): number {
  return proposals.filter((p) => p.status === "pending").length;
}
