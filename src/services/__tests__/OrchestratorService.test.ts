/**
 * OrchestratorService.test.ts
 *
 * Tests for reviewProposal steps 0–4 (substage 3.7).
 * Steps 5–8 are NOT YET IMPLEMENTED — the function returns a stub
 * "approve" result after step 4 until substage 3.8 completes.
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/OrchestratorService.test.ts
 */

import { OrchestratorService } from "../OrchestratorService.js";
import type { VerifierServiceLike } from "../OrchestratorService.js";
import type {
  QueueProposal,
  KnowledgeFile,
  StateRecord,
  OrchestratorSession,
  ScopeDefinition,
  HookConfig,
  ChangeType,
  RiskSignals,
} from "../../types/index.js";
import { DEFAULT_HOOK_CONFIG, DEFAULT_SESSION_BUDGET } from "../../types/index.js";
import type { SKLFileSystem } from "../SKLFileSystem.js";
import type * as vscode from "vscode";
import {
  setSelectChatModels,
  resetLmMock,
  createMockModel,
} from "../../testing/configure-lm-mock.js";

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
// Minimal mocks
// ---------------------------------------------------------------------------

const MOCK_FS = {} as unknown as SKLFileSystem;
const MOCK_CTX = {} as unknown as vscode.ExtensionContext;

const SCOPE_DEFS: ScopeDefinition = {
  scope_definitions: { version: "1.0", scopes: {} },
};

const HOOK_CFG: HookConfig = { ...DEFAULT_HOOK_CONFIG, circuit_breaker_threshold: 3 };

function makeSession(): OrchestratorSession {
  return {
    session_id: "S001",
    session_start: new Date().toISOString(),
    proposals_reviewed: 0,
    circuit_breaker_counts: {},
    consecutive_uncertain: 0,
    escalations: [],
    rfcs_opened: [],
    uncertain_decisions: [],
    circuit_breakers_triggered: [],
    recurring_patterns_flagged: [],
  };
}

function makeRiskSignals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return {
    touched_auth_or_permission_patterns: false,
    public_api_signature_changed: false,
    invariant_referenced_file_modified: false,
    high_fan_in_module_modified: false,
    ast_change_type: "behavioral",
    mechanical_only: false,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<QueueProposal> = {}): QueueProposal {
  return {
    proposal_id: "p-001",
    agent_id: "agent-alpha",
    path: "src/auth/tokens.py",
    semantic_scope: "auth",
    scope_schema_version: "1.0",
    change_type: "behavioral",
    responsibilities: "Handles token generation",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    uncertainty_delta: "+0",
    rationale: "Refactored token expiry logic",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: "feat/auth-refactor",
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
    agent_reasoning_summary: "Tokens now expire correctly",
    status: "pending",
    submitted_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStateRecord(overrides: Partial<StateRecord> = {}): StateRecord {
  return {
    id: "src_auth_tokens",
    path: "src/auth/tokens.py",
    semantic_scope: "auth",
    scope_schema_version: "1.0",
    responsibilities: "Token generation",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-alpha",
    version: 2,
    uncertainty_level: 2,
    change_count_since_review: 1,
    ...overrides,
  };
}

function makeKnowledge(
  stateRecords: StateRecord[] = [],
  queueProposals: QueueProposal[] = [],
): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["Python", "TypeScript"],
      auth_model: "JWT",
      data_storage: "PostgreSQL",
      security_patterns: ["jwt", "token", "auth", "permission"],
    },
    state: stateRecords,
    queue: queueProposals,
  };
}

/** A verifier that always agrees with the agent classification. */
function makeAgreementVerifier(): VerifierServiceLike & { wasCalled: () => boolean } {
  let called = false;
  return {
    getFileDiff: async () => "",
    runVerifierPass: async (_proposal, agentClassification) => {
      called = true;
      return {
        verifier_classification: agentClassification,
        justification: "mock: agrees",
        agreement: true,
        resolved_classification: agentClassification,
      };
    },
    wasCalled: () => called,
  };
}

/** A verifier that always disagrees: verifier says mechanical, agent said behavioral.
 * Resolved to behavioral (higher risk) — avoids triggering an RFC. */
function makeDisagreementVerifier(): VerifierServiceLike & { wasCalled: () => boolean } {
  let called = false;
  return {
    getFileDiff: async () => "",
    runVerifierPass: async () => {
      called = true;
      return {
        verifier_classification: "mechanical" as ChangeType,
        justification: "mock: disagrees",
        agreement: false,
        resolved_classification: "behavioral" as ChangeType,
      };
    },
    wasCalled: () => called,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nOrchestratorService — reviewProposal steps 0–4");
console.log("================================================");

void (async () => {

// Test 1 — Step 0: Proposal targeting level-3 State record → escalate immediately
await testAsync(
  "Test 1 — level-3 State record → decision 'escalate', returned immediately",
  async () => {
    const contestedRecord = makeStateRecord({ uncertainty_level: 3 });
    const proposal = makeProposal(); // path matches contestedRecord.path
    // proposal must be in knowledge.queue — writeRationale (step 0) reads it from there
    const knowledge = makeKnowledge([contestedRecord], [proposal]);

    // Verifier should NEVER be called in an early-return path
    let verifierCalled = false;
    const verifier: VerifierServiceLike = {
      getFileDiff: async () => { verifierCalled = true; return ""; },
      runVerifierPass: async (_p, c) => {
        verifierCalled = true;
        return { verifier_classification: c, justification: "", agreement: true, resolved_classification: c };
      },
    };

    const service = new OrchestratorService(MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, verifier);
    const { result, updatedSession } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );

    assertEqual(result.decision, "escalate", "decision");
    assertEqual(result.rfc_id, null, "rfc_id");
    assertEqual(result.state_updated, false, "state_updated");
    assertEqual(updatedSession.escalations.length, 1, "escalations.length");
    if (!updatedSession.escalations[0]!.includes("uncertainty level 3")) {
      throw new Error(`Escalation message should mention 'uncertainty level 3'. Got: ${updatedSession.escalations[0]}`);
    }
    if (verifierCalled) throw new Error("Verifier should not be called on step-0 early return");
  },
);

// Test 2 — Step 1: mechanical_only → stage1_override true, verifier skipped
await testAsync(
  "Test 2 — mechanical_only:true → stage1_override fires, verifier pass skipped",
  async () => {
    const proposal = makeProposal({
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });
    // proposal must be in knowledge.queue — writeRationale (step 8 auto_approve) reads it
    const knowledge = makeKnowledge([], [proposal]);

    const verifier = makeAgreementVerifier();
    const service = new OrchestratorService(MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, verifier);
    const { result } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );

    // Stage 1 fires → stage1_override: true → needsVerifierPass returns false
    if (verifier.wasCalled()) {
      throw new Error("Verifier must NOT run when Stage 1 has already resolved");
    }
    // Result is the stub (steps 5–8 not yet done) but proposal was NOT escalated
    if (result.decision === "escalate") {
      throw new Error("mechanical_only proposal must not be escalated");
    }
  },
);

// Test 3 — Step 2: No stage 1 override → verifier pass runs
await testAsync(
  "Test 3 — no stage 1 override → verifier pass runs",
  async () => {
    // behavioral change with no risk signals → stage1_override = false → verifier runs
    const proposal = makeProposal({
      change_type: "behavioral",
      risk_signals: makeRiskSignals(), // all false, mechanical_only false
    });
    // proposal must be in knowledge.queue — writeRationale (step 8) reads it
    const knowledge = makeKnowledge([], [proposal]);

    const verifier = makeAgreementVerifier();
    const service = new OrchestratorService(MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, verifier);
    await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );

    if (!verifier.wasCalled()) {
      throw new Error("Verifier must run when Stage 1 does not produce an override");
    }
  },
);

// Test 4 — Step 2: Verifier disagreement → circuit_breaker_counts incremented
await testAsync(
  "Test 4 — verifier disagreement → circuit_breaker_counts incremented in returned session",
  async () => {
    const proposal = makeProposal({ agent_id: "agent-beta" });
    // proposal must be in queue for writeRationale in step 8
    const knowledge = makeKnowledge([], [proposal]);

    const verifier = makeDisagreementVerifier();
    const service = new OrchestratorService(MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, verifier);
    const { updatedSession } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );

    const count = updatedSession.circuit_breaker_counts["agent-beta"] ?? 0;
    if (count !== 1) {
      throw new Error(
        `circuit_breaker_counts["agent-beta"] should be 1 after 1 disagreement, got ${count}`,
      );
    }
  },
);

// Test 5 — Three disagreements for same agent → circuit_breakers_triggered populated
await testAsync(
  "Test 5 — three disagreements for same agent → circuit_breakers_triggered populated",
  async () => {
    const proposal = makeProposal({ agent_id: "agent-gamma" });
    // proposal must be in queue for writeRationale in each step-8 call
    const knowledge = makeKnowledge([], [proposal]);

    const verifier = makeDisagreementVerifier();
    const service = new OrchestratorService(MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, verifier);

    // Call 1
    const { updatedSession: s1 } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    // Call 2 — pass s1 as session
    const { updatedSession: s2 } = await service.reviewProposal(
      proposal, s1, knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    // Call 3 — pass s2 as session; threshold=3 so breaker trips
    const { updatedSession: s3 } = await service.reviewProposal(
      proposal, s2, knowledge, SCOPE_DEFS, HOOK_CFG,
    );

    const count = s3.circuit_breaker_counts["agent-gamma"] ?? 0;
    if (count !== 3) {
      throw new Error(`Expected circuit_breaker_counts=3, got ${count}`);
    }
    if (s3.circuit_breakers_triggered.length === 0) {
      throw new Error("circuit_breakers_triggered must be populated after threshold is reached");
    }
    if (!s3.circuit_breakers_triggered[0]!.includes("agent-gamma")) {
      throw new Error(`circuit_breakers_triggered entry should reference agent-gamma: ${s3.circuit_breakers_triggered[0]}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Helper: sequential LLM model (returns responses in order)
// ---------------------------------------------------------------------------

function makeSequentialModel(
  responses: string[],
): ReturnType<typeof createMockModel> {
  let callCount = 0;
  return {
    sendRequest: async () => ({
      text: (async function* () {
        yield responses[callCount++ % responses.length] ?? "";
      })(),
    }),
  };
}

function makeRfcFs(): SKLFileSystem {
  return {
    listRFCs: async () => [],
    writeRFC: async () => {},
  } as unknown as SKLFileSystem;
}

const MOCK_RFC_JSON = JSON.stringify({
  decision_required: "Should the auth token logic be refactored?",
  context: "The token expiry logic needs architectural guidance.",
  option_a: { description: "Refactor now", consequences: "API improved." },
  option_b: { description: "Delay", consequences: "Technical debt accrues." },
  option_c: { description: "Reject", consequences: "No change." },
  orchestrator_recommendation: "option_a",
  orchestrator_rationale: "Refactoring now prevents drift.",
});

// ---------------------------------------------------------------------------
// Steps 5–8: decision engine
// ---------------------------------------------------------------------------

console.log("\nOrchestratorService — reviewProposal steps 5–8");
console.log("================================================");

// Test 6 — Eligible mechanical proposal → auto_approve, template rationale, no LLM
await testAsync(
  "Test 6 — eligible mechanical_only → auto_approve, template rationale, no LLM",
  async () => {
    resetLmMock();
    const proposal = makeProposal({
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });
    const knowledge = makeKnowledge([], [proposal]);
    const service = new OrchestratorService(
      MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const { result } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    assertEqual(result.decision, "auto_approve", "decision");
    assertEqual(result.state_updated, true, "state_updated");
    assertEqual(result.rfc_id, null, "rfc_id");
    if (!result.rationale.startsWith("Auto-approved:")) {
      throw new Error(`Expected template rationale, got: ${result.rationale}`);
    }
  },
);

// Test 7 — State conflict (different owner) → reject, LLM called
await testAsync(
  "Test 7 — state conflict → reject, LLM called for rationale",
  async () => {
    resetLmMock();
    const proposal = makeProposal({ agent_id: "agent-delta" });
    // State record for same path, owned by a different agent
    const owningRecord = makeStateRecord({ owner: "agent-alpha" });
    const knowledge = makeKnowledge([owningRecord], [proposal]);
    setSelectChatModels(async () => [
      createMockModel("Rejected due to ownership conflict."),
    ]);
    const service = new OrchestratorService(
      MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const { result } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    assertEqual(result.decision, "reject", "decision");
    assertEqual(result.state_updated, false, "state_updated");
    if (!result.rationale.includes("Rejected") && !result.rationale.includes("rejected")) {
      throw new Error(`Expected reject-related rationale, got: ${result.rationale}`);
    }
    resetLmMock();
  },
);

// Test 8 — Architectural change → RFC trigger, state NOT updated
await testAsync(
  "Test 8 — architectural change → rfc decision, state not updated",
  async () => {
    resetLmMock();
    const proposal = makeProposal({ change_type: "architectural" });
    const knowledge = makeKnowledge([], [proposal]);
    setSelectChatModels(async () => [
      makeSequentialModel([MOCK_RFC_JSON, "An RFC has been opened for architectural review."]),
    ]);
    const service = new OrchestratorService(
      makeRfcFs(), MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const { result } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    assertEqual(result.decision, "rfc", "decision");
    if (result.rfc_id === null) throw new Error("rfc_id should be populated");
    assertEqual(result.state_updated, false, "state_updated");
    resetLmMock();
  },
);

// Test 9 — Shared assumption conflict → RFC trigger
await testAsync(
  "Test 9 — shared assumption conflict → rfc decision",
  async () => {
    resetLmMock();
    const primaryProposal = makeProposal({
      proposal_id: "p-100",
      agent_id: "agent-delta",
      assumptions: [{ id: "a1", text: "JWT stays stable", declared_by: "agent-delta", scope: "auth", shared: true }],
    });
    const otherProposal = makeProposal({
      proposal_id: "p-101",
      agent_id: "agent-epsilon",
      path: "src/auth/other.py",
      assumptions: [{ id: "a2", text: "JWT will change", declared_by: "agent-epsilon", scope: "auth", shared: true }],
    });
    const knowledge = makeKnowledge([], [primaryProposal, otherProposal]);
    // 3 sequential LLM calls: assumption conflict check, RFC JSON, RFC rationale
    setSelectChatModels(async () => [
      makeSequentialModel([
        "YES\nThe assumptions about JWT stability are contradictory.",
        MOCK_RFC_JSON,
        "RFC opened: assumption conflict requires human resolution.",
      ]),
    ]);
    const service = new OrchestratorService(
      makeRfcFs(), MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const { result } = await service.reviewProposal(
      primaryProposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    assertEqual(result.decision, "rfc", "decision");
    if (result.rfc_id === null) throw new Error("rfc_id should be populated");
    resetLmMock();
  },
);

// Test 10 — Approve decision → State record created in updatedKnowledge
await testAsync(
  "Test 10 — approve decision → state record created in updatedKnowledge",
  async () => {
    resetLmMock();
    const proposal = makeProposal({ agent_id: "agent-zeta", proposal_id: "p-200" });
    const knowledge = makeKnowledge([], [proposal]);
    setSelectChatModels(async () => [
      createMockModel("Approved with standard review."),
    ]);
    const service = new OrchestratorService(
      MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const { result, updatedKnowledge } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    assertEqual(result.decision, "approve", "decision");
    assertEqual(result.state_updated, true, "state_updated");
    const stateEntry = updatedKnowledge.state.find((r) => r.path === proposal.path);
    if (!stateEntry) throw new Error("State record should be created for approved proposal");
    assertEqual(stateEntry.owner, "agent-zeta", "stateEntry.owner");
    resetLmMock();
  },
);

// Test 11 — LLM unavailable → falls back to template rationale, does not throw
await testAsync(
  "Test 11 — LLM unavailable → fallback rationale returned without throwing",
  async () => {
    resetLmMock();
    const proposal = makeProposal({ proposal_id: "p-300" });
    const knowledge = makeKnowledge([], [proposal]);
    const service = new OrchestratorService(
      MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const { result } = await service.reviewProposal(
      proposal, makeSession(), knowledge, SCOPE_DEFS, HOOK_CFG,
    );
    // decision is approve (behavioral, no conflicts)
    assertEqual(result.decision, "approve", "decision");
    if (!result.rationale.includes("LLM unavailable for detailed rationale")) {
      throw new Error(`Expected fallback rationale, got: ${result.rationale}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
})();
