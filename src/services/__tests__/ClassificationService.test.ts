/**
 * ClassificationService.test.ts
 *
 * Tests for Stage 1 deterministic override rules (Section 6.1).
 *
 * Run with:
 *   npx tsx src/services/__tests__/ClassificationService.test.ts
 */

import {
  applyStage1Overrides,
  requiresMandatoryIndividualReview,
  isEligibleForAutoApproval,
} from "../ClassificationService.js";
import type { QueueProposal, RiskSignals, ChangeType, Assumption, ClassificationResult } from "../../types/index.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Baseline risk signals — everything false / neutral. */
function defaultRiskSignals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return {
    touched_auth_or_permission_patterns: false,
    public_api_signature_changed: false,
    invariant_referenced_file_modified: false,
    high_fan_in_module_modified: false,
    ast_change_type: "mechanical",
    mechanical_only: false,
    ...overrides,
  };
}

/** Minimal valid QueueProposal with overridable fields. */
function makeProposal(overrides: {
  change_type?: ChangeType;
  cross_scope_flag?: boolean;
  risk_signals?: Partial<RiskSignals>;
  assumptions?: Assumption[];
} = {}): QueueProposal {
  return {
    proposal_id: "test-001",
    agent_id: "agent-a",
    path: "src/foo.ts",
    semantic_scope: "core",
    scope_schema_version: "1.0.0",
    change_type: overrides.change_type ?? "mechanical",
    responsibilities: "handles foo logic",
    dependencies: [],
    invariants_touched: [],
    assumptions: overrides.assumptions ?? [],
    uncertainty_delta: "+0",
    rationale: "test proposal",
    out_of_scope: false,
    cross_scope_flag: overrides.cross_scope_flag ?? false,
    branch: "feat/test",
    risk_signals: defaultRiskSignals(overrides.risk_signals),
    classification_verification: {
      agent_classification: overrides.change_type ?? "mechanical",
      verifier_classification: "mechanical",
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
    submitted_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Test runner                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✔  ${label}`);
  } else {
    failed++;
    console.error(`  ✘  FAIL: ${label}`);
  }
}

console.log("ClassificationService — Stage 1 overrides\n");

/* ------------------------------------------------------------------ */
/*  Test 1: Rule 1 — mechanical_only true, all other signals false     */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({ change_type: "mechanical", risk_signals: { mechanical_only: true } }),
  );
  assert(result.resolved_change_type === "mechanical", "Test 1: resolved to mechanical");
  assert(result.stage1_override === true, "Test 1: stage1_override is true");
  assert(result.override_reason === "AST confirms mechanical-only change", "Test 1: correct reason");
}

/* ------------------------------------------------------------------ */
/*  Test 2: Rule 1 wins over cross_scope_flag                         */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({
      change_type: "mechanical",
      cross_scope_flag: true,
      risk_signals: { mechanical_only: true },
    }),
  );
  assert(result.resolved_change_type === "mechanical", "Test 2: stays mechanical despite cross_scope_flag");
  assert(result.stage1_override === true, "Test 2: stage1_override is true");
  assert(result.override_reason === "AST confirms mechanical-only change", "Test 2: Rule 1 reason");
}

/* ------------------------------------------------------------------ */
/*  Test 3: Rule 2 — single risk signal contradicts mechanical         */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({
      change_type: "mechanical",
      risk_signals: { touched_auth_or_permission_patterns: true },
    }),
  );
  assert(result.resolved_change_type === "behavioral", "Test 3: overridden to behavioral");
  assert(result.stage1_override === true, "Test 3: stage1_override is true");
  assert(
    result.override_reason !== null &&
    result.override_reason.includes("touched_auth_or_permission_patterns"),
    "Test 3: reason mentions touched_auth_or_permission_patterns",
  );
}

/* ------------------------------------------------------------------ */
/*  Test 4: Rule 2 — two risk signals, reason lists both               */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({
      change_type: "mechanical",
      risk_signals: {
        public_api_signature_changed: true,
        touched_auth_or_permission_patterns: true,
      },
    }),
  );
  assert(result.resolved_change_type === "behavioral", "Test 4: overridden to behavioral");
  assert(result.stage1_override === true, "Test 4: stage1_override is true");
  assert(
    result.override_reason !== null &&
    result.override_reason.includes("touched_auth_or_permission_patterns") &&
    result.override_reason.includes("public_api_signature_changed"),
    "Test 4: reason lists both signals",
  );
}

/* ------------------------------------------------------------------ */
/*  Test 5: Rule 3 — cross_scope_flag, agent says mechanical           */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({
      change_type: "mechanical",
      cross_scope_flag: true,
    }),
  );
  assert(result.resolved_change_type === "behavioral", "Test 5: overridden to behavioral");
  assert(result.stage1_override === true, "Test 5: stage1_override is true");
  assert(
    result.override_reason === "Cross-scope modification cannot be mechanical",
    "Test 5: correct reason",
  );
}

/* ------------------------------------------------------------------ */
/*  Test 6: Rule 4 — agent says behavioral, no signals                 */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({ change_type: "behavioral" }),
  );
  assert(result.resolved_change_type === "behavioral", "Test 6: behavioral unchanged");
  assert(result.stage1_override === false, "Test 6: no override");
  assert(result.override_reason === null, "Test 6: no reason");
}

/* ------------------------------------------------------------------ */
/*  Test 7: Rule 4 — agent says architectural, no signals              */
/* ------------------------------------------------------------------ */
{
  const result = applyStage1Overrides(
    makeProposal({ change_type: "architectural" }),
  );
  assert(result.resolved_change_type === "architectural", "Test 7: architectural unchanged");
  assert(result.stage1_override === false, "Test 7: no override");
  assert(result.override_reason === null, "Test 7: no reason");
}

/* ================================================================== */
console.log("\nisEligibleForAutoApproval\n");
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Test 8: All signals false, mechanical_only true, empty assumptions */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ risk_signals: { mechanical_only: true } });
  const result: ClassificationResult = { resolved_change_type: "mechanical", stage1_override: true, override_reason: "AST confirms mechanical-only change" };
  assert(isEligibleForAutoApproval(proposal, result) === true, "Test 8: eligible for auto-approval");
}

/* ------------------------------------------------------------------ */
/*  Test 9: mechanical_only true but high_fan_in_module_modified true  */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ risk_signals: { mechanical_only: true, high_fan_in_module_modified: true } });
  const result: ClassificationResult = { resolved_change_type: "mechanical", stage1_override: true, override_reason: "AST confirms mechanical-only change" };
  assert(isEligibleForAutoApproval(proposal, result) === false, "Test 9: high_fan_in disqualifies auto-approval");
}

/* ------------------------------------------------------------------ */
/*  Test 10: mechanical_only true but a shared assumption              */
/* ------------------------------------------------------------------ */
{
  const sharedAssumption: Assumption = { id: "a1", text: "DB schema stable", declared_by: "agent-a", scope: "core", shared: true };
  const proposal = makeProposal({ risk_signals: { mechanical_only: true }, assumptions: [sharedAssumption] });
  const result: ClassificationResult = { resolved_change_type: "mechanical", stage1_override: true, override_reason: "AST confirms mechanical-only change" };
  assert(isEligibleForAutoApproval(proposal, result) === false, "Test 10: shared assumption disqualifies auto-approval");
}

/* ------------------------------------------------------------------ */
/*  Test 11: mechanical_only true, only non-shared assumptions         */
/* ------------------------------------------------------------------ */
{
  const privateAssumption: Assumption = { id: "a2", text: "internal detail", declared_by: "agent-a", scope: "core", shared: false };
  const proposal = makeProposal({ risk_signals: { mechanical_only: true }, assumptions: [privateAssumption] });
  const result: ClassificationResult = { resolved_change_type: "mechanical", stage1_override: true, override_reason: "AST confirms mechanical-only change" };
  assert(isEligibleForAutoApproval(proposal, result) === true, "Test 11: non-shared assumptions still eligible");
}

/* ================================================================== */
console.log("\nrequiresMandatoryIndividualReview\n");
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Test 12: touched_auth_or_permission_patterns triggers review       */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ risk_signals: { touched_auth_or_permission_patterns: true } });
  const result: ClassificationResult = { resolved_change_type: "behavioral", stage1_override: true, override_reason: "signals" };
  assert(requiresMandatoryIndividualReview(proposal, result) === true, "Test 12: auth signal triggers review");
}

/* ------------------------------------------------------------------ */
/*  Test 13: only stage1_override true (no risk signals)               */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal();
  const result: ClassificationResult = { resolved_change_type: "behavioral", stage1_override: true, override_reason: "override" };
  assert(requiresMandatoryIndividualReview(proposal, result) === true, "Test 13: stage1_override alone triggers review");
}

/* ------------------------------------------------------------------ */
/*  Test 14: all false, stage1_override false → no mandatory review    */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ change_type: "behavioral" });
  const result: ClassificationResult = { resolved_change_type: "behavioral", stage1_override: false, override_reason: null };
  assert(requiresMandatoryIndividualReview(proposal, result) === false, "Test 14: no signals, no override → no mandatory review");
}

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) {
  process.exit(1);
}
