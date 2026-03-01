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

/** A verifier that always disagrees: upgrades to architectural. */
function makeDisagreementVerifier(): VerifierServiceLike & { wasCalled: () => boolean } {
  let called = false;
  return {
    getFileDiff: async () => "",
    runVerifierPass: async () => {
      called = true;
      const verifierClass: ChangeType = "architectural";
      return {
        verifier_classification: verifierClass,
        justification: "mock: disagrees",
        agreement: false,
        resolved_classification: verifierClass,
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
    const knowledge = makeKnowledge(); // no state records → no level-3

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
    const knowledge = makeKnowledge();

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
    const knowledge = makeKnowledge();

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
    const knowledge = makeKnowledge();

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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
})();
