/**
 * ConflictDetectionService.test.ts
 *
 * Tests for State conflict detection (Sections 7.2, 7.3) and
 * assumption conflict detection (Section 8.1).
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/ConflictDetectionService.test.ts
 */

import {
  detectStateConflict,
  isUncertaintyLevel3,
  detectAssumptionConflict,
} from "../ConflictDetectionService.js";
import {
  setSelectChatModels,
  resetLmMock,
  createMockModel,
} from "../../testing/configure-lm-mock.js";
import type {
  QueueProposal,
  StateRecord,
  RiskSignals,
  ChangeType,
  Assumption,
} from "../../types/index.js";
import type { OutputChannelLike } from "../VerifierService.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

function makeProposal(overrides: {
  path?: string;
  agent_id?: string;
  change_type?: ChangeType;
  risk_signals?: Partial<RiskSignals>;
} = {}): QueueProposal {
  return {
    proposal_id: "prop-001",
    agent_id: overrides.agent_id ?? "agent-a",
    path: overrides.path ?? "app/auth.py",
    semantic_scope: "core",
    scope_schema_version: "1.0.0",
    change_type: overrides.change_type ?? "behavioral",
    responsibilities: "handles auth",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    uncertainty_delta: "+0",
    rationale: "fix auth",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: "feat/auth",
    risk_signals: defaultRiskSignals(overrides.risk_signals),
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
    submitted_at: new Date().toISOString(),
  };
}

function makeStateRecord(overrides: Partial<StateRecord> = {}): StateRecord {
  return {
    id: overrides.id ?? "state-auth",
    path: overrides.path ?? "app/auth.py",
    semantic_scope: "core",
    scope_schema_version: "1.0.0",
    responsibilities: "handles auth",
    dependencies: overrides.dependencies ?? [],
    invariants_touched: [],
    assumptions: [],
    owner: overrides.owner ?? "agent-a",
    version: 1,
    uncertainty_level: overrides.uncertainty_level ?? 2,
    change_count_since_review: 0,
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
    console.log(`  \u2714  ${label}`);
  } else {
    failed++;
    console.error(`  \u2718  FAIL: ${label}`);
  }
}

console.log("ConflictDetectionService \u2014 State conflict detection\n");

/* ------------------------------------------------------------------ */
/*  Test 1: Same path, same owner \u2192 no conflict                       */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ path: "app/auth.py", agent_id: "agent-a" });
  const records = [makeStateRecord({ path: "app/auth.py", owner: "agent-a" })];
  const result = detectStateConflict(proposal, records);
  assert(result.has_conflict === false, "Test 1: same owner \u2192 no conflict");
  assert(result.conflicting_record === null, "Test 1: no conflicting record");
  assert(result.conflict_description === null, "Test 1: no description");
}

/* ------------------------------------------------------------------ */
/*  Test 2: Same path, different owner \u2192 Check A conflict             */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ path: "app/auth.py", agent_id: "agent-b" });
  const records = [makeStateRecord({ path: "app/auth.py", owner: "agent-a" })];
  const result = detectStateConflict(proposal, records);
  assert(result.has_conflict === true, "Test 2: different owner \u2192 conflict");
  assert(result.conflicting_record !== null, "Test 2: conflicting record present");
  assert(
    result.conflict_description !== null &&
    result.conflict_description.includes("owned by agent-a") &&
    result.conflict_description.includes("agent-b"),
    "Test 2: description mentions both agents",
  );
}

/* ------------------------------------------------------------------ */
/*  Test 3: Downstream impact \u2014 public API changed, different owner   */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({
    path: "app/utils/tokens.py",
    agent_id: "agent-a",
    risk_signals: { public_api_signature_changed: true },
  });
  const records = [
    makeStateRecord({
      id: "state-consumer",
      path: "app/consumer.py",
      owner: "agent-b",
      dependencies: ["app/utils/tokens.py"],
    }),
  ];
  const result = detectStateConflict(proposal, records);
  assert(result.has_conflict === true, "Test 3: downstream impact conflict");
  assert(
    result.conflict_description !== null &&
    result.conflict_description.includes("dependency of state-consumer") &&
    result.conflict_description.includes("agent-b"),
    "Test 3: description mentions dependent record and owner",
  );
}

/* ------------------------------------------------------------------ */
/*  Test 4: Same scenario but public_api_signature_changed: false      */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({
    path: "app/utils/tokens.py",
    agent_id: "agent-a",
    risk_signals: { public_api_signature_changed: false },
  });
  const records = [
    makeStateRecord({
      id: "state-consumer",
      path: "app/consumer.py",
      owner: "agent-b",
      dependencies: ["app/utils/tokens.py"],
    }),
  ];
  const result = detectStateConflict(proposal, records);
  assert(result.has_conflict === false, "Test 4: no public API change \u2192 no Check B conflict");
}

/* ------------------------------------------------------------------ */
/*  Test 5: uncertainty_level 3 \u2192 excluded from Check A, isUncert true */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ path: "app/auth.py", agent_id: "agent-b" });
  const records = [makeStateRecord({ path: "app/auth.py", owner: "agent-a", uncertainty_level: 3 })];

  const conflictResult = detectStateConflict(proposal, records);
  assert(conflictResult.has_conflict === false, "Test 5: uncertainty_level 3 excluded from Check A");

  const uncertResult = isUncertaintyLevel3(proposal, records);
  assert(uncertResult === true, "Test 5: isUncertaintyLevel3 returns true");
}

/* ------------------------------------------------------------------ */
/*  Test 6: No State record for path \u2192 isUncertaintyLevel3 false      */
/* ------------------------------------------------------------------ */
{
  const proposal = makeProposal({ path: "app/new-file.py" });
  const records = [makeStateRecord({ path: "app/auth.py" })];
  const result = isUncertaintyLevel3(proposal, records);
  assert(result === false, "Test 6: no matching record \u2192 isUncertaintyLevel3 false");
}

/* ================================================================== */
console.log("\ndetectAssumptionConflict\n");
/* ================================================================== */

/** Reusable null-logging output channel for tests. */
function silentChannel(): OutputChannelLike & { lines: string[] } {
  const lines: string[] = [];
  return { lines, appendLine(v: string) { lines.push(v); } };
}

function makeAssumption(overrides: Partial<Assumption> = {}): Assumption {
  return {
    id: overrides.id ?? "a1",
    text: overrides.text ?? "DB schema is stable",
    declared_by: overrides.declared_by ?? "agent-a",
    scope: overrides.scope ?? "core",
    shared: overrides.shared ?? false,
    ...overrides,
  };
}

function makeProposalWithAssumptions(overrides: {
  proposal_id?: string;
  agent_id?: string;
  semantic_scope?: string;
  dependencies?: string[];
  assumptions?: Assumption[];
} = {}): QueueProposal {
  return {
    proposal_id: overrides.proposal_id ?? "prop-a",
    agent_id: overrides.agent_id ?? "agent-a",
    path: "app/foo.py",
    semantic_scope: overrides.semantic_scope ?? "core",
    scope_schema_version: "1.0.0",
    change_type: "behavioral",
    responsibilities: "handles foo",
    dependencies: overrides.dependencies ?? [],
    invariants_touched: [],
    assumptions: overrides.assumptions ?? [],
    uncertainty_delta: "+0",
    rationale: "fix",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: "feat/foo",
    risk_signals: {
      touched_auth_or_permission_patterns: false,
      public_api_signature_changed: false,
      invariant_referenced_file_modified: false,
      high_fan_in_module_modified: false,
      ast_change_type: "mechanical",
      mechanical_only: false,
    },
    classification_verification: {
      agent_classification: "behavioral",
      verifier_classification: "behavioral",
      agreement: true,
      stage1_override: false,
    },
    dependency_scan: { undeclared_imports: [], stale_declared_deps: [], cross_scope_undeclared: [] },
    agent_reasoning_summary: "",
    status: "pending",
    submitted_at: new Date().toISOString(),
  };
}

// Async wrapper so we can await detectAssumptionConflict
(async () => {
  /* -------------------------------------------------------------- */
  /*  Test 7: Empty assumptions → no-conflict, no LLM call          */
  /* -------------------------------------------------------------- */
  {
    resetLmMock();
    let llmCalled = false;
    setSelectChatModels(async () => {
      llmCalled = true;
      return [createMockModel("YES\nshould not reach")];
    });
    const current = makeProposalWithAssumptions({ assumptions: [] });
    const other = makeProposalWithAssumptions({ proposal_id: "prop-b", assumptions: [makeAssumption()] });
    const result = await detectAssumptionConflict(current, [other], silentChannel());
    assert(result.has_conflict === false, "Test 7: empty assumptions → no conflict");
    assert(!llmCalled, "Test 7: LLM not called for empty assumptions");
  }

  /* -------------------------------------------------------------- */
  /*  Test 8: Different scopes, no shared deps → pre-filter removes  */
  /* -------------------------------------------------------------- */
  {
    resetLmMock();
    let llmCalled = false;
    setSelectChatModels(async () => {
      llmCalled = true;
      return [createMockModel("YES\nshould not reach")];
    });
    const current = makeProposalWithAssumptions({
      semantic_scope: "auth",
      dependencies: ["app/a.py"],
      assumptions: [makeAssumption({ id: "a1" })],
    });
    const other = makeProposalWithAssumptions({
      proposal_id: "prop-b",
      semantic_scope: "billing",
      dependencies: ["app/b.py"],
      assumptions: [makeAssumption({ id: "b1" })],
    });
    const result = await detectAssumptionConflict(current, [other], silentChannel());
    assert(result.has_conflict === false, "Test 8: different scope/deps → pre-filter removes, no conflict");
    assert(!llmCalled, "Test 8: LLM not called after pre-filter removes all candidates");
  }

  /* -------------------------------------------------------------- */
  /*  Test 9: Same scope, LLM returns YES → conflict detected        */
  /* -------------------------------------------------------------- */
  {
    resetLmMock();
    setSelectChatModels(async () => [
      createMockModel("YES\nBoth assume non-overlapping ownership of the auth table."),
    ]);
    const current = makeProposalWithAssumptions({
      proposal_id: "prop-a",
      semantic_scope: "core",
      assumptions: [makeAssumption({ id: "a1", text: "auth table is mine" })],
    });
    const other = makeProposalWithAssumptions({
      proposal_id: "prop-b",
      semantic_scope: "core",
      assumptions: [makeAssumption({ id: "b1", text: "auth table is also mine" })],
    });
    const result = await detectAssumptionConflict(current, [other], silentChannel());
    assert(result.has_conflict === true, "Test 9: same scope + LLM YES → conflict");
    assert(result.proposal_a_id === "prop-a", "Test 9: proposal_a_id set");
    assert(result.proposal_b_id === "prop-b", "Test 9: proposal_b_id set");
    assert(
      result.conflict_description !== null &&
      result.conflict_description.includes("auth table"),
      "Test 9: description from LLM explanation",
    );
  }

  /* -------------------------------------------------------------- */
  /*  Test 10: Same scope, LLM returns NO → no conflict             */
  /* -------------------------------------------------------------- */
  {
    resetLmMock();
    setSelectChatModels(async () => [
      createMockModel("NO\nThe assumptions are independent."),
    ]);
    const current = makeProposalWithAssumptions({
      semantic_scope: "core",
      assumptions: [makeAssumption({ id: "a1" })],
    });
    const other = makeProposalWithAssumptions({
      proposal_id: "prop-b",
      semantic_scope: "core",
      assumptions: [makeAssumption({ id: "b1" })],
    });
    const result = await detectAssumptionConflict(current, [other], silentChannel());
    assert(result.has_conflict === false, "Test 10: same scope + LLM NO → no conflict");
  }

  /* -------------------------------------------------------------- */
  /*  Test 11: LLM unavailable → no-conflict, no throw, logged      */
  /* -------------------------------------------------------------- */
  {
    resetLmMock(); // no models
    const channel = silentChannel();
    const current = makeProposalWithAssumptions({
      semantic_scope: "core",
      assumptions: [makeAssumption()],
    });
    const other = makeProposalWithAssumptions({
      proposal_id: "prop-b",
      semantic_scope: "core",
      assumptions: [makeAssumption({ id: "b1" })],
    });
    let threw = false;
    let result = { has_conflict: false } as { has_conflict: boolean };
    try {
      result = await detectAssumptionConflict(current, [other], channel);
    } catch {
      threw = true;
    }
    assert(!threw, "Test 11: LLM unavailable does not throw");
    assert(result.has_conflict === false, "Test 11: LLM unavailable → no conflict");
    assert(channel.lines.length > 0, "Test 11: warning logged to output channel");
  }

  /* -------------------------------------------------------------- */
  /*  Test 12: shared:true assumption always survives pre-filter     */
  /* -------------------------------------------------------------- */
  {
    resetLmMock();
    let llmCalled = false;
    setSelectChatModels(async () => {
      llmCalled = true;
      return [createMockModel("NO\nindependent")];
    });
    const current = makeProposalWithAssumptions({
      semantic_scope: "auth",
      dependencies: [],
      assumptions: [makeAssumption({ id: "a1", shared: true })],
    });
    const other = makeProposalWithAssumptions({
      proposal_id: "prop-b",
      semantic_scope: "billing",  // different scope
      dependencies: [],           // no shared deps
      assumptions: [makeAssumption({ id: "b1" })],
    });
    await detectAssumptionConflict(current, [other], silentChannel());
    assert(llmCalled, "Test 12: shared:true assumption survives pre-filter to reach LLM");
  }

  /* ---------------------------------------------------------------- */
  /*  Final summary                                                   */
  /* ---------------------------------------------------------------- */

  resetLmMock();
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed}`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
