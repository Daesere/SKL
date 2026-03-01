/**
 * DigestService.test.ts
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/DigestService.test.ts
 */

import { generateDigest, shouldTriggerDigest, DIGEST_INTERVAL, REVIEW_THRESHOLD } from "../DigestService.js";
import type { KnowledgeFile, StateRecord, QueueProposal } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`         ${(err as Error).message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStateRecord(overrides: Partial<StateRecord> = {}): StateRecord {
  return {
    id: "app_auth_tokens",
    path: "app/auth/tokens.py",
    semantic_scope: "auth",
    scope_schema_version: "1.0",
    responsibilities: "Token generation and validation",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-alpha",
    version: 2,
    uncertainty_level: 2,
    change_count_since_review: 0,
    ...overrides,
  };
}

function makeApprovedArchitecturalProposal(
  id: string,
  recordedAt: string,
  status: "approved" | "auto_approve" = "approved",
): QueueProposal {
  return {
    proposal_id: `prop-${id}`,
    agent_id: "agent-alpha",
    path: `src/${id}.ts`,
    semantic_scope: "auth",
    scope_schema_version: "1.0",
    change_type: "behavioral",
    responsibilities: "handles auth",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    uncertainty_delta: "+0",
    rationale: "architectural refactor",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: `feat/${id}`,
    risk_signals: {
      touched_auth_or_permission_patterns: false,
      public_api_signature_changed: false,
      invariant_referenced_file_modified: false,
      high_fan_in_module_modified: false,
      ast_change_type: "behavioral",
      mechanical_only: false,
    },
    classification_verification: {
      agent_classification: "behavioral",
      verifier_classification: "behavioral",
      agreement: true,
      stage1_override: false,
    },
    dependency_scan: {
      undeclared_imports: [],
      stale_declared_deps: [],
      cross_scope_undeclared: [],
    },
    agent_reasoning_summary: "architectural change",
    status: status as QueueProposal["status"],
    submitted_at: "2025-01-01T00:00:00.000Z",
    decision_rationale: {
      decision_type: "architectural",
      text: "Approved: architectural decision",
      recorded_at: recordedAt,
    },
  };
}

function makeKnowledge(
  stateRecords: StateRecord[] = [],
  queue: QueueProposal[] = [],
): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["Python"],
      auth_model: "JWT",
      data_storage: "PostgreSQL",
      security_patterns: [],
    },
    state: stateRecords,
    queue,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

console.log("\nDigestService — generateDigest");
console.log("================================");

await testAsync("Test 1 — 3 level-2 entries → state_entries_for_review.length === 3", async () => {
  const records = [
    makeStateRecord({ id: "a", uncertainty_level: 2 }),
    makeStateRecord({ id: "b", uncertainty_level: 2 }),
    makeStateRecord({ id: "c", uncertainty_level: 2 }),
    makeStateRecord({ id: "d", uncertainty_level: 1 }), // not level-2, excluded
  ];
  const report = generateDigest(makeKnowledge(records), []);
  assertEqual(report.state_entries_for_review.length, 3, "state_entries_for_review.length");
});

await testAsync("Test 2 — entry at change_count_since_review >= REVIEW_THRESHOLD → in state_entries_flagged", async () => {
  const records = [
    makeStateRecord({ id: "flagged", change_count_since_review: REVIEW_THRESHOLD }),
  ];
  const report = generateDigest(makeKnowledge(records), []);
  assertEqual(report.state_entries_flagged.length, 1, "flagged.length");
  assertEqual(report.state_entries_flagged[0].id, "flagged", "flagged id");
});

await testAsync("Test 3 — entry at change_count_since_review < REVIEW_THRESHOLD → not in state_entries_flagged", async () => {
  const records = [
    makeStateRecord({ id: "under", change_count_since_review: REVIEW_THRESHOLD - 1 }),
  ];
  const report = generateDigest(makeKnowledge(records), []);
  assertEqual(report.state_entries_flagged.length, 0, "flagged.length");
});

await testAsync("Test 4 — level-3 entry → in contested_entries only, not in state_entries_for_review", async () => {
  const records = [
    makeStateRecord({ id: "contested", uncertainty_level: 3, change_count_since_review: 0 }),
  ];
  const report = generateDigest(makeKnowledge(records), []);
  assertEqual(report.contested_entries.length, 1, "contested.length");
  assertEqual(report.state_entries_for_review.length, 0, "for_review.length should be 0");
});

console.log("\nDigestService — shouldTriggerDigest");
console.log("=====================================");

await testAsync("Test 5 — lastDigestAt: null → true", async () => {
  const result = shouldTriggerDigest(makeKnowledge(), null);
  assertEqual(result, true, "shouldTriggerDigest(null)");
});

await testAsync(`Test 6 — ${DIGEST_INTERVAL - 1} architectural decisions since last digest → false`, async () => {
  const lastDigestAt = "2025-01-01T00:00:00.000Z";
  const queue: QueueProposal[] = [];
  for (let i = 0; i < DIGEST_INTERVAL - 1; i++) {
    queue.push(makeApprovedArchitecturalProposal(`p${i}`, "2025-06-01T00:00:00.000Z"));
  }
  const result = shouldTriggerDigest(makeKnowledge([], queue), lastDigestAt);
  assertEqual(result, false, `shouldTriggerDigest(${DIGEST_INTERVAL - 1} decisions)`);
});

await testAsync(`Test 7 — ${DIGEST_INTERVAL} architectural decisions since last digest → true`, async () => {
  const lastDigestAt = "2025-01-01T00:00:00.000Z";
  const queue: QueueProposal[] = [];
  for (let i = 0; i < DIGEST_INTERVAL; i++) {
    queue.push(makeApprovedArchitecturalProposal(`p${i}`, "2025-06-01T00:00:00.000Z"));
  }
  const result = shouldTriggerDigest(makeKnowledge([], queue), lastDigestAt);
  assertEqual(result, true, `shouldTriggerDigest(${DIGEST_INTERVAL} decisions)`);
});

await testAsync("Test 8 — generateDigest is pure: two calls with same input yield equivalent output", async () => {
  const records = [
    makeStateRecord({ id: "a", uncertainty_level: 2, change_count_since_review: 3 }),
  ];
  const knowledge = makeKnowledge(records, []);
  const openRfcIds = ["rfc-001", "rfc-002"];

  const r1 = generateDigest(knowledge, openRfcIds);
  const r2 = generateDigest(knowledge, openRfcIds);

  assertEqual(r1.state_entries_for_review.length, r2.state_entries_for_review.length, "for_review.length");
  assertEqual(r1.state_entries_flagged.length, r2.state_entries_flagged.length, "flagged.length");
  assertEqual(r1.contested_entries.length, r2.contested_entries.length, "contested.length");
  assertEqual(r1.open_rfc_ids.length, r2.open_rfc_ids.length, "open_rfcs.length");
  assertEqual(r1.architectural_decisions_since_last_digest.length, r2.architectural_decisions_since_last_digest.length, "decisions.length");

  // Verify the original knowledge is not mutated
  assertEqual(knowledge.state[0].uncertainty_level, 2, "original not mutated");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log();
const total = passed + failed;
if (failed === 0) {
  console.log(`${total} tests: ${passed} passed, 0 failed`);
} else {
  console.log(`${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

})();
