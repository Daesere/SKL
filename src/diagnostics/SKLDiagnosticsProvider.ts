import * as vscode from "vscode";
import { SKLFileSystem } from "../services/index.js";
import { SKLFileNotFoundError } from "../errors/index.js";
import { KnowledgeFileSchema } from "../types/index.js";
import type { KnowledgeFile, ScopeDefinition } from "../types/index.js";

// ── Configurable constants ─────────────────────────────────────────

/**
 * Number of changes since last review before an informational
 * diagnostic is raised. Adjust as project conventions evolve.
 */
const REVIEW_THRESHOLD = 5;

// ── Helper: full-file diagnostic range ─────────────────────────────

/** A zero-width range at the top of the file (line 0, col 0). */
const FILE_START = new vscode.Range(0, 0, 0, 0);

// ── Provider ───────────────────────────────────────────────────────

/**
 * SKLDiagnosticsProvider
 *
 * Runs structural and semantic checks against .skl/knowledge.json and
 * .skl/scope_definitions.json, publishing results to the VS Code
 * Problems panel via a `DiagnosticCollection`.
 *
 * Each check is a private method returning `vscode.Diagnostic[]` so
 * it can be tested independently.
 */
export class SKLDiagnosticsProvider {
  private readonly skl: SKLFileSystem;
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(skl: SKLFileSystem) {
    this.skl = skl;
    this.collection = vscode.languages.createDiagnosticCollection("skl");

    // ── File watchers ────────────────────────────────────────────
    const knowledgeWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.skl/knowledge.json",
    );
    const scopeWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.skl/scope_definitions.json",
    );

    knowledgeWatcher.onDidChange(() => void this.validate());
    knowledgeWatcher.onDidCreate(() => void this.validate());
    knowledgeWatcher.onDidDelete(() => void this.validate());

    scopeWatcher.onDidChange(() => void this.validate());
    scopeWatcher.onDidCreate(() => void this.validate());
    scopeWatcher.onDidDelete(() => void this.validate());

    this.disposables.push(knowledgeWatcher, scopeWatcher);
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Run every diagnostic check and publish the collected diagnostics
   * to the VS Code Problems panel.
   */
  async validate(): Promise<void> {
    this.collection.clear();

    const knowledgeUri = vscode.Uri.file(this.skl.knowledgePath);
    const scopeUri = vscode.Uri.file(this.skl.scopeDefinitionsPath);

    // Accumulate diagnostics per file URI.
    const knowledgeDiags: vscode.Diagnostic[] = [];
    const scopeDiags: vscode.Diagnostic[] = [];

    // 1. Schema validation — if this fails, most other checks
    //    cannot run because we don't have valid data.
    const schemaResult = await this.checkKnowledgeSchema();
    if (schemaResult.error) {
      knowledgeDiags.push(...schemaResult.diagnostics);
      this.collection.set(knowledgeUri, knowledgeDiags);
      return; // remaining checks need parsed data
    }
    const knowledge = schemaResult.data;

    // 2. Try loading scope definitions (optional)
    const scopeResult = await this.loadScopeDefinitions();
    if (scopeResult.infoDiag) {
      knowledgeDiags.push(scopeResult.infoDiag);
    }
    const scopeDefs = scopeResult.data;

    // 3. Run remaining checks
    if (scopeDefs) {
      knowledgeDiags.push(
        ...this.checkScopeReferences(knowledge, scopeDefs),
      );
      knowledgeDiags.push(
        ...this.checkSchemaVersions(knowledge, scopeDefs),
      );
      scopeDiags.push(
        ...this.checkScopeDefinitionOverlap(scopeDefs),
      );
    }

    knowledgeDiags.push(...this.checkUncertaintyLevels(knowledge));
    knowledgeDiags.push(...this.checkInvariantReferences(knowledge));
    knowledgeDiags.push(
      ...await this.checkStaleWhitelist(knowledge),
    );
    knowledgeDiags.push(...this.checkReviewThreshold(knowledge));

    // Publish
    if (knowledgeDiags.length > 0) {
      this.collection.set(knowledgeUri, knowledgeDiags);
    }
    if (scopeDiags.length > 0) {
      this.collection.set(scopeUri, scopeDiags);
    }
  }

  /** Clear and dispose the diagnostic collection and watchers. */
  dispose(): void {
    this.collection.clear();
    this.collection.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // ── Private checks ──────────────────────────────────────────────

  /**
   * Check 1: Zod-parse knowledge.json.
   * Returns the parsed data on success, or diagnostics on failure.
   */
  private async checkKnowledgeSchema(): Promise<
    | { error: false; data: KnowledgeFile; diagnostics: never[] }
    | { error: true; data: null; diagnostics: vscode.Diagnostic[] }
  > {
    let raw: unknown;
    try {
      // Use raw JSON read — we want Zod errors, not SKLValidationError.
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(this.skl.knowledgePath),
      );
      raw = JSON.parse(doc.getText());
    } catch (err) {
      if (err instanceof SKLFileNotFoundError || isFileNotFound(err)) {
        return {
          error: true,
          data: null,
          diagnostics: [
            new vscode.Diagnostic(
              FILE_START,
              "knowledge.json not found. Run 'SKL: Initialize Project' to create it.",
              vscode.DiagnosticSeverity.Error,
            ),
          ],
        };
      }
      return {
        error: true,
        data: null,
        diagnostics: [
          new vscode.Diagnostic(
            FILE_START,
            `knowledge.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
            vscode.DiagnosticSeverity.Error,
          ),
        ],
      };
    }

    const result = KnowledgeFileSchema.safeParse(raw);
    if (!result.success) {
      const diags = result.error.issues.map(
        (issue) =>
          new vscode.Diagnostic(
            FILE_START,
            `[${issue.path.join(".")}] ${issue.message}`,
            vscode.DiagnosticSeverity.Error,
          ),
      );
      return { error: true, data: null, diagnostics: diags };
    }

    return { error: false, data: result.data, diagnostics: [] };
  }

  /**
   * Try to load and validate scope_definitions.json.
   * Returns the parsed data if available, or an Info diagnostic
   * if the file doesn't exist yet.
   */
  private async loadScopeDefinitions(): Promise<{
    data: ScopeDefinition | null;
    infoDiag: vscode.Diagnostic | null;
  }> {
    try {
      const data = await this.skl.readScopeDefinitions();
      return { data, infoDiag: null };
    } catch (err) {
      if (err instanceof SKLFileNotFoundError) {
        return {
          data: null,
          infoDiag: new vscode.Diagnostic(
            FILE_START,
            "Scope validation is pending initialization — scope_definitions.json not found.",
            vscode.DiagnosticSeverity.Information,
          ),
        };
      }
      // Validation error — schema is bad
      return {
        data: null,
        infoDiag: new vscode.Diagnostic(
          FILE_START,
          `scope_definitions.json is invalid: ${err instanceof Error ? err.message : String(err)}`,
          vscode.DiagnosticSeverity.Error,
        ),
      };
    }
  }

  /**
   * Check 2: Every State entry's `semantic_scope` must match a key
   * in scope_definitions.json.
   */
  private checkScopeReferences(
    knowledge: KnowledgeFile,
    scopeDefs: ScopeDefinition,
  ): vscode.Diagnostic[] {
    const validScopes = new Set(
      Object.keys(scopeDefs.scope_definitions.scopes),
    );
    const diags: vscode.Diagnostic[] = [];

    for (const entry of knowledge.state) {
      if (!validScopes.has(entry.semantic_scope)) {
        diags.push(
          new vscode.Diagnostic(
            FILE_START,
            `State entry '${entry.id}' references unknown scope '${entry.semantic_scope}'. ` +
              `Valid scopes: ${[...validScopes].join(", ")}.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }

    return diags;
  }

  /**
   * Check 3: Compare each State entry's `scope_schema_version`
   * against the current scope_definitions version.
   */
  private checkSchemaVersions(
    knowledge: KnowledgeFile,
    scopeDefs: ScopeDefinition,
  ): vscode.Diagnostic[] {
    const currentVersion = scopeDefs.scope_definitions.version;
    const diags: vscode.Diagnostic[] = [];

    for (const entry of knowledge.state) {
      if (entry.scope_schema_version !== currentVersion) {
        diags.push(
          new vscode.Diagnostic(
            FILE_START,
            `State entry '${entry.id}' was validated against scope schema ${entry.scope_schema_version}, ` +
              `current is ${currentVersion}. Re-review recommended.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    return diags;
  }

  /**
   * Check 4: Flag uncertainty_level outside 0–3 as Error, and level 3
   * as Warning (Contested — no automated merges permitted).
   */
  private checkUncertaintyLevels(
    knowledge: KnowledgeFile,
  ): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];

    for (const entry of knowledge.state) {
      const level = entry.uncertainty_level;
      if (level < 0 || level > 3) {
        diags.push(
          new vscode.Diagnostic(
            FILE_START,
            `State entry '${entry.id}' has invalid uncertainty_level ${level} (must be 0–3).`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      } else if (level === 3) {
        diags.push(
          new vscode.Diagnostic(
            FILE_START,
            `State entry '${entry.id}' is Contested. No automated merges permitted until resolved.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    return diags;
  }

  /**
   * Check 5: Every value in a State entry's `invariants_touched` array
   * must match a key in knowledge.json.invariants.
   */
  private checkInvariantReferences(
    knowledge: KnowledgeFile,
  ): vscode.Diagnostic[] {
    const validKeys = new Set(Object.keys(knowledge.invariants));
    const diags: vscode.Diagnostic[] = [];

    for (const entry of knowledge.state) {
      for (const key of entry.invariants_touched) {
        if (!validKeys.has(key)) {
          diags.push(
            new vscode.Diagnostic(
              FILE_START,
              `State entry '${entry.id}' references unknown invariant '${key}'. ` +
                `Valid invariants: ${[...validKeys].join(", ")}.`,
              vscode.DiagnosticSeverity.Warning,
            ),
          );
        }
      }
    }

    return diags;
  }

  /**
   * Check 6: Detect identical `allowed_path_prefixes` across different
   * scope definitions.
   */
  private checkScopeDefinitionOverlap(
    scopeDefs: ScopeDefinition,
  ): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    const scopeNames = Object.keys(scopeDefs.scope_definitions.scopes);

    for (let i = 0; i < scopeNames.length; i++) {
      const nameA = scopeNames[i];
      const prefixesA = new Set(
        scopeDefs.scope_definitions.scopes[nameA].allowed_path_prefixes,
      );

      for (let j = i + 1; j < scopeNames.length; j++) {
        const nameB = scopeNames[j];
        const prefixesB =
          scopeDefs.scope_definitions.scopes[nameB].allowed_path_prefixes;

        for (const prefix of prefixesB) {
          if (prefixesA.has(prefix)) {
            diags.push(
              new vscode.Diagnostic(
                FILE_START,
                `Scopes '${nameA}' and '${nameB}' share identical allowed_path_prefix '${prefix}'. ` +
                  `Consider making scopes mutually exclusive.`,
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
      }
    }

    return diags;
  }

  /**
   * Check 7: For each path in `known_expected_cross_scope_imports`
   * (if present on the raw knowledge data), confirm it exists in the
   * repo. Non-existent paths are Warning severity.
   *
   * Delegates file-existence checks to `SKLFileSystem.fileExists()` to
   * honour the "no direct fs access" lint rule.
   */
  private async checkStaleWhitelist(
    knowledge: KnowledgeFile,
  ): Promise<vscode.Diagnostic[]> {
    // The field may not be present in the strict schema — use runtime check.
    const raw = knowledge as Record<string, unknown>;
    const whitelist = raw["known_expected_cross_scope_imports"];
    if (!Array.isArray(whitelist) || whitelist.length === 0) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const entry of whitelist) {
      if (typeof entry !== "string") continue;
      const exists = await this.skl.fileExistsInRepo(entry);
      if (!exists) {
        diags.push(
          new vscode.Diagnostic(
            FILE_START,
            `Stale whitelist entry: '${entry}' does not exist in the repository.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    return diags;
  }

  /**
   * Check 8: Flag State entries where `change_count_since_review`
   * meets or exceeds the configurable threshold.
   */
  private checkReviewThreshold(
    knowledge: KnowledgeFile,
  ): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];

    for (const entry of knowledge.state) {
      if (entry.change_count_since_review >= REVIEW_THRESHOLD) {
        diags.push(
          new vscode.Diagnostic(
            FILE_START,
            `State entry '${entry.id}' has ${entry.change_count_since_review} changes since last review.`,
            vscode.DiagnosticSeverity.Information,
          ),
        );
      }
    }

    return diags;
  }
}

// ── Internal helper ────────────────────────────────────────────────

/** Check whether an error looks like an ENOENT / file-not-found. */
function isFileNotFound(err: unknown): boolean {
  if (err instanceof SKLFileNotFoundError) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  ) {
    return true;
  }
  // vscode.FileSystemError.FileNotFound
  if (
    err instanceof vscode.FileSystemError &&
    err.code === "FileNotFound"
  ) {
    return true;
  }
  return false;
}
