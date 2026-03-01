import * as fs from 'fs';
import * as path from 'path';
import { findRepoRoot, readSKLFile } from '../lib/reader.js';
import { c } from '../lib/colours.js';

interface HookConfig {
  skl_mode?: string;
  [key: string]: unknown;
}

export function upgradeCommand(): void {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error('Error: not inside a git repository.');
    process.exit(1);
  }

  const hookConfig = readSKLFile<HookConfig>(repoRoot, 'hook_config.json');
  if (!hookConfig) {
    console.error('Error: .skl/hook_config.json is missing or unreadable.');
    process.exit(1);
  }

  if (hookConfig.skl_mode === 'full') {
    console.log('Already running full SKL.');
    return;
  }

  const scopeDefsPath = path.join(repoRoot, '.skl', 'scope_definitions.json');
  if (!fs.existsSync(scopeDefsPath)) {
    console.log(
      "Scope definitions are required for full SKL.\n" +
      "Run 'SKL: Generate Scope Definitions' in VS Code first, then run 'skl upgrade' again.",
    );
    return;
  }

  const updated: HookConfig = { ...hookConfig, skl_mode: 'full' };
  const configPath = path.join(repoRoot, '.skl', 'hook_config.json');
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8');

  console.log(
    c.green + '✓ SKL upgraded to full mode. Scope enforcement, RFCs, and the Orchestrator are now active.' + c.reset,
  );
}
