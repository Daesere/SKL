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
import { generateDigestHtml } from "./digestPanelHtml.js";
import { generateQueueHtml, generateHeatmapSection } from "./queuePanelHtml.js";
import { generateRFCResolutionHtml } from "./rfcResolutionPanelHtml.js";
import type { DigestReport } from "../services/DigestService.js";
import type { StateRecord, Rfc } from "../types/index.js";

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

// ── 4. Digest panel — all five sections ───────────────────────

const mockDigestReport: DigestReport = {
  generated_at: new Date().toISOString(),
  architectural_decisions_since_last_digest: [
    {
      proposal_id: "prop-auth-042",
      path: "src/auth/TokenManager.ts",
      rationale_text: "Introducing a stateless JWT verification layer removes the need for a shared session store. This is an architectural boundary change that affects the auth and api scopes.",
      decision: "approved",
      recorded_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    },
    {
      proposal_id: "prop-data-017",
      path: "src/data/QueryBuilder.ts",
      rationale_text: "Query builder now uses a cursor-based pagination strategy instead of offset-based. Required by the Product RFC-007 decision.",
      decision: "auto_approve",
      recorded_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
    },
  ],
  state_entries_for_review: [
    {
      id: "auth_token_manager",
      path: "src/auth/TokenManager.ts",
      semantic_scope: "auth",
      scope_schema_version: "1.0",
      responsibilities: "Manages JWT token creation, verification, and revocation for all authenticated sessions.",
      dependencies: ["src/config/env.ts", "src/logging/Logger.ts"],
      invariants_touched: ["auth_model"],
      assumptions: [],
      owner: "agent-alpha",
      version: 3,
      uncertainty_level: 2,
      change_count_since_review: 2,
    },
    {
      id: "api_rate_limiter",
      path: "src/api/RateLimiter.ts",
      semantic_scope: "api",
      scope_schema_version: "1.0",
      responsibilities: "Enforces per-client request rate limits using a token bucket algorithm.",
      dependencies: ["src/cache/Redis.ts"],
      invariants_touched: [],
      assumptions: [],
      owner: "agent-beta",
      version: 1,
      uncertainty_level: 2,
      change_count_since_review: 3,
    },
  ],
  state_entries_flagged: [
    {
      id: "data_query_builder",
      path: "src/data/QueryBuilder.ts",
      semantic_scope: "data",
      scope_schema_version: "1.0",
      responsibilities: "Constructs parameterised SQL queries for the data layer. Supports cursor-based and offset-based pagination.",
      dependencies: ["src/data/ConnectionPool.ts"],
      invariants_touched: ["data_storage"],
      assumptions: [],
      owner: "agent-gamma",
      version: 8,
      uncertainty_level: 1, // level 1, not 2 — should appear in Section 2 only
      change_count_since_review: 7,
    },
  ],
  contested_entries: [
    {
      id: "infra_deploy_config",
      path: "infra/deploy.yaml",
      semantic_scope: "infra",
      scope_schema_version: "1.0",
      responsibilities: "Kubernetes deployment configuration for production environment.",
      dependencies: [],
      invariants_touched: [],
      assumptions: [],
      owner: "agent-delta",
      version: 2,
      uncertainty_level: 3,
      change_count_since_review: 1,
    },
  ],
  open_rfc_ids: ["RFC_003", "RFC_007"],
  summary: "Digest " + new Date().toLocaleDateString() + ". 2 entries pending review, 1 flagged for drift, 1 contested, 2 open RFCs, 2 architectural decisions since last digest.",
};

const digestHtml = generateDigestHtml(mockDigestReport);
writeFileSync(join(outDir, "test-digest.html"), digestHtml, "utf8");
console.log(`Wrote: ${join(outDir, "test-digest.html")}`);
console.log(`  file://${join(outDir, "test-digest.html")}`);

// ── 5. Queue panel with heatmap ────────────────────────────────

const mockStateRecords: StateRecord[] = [
  {
    id: "auth_token_manager",
    path: "src/auth/TokenManager.ts",
    semantic_scope: "auth",
    scope_schema_version: "1.0",
    responsibilities: "JWT management",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-alpha",
    version: 3,
    uncertainty_level: 2,
    change_count_since_review: 7,
  },
  {
    id: "api_rate_limiter",
    path: "src/api/RateLimiter.ts",
    semantic_scope: "api",
    scope_schema_version: "1.0",
    responsibilities: "Rate limiting",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-beta",
    version: 1,
    uncertainty_level: 1,
    change_count_since_review: 3,
  },
  {
    id: "data_query_builder",
    path: "src/data/QueryBuilder.ts",
    semantic_scope: "data",
    scope_schema_version: "1.0",
    responsibilities: "SQL query construction",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-gamma",
    version: 8,
    uncertainty_level: 1,
    change_count_since_review: 6,
  },
  {
    id: "infra_deploy_config",
    path: "infra/deploy.yaml",
    semantic_scope: "infra",
    scope_schema_version: "1.0",
    responsibilities: "K8s deploy config",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-delta",
    version: 2,
    uncertainty_level: 3,
    change_count_since_review: 1,
  },
  {
    id: "ui_dashboard",
    path: "src/ui/Dashboard.tsx",
    semantic_scope: "ui",
    scope_schema_version: "1.0",
    responsibilities: "Main dashboard",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-epsilon",
    version: 4,
    uncertainty_level: 1,
    change_count_since_review: 4,
  },
];

const queueWithHeatmapHtml = generateQueueHtml([], mockStateRecords, true);
writeFileSync(join(outDir, "test-queue-heatmap.html"), queueWithHeatmapHtml, "utf8");
console.log(`Wrote: ${join(outDir, "test-queue-heatmap.html")}`);
console.log(`  file://${join(outDir, "test-queue-heatmap.html")}`);

// ── 6. generateHeatmapSection — zero-change guard ─────────────

const zeroRecords: StateRecord[] = mockStateRecords.map((r) => ({
  ...r,
  change_count_since_review: 0,
}));
const zeroHtml = generateHeatmapSection(zeroRecords, 5);
if (!zeroHtml.includes("No modules have unreviewed changes")) {
  throw new Error("FAIL: zero-change guard — expected 'No modules have unreviewed changes' in output");
}
console.log("PASS: zero-change guard");

// ── 7. generateHeatmapSection — 20 records → only 15 shown ────

const twentyRecords: StateRecord[] = Array.from({ length: 20 }, (_, i) => ({
  id: `module_${i}`,
  path: `src/module_${i}.ts`,
  semantic_scope: "core",
  scope_schema_version: "1.0",
  responsibilities: `Module ${i}`,
  dependencies: [],
  invariants_touched: [],
  assumptions: [],
  owner: "agent-x",
  version: 1,
  uncertainty_level: 1,
  change_count_since_review: i + 1,
}));
const twentyHtml = generateHeatmapSection(twentyRecords, 5);
const rowCount = (twentyHtml.match(/class="heatmap-row"/g) ?? []).length;
if (rowCount !== 15) {
  throw new Error(`FAIL: top-15 cap — expected 15 heatmap-row divs, got ${rowCount}`);
}
console.log(`PASS: top-15 cap (${rowCount} rows rendered for 20 input records)`);

// ── 8. RFC Resolution Panel ────────────────────────────────────

const mockRfc: Rfc = {
  id: "RFC_007",
  status: "open",
  created_at: new Date().toISOString(),
  triggering_proposal: "prop-auth-042",
  decision_required: "Should the auth service switch from session-based to stateless JWT authentication?",
  context: "The current session store creates coupling between auth and data layer. Moving to JWT would decouple them but requires rotating secrets and updating all token consumers.",
  option_a: {
    description: "Migrate to stateless JWT immediately",
    consequences: "Clean decoupling but requires coordinating token rotation across all consumers in a single release.",
  },
  option_b: {
    description: "Introduce JWT alongside sessions, deprecate sessions over two sprints",
    consequences: "Gradual migration reduces risk but increases complexity short-term.",
  },
  option_c: {
    description: "Keep session-based auth and document the coupling explicitly",
    consequences: "No migration cost, but architectural debt persists.",
  },
  orchestrator_recommendation: "option_b",
  orchestrator_rationale: "Gradual migration balances risk and completeness.",
  option_rankings: [
    {
      option: "option_a",
      effort_score: 7,
      risk_score: 8,
      invariant_alignment_score: 9,
      composite_score: 6,
      recommended: false,
      ranking_rationale: "High effort and risk despite good invariant alignment.",
    },
    {
      option: "option_b",
      effort_score: 5,
      risk_score: 4,
      invariant_alignment_score: 9,
      composite_score: 0,
      recommended: true,
      ranking_rationale: "Best balance of effort, risk, and invariant alignment.",
    },
    {
      option: "option_c",
      effort_score: 1,
      risk_score: 2,
      invariant_alignment_score: 3,
      composite_score: 0,
      recommended: false,
      ranking_rationale: "Lowest effort but poor long-term alignment.",
    },
  ],
  recommended_human_rationale: "I recommend option_b because it allows a controlled migration with validation checkpoints. You may accept, edit, or replace this rationale entirely.",
  draft_acceptance_criteria: [
    {
      id: "ac_draft_001",
      description: "All existing auth integration tests must pass after JWT rollout",
      check_type: "test",
      check_reference: "npm run test:auth",
      rationale: "Ensures backward compatibility during migration.",
      status: "pending",
    },
    {
      id: "ac_draft_002",
      description: "Token expiry edge cases validated in staging environment",
      check_type: "manual",
      check_reference: "docs/staging-auth-checklist.md",
      rationale: "JWT expiry behaviour cannot be fully automated.",
      status: "pending",
    },
  ],
  human_response_deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
};

const rfcResolutionHtml = generateRFCResolutionHtml(mockRfc);
writeFileSync(join(outDir, "test-rfc-resolution.html"), rfcResolutionHtml, "utf8");
console.log(`Wrote: ${join(outDir, "test-rfc-resolution.html")}`);
console.log(`  file://${join(outDir, "test-rfc-resolution.html")}`);
