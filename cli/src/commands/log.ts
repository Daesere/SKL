import { findRepoRoot, readSKLFile, sklExists } from '../lib/reader.js';
import { c } from '../lib/colours.js';

interface ProposalEntry {
  agent_id?: string;
  path?: string;
  change_type?: string;
  semantic_scope?: string;
  status?: string;
  submitted_at?: string;
  risk_signals?: {
    touched_auth_or_permission_patterns?: boolean;
    public_api_signature_changed?: boolean;
    invariant_referenced_file_modified?: boolean;
    high_fan_in_module_modified?: boolean;
    mechanical_only?: boolean;
  };
  agent_reasoning_summary?: string;
}

interface KnowledgeFile {
  queue?: ProposalEntry[];
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

function changeTypeLabel(ct: string): string {
  switch (ct) {
    case 'mechanical':    return 'Mechanical change (comments, formatting)';
    case 'behavioral':    return 'Behavioral change';
    case 'architectural': return 'Architectural change';
    default:              return ct;
  }
}

function riskSignalLabels(rs: ProposalEntry['risk_signals']): string[] {
  if (!rs) return [];
  const labels: string[] = [];
  if (rs.touched_auth_or_permission_patterns) labels.push('Touches security-sensitive code');
  if (rs.public_api_signature_changed)        labels.push('Public API signature changed');
  if (rs.invariant_referenced_file_modified)  labels.push('Modifies a file tied to a system invariant');
  if (rs.high_fan_in_module_modified)         labels.push('Many modules depend on this file');
  if (rs.mechanical_only)                     labels.push('AST confirms mechanical-only change');
  return labels;
}

function statusColour(status: string): string {
  switch (status) {
    case 'approved':  return c.green  + status + c.reset;
    case 'rejected':  return c.red    + status + c.reset;
    case 'rfc':       return c.yellow + status + c.reset;
    case 'escalated': return c.red    + status + c.reset;
    default:          return c.grey   + status + c.reset;
  }
}

export function logCommand(args: string[]): void {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error('Error: not inside a git repository.');
    process.exit(1);
  }
  if (!sklExists(repoRoot)) {
    console.log("SKL is not initialised in this repo. Run 'skl init' to get started.");
    process.exit(1);
  }
  const knowledge = readSKLFile<KnowledgeFile>(repoRoot, 'knowledge.json');
  if (!knowledge) {
    console.error('Error: .skl/knowledge.json is missing or unreadable.');
    process.exit(1);
  }

  // Parse flags manually
  let agentFilter: string | null = null;
  let scopeFilter: string | null = null;
  let limit = 20;
  let pendingOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      agentFilter = args[++i];
    } else if (args[i] === '--scope' && args[i + 1]) {
      scopeFilter = args[++i];
    } else if (args[i] === '--limit' && args[i + 1]) {
      const parsed = parseInt(args[++i], 10);
      if (!isNaN(parsed)) limit = parsed;
    } else if (args[i] === '--pending') {
      pendingOnly = true;
    }
  }

  const queue = knowledge.queue ?? [];

  // Sort most recent first
  let proposals = [...queue].sort((a, b) => {
    const ta = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
    const tb = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
    return tb - ta;
  });

  // Apply filters
  if (agentFilter) proposals = proposals.filter((p) => p.agent_id === agentFilter);
  if (scopeFilter) proposals = proposals.filter((p) => p.semantic_scope === scopeFilter);
  if (pendingOnly) proposals = proposals.filter((p) => p.status === 'pending');

  const total = proposals.length;
  proposals = proposals.slice(0, limit);

  console.log(c.bold + 'SKL activity log' + c.reset);

  const filters: string[] = [];
  if (agentFilter) filters.push(`agent=${agentFilter}`);
  if (scopeFilter) filters.push(`scope=${scopeFilter}`);
  if (pendingOnly) filters.push('pending only');
  if (filters.length > 0) {
    console.log(`Filtered: ${filters.join(', ')}`);
  }
  console.log('');

  if (proposals.length === 0) {
    console.log(c.grey + 'No activity found.' + c.reset);
    return;
  }

  for (const p of proposals) {
    const dateStr = p.submitted_at ? formatDate(p.submitted_at) : '?';
    console.log(`[${dateStr}]  ${p.agent_id ?? 'unknown'}`);
    console.log(`  ${p.path ?? ''}  ·  ${changeTypeLabel(p.change_type ?? '')}  ·  ${statusColour(p.status ?? 'pending')}`);

    const signals = riskSignalLabels(p.risk_signals);
    if (signals.length > 0) {
      console.log(`  ${signals.join(', ')}`);
    }
    if (p.agent_reasoning_summary && p.agent_reasoning_summary.trim()) {
      const truncated = p.agent_reasoning_summary.length > 80
        ? p.agent_reasoning_summary.slice(0, 77) + '...'
        : p.agent_reasoning_summary;
      console.log(`  ${c.dim}${truncated}${c.reset}`);
    }
    console.log('');
  }

  console.log(c.dim + c.grey + `Showing ${proposals.length} of ${total} proposals.` + c.reset);
}

