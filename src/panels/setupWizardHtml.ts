/**
 * setupWizardHtml.ts — pure HTML generator for the SKL Setup Wizard webview.
 * No VSCode imports, no side effects. Inline CSS only.
 */

// ── Types ─────────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export type WizardState = {
  step: WizardStep;
  detectedTechStack?: string;
  scopeGenerationStatus?: "idle" | "generating" | "done" | "error";
  generatedScopes?: Array<{
    name: string;
    description: string;
    allowed_path_prefixes: string[];
    forbidden_path_prefixes: string[];
    permitted_responsibilities: string[];
    forbidden_responsibilities: string[];
  }>;
  hookInstallStatus?: "idle" | "installed" | "error";
  hookInstallError?: string;
};

// ── HTML generator ────────────────────────────────────────────────

export function generateSetupWizardHtml(state: WizardState): string {
  const dots = [1, 2, 3, 4, 5]
    .map((n) => {
      const cls =
        n === state.step
          ? "step-dot active"
          : n < state.step
          ? "step-dot done"
          : "step-dot";
      return `<span class="${cls}"></span>`;
    })
    .join("");

  const stepBody = renderStep(state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SKL Setup</title>
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); max-width: 640px; }
    .step-indicator { margin-bottom: 20px; }
    .step-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; margin: 0 4px; background: #555; }
    .step-dot.active { background: #4caf50; }
    .step-dot.done { background: #888; }
    h2 { margin-top: 0; }
    label { display: block; margin-bottom: 10px; font-size: 0.9em; }
    input, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 5px 8px; border-radius: 3px; font-size: 0.9em; }
    textarea { min-height: 70px; resize: vertical; }
    button { margin-top: 8px; margin-right: 8px; padding: 6px 14px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; font-size: 0.9em; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .warning-box { background: rgba(255,170,0,0.1); border-left: 4px solid #ffaa00; padding: 10px 14px; margin: 12px 0; font-size: 0.9em; }
    .success-text { color: #4caf50; }
    .error-text { color: #f44336; }
    .loading { font-style: italic; color: var(--vscode-descriptionForeground); }
    .scope-card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
    .scope-card label { margin-bottom: 6px; }
    .hint { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 8px; }
    .button-row { margin-top: 12px; }
    .mode-selection { display: flex; gap: 24px; margin-top: 16px; }
    .mode-card { flex: 1; border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 20px; }
    .mode-card.recommended { border-color: var(--vscode-focusBorder, #0078d4); background: var(--vscode-editor-inactiveSelectionBackground, rgba(0,0,0,0.1)); }
    .mode-card ul { padding-left: 16px; margin: 12px 0; }
    .mode-card li { list-style: none; margin: 4px 0; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="step-indicator">${dots}</div>
  ${stepBody}
  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
}

// ── Step renderers ────────────────────────────────────────────────

function renderStep(state: WizardState): string {
  switch (state.step) {
    case 1:
      return renderStep1();
    case 2:
      return renderStep2(state);
    case 3:
      return renderStep3(state);
    case 4:
      return renderStep4(state);
    case 5:
      return renderStep5();
    default: {
      const _exhaustive: never = state.step;
      return String(_exhaustive);
    }
  }
}

function renderStep1(): string {
  return `<h2>Welcome to SKL</h2>
<p>SKL (Shared Knowledge Layer) coordinates multi-agent development by making architectural decisions, scope boundaries, and shared assumptions explicit and enforceable.</p>
<p>SKL is not a code generator, not a CI system, and not a replacement for code review. It is a coordination layer that ensures agents cannot inadvertently break each other's assumptions.</p>
<div class="mode-selection">
  <div class="mode-card recommended">
    <h3>Phase 0 — Start here</h3>
    <p>See what your agents are doing in under 10 minutes.
       No scope definitions required. Upgrade to full SKL when ready.</p>
    <ul>
      <li>✓ Hook installed automatically</li>
      <li>✓ Activity feed shows agent changes</li>
      <li>✓ Risk signals flagged on push</li>
      <li>○ Scope enforcement (not active)</li>
      <li>○ RFCs and governance (not active)</li>
    </ul>
    <button onclick="vscode.postMessage({command:'start_phase0'})">
      Start with Phase 0 (recommended)
    </button>
  </div>
  <div class="mode-card">
    <h3>Full SKL</h3>
    <p>Complete governance layer with scope enforcement, RFCs,
       and the Orchestrator. Requires defining scopes and invariants.</p>
    <ul>
      <li>✓ Everything in Phase 0</li>
      <li>✓ Scope enforcement on push</li>
      <li>✓ RFC gate for architectural changes</li>
      <li>✓ Orchestrator review session</li>
    </ul>
    <button onclick="vscode.postMessage({command:'start_full_setup'})">
      Full Setup
    </button>
  </div>
</div>`;
}

function renderStep2(state: WizardState): string {
  const techStack = escAttr(state.detectedTechStack ?? "");
  return `<h2>Define Your Invariants</h2>
<p>Invariants are the fundamental constraints your codebase must always satisfy. Agents cannot modify them without triggering an RFC.</p>
<label>Tech stack <input id="tech-stack" type="text" value="${techStack}" placeholder="e.g. FastAPI, PostgreSQL, Redis"></label>
<label>Architectural style <input id="arch-style" type="text" placeholder="e.g. REST, event-driven, monolith"></label>
<label>Performance constraints <input id="perf" type="text" placeholder="e.g. API P95 &lt; 200ms"></label>
<label>Non-negotiable conventions <input id="conventions" type="text" placeholder="e.g. No direct DB access outside data-access scope"></label>
<button onclick="vscode.postMessage({command:'step2_next', invariants:{
  tech_stack: document.getElementById('tech-stack').value,
  architectural_style: document.getElementById('arch-style').value,
  performance_constraints: document.getElementById('perf').value,
  non_negotiable_conventions: document.getElementById('conventions').value
}})">Next</button>`;
}

function renderStep3(state: WizardState): string {
  const status = state.scopeGenerationStatus;

  if (status === "generating") {
    return `<h2>Generate Scope Definitions</h2>
<p class="loading">Generating scope definitions…</p>`;
  }

  if (status === "done" && state.generatedScopes && state.generatedScopes.length > 0) {
    const cards = state.generatedScopes
      .map(
        (s) => `<div class="scope-card">
  <label>Scope name <input class="scope-name" type="text" value="${escAttr(s.name)}"></label>
  <label>Description <textarea class="scope-desc">${escHtml(s.description)}</textarea></label>
  <label>Allowed path prefixes (one per line) <textarea class="scope-allowed">${escHtml(s.allowed_path_prefixes.join("\n"))}</textarea></label>
  <label>Forbidden path prefixes (one per line) <textarea class="scope-forbidden">${escHtml(s.forbidden_path_prefixes.join("\n"))}</textarea></label>
</div>`,
      )
      .join("\n");

    return `<h2>Review Generated Scopes</h2>
${cards}
<div class="button-row">
<button onclick="vscode.postMessage({command:'generate_scopes'})">Regenerate</button>
<button onclick="confirmScopes()">Confirm Scopes</button>
</div>
<script>
function confirmScopes() {
  const cards = Array.from(document.querySelectorAll('.scope-card'));
  const scopes = cards.map(function(card) {
    return {
      name: card.querySelector('.scope-name').value.trim(),
      description: card.querySelector('.scope-desc').value.trim(),
      allowed_path_prefixes: card.querySelector('.scope-allowed').value.trim().split('\\n').map(function(s){return s.trim();}).filter(Boolean),
      forbidden_path_prefixes: card.querySelector('.scope-forbidden').value.trim().split('\\n').map(function(s){return s.trim();}).filter(Boolean),
      permitted_responsibilities: [],
      forbidden_responsibilities: [],
    };
  });
  vscode.postMessage({command:'step3_complete', scopes: scopes});
}
</script>`;
  }

  if (status === "error") {
    return `<h2>Generate Scope Definitions</h2>
<p class="error-text">Scope generation failed. Try again.</p>
<button onclick="vscode.postMessage({command:'generate_scopes'})">Regenerate</button>`;
  }

  // idle / undefined
  return `<h2>Generate Scope Definitions</h2>
<p>SKL will analyse your directory tree and propose scope boundaries for your project. Review and edit them before continuing — scopes are the primary enforcement mechanism.</p>
<div class="warning-box">⚠ Scope definition quality is load-bearing. Review generated scopes carefully — a poorly defined scope produces false confidence.</div>
<button onclick="vscode.postMessage({command:'generate_scopes'})">Generate Scopes</button>`;
}

function renderStep4(state: WizardState): string {
  const status = state.hookInstallStatus;

  if (status === "installed") {
    return `<h2>Install Pre-Push Hook</h2>
<p class="success-text">✓ Hook installed at .git/hooks/pre-push.</p>
<button onclick="vscode.postMessage({command:'step4_next'})">Next</button>`;
  }

  if (status === "error") {
    const msg = escHtml(state.hookInstallError ?? "Installation failed.");
    return `<h2>Install Pre-Push Hook</h2>
<p class="error-text">${msg}</p>
<button onclick="vscode.postMessage({command:'install_hook'})">Retry</button>`;
  }

  // idle / undefined
  return `<h2>Install Pre-Push Hook</h2>
<p>The SKL pre-push hook validates that every push respects scope boundaries, uncertainty levels, and acceptance criteria. It must be installed before agent contexts can be enforced.</p>
<p>The hook is a Python script placed at <code>.git/hooks/pre-push</code>. It runs automatically on every <code>git push</code>.</p>
<button onclick="vscode.postMessage({command:'install_hook'})">Install Hook</button>`;
}

function renderStep5(): string {
  return `<h2>Configure Your First Agent</h2>
<p>Configure at least one agent context so SKL can validate its pushes. You can add more agents later with 'SKL: Configure Agent'.</p>
<label>Agent ID <input id="w-agent-id" type="text" placeholder="e.g. Agent-1"></label>
<label>Semantic scope <input id="w-scope" type="text" placeholder="Enter a scope name from the definitions above"></label>
<label>File scope (optional, one path per line) <textarea id="w-file-scope"></textarea></label>
<button onclick="vscode.postMessage({command:'step5_apply',
  agent_id: document.getElementById('w-agent-id').value.trim(),
  semantic_scope: document.getElementById('w-scope').value.trim(),
  file_scope: document.getElementById('w-file-scope').value.trim()
})">Apply and Finish</button>
<button onclick="vscode.postMessage({command:'step5_skip'})">Skip for Now</button>
<p class="hint">You will need to configure at least one agent before the first push.</p>`;
}

// ── Helpers ───────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
