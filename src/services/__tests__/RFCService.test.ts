/**
 * Tests for RFCService.detectRFCTrigger
 *
 * Run: npx tsx src/services/__tests__/RFCService.test.ts
 * (No vscode mock needed — pure function, no I/O, no LLM calls)
 */

import { detectRFCTrigger } from "../RFCService.js";
import type {
  QueueProposal,
  KnowledgeFile,
  AssumptionConflictResult,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeRiskSignals(overrides: Partial<{
  touched_auth_or_permission_patterns: boolean;
  public_api_signature_changed: boolean;
  invariant_referenced_file_modified: boolean;
  high_fan_in_module_modified: boolean;
  ast_change_type: "mechanical" | "behavioral" | "structural";
  mechanical_only: boolean;
}> = {}) {
  return {
    touched_auth_or_permission_patterns: false,
    public_api_signature_changed: false,
    invariant_referenced_file_modified: false,
    high_fan_in_module_modified: false,
    ast_change_type: "behavioral" as const,
    mechanical_only: false,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<QueueProposal> = {}): QueueProposal {
  return {
    proposal_id: "p-001",
    agent_id: "agent-test",
    path: "src/services/AuthService.ts",
    semantic_scope: "auth",
    scope_schema_version: "1.0.0",
    change_type: "behavioral",
    responsibilities: "Handle user authentication.",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    uncertainty_delta: "+0",
    rationale: "Test proposal",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: "feature/test",
    risk_signals: makeRiskSignals(),
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
    agent_reasoning_summary: "",
    status: "pending",
    submitted_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeKnowledge(overrides: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["typescript", "react", "node"],
      auth_model: "jwt",
      data_storage: "postgres",
      security_patterns: ["password", "token"],
    },
    state: [
      {
        id: "sr-001",
        path: "src/services/AuthService.ts",
        semantic_scope: "auth",
        scope_schema_version: "1.0.0",
        responsibilities: "Handles authentication.",
        dependencies: [],
        invariants_touched: ["auth_model"],
        assumptions: [],
        owner: "agent-a",
        version: 1,
        uncertainty_level: 1,
        change_count_since_review: 0,
      },
    ],
    queue: [],
    ...overrides,
  };
}

function makeNoConflict(): AssumptionConflictResult {
  return {
    has_conflict: false,
    proposal_a_id: null,
    proposal_b_id: null,
    assumption_a: null,
    assumption_b: null,
    conflict_description: null,
  };
}

function makeConflict(): AssumptionConflictResult {
  return {
    has_conflict: true,
    proposal_a_id: "p-001",
    proposal_b_id: "p-002",
    assumption_a: {
      id: "a-1",
      text: "auth is stateless",
      declared_by: "agent-a",
      scope: "auth",
      shared: true,
    },
    assumption_b: {
      id: "a-2",
      text: "auth uses sessions",
      declared_by: "agent-b",
      scope: "auth",
      shared: true,
    },
    conflict_description: "Conflicting session assumptions.",
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`         ${(err as Error).message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nRFCService.detectRFCTrigger");
console.log("===========================");

// Test 1: Rule 1 — architectural change_type always triggers RFC
test("Test 1 — architectural change_type triggers architectural_change_type", () => {
  const proposal = makeProposal({ change_type: "architectural" });
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  assertEqual(result, "architectural_change_type");
});

// Test 2: Rule 2 — invariant touched + modification keyword → invariant_modification_required
test("Test 2 — invariants_touched + modification keyword triggers invariant_modification_required", () => {
  const proposal = makeProposal({
    invariants_touched: ["auth_model"],
    responsibilities: "Update the auth model to use OAuth2.",
  });
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  assertEqual(result, "invariant_modification_required");
});

// Test 3: Rule 2 — invariant touched but NO modification keyword → rule 2 does NOT trigger
test("Test 3 — invariants_touched but no modification keyword does not trigger rule 2", () => {
  const proposal = makeProposal({
    invariants_touched: ["auth_model"],
    responsibilities: "Read the auth model and return a summary.",
  });
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  // Should not return invariant_modification_required; no other rules fire either
  if (result === "invariant_modification_required") {
    throw new Error(`Expected rule 2 not to fire, got ${result}`);
  }
});

// Test 4: Rule 3 — dependency not in State records and not in tech_stack → new_external_dependency
test("Test 4 — unknown dependency triggers new_external_dependency", () => {
  const proposal = makeProposal({
    dependencies: ["lodash"],
  });
  const knowledge = makeKnowledge(); // tech_stack: typescript, react, node — none include "lodash"
  const result = detectRFCTrigger(proposal, knowledge, makeNoConflict());
  assertEqual(result, "new_external_dependency");
});

// Test 5: Rule 3 — dependency IS in State records → no rule-3 trigger
test("Test 5 — dependency found in State records does not trigger rule 3", () => {
  const proposal = makeProposal({
    dependencies: ["src/services/AuthService.ts"],
  });
  // knowledge.state already has path "src/services/AuthService.ts"
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  if (result === "new_external_dependency") {
    throw new Error("Rule 3 should not fire when dependency is in State records");
  }
});

// Test 6: Rule 3 — dependency is substring of tech_stack entry → no rule-3 trigger
test("Test 6 — dependency covered by tech_stack entry does not trigger rule 3", () => {
  const proposal = makeProposal({
    dependencies: ["react"],
  });
  // "react" IS in knowledge.invariants.tech_stack
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  if (result === "new_external_dependency") {
    throw new Error("Rule 3 should not fire when dependency is in tech_stack");
  }
});

// Test 7: Rule 4 — both high_fan_in AND public_api_signature_changed → high_fan_in_interface_change
test("Test 7 — both fan-in signals trigger high_fan_in_interface_change", () => {
  const proposal = makeProposal({
    risk_signals: makeRiskSignals({
      high_fan_in_module_modified: true,
      public_api_signature_changed: true,
    }),
  });
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  assertEqual(result, "high_fan_in_interface_change");
});

// Test 8: Rule 4 — only ONE signal is true → rule 4 does NOT trigger
test("Test 8 — only one fan-in signal does not trigger rule 4", () => {
  const proposal = makeProposal({
    risk_signals: makeRiskSignals({
      high_fan_in_module_modified: true,
      public_api_signature_changed: false,
    }),
  });
  const result = detectRFCTrigger(proposal, makeKnowledge(), makeNoConflict());
  if (result === "high_fan_in_interface_change") {
    throw new Error("Rule 4 should require BOTH signals to be true");
  }
});

// Test 9: Rule 5 — assumptionConflict.has_conflict true → shared_assumption_conflict
test("Test 9 — has_conflict true triggers shared_assumption_conflict", () => {
  const result = detectRFCTrigger(makeProposal(), makeKnowledge(), makeConflict());
  assertEqual(result, "shared_assumption_conflict");
});

// Test 10: All conditions false → null
test("Test 10 — all conditions false returns null", () => {
  const result = detectRFCTrigger(makeProposal(), makeKnowledge(), makeNoConflict());
  assertEqual(result, null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
