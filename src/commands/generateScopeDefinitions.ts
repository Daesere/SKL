import * as vscode from "vscode";
import { SKLFileSystem } from "../services/index.js";
import { ScopeDefinitionSchema } from "../types/index.js";

// ── LLM prompt ───────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are an expert software architect. Given the directory tree of a project, generate a scope_definitions.json file following the SKL v1.4 specification.

Each scope must have:
- description: Narrow description of what it covers.
- allowed_path_prefixes: Directory prefixes where files in this scope live.
- forbidden_path_prefixes: Directory prefixes this scope must NOT touch.
- permitted_responsibilities: What modules in this scope are allowed to do.
- forbidden_responsibilities: What this scope must NOT do.
- owner: Always "human-operator".
- allowed_paths (optional): Specific file paths if needed.

Rules:
- Create 3-8 scopes based on the actual directory structure.
- Scopes should be mutually exclusive where possible.
- Every significant directory should be covered by at least one scope.
- Use descriptive scope names (e.g. "auth", "persistence", "api", "infra", "core").

Respond with ONLY the JSON object. No markdown fences, no explanation.

Required shape:
{
  "scope_definitions": {
    "version": "1.0",
    "scopes": {
      "<scope_name>": {
        "description": "...",
        "allowed_path_prefixes": ["..."],
        "forbidden_path_prefixes": ["..."],
        "permitted_responsibilities": ["..."],
        "forbidden_responsibilities": ["..."],
        "owner": "human-operator"
      }
    }
  }
}`;

// ── Main command ─────────────────────────────────────────────────────

export async function generateScopeDefinitions(): Promise<void> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  let skl: SKLFileSystem;
  try {
    skl = await SKLFileSystem.create(wsFolder.uri.fsPath);
  } catch {
    vscode.window.showErrorMessage("Not inside a Git repository.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "SKL: Generate Scope Definitions",
      cancellable: true,
    },
    async (progress, token) => {
      // 1. Scan directory tree
      progress.report({ message: "Scanning directory tree\u2026" });
      const tree = await skl.buildDirectoryTree(wsFolder.uri.fsPath);
      if (token.isCancellationRequested) return;

      // 2. Select an available LLM
      progress.report({ message: "Selecting language model\u2026" });
      const models = await vscode.lm.selectChatModels();
      if (models.length === 0) {
        vscode.window.showErrorMessage(
          "No language model available. Ensure GitHub Copilot or another LM extension is installed and signed in.",
        );
        return;
      }
      const model = models[0];
      if (token.isCancellationRequested) return;

      // 3. Generate via LLM
      progress.report({ message: `Generating with ${model.name}\u2026` });
      const messages = [
        vscode.LanguageModelChatMessage.User(
          `${SYSTEM_PROMPT}\n\nDirectory tree:\n${tree}`,
        ),
      ];

      let responseText = "";
      try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
          if (token.isCancellationRequested) return;
          responseText += chunk;
        }
      } catch (err) {
        if (err instanceof vscode.CancellationError) return;
        vscode.window.showErrorMessage(
          `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // 4. Parse JSON (strip accidental markdown fences)
      progress.report({ message: "Validating response\u2026" });
      let jsonText = responseText.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?\s*```\s*$/, "");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        vscode.window.showErrorMessage(
          "LLM returned invalid JSON. The raw output will be opened for manual editing.",
        );
        const doc = await vscode.workspace.openTextDocument({
          content: responseText,
          language: "json",
        });
        await vscode.window.showTextDocument(doc);
        return;
      }

      // Optional Zod pre-check — warn but don't block
      const validation = ScopeDefinitionSchema.safeParse(parsed);
      if (!validation.success) {
        const issues = validation.error.issues
          .map((i) => `[${i.path.join(".")}] ${i.message}`)
          .join("; ");
        vscode.window.showWarningMessage(
          `Schema warnings (editable in review): ${issues}`,
        );
      }

      // 5. Write proposed file & open Human Review Gate
      progress.report({ message: "Opening review editor\u2026" });

      const formattedJson =
        JSON.stringify(
          validation.success ? validation.data : parsed,
          null,
          2,
        ) + "\n";

      await openHumanReviewGate(skl, formattedJson);
    },
  );
}

// ── Human Review Gate ────────────────────────────────────────────────

/**
 * Open the proposed scope_definitions.json in a side-by-side diff editor.
 * The file is NOT written to the canonical path until the user clicks
 * the ✓ Confirm button in the editor title bar.
 */
async function openHumanReviewGate(
  skl: SKLFileSystem,
  proposedContent: string,
): Promise<void> {
  // Write the proposed file (this is the right-hand side of the diff)
  await skl.writeProposedScopeDefinitions(proposedContent);

  // Ensure the actual file exists for the left-hand side (empty if first time)
  await skl.ensureScopeDefinitionsPlaceholder();

  // Open diff: current (left) ↔ proposed (right)
  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(skl.scopeDefinitionsPath),
    vscode.Uri.file(skl.proposedScopeDefinitionsPath),
    "Scope Definitions: Current \u2194 Proposed",
  );

  vscode.window.showInformationMessage(
    "Review the proposed scope definitions. " +
      "Edit freely in the right pane, then click \u2713 Confirm or \u2717 Reject in the editor title bar.",
  );
}

// ── Confirm / Reject (editor title-bar actions) ──────────────────────

/**
 * Confirm: save any in-editor edits, validate, then atomically move
 * proposed → actual. Closes the diff editor.
 */
export async function confirmScopeDefinitions(): Promise<void> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return;

  let skl: SKLFileSystem;
  try {
    skl = await SKLFileSystem.create(wsFolder.uri.fsPath);
  } catch {
    return;
  }

  try {
    // Flush any unsaved editor changes for the proposed file
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === skl.proposedScopeDefinitionsPath,
    );
    if (openDoc?.isDirty) {
      await openDoc.save();
    }

    const content = await skl.readProposedScopeDefinitions();
    const parsed: unknown = JSON.parse(content);

    // Validate
    const result = ScopeDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `[${i.path.join(".")}] ${i.message}`)
        .join("\n");
      const choice = await vscode.window.showWarningMessage(
        `Schema validation issues:\n${issues}`,
        { modal: true },
        "Confirm Anyway",
      );
      if (choice !== "Confirm Anyway") return;
    }

    // Atomic write via SKLFileSystem
    await skl.commitProposedScopeDefinitions(content);

    // Close the diff editor
    await vscode.commands.executeCommand(
      "workbench.action.closeActiveEditor",
    );

    vscode.window.showInformationMessage(
      `Scope definitions confirmed \u2014 ${skl.scopeDefinitionsPath}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to confirm: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reject: delete proposed file, clean up empty placeholder, close diff.
 */
export async function rejectScopeDefinitions(): Promise<void> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return;

  let skl: SKLFileSystem;
  try {
    skl = await SKLFileSystem.create(wsFolder.uri.fsPath);
  } catch {
    return;
  }

  await skl.rejectProposedScopeDefinitions();

  await vscode.commands.executeCommand(
    "workbench.action.closeActiveEditor",
  );

  vscode.window.showInformationMessage(
    "Scope definitions rejected. No changes written to disk.",
  );
}
