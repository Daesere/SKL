import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  KnowledgeFileSchema,
  ScopeDefinitionSchema,
  RfcSchema,
  SessionLogSchema,
  AgentContextSchema,
  HookConfigSchema,
  DEFAULT_HOOK_CONFIG,
} from "../types/index.js";
import type {
  KnowledgeFile,
  ScopeDefinition,
  Rfc,
  SessionLog,
  AgentContext,
  HookConfig,
} from "../types/index.js";
import {
  SKLValidationError,
  SKLFileNotFoundError,
  SKLWriteError,
} from "../errors/index.js";

/** Directory inside the repo root that holds SKL artifacts. */
const SKL_DIR = ".skl";

/** Name of the primary knowledge store. */
const KNOWLEDGE_FILENAME = "knowledge.json";

/** Name of the hook configuration file. */
const HOOK_CONFIG_FILENAME = "hook_config.json";

/** Name of the scope definitions file. */
const SCOPE_DEFS_FILENAME = "scope_definitions.json";

/** Name of the proposed scope definitions file (Human Review Gate). */
const SCOPE_DEFS_PROPOSED_FILENAME = "scope_definitions.proposed.json";

/** Subdirectories that form the SKL structure. */
const SKL_SUBDIRS = ["rfcs", "adrs", "orchestrator_log", "scratch"] as const;

// ── Directory-tree scanning constants ──────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".skl",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "coverage",
  ".next",
  ".nuxt",
]);

const IGNORE_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

const MAX_TREE_DEPTH = 6;

// ── Helpers ────────────────────────────────────────────────────────

/** Return true when an `fs` error has code === `code`. */
function isFsError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === code
  );
}

/**
 * Read a JSON file, throwing `SKLFileNotFoundError` when absent.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isFsError(err, "ENOENT")) {
      throw new SKLFileNotFoundError(filePath);
    }
    throw err;
  }
  return JSON.parse(raw) as unknown;
}

/**
 * Atomic write: data → tmp → rename.
 * Ensures the parent directory exists before writing.
 */
async function atomicWrite(
  targetPath: string,
  data: string,
): Promise<void> {
  const tmpPath = targetPath + ".tmp";
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(tmpPath, data, "utf-8");
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file on failure
    await fs.unlink(tmpPath).catch(() => {});
    throw new SKLWriteError(targetPath, err);
  }
}

/**
 * SKLFileSystem
 *
 * Encapsulates all file-system access for the SKL knowledge store.
 *
 * Design invariants:
 *   - Reads are always Zod-validated before returning.
 *   - Writes use the atomic temp-and-rename pattern to prevent partial writes.
 *   - The repo root is located by walking up until `.git` is found.
 */
export class SKLFileSystem {
  private readonly _repoRoot: string;

  /** Resolved path to the repo root (directory containing `.git`). */
  public get repoRoot(): string {
    return this._repoRoot;
  }

  /** Resolved path to the .skl directory. */
  public readonly sklDir: string;

  /** Resolved path to knowledge.json. */
  public readonly knowledgePath: string;

  // ── Event emitter ──────────────────────────────────────────────

  private readonly _onKnowledgeChanged =
    new vscode.EventEmitter<KnowledgeFile>();

  /**
   * Fires after every successful `writeKnowledge()` with the written data.
   * Subscribe: `skl.onKnowledgeChanged(data => { ... })`.
   */
  public readonly onKnowledgeChanged: vscode.Event<KnowledgeFile> =
    this._onKnowledgeChanged.event;

  private constructor(repoRoot: string) {
    this._repoRoot = repoRoot;
    this.sklDir = path.join(repoRoot, SKL_DIR);
    this.knowledgePath = path.join(this.sklDir, KNOWLEDGE_FILENAME);
  }

  // ── Factory ──────────────────────────────────────────────────────

  /**
   * Create an SKLFileSystem rooted at the repo that contains `startDir`.
   *
   * Walks up the directory tree from `startDir` until it finds a `.git`
   * directory. Throws if none is found (i.e. not inside a Git repository).
   */
  static async create(startDir?: string): Promise<SKLFileSystem> {
    const root = await SKLFileSystem.findRepoRoot(
      startDir ?? process.cwd(),
    );
    return new SKLFileSystem(root);
  }

  // ── Knowledge (read / write) ─────────────────────────────────────

  /**
   * Read and validate knowledge.json from disk.
   *
   * @throws SKLFileNotFoundError — file absent
   * @throws SKLValidationError   — JSON present but fails Zod
   */
  async readKnowledge(): Promise<KnowledgeFile> {
    const json = await readJsonFile(this.knowledgePath);
    const result = KnowledgeFileSchema.safeParse(json);

    if (!result.success) {
      throw new SKLValidationError(this.knowledgePath, result.error);
    }

    return result.data;
  }

  /**
   * Atomically write a KnowledgeFile to disk, then fire `onKnowledgeChanged`.
   *
   * @throws SKLValidationError — payload fails pre-write Zod check
   * @throws SKLWriteError      — I/O failure during write
   */
  async writeKnowledge(data: KnowledgeFile): Promise<void> {
    const result = KnowledgeFileSchema.safeParse(data);
    if (!result.success) {
      throw new SKLValidationError(this.knowledgePath, result.error);
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    await fs.mkdir(this.sklDir, { recursive: true });
    await atomicWrite(this.knowledgePath, serialized);

    this._onKnowledgeChanged.fire(result.data);
  }

  // ── Scope Definitions (read / write) ─────────────────────────────

  /** Resolved path to scope_definitions.json. */
  get scopeDefinitionsPath(): string {
    return path.join(this.sklDir, SCOPE_DEFS_FILENAME);
  }

  /**
   * Read and validate .skl/scope_definitions.json.
   *
   * @throws SKLFileNotFoundError — file absent
   * @throws SKLValidationError   — JSON present but fails Zod
   */
  async readScopeDefinitions(): Promise<ScopeDefinition> {
    const filePath = this.scopeDefinitionsPath;
    const json = await readJsonFile(filePath);
    const result = ScopeDefinitionSchema.safeParse(json);

    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    return result.data;
  }

  /**
   * Atomically write scope definitions to disk.
   *
   * @throws SKLValidationError — payload fails pre-write Zod check
   * @throws SKLWriteError      — I/O failure
   */
  async writeScopeDefinitions(data: ScopeDefinition): Promise<void> {
    const filePath = this.scopeDefinitionsPath;
    const result = ScopeDefinitionSchema.safeParse(data);
    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    await atomicWrite(filePath, serialized);
  }

  // ── Proposed Scope Definitions (Human Review Gate) ───────────────

  /** Resolved path to scope_definitions.proposed.json. */
  get proposedScopeDefinitionsPath(): string {
    return path.join(this.sklDir, SCOPE_DEFS_PROPOSED_FILENAME);
  }

  /**
   * Write the proposed scope definitions file for human review.
   * This does NOT validate against the schema — the reviewer is
   * expected to fix issues in the diff editor before confirming.
   */
  async writeProposedScopeDefinitions(content: string): Promise<void> {
    await fs.mkdir(this.sklDir, { recursive: true });
    await fs.writeFile(this.proposedScopeDefinitionsPath, content, "utf-8");
  }

  /**
   * Read the proposed scope definitions file as raw text.
   *
   * @throws SKLFileNotFoundError — file absent
   */
  async readProposedScopeDefinitions(): Promise<string> {
    try {
      return await fs.readFile(this.proposedScopeDefinitionsPath, "utf-8");
    } catch (err) {
      if (isFsError(err, "ENOENT")) {
        throw new SKLFileNotFoundError(this.proposedScopeDefinitionsPath);
      }
      throw err;
    }
  }

  /**
   * Confirm proposed scope definitions: atomically move
   * proposed → actual, then delete the proposed file.
   *
   * @param content — final content to commit (may have been edited
   *                  in the diff editor)
   */
  async commitProposedScopeDefinitions(content: string): Promise<void> {
    await atomicWrite(this.scopeDefinitionsPath, content);
    await fs.unlink(this.proposedScopeDefinitionsPath).catch(() => {});
  }

  /**
   * Reject proposed scope definitions: delete the proposed file and
   * clean up an empty placeholder if one was created for the diff.
   */
  async rejectProposedScopeDefinitions(): Promise<void> {
    await fs.unlink(this.proposedScopeDefinitionsPath).catch(() => {});

    // Remove empty placeholder left by openHumanReviewGate
    try {
      const content = await fs.readFile(this.scopeDefinitionsPath, "utf-8");
      if (content.trim() === "{}") {
        await fs.unlink(this.scopeDefinitionsPath).catch(() => {});
      }
    } catch {
      // nothing to remove
    }
  }

  /**
   * Ensure the scope definitions file exists (creates a `{}` placeholder
   * if absent). Used to provide a left-hand side for the diff editor.
   */
  async ensureScopeDefinitionsPlaceholder(): Promise<void> {
    await fs.mkdir(this.sklDir, { recursive: true });
    try {
      await fs.stat(this.scopeDefinitionsPath);
    } catch {
      await fs.writeFile(this.scopeDefinitionsPath, "{}\n", "utf-8");
    }
  }

  // ── Directory tree scanning ──────────────────────────────────────

  /**
   * Build a text representation of the directory tree rooted at `dir`.
   * Used by the LLM prompt builder. Respects standard ignore patterns
   * and caps depth at 6 levels.
   */
  async buildDirectoryTree(
    dir: string,
    prefix = "",
    depth = 0,
  ): Promise<string> {
    if (depth >= MAX_TREE_DEPTH) return `${prefix}└── …`;

    let raw: import("node:fs").Dirent[];
    try {
      raw = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return "";
    }

    const entries = raw.map((e) => ({
      name: String(e.name),
      isDir: e.isDirectory(),
    }));

    const filtered = entries
      .filter((e) => !IGNORE_DIRS.has(e.name) && !IGNORE_FILES.has(e.name))
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });

    const lines: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDir) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        const subtree = await this.buildDirectoryTree(
          path.join(dir, entry.name),
          prefix + childPrefix,
          depth + 1,
        );
        if (subtree) lines.push(subtree);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
    return lines.join("\n");
  }

  // ── SKL structure ────────────────────────────────────────────────

  /**
   * Ensure .skl/ and its required subdirectories exist.
   * Places a `.gitkeep` in each subdirectory. Never overwrites existing files.
   */
  async ensureSKLStructure(): Promise<void> {
    for (const sub of SKL_SUBDIRS) {
      const dirPath = path.join(this.sklDir, sub);
      await fs.mkdir(dirPath, { recursive: true });

      const gitkeep = path.join(dirPath, ".gitkeep");
      try {
        // wx = create exclusive — fail silently if file already exists
        await fs.writeFile(gitkeep, "", { flag: "wx" });
      } catch (err) {
        if (!isFsError(err, "EEXIST")) throw err;
      }
    }
  }

  // ── Repo file existence ──────────────────────────────────────────

  /**
   * Check whether a relative path exists inside the repository.
   * Used by the diagnostics provider for stale whitelist detection.
   */
  async fileExistsInRepo(relativePath: string): Promise<boolean> {
    try {
      await fs.stat(path.join(this._repoRoot, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  // ── RFCs (read / write / list) ───────────────────────────────────

  /** Resolved path to the rfcs directory. */
  private get rfcsDir(): string {
    return path.join(this.sklDir, "rfcs");
  }

  /** Resolved path to a specific RFC file. */
  private rfcPath(id: string): string {
    return path.join(this.rfcsDir, `${id}.json`);
  }

  /**
   * Read and validate a single RFC by ID.
   *
   * @throws SKLFileNotFoundError — RFC file absent
   * @throws SKLValidationError   — JSON present but fails Zod
   */
  async readRFC(id: string): Promise<Rfc> {
    const filePath = this.rfcPath(id);
    const json = await readJsonFile(filePath);
    const result = RfcSchema.safeParse(json);

    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    return result.data;
  }

  /**
   * Atomically write an RFC to .skl/rfcs/{rfc.id}.json.
   *
   * @throws SKLValidationError — payload fails pre-write Zod check
   * @throws SKLWriteError      — I/O failure
   */
  async writeRFC(rfc: Rfc): Promise<void> {
    const filePath = this.rfcPath(rfc.id);
    const result = RfcSchema.safeParse(rfc);
    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    await atomicWrite(filePath, serialized);
  }

  /**
   * List all RFC IDs (filenames without .json) sorted alphabetically.
   * Returns an empty array when the rfcs/ directory is empty or absent.
   */
  async listRFCs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rfcsDir);
    } catch (err) {
      if (isFsError(err, "ENOENT")) return [];
      throw err;
    }

    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  }

  // ── Session Logs (read all / write) ──────────────────────────────

  /** Resolved path to the orchestrator_log directory. */
  private get logDir(): string {
    return path.join(this.sklDir, "orchestrator_log");
  }

  /**
   * Read all session log files, Zod-validate each, and return
   * the array sorted by `session_id` ascending.
   *
   * Invalid files are skipped with a console warning rather than
   * blocking all reads.
   */
  async readSessionLogs(): Promise<SessionLog[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.logDir);
    } catch (err) {
      if (isFsError(err, "ENOENT")) return [];
      throw err;
    }

    const jsonFiles = entries
      .filter((f) => f.endsWith(".json"))
      .sort();

    const logs: SessionLog[] = [];
    for (const file of jsonFiles) {
      const filePath = path.join(this.logDir, file);
      const json = await readJsonFile(filePath);
      const result = SessionLogSchema.safeParse(json);
      if (result.success) {
        logs.push(result.data);
      } else {
        console.warn(
          `SKLFileSystem: skipping invalid session log ${filePath}`,
        );
      }
    }

    return logs.sort((a, b) =>
      a.session_id.localeCompare(b.session_id),
    );
  }

  /**
   * Atomically write a session log to
   * .skl/orchestrator_log/{log.session_id}.json.
   *
   * @throws SKLValidationError — payload fails pre-write Zod check
   * @throws SKLWriteError      — I/O failure
   */
  async writeSessionLog(log: SessionLog): Promise<void> {
    const filePath = path.join(this.logDir, `${log.session_id}.json`);
    const result = SessionLogSchema.safeParse(log);
    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    await atomicWrite(filePath, serialized);
  }

  /**
   * Return the most recent session log by `session_id` (alphabetic
   * sort works because IDs are zero-padded).
   *
   * Returns `null` without throwing when the directory is empty or
   * contains no valid session logs.
   */
  async readMostRecentSessionLog(): Promise<SessionLog | null> {
    const logs = await this.readSessionLogs();
    if (logs.length === 0) return null;
    return logs[logs.length - 1]!;
  }

  /**
   * Derive the next `session_NNN` ID by counting existing log files.
   *
   * 0 existing → `"session_001"`, 2 existing → `"session_003"`, etc.
   */
  async getNextSessionId(): Promise<string> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.logDir);
    } catch (err) {
      if (isFsError(err, "ENOENT")) entries = [];
      else throw err;
    }

    const count = entries.filter((f) => f.endsWith(".json")).length;
    return `session_${String(count + 1).padStart(3, "0")}`;
  }

  // ── Agent Context (read / write) ─────────────────────────────────

  /** Resolved path to a specific agent context file. */
  private agentContextPath(agentId: string): string {
    return path.join(this.sklDir, "scratch", `${agentId}_context.json`);
  }

  /**
   * Read and validate .skl/scratch/{agentId}_context.json.
   *
   * @throws SKLFileNotFoundError — file absent
   * @throws SKLValidationError   — JSON present but fails Zod
   */
  async readAgentContext(agentId: string): Promise<AgentContext> {
    const filePath = this.agentContextPath(agentId);
    const json = await readJsonFile(filePath);
    const result = AgentContextSchema.safeParse(json);

    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    return result.data;
  }

  /**
   * Atomically write an agent context to
   * .skl/scratch/{ctx.agent_id}_context.json.
   *
   * @throws SKLValidationError — payload fails pre-write Zod check
   * @throws SKLWriteError      — I/O failure
   */
  async writeAgentContext(ctx: AgentContext): Promise<void> {
    const filePath = this.agentContextPath(ctx.agent_id);
    const result = AgentContextSchema.safeParse(ctx);
    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    await atomicWrite(filePath, serialized);
  }

  // ── Hook Config (read / write) ───────────────────────────────────

  /** Resolved path to hook_config.json. */
  private get hookConfigPath(): string {
    return path.join(this.sklDir, HOOK_CONFIG_FILENAME);
  }

  /**
   * Read and validate .skl/hook_config.json.
   *
   * If the file is absent, returns `DEFAULT_HOOK_CONFIG` without
   * throwing — absence is expected on fresh repos.
   *
   * @throws SKLValidationError — JSON present but fails Zod
   */
  async readHookConfig(): Promise<HookConfig> {
    let json: unknown;
    try {
      json = await readJsonFile(this.hookConfigPath);
    } catch (err) {
      if (err instanceof SKLFileNotFoundError) {
        return DEFAULT_HOOK_CONFIG;
      }
      throw err;
    }

    const result = HookConfigSchema.safeParse(json);
    if (!result.success) {
      throw new SKLValidationError(this.hookConfigPath, result.error);
    }

    return result.data;
  }

  /**
   * Atomically write hook configuration to .skl/hook_config.json.
   *
   * @throws SKLValidationError — payload fails pre-write Zod check
   * @throws SKLWriteError      — I/O failure
   */
  async writeHookConfig(config: HookConfig): Promise<void> {
    const filePath = this.hookConfigPath;
    const result = HookConfigSchema.safeParse(config);
    if (!result.success) {
      throw new SKLValidationError(filePath, result.error);
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    await atomicWrite(filePath, serialized);
  }

  // ── Repo root discovery ──────────────────────────────────────────

  /**
   * Walk up the directory tree from `startDir` looking for `.git`.
   *
   * Returns the directory that contains `.git`.
   * Throws if the filesystem root is reached without finding one.
   */
  static async findRepoRoot(startDir: string): Promise<string> {
    let current = path.resolve(startDir);

    while (true) {
      const gitDir = path.join(current, ".git");

      try {
        const stat = await fs.stat(gitDir);
        if (stat.isDirectory()) {
          return current;
        }
      } catch {
        // .git not found here — keep walking up.
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(
          `findRepoRoot: no .git directory found in any parent of "${startDir}"`,
        );
      }
      current = parent;
    }
  }

  // ── Dispose ──────────────────────────────────────────────────────

  /** Clean up the event emitter. Call when the extension deactivates. */
  dispose(): void {
    this._onKnowledgeChanged.dispose();
  }
}
