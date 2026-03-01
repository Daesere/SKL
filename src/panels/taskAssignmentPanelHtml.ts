/**
 * taskAssignmentPanelHtml.ts — pure HTML generator for the Task Assignment
 * Review webview panel. No VSCode imports, no side effects.
 */

import type { TaskAssignment } from "../types/index.js";

// ── HTML generator ────────────────────────────────────────────────

export function generateTaskAssignmentHtml(
  assignments: TaskAssignment[],
  scopeNames: string[],
): string {
  const cards =
    assignments.length === 0
      ? `<p>No task assignments were generated.</p>
<button onclick="vscode.postMessage({command:'regenerate'})">Regenerate</button>`
      : assignments
          .map(
            (a, i) => `
<div class="assignment-card" id="card-${i}">
  <div class="card-header">Assignment ${i + 1}</div>
  <label>Agent ID
    <input class="agent-id-input" type="text" value="${escHtml(a.agent_id)}">
  </label>
  <label>Scope
    <select class="scope-select">
      ${scopeNames.map((s) => `<option ${s === a.semantic_scope ? "selected" : ""}>${escHtml(s)}</option>`).join("")}
    </select>
  </label>
  <label>File scope (optional, one path per line)
    <textarea class="file-scope-input">${escHtml(a.file_scope ?? "")}</textarea>
  </label>
  <label>Task
    <textarea class="task-input">${escHtml(a.task_description)}</textarea>
  </label>
  <label>Rationale
    <textarea class="rationale-input">${escHtml(a.assignment_rationale)}</textarea>
  </label>
  <button onclick="applyOne(${i})">Apply This Assignment</button>
</div>`,
          )
          .join("\n");

  const footer =
    assignments.length > 0
      ? `<div class="panel-footer"><button onclick="applyAll()">Apply All Assignments</button><button onclick="vscode.postMessage({command:'regenerate'})">Regenerate</button></div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task Assignment Review</title>
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 16px; color: var(--vscode-foreground); }
    h1 { font-size: 1.3em; margin-bottom: 4px; }
    p.note { color: var(--vscode-descriptionForeground); margin-bottom: 16px; font-size: 0.9em; }
    .assignment-card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; padding: 12px; margin-bottom: 16px; }
    .card-header { font-weight: bold; margin-bottom: 8px; }
    label { display: block; margin-bottom: 8px; font-size: 0.9em; }
    input, select, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 4px 6px; border-radius: 3px; font-size: 0.9em; }
    textarea { min-height: 60px; resize: vertical; }
    button { margin-top: 6px; margin-right: 6px; padding: 5px 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .panel-footer { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, #444); }
  </style>
</head>
<body>
  <h1>Task Assignment Review</h1>
  <p class="note">Review the proposed task breakdown. Edit any assignment before applying. Applied assignments write agent contexts to .skl/scratch/.</p>
  ${cards}
  ${footer}
  <script>
    const vscode = acquireVsCodeApi();
    function readCard(card) {
      return {
        agent_id: card.querySelector('.agent-id-input').value.trim(),
        semantic_scope: card.querySelector('.scope-select').value,
        file_scope: card.querySelector('.file-scope-input').value.trim() || undefined,
        task_description: card.querySelector('.task-input').value.trim(),
        assignment_rationale: card.querySelector('.rationale-input').value.trim(),
      };
    }
    function applyOne(index) {
      const card = document.getElementById('card-' + index);
      vscode.postMessage({ command: 'apply_assignment', index, assignment: readCard(card) });
    }
    function applyAll() {
      const all = Array.from(document.querySelectorAll('.assignment-card')).map(readCard);
      vscode.postMessage({ command: 'apply_all_assignments', assignments: all });
    }
  </script>
</body>
</html>`;
}

// ── Helpers ───────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
