import * as vscode from "vscode";
import {
  initializeProject,
  generateScopeDefinitions,
  confirmScopeDefinitions,
  rejectScopeDefinitions,
} from "./commands/index.js";
import { SKLFileSystem } from "./services/index.js";
import { SKLDiagnosticsProvider } from "./diagnostics/index.js";

// -- Activation ---------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "skl.initializeProject",
      initializeProject,
    ),
    vscode.commands.registerCommand(
      "skl.generateScopeDefinitions",
      generateScopeDefinitions,
    ),
    vscode.commands.registerCommand(
      "skl.confirmScopeDefinitions",
      confirmScopeDefinitions,
    ),
    vscode.commands.registerCommand(
      "skl.rejectScopeDefinitions",
      rejectScopeDefinitions,
    ),
  );

  // -- Diagnostics ------------------------------------------------
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    void SKLFileSystem.create(wsFolder.uri.fsPath)
      .then((skl) => {
        const diagnostics = new SKLDiagnosticsProvider(skl);
        context.subscriptions.push(diagnostics);
        void diagnostics.validate();
      })
      .catch(() => {
        // Not a Git repository — diagnostics not available.
      });
  }
}

export function deactivate(): void {
  // No cleanup needed — subscriptions handle disposal.
}