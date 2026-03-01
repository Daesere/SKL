import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { findRepoRoot } from '../lib/reader.js';
import { c } from '../lib/colours.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

interface KnowledgeFile {
  invariants: {
    tech_stack: string[];
    auth_model: string;
    data_storage: string;
    security_patterns: string[];
  };
  state: unknown[];
  queue: unknown[];
}

interface HookConfig {
  skl_mode: string;
  queue_max: number;
  python_executable: string;
  post_approval_wait_seconds: number;
  uncertainty_escalate_threshold: number;
  uncertainty_block_threshold: number;
  scope_strict: boolean;
  require_test_for_level_0: boolean;
}

function detectTechStack(repoRoot: string): string {
  const pkgPath = path.join(repoRoot, 'package.json');
  const reqPath = path.join(repoRoot, 'requirements.txt');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      const deps = Object.keys(
        Object.assign({}, pkg['dependencies'] ?? {}, pkg['devDependencies'] ?? {}),
      ).join(', ');
      return deps ? `Node.js, ${deps.slice(0, 60)}` : 'Node.js';
    } catch {
      return 'Node.js';
    }
  }
  if (fs.existsSync(reqPath)) {
    return 'Python';
  }
  return '';
}

export async function initCommand(): Promise<void> {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error('Error: not inside a git repository.');
    process.exit(1);
  }

  const knowledgePath = path.join(repoRoot, '.skl', 'knowledge.json');
  if (fs.existsSync(knowledgePath)) {
    console.log('SKL already initialised. Delete .skl/ and run again to start fresh.');
    rl.close();
    return;
  }

  const detected = detectTechStack(repoRoot);
  if (detected) {
    console.log(`Detected tech stack: ${detected}`);
  }

  const techStackInput = await ask(
    `Tech stack (press Enter to accept${detected ? ` "${detected}"` : ' detected'} or type your own): `,
  );
  const techStack = techStackInput.trim() !== '' ? techStackInput.trim() : detected;

  console.log(`\nSKL Phase 0 will be initialised in ${repoRoot}.`);
  const confirm = await ask('Proceed? (y/N): ');
  if (confirm.trim().toLowerCase() !== 'y') {
    console.log('Aborted.');
    rl.close();
    return;
  }

  // Create directory structure
  const sklDir = path.join(repoRoot, '.skl');
  for (const sub of ['rfcs', 'adrs', 'scratch', 'orchestrator_log']) {
    fs.mkdirSync(path.join(sklDir, sub), { recursive: true });
  }

  // Write knowledge.json
  const knowledge: KnowledgeFile = {
    invariants: {
      tech_stack: techStack ? techStack.split(',').map((s) => s.trim()).filter(Boolean) : [],
      auth_model: '',
      data_storage: '',
      security_patterns: [],
    },
    state: [],
    queue: [],
  };
  fs.writeFileSync(knowledgePath, JSON.stringify(knowledge, null, 2), 'utf8');

  // Write hook_config.json
  const hookConfig: HookConfig = {
    skl_mode: 'phase_0',
    queue_max: 50,
    python_executable: 'python3',
    post_approval_wait_seconds: 0,
    uncertainty_escalate_threshold: 2,
    uncertainty_block_threshold: 3,
    scope_strict: false,
    require_test_for_level_0: false,
  };
  fs.writeFileSync(
    path.join(sklDir, 'hook_config.json'),
    JSON.stringify(hookConfig, null, 2),
    'utf8',
  );

  console.log(c.green + '\n✓ SKL Phase 0 initialised.' + c.reset);
  console.log('\nNext steps:');
  console.log("  1. Install the enforcement hook: run 'SKL: Install Hook' in VS Code");
  console.log('     or copy hook/pre-push.py to .git/hooks/pre-push and chmod +x it.');
  console.log("  2. Set SKL_AGENT_ID=Agent-1 in your agent's terminal.");
  console.log('  3. Push a branch to start logging activity.');

  rl.close();
}
