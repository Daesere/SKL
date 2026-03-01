import * as fs from 'fs';
import * as path from 'path';

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readSKLFile<T>(repoRoot: string, relativePath: string): T | null {
  const fullPath = path.join(repoRoot, '.skl', relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function sklExists(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, '.skl', 'knowledge.json'));
}
