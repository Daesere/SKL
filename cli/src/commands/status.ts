import * as path from 'path';
import { findRepoRoot, readSKLFile, sklExists } from '../lib/reader.js';
import { c } from '../lib/colours.js';

interface KnowledgeFile {
  queue?: ProposalEntry[];
  state?: StateEntry[];
}

interface ProposalEntry {
  agent_id?: string;
  path?: string;
  change_type?: string;
  status?: string;
  submitted_at?: string;
}

interface StateEntry {
  id: string;
}

interface HookConfig {
  skl_mode?: string;
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const deltaS = Math.floor((now - then) / 1000);
  if (deltaS < 60) return 'just now';
  const deltaM = Math.floor(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.floor(deltaM / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  const d = new Date(isoString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function statusColour(status: string): string {
  switch (status) {
    case 'approved':  return c.green + status.padEnd(10) + c.reset;
    case 'rejected':  return c.red   + status.padEnd(10) + c.reset;
    case 'rfc':       return c.yellow + status.padEnd(10) + c.reset;
    case 'escalated': return c.red   + status.padEnd(10) + c.reset;
    default:          return c.grey  + status.padEnd(10) + c.reset;
  }
}

function changeTypeShort(ct: string): string {
  switch (ct) {
    case 'mechanical':    return 'mechanical';
    case 'behavioral':    return 'behavioral';
    case 'architectural': return 'architectural';
    default:              return ct;
  }
}

export function statusCommand(): void {
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

  const hookConfig = readSKLFile<HookConfig>(repoRoot, 'hook_config.json');
  const sklMode = hookConfig?.skl_mode ?? 'full';
  const sklModeLabel = sklMode === 'phase_0' ? 'Phase 0' : 'Full SKL';

  const queue = knowledge.queue ?? [];
  const state = knowledge.state ?? [];
  const pending = queue.filter((p) => p.status === 'pending');
  const repoName = path.basename(repoRoot);

  console.log(c.bold + `SKL status — ${repoName}  (${sklMode})` + c.reset);
  console.log('');
  console.log(`Queue:    ${pending.length} pending proposals`);
  console.log(`State:    ${state.length} tracked modules`);
  console.log(`Mode:     ${sklModeLabel}`);

  if (queue.length > 0) {
    console.log('');
    console.log('Recent activity:');

    const sorted = [...queue]
      .sort((a, b) => {
        const ta = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
        const tb = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 5);

    for (const p of sorted) {
      const agent    = (p.agent_id    ?? '').padEnd(12);
      const filePath = (p.path        ?? '').padEnd(35);
      const ct       = changeTypeShort(p.change_type ?? '').padEnd(12);
      const status   = statusColour(p.status ?? 'pending');
      const ts       = p.submitted_at ? relativeTime(p.submitted_at) : '';
      console.log(`  ${agent}  ${filePath}  ${ct}  ${status}  ${ts}`);
    }

    console.log('');
    console.log(c.dim + "Run 'skl log' for full history." + c.reset);
  }

  if (sklMode === 'phase_0') {
    console.log('');
    console.log(c.yellow + "Run 'skl upgrade' to enable full SKL governance." + c.reset);
  }
}
