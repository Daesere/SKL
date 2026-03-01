/**
 * rfcResolutionPanelHtml.ts — Pure HTML generation for the RFC Resolution webview.
 *
 * No VSCode imports. Receives a typed Rfc object and returns a complete HTML
 * document string with inline CSS only.
 */

import type { Rfc } from "../types/index.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderOptionCard(
  key: "option_a" | "option_b" | "option_c",
  rfc: Rfc,
): string {
  const option = rfc[key];
  if (!option) return "";

  const isRecommended = rfc.orchestrator_recommendation === key;
  const ranking = rfc.option_rankings?.find((r) => r.option === key);

  const recommendedBadge = isRecommended
    ? `<span class="recommended-badge">&#9733; Recommended</span>`
    : "";

  const scoreRow = ranking
    ? `<div class="score-row">
         <span>Effort: ${ranking.effort_score}/10</span>
         <span>Risk: ${ranking.risk_score}/10</span>
         <span>Alignment: ${ranking.invariant_alignment_score}/10</span>
       </div>
       <p class="ranking-rationale">${escapeHtml(ranking.ranking_rationale)}</p>`
    : "";

  return `<div class="option-card ${isRecommended ? "recommended" : ""}" id="card-${key}">
  ${recommendedBadge}
  <h3>${key.toUpperCase()}</h3>
  <p>${escapeHtml(option.description)}</p>
  <p><em>${escapeHtml(option.consequences)}</em></p>
  ${scoreRow}
  <button onclick="selectOption('${key}')">Select this option</button>
</div>`;
}

/**
 * Generate a full HTML document for the RFC Resolution webview panel.
 *
 * @param rfc The RFC document to display for resolution.
 */
export function generateRFCResolutionHtml(rfc: Rfc): string {
  const optionCards = [
    renderOptionCard("option_a", rfc),
    renderOptionCard("option_b", rfc),
    rfc.option_c ? renderOptionCard("option_c", rfc) : "",
  ]
    .filter(Boolean)
    .join("\n");

  const hintLine =
    rfc.recommended_human_rationale
      ? `<p class="hint">Pre-populated by the Orchestrator. Edit or replace as needed.</p>`
      : "";

  const injectedCriteria = JSON.stringify(rfc.draft_acceptance_criteria ?? []);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resolve RFC ${escapeHtml(rfc.id)}</title>
  <style>
    :root {
      --color-recommended: #4caf50;
      --color-normal: #555;
      --color-danger: #e04040;
      --color-amber: #f0a030;
    }
    body {
      margin: 0; padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e; color: #ccc;
    }
    h1 { margin: 0 0 4px; color: #e0e0e0; font-size: 1.4em; }
    h3 { margin: 0 0 8px; color: #e0e0e0; font-weight: 500; }
    h4 { margin: 16px 0 4px; color: #ccc; }
    p { margin: 4px 0; }
    .trigger { font-size: 0.85em; color: #888; margin-bottom: 4px; }
    .decision-required { font-size: 1em; color: #ccc; margin-bottom: 16px; }
    .context-block { background: #2d2d2d; border-radius: 4px; padding: 12px; margin-bottom: 20px; }
    .context-block h3 { color: #bbb; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.05em; }
    .options-grid { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
    .option-card {
      flex: 1; min-width: 200px; background: #2d2d2d;
      border: 1px solid var(--color-normal); border-radius: 6px;
      padding: 16px; cursor: pointer; position: relative;
      transition: border-color 0.15s;
    }
    .option-card:hover { border-color: #888; }
    .option-card.selected { border-left: 4px solid var(--color-recommended); }
    .option-card.recommended {
      border-top: 2px solid var(--color-amber); position: relative;
    }
    .recommended-badge {
      position: absolute; top: 8px; right: 8px;
      background: var(--color-amber); color: #222;
      padding: 2px 6px; border-radius: 3px; font-size: 0.78em; font-weight: 600;
    }
    .score-row { display: flex; gap: 12px; font-size: 0.82em; color: #aaa; margin-top: 8px; }
    .ranking-rationale { font-size: 0.82em; color: #888; margin-top: 4px; }
    .option-card button { margin-top: 12px; }
    button {
      background: #0e639c; color: #fff; border: none; padding: 5px 12px;
      border-radius: 3px; cursor: pointer; font-size: 0.85em;
    }
    button:hover { opacity: 0.85; }
    #confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #resolution-section { margin-top: 24px; background: #2d2d2d; border-radius: 6px; padding: 16px; }
    label { display: block; margin-bottom: 12px; color: #bbb; font-size: 0.9em; }
    textarea, input[type="text"] {
      display: block; width: 100%; box-sizing: border-box;
      background: #1e1e1e; color: #ccc; border: 1px solid #555;
      border-radius: 3px; padding: 6px 8px; margin-top: 4px; font-size: 0.9em;
      font-family: inherit;
    }
    textarea { resize: vertical; }
    .hint { font-size: 0.82em; color: #888; margin: 2px 0 8px; }
    .criterion-row {
      background: #1e1e1e; border: 1px solid #444; border-radius: 4px;
      padding: 8px 12px; margin-bottom: 8px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .criterion-row input, .criterion-row select { margin-top: 2px; }
    .criterion-type-row { display: flex; gap: 8px; align-items: center; }
    select {
      background: #2d2d2d; color: #ccc; border: 1px solid #555;
      border-radius: 3px; padding: 4px 6px; font-size: 0.88em;
    }
    .btn-danger { background: #733; margin-top: 4px; }
    .btn-secondary { background: #444; }
    .action-row { display: flex; gap: 8px; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Resolve RFC ${escapeHtml(rfc.id)}</h1>
  <p class="trigger">Triggered by: ${escapeHtml(rfc.triggering_proposal)}</p>
  <p class="decision-required">${escapeHtml(rfc.decision_required)}</p>

  <section class="context-block">
    <h3>Context</h3>
    <p>${escapeHtml(rfc.context)}</p>
  </section>

  <div class="options-grid">
    ${optionCards}
  </div>

  <section id="resolution-section" style="display:none">
    <h3>Your Decision</h3>
    <label>Rationale
      <textarea id="rationale-input" rows="6" oninput="validateConfirm()">${escapeHtml(rfc.recommended_human_rationale ?? "")}</textarea>
    </label>
    ${hintLine}
    <h4>Acceptance Criteria</h4>
    <p class="hint">At least one criterion is required.</p>
    <div id="criteria-list"></div>
    <div class="action-row">
      <button onclick="confirmResolution()" id="confirm-btn" disabled>Confirm Resolution</button>
      <button class="btn-secondary" onclick="vscode.postMessage({command:'cancel'})">Cancel</button>
    </div>
  </section>

  <script>
    /* eslint-disable */
    const vscode = acquireVsCodeApi();
    let selectedOption = null;
    let criteriaList = ${injectedCriteria};

    function selectOption(opt) {
      selectedOption = opt;
      document.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
      document.getElementById('card-' + opt).classList.add('selected');
      document.getElementById('resolution-section').style.display = 'block';
      validateConfirm();
    }

    function validateConfirm() {
      const rationale = document.getElementById('rationale-input').value.trim();
      document.getElementById('confirm-btn').disabled =
        !selectedOption || !rationale || criteriaList.length === 0;
    }

    function removeCriterion(id) {
      criteriaList = criteriaList.filter(c => c.id !== id);
      renderCriteria();
      validateConfirm();
    }

    function renderCriteria() {
      const container = document.getElementById("criteria-list");
      container.innerHTML = "";
      criteriaList.forEach(function(c) {
        const row = document.createElement("div");
        row.className = "criterion-row";

        const desc = document.createElement("input");
        desc.type = "text";
        desc.placeholder = "Description";
        desc.value = c.description || "";
        desc.addEventListener("input", function() { c.description = desc.value; });
        row.appendChild(desc);

        const typeRow = document.createElement("div");
        typeRow.className = "criterion-type-row";

        const sel = document.createElement("select");
        ["test","performance_test","manual","lint","ci"].forEach(function(t) {
          const opt = document.createElement("option");
          opt.value = t; opt.textContent = t;
          if (c.check_type === t) { opt.selected = true; }
          sel.appendChild(opt);
        });
        sel.addEventListener("change", function() { c.check_type = sel.value; });
        typeRow.appendChild(sel);

        const ref = document.createElement("input");
        ref.type = "text";
        ref.placeholder = "File path or CLI command";
        ref.style.flex = "1";
        ref.value = c.check_reference || "";
        ref.addEventListener("input", function() { c.check_reference = ref.value; });
        typeRow.appendChild(ref);
        row.appendChild(typeRow);

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-danger";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", function() { removeCriterion(c.id); });
        row.appendChild(removeBtn);

        container.appendChild(row);
      });
    }

    function confirmResolution() {
      vscode.postMessage({
        command: 'confirm_resolution',
        option: selectedOption,
        rationale: document.getElementById('rationale-input').value.trim(),
        criteria: criteriaList
      });
    }

    window.addEventListener('load', renderCriteria);
    /* eslint-enable */
  </script>
</body>
</html>`;
}
