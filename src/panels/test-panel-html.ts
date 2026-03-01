/**
 * test-panel-html.ts
 *
 * Visual smoke-test for orchestratorPanelHtml.ts.
 *
 * Writes two HTML files for manual browser inspection:
 *   - /tmp/test-null.html    — start screen (session === null)
 *   - /tmp/test-session.html — active session with results and open RFCs
 *
 * Run with:
 *   npx tsx src/panels/test-panel-html.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateOrchestratorHtml,
  generateProgressUpdate,
} from "./orchestratorPanelHtml.js";

const outDir = join(tmpdir(), "skl-panel-test");
mkdirSync(outDir, { recursive: true });

// ── 1. Start-screen (null session) ─────────────────────────────

const nullHtml = generateOrchestratorHtml(null, [], "", [], 15);
writeFileSync(join(outDir, "test-null.html"), nullHtml, "utf8");
console.log(`Wrote: ${join(outDir, "test-null.html")}`);

// ── 2. Active session with results and open RFCs ───────────────

const mockSession = {
  session_id: "session_001",
  session_start: new Date(Date.now() - 12 * 60_000).toISOString(), // 12 min ago
  proposals_reviewed: 7,
  escalations: ["p-auth-003"],
  rfcs_opened: ["RFC_002"],
  uncertain_decisions: ["p-ui-009"],
  circuit_breakers_triggered: [],
  recurring_patterns_flagged: [],
  consecutive_uncertain: 0,
};

const mockResults = [
  {
    proposal_id: "p-auth-001",
    decision: "auto_approve",
    rationale:
      "Auto-approved: AST confirms mechanical-only change with no risk signals, no assumption conflicts, and no cross-scope dependencies.",
    rfc_id: null,
    state_updated: true,
    branch_merged: true,
    merge_conflict: false,
  },
  {
    proposal_id: "p-auth-002",
    decision: "approve",
    rationale:
      "The proposed change correctly scopes the token expiry logic to the auth module. No invariants are violated and the dependency declarations are complete.",
    rfc_id: null,
    state_updated: true,
    branch_merged: false,
    merge_conflict: false,
  },
  {
    proposal_id: "p-auth-003",
    decision: "escalate",
    rationale:
      "The target State record has uncertainty level 3. Human review is required before this proposal can proceed.",
    rfc_id: null,
    state_updated: false,
    branch_merged: false,
    merge_conflict: false,
  },
  {
    proposal_id: "p-data-011",
    decision: "reject",
    rationale:
      "Conflicting State record src_data_models is owned by Agent-2. The proposing agent must coordinate with the owning agent and re-scope the change before resubmitting.",
    rfc_id: null,
    state_updated: false,
    branch_merged: false,
    merge_conflict: false,
  },
  {
    proposal_id: "p-infra-005",
    decision: "approve",
    rationale:
      "Infrastructure change approved. No cross-scope dependencies detected and all assumption declarations match.",
    rfc_id: null,
    state_updated: true,
    branch_merged: true,
    merge_conflict: true, // Conflict example
  },
  {
    proposal_id: "p-arch-007",
    decision: "rfc",
    rationale:
      "This proposal modifies the public API surface and introduces a new architectural pattern not covered by existing ADRs. An RFC has been opened.",
    rfc_id: "RFC_002",
    state_updated: false,
    branch_merged: false,
    merge_conflict: false,
  },
  {
    proposal_id: "p-ui-009",
    decision: "approve",
    rationale:
      "UI change within declared file scope. The rationale for choosing a controlled component pattern here is unclear about whether it should apply globally.",
    rfc_id: null,
    state_updated: true,
    branch_merged: false,
    merge_conflict: false,
  },
];

const mockOpenRFCs = [
  {
    id: "RFC_001",
    status: "open",
    decision_required:
      "Which caching strategy should the auth service use? In-process LRU vs Redis-backed distributed cache vs read replica.",
    human_response_deadline: new Date(Date.now() + 4 * 60 * 60_000 + 23 * 60_000).toISOString(), // 4h 23m
  },
  {
    id: "RFC_002",
    status: "open",
    decision_required:
      "Should the new streaming API use WebSockets or Server-Sent Events as the primary transport mechanism?",
    human_response_deadline: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min OVERDUE
  },
];

const sessionHtml = generateOrchestratorHtml(
  mockSession,
  mockResults,
  "7 / 15 proposals reviewed (47%). 83 minutes remaining.",
  mockOpenRFCs,
  15,
);
writeFileSync(join(outDir, "test-session.html"), sessionHtml, "utf8");
console.log(`Wrote: ${join(outDir, "test-session.html")}`);

// ── 3. Progress update fragment ────────────────────────────────

const fragment = generateProgressUpdate(
  "Reviewing proposal p-auth-002 (2/15)...",
  mockResults.slice(0, 1),
);
writeFileSync(join(outDir, "test-progress.html"), `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>body{margin:20px;font-family:sans-serif;background:#1e1e1e;}</style></head>
<body>${fragment}</body></html>`, "utf8");
console.log(`Wrote: ${join(outDir, "test-progress.html")}`);

console.log("\nAll files written. Open in a browser to inspect:");
console.log(`  file://${join(outDir, "test-null.html")}`);
console.log(`  file://${join(outDir, "test-session.html")}`);
console.log(`  file://${join(outDir, "test-progress.html")}`);
