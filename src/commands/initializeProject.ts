import * as vscode from "vscode";
import { SKLFileSystem } from "../services/index.js";
import type { KnowledgeFile } from "../types/index.js";

// ── Constants ────────────────────────────────────────────────────────

const TITLE = "SKL: Initialize Project";

/**
 * QuickPickItem with a concrete `value` string and optional custom flag.
 */
interface ValueItem extends vscode.QuickPickItem {
  value: string;
  isCustom?: boolean;
}

const CUSTOM_ITEM: ValueItem = {
  label: "$(pencil) Enter custom value\u2026",
  value: "__custom__",
  isCustom: true,
  alwaysShow: true,
};

// ── Preset catalogues ────────────────────────────────────────────────

const TECH_STACK_PRESETS: ValueItem[] = [
  { label: "Python 3.11", value: "Python 3.11" },
  { label: "Python 3.12", value: "Python 3.12" },
  { label: "Node.js 20", value: "Node.js 20" },
  { label: "Node.js 22", value: "Node.js 22" },
  { label: "TypeScript 5", value: "TypeScript 5" },
  { label: "FastAPI", value: "FastAPI" },
  { label: "Express.js", value: "Express.js" },
  { label: "Django", value: "Django" },
  { label: "SQLAlchemy 2.0", value: "SQLAlchemy 2.0" },
  { label: "Prisma", value: "Prisma" },
  { label: "PostgreSQL", value: "PostgreSQL" },
  { label: "MongoDB", value: "MongoDB" },
  { label: "Redis", value: "Redis" },
];

const AUTH_MODEL_PRESETS: ValueItem[] = [
  { label: "JWT over Bearer header", value: "JWT over Bearer header" },
  { label: "Session-based (cookies)", value: "Session-based (cookies)" },
  { label: "OAuth 2.0 / OIDC", value: "OAuth 2.0 / OIDC" },
  { label: "API Key", value: "API Key" },
  { label: "mTLS (mutual TLS)", value: "mTLS (mutual TLS)" },
];

const DATA_STORAGE_PRESETS: ValueItem[] = [
  { label: "PostgreSQL only", value: "PostgreSQL only" },
  { label: "MySQL only", value: "MySQL only" },
  { label: "MongoDB only", value: "MongoDB only" },
  { label: "SQLite (development)", value: "SQLite (development)" },
];

const SECURITY_PATTERN_PRESETS: ValueItem[] = [
  { label: "@require_auth", value: "@require_auth" },
  { label: "@login_required", value: "@login_required" },
  { label: "verify_", value: "verify_" },
  { label: "check_permission", value: "check_permission" },
  { label: "is_authorized", value: "is_authorized" },
  { label: "authenticate", value: "authenticate" },
  { label: "@protected", value: "@protected" },
  { label: "requireAuth", value: "requireAuth" },
];

// ── QuickPick helpers ────────────────────────────────────────────────

/**
 * Show a `createQuickPick` step in the multi-step flow.
 *
 * Returns the selected items, or `undefined` if the user pressed Escape.
 */
function showPickStep(opts: {
  step: number;
  totalSteps: number;
  placeholder: string;
  items: ValueItem[];
  canPickMany: boolean; // maps to QuickPick.canSelectMany
}): Promise<ValueItem[] | undefined> {
  return new Promise<ValueItem[] | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<ValueItem>();
    qp.title = TITLE;
    qp.step = opts.step;
    qp.totalSteps = opts.totalSteps;
    qp.placeholder = opts.placeholder;
    qp.items = [...opts.items, CUSTOM_ITEM];
    qp.canSelectMany = opts.canPickMany;
    qp.ignoreFocusOut = true;

    let resolved = false;

    qp.onDidAccept(() => {
      if (resolved) return;
      resolved = true;
      const selected = opts.canPickMany
        ? [...qp.selectedItems]
        : qp.activeItems.length > 0
          ? [qp.activeItems[0]]
          : [];
      qp.dispose();
      resolve(selected.length > 0 ? selected : undefined);
    });

    qp.onDidHide(() => {
      if (resolved) return;
      resolved = true;
      qp.dispose();
      resolve(undefined);
    });

    qp.show();
  });
}

/**
 * Prompt for comma-separated custom values via InputBox.
 */
async function askCustomValues(prompt: string): Promise<string[] | undefined> {
  const raw = await vscode.window.showInputBox({
    title: TITLE,
    prompt,
    placeHolder: "value1, value2, value3",
    ignoreFocusOut: true,
  });
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Prompt for a single custom value via InputBox.
 */
async function askCustomValue(prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: TITLE,
    prompt,
    ignoreFocusOut: true,
  });
}

// ── Multi-select step (tech_stack, security_patterns) ────────────────

async function collectMultiValues(
  step: number,
  totalSteps: number,
  placeholder: string,
  presets: ValueItem[],
  customPrompt: string,
): Promise<string[] | undefined> {
  const picks = await showPickStep({
    step,
    totalSteps,
    placeholder,
    items: presets,
    canPickMany: true,
  });
  if (!picks) return undefined;

  const values = picks.filter((p) => !p.isCustom).map((p) => p.value);

  if (picks.some((p) => p.isCustom)) {
    const custom = await askCustomValues(customPrompt);
    if (custom === undefined) return undefined;
    values.push(...custom);
  }

  return values;
}

// ── Single-select step (auth_model, data_storage) ────────────────────

async function collectSingleValue(
  step: number,
  totalSteps: number,
  placeholder: string,
  presets: ValueItem[],
  customPrompt: string,
): Promise<string | undefined> {
  const picks = await showPickStep({
    step,
    totalSteps,
    placeholder,
    items: presets,
    canPickMany: false,
  });
  if (!picks) return undefined;

  if (picks[0].isCustom) {
    return askCustomValue(customPrompt);
  }
  return picks[0].value;
}

// ── Command entry point ──────────────────────────────────────────────

export async function initializeProject(): Promise<void> {
  // Resolve workspace & repo root
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  let skl: SKLFileSystem;
  try {
    skl = await SKLFileSystem.create(wsFolder.uri.fsPath);
  } catch {
    vscode.window.showErrorMessage(
      "Not inside a Git repository. Run `git init` first.",
    );
    return;
  }

  // Guard against overwriting an existing knowledge.json
  try {
    await skl.readKnowledge();
    const choice = await vscode.window.showWarningMessage(
      "SKL is already initialized in this repository. Overwrite?",
      { modal: true },
      "Overwrite",
    );
    if (choice !== "Overwrite") return;
  } catch {
    // Not yet initialized — proceed.
  }

  // ── Step 1/4 — Tech Stack ─────────────────────────────────────
  const techStack = await collectMultiValues(
    1,
    4,
    "Select technologies in your stack (multi-select)",
    TECH_STACK_PRESETS,
    "Enter custom tech stack items (comma-separated)",
  );
  if (!techStack || techStack.length === 0) {
    if (techStack?.length === 0) {
      vscode.window.showWarningMessage("At least one tech-stack item is required.");
    }
    return;
  }

  // ── Step 2/4 — Auth Model ──────────────────────────────────────
  const authModel = await collectSingleValue(
    2,
    4,
    "Select authentication model",
    AUTH_MODEL_PRESETS,
    "Enter your authentication model",
  );
  if (!authModel) return;

  // ── Step 3/4 — Data Storage ────────────────────────────────────
  const dataStorage = await collectSingleValue(
    3,
    4,
    "Select data storage constraint",
    DATA_STORAGE_PRESETS,
    "Enter your data storage constraint",
  );
  if (!dataStorage) return;

  // ── Step 4/4 — Security Patterns ───────────────────────────────
  const securityPatterns = await collectMultiValues(
    4,
    4,
    "Select security-sensitive patterns (multi-select)",
    SECURITY_PATTERN_PRESETS,
    "Enter custom security patterns (comma-separated)",
  );
  if (!securityPatterns) return;

  // ── Atomic write ───────────────────────────────────────────────
  const knowledge: KnowledgeFile = {
    invariants: {
      tech_stack: techStack,
      auth_model: authModel,
      data_storage: dataStorage,
      security_patterns: securityPatterns,
    },
    state: [],
    queue: [],
  };

  try {
    await skl.writeKnowledge(knowledge);
    vscode.window.showInformationMessage(
      `SKL initialized \u2014 ${skl.knowledgePath}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to initialize SKL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
