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
import type { VerifierServiceLike, ExecFileFn } from "../OrchestratorService.js";
import type {
  QueueProposal,
  KnowledgeFile,
  StateRecord,
  OrchestratorSession,
  ScopeDefinition,
  HookConfig,
  ChangeType,
  RiskSignals,
  TaskAssignment,
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
// mergeBranch tests (Tests 12–15)
// ---------------------------------------------------------------------------

console.log("\nOrchestratorService — mergeBranch");
console.log("====================================");

function makeExecFileFn(
  impl: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): ExecFileFn & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fn = async (
    file: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args });
    return impl(file, args);
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as unknown as ExecFileFn & { calls: typeof calls };
}

function makeService(execFileFn: ExecFileFn): OrchestratorService {
  return new OrchestratorService(
    MOCK_FS, MOCK_CTX, DEFAULT_SESSION_BUDGET,
    makeAgreementVerifier(), undefined, execFileFn,
  );
}

// Test 12 — Exit code 0 → success: true
await testAsync(
  "Test 12 — mergeBranch: exit code 0 → success: true",
  async () => {
    const execFn = makeExecFileFn(async () => ({ stdout: "", stderr: "" }));
    const service = makeService(execFn);
    const result = await service.mergeBranch("feat/my-feature", "/repo");
    assertEqual(result.success, true, "success");
    assertEqual(result.conflict, false, "conflict");
    assertEqual(result.error, null, "error");
    if (execFn.calls.length !== 1) {
      throw new Error(`Expected 1 git call, got ${execFn.calls.length}`);
    }
    const args = execFn.calls[0]!.args;
    if (!args.includes("--no-ff")) throw new Error("--no-ff flag must be present");
    if (!args.includes("feat/my-feature")) throw new Error("branch must be in args");
  },
);

// Test 13 — Exit code 1, stderr contains CONFLICT → conflict: true, abort called
await testAsync(
  "Test 13 — mergeBranch: stderr contains CONFLICT → conflict: true, --abort called",
  async () => {
    const execFn = makeExecFileFn(async (_file, args) => {
      if (args.includes("merge") && args.includes("--no-ff")) {
        const err = Object.assign(new Error("merge failed"), {
          stderr: "Auto-merging src/auth.py\nCONFLICT (content): Merge conflict in src/auth.py",
        });
        throw err;
      }
      // --abort call succeeds
      return { stdout: "", stderr: "" };
    });
    const service = makeService(execFn);
    const result = await service.mergeBranch("feat/conflict-branch", "/repo");
    assertEqual(result.success, false, "success");
    assertEqual(result.conflict, true, "conflict");
    if (result.error === null || !result.error.includes("CONFLICT")) {
      throw new Error(`error should contain CONFLICT, got: ${result.error}`);
    }
    // Two calls: merge, then abort
    if (execFn.calls.length !== 2) {
      throw new Error(`Expected 2 git calls (merge + abort), got ${execFn.calls.length}`);
    }
    const abortCall = execFn.calls[1]!;
    if (!abortCall.args.includes("--abort")) {
      throw new Error("Second call should be git merge --abort");
    }
  },
);

// Test 14 — Exit code 1, no CONFLICT in stderr → success: false, conflict: false
await testAsync(
  "Test 14 — mergeBranch: non-zero exit without CONFLICT → success: false, no abort",
  async () => {
    const execFn = makeExecFileFn(async () => {
      const err = Object.assign(new Error("invalid ref"), {
        stderr: "fatal: 'feat/nonexistent' does not appear to be a git repository",
      });
      throw err;
    });
    const service = makeService(execFn);
    const result = await service.mergeBranch("feat/nonexistent", "/repo");
    assertEqual(result.success, false, "success");
    assertEqual(result.conflict, false, "conflict");
    if (result.error === null || result.error.length === 0) {
      throw new Error("error should be populated");
    }
    // Only one call — no --abort
    if (execFn.calls.length !== 1) {
      throw new Error(`Expected 1 git call, got ${execFn.calls.length}`);
    }
  },
);

// Test 15 — Empty branch → error immediately, no git call
await testAsync(
  "Test 15 — mergeBranch: empty branch string → error, no git call",
  async () => {
    let gitCalled = false;
    const execFn = makeExecFileFn(async () => {
      gitCalled = true;
      return { stdout: "", stderr: "" };
    });
    const service = makeService(execFn);
    const result = await service.mergeBranch("", "/repo");
    assertEqual(result.success, false, "success");
    assertEqual(result.conflict, false, "conflict");
    if (result.error !== "No branch specified for merge") {
      throw new Error(`Unexpected error: ${result.error}`);
    }
    if (gitCalled) throw new Error("git must not be called for empty branch");
  },
);

// ---------------------------------------------------------------------------
// runSession tests (Tests 16–20)
// ---------------------------------------------------------------------------

console.log("\nOrchestratorService — runSession");
console.log("====================================");

interface RunSessionMocks {
  fs: SKLFileSystem;
  sessionLogs: unknown[];
  knowledgeWrites: KnowledgeFile[];
}

function makeRunSessionFs(opts: {
  proposals: QueueProposal[];
  writeKnowledgeFn?: (data: KnowledgeFile) => Promise<void>;
}): RunSessionMocks {
  const sessionLogs: unknown[] = [];
  const knowledgeWrites: KnowledgeFile[] = [];
  const knowledge = makeKnowledge([], opts.proposals);

  const fs = {
    repoRoot: "/repo",
    readKnowledge: async () => ({
      ...knowledge,
      queue: [...knowledge.queue],
      state: [...knowledge.state],
    }),
    readScopeDefinitions: async () => SCOPE_DEFS,
    readHookConfig: async () => HOOK_CFG,
    listADRs: async () => [] as string[],
    writeKnowledge:
      opts.writeKnowledgeFn ??
      (async (data: KnowledgeFile) => {
        knowledgeWrites.push(data);
      }),
    writeSessionLog: async (log: unknown) => {
      sessionLogs.push(log);
    },
    getNextSessionId: async () => "session_rs_001",
    readMostRecentSessionLog: async () => null,
  } as unknown as SKLFileSystem;

  return { fs, sessionLogs, knowledgeWrites };
}

// Test 16 — budget cap: 3 proposals, max_proposals: 2 → 2 reviewed, 3rd skipped
await testAsync(
  "Test 16 — runSession: budget cap stops loop after max_proposals reviews",
  async () => {
    resetLmMock();
    const p1 = makeProposal({
      proposal_id: "p-b1",
      path: "src/a.py",
      branch: "feat/b1",
      submitted_at: "2024-01-01T00:00:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });
    const p2 = makeProposal({
      proposal_id: "p-b2",
      path: "src/b.py",
      branch: "feat/b2",
      submitted_at: "2024-01-01T00:01:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });
    const p3 = makeProposal({
      proposal_id: "p-b3",
      path: "src/c.py",
      branch: "feat/b3",
      submitted_at: "2024-01-01T00:02:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });

    const budget = { ...DEFAULT_SESSION_BUDGET, max_proposals: 2 };
    const mocks = makeRunSessionFs({ proposals: [p1, p2, p3] });
    const progressMessages: string[] = [];
    const execFn = makeExecFileFn(async () => ({ stdout: "", stderr: "" }));
    const service = new OrchestratorService(
      mocks.fs,
      MOCK_CTX,
      budget,
      makeAgreementVerifier(),
      undefined,
      execFn,
    );

    await service.runSession((msg) => {
      progressMessages.push(msg);
    });

    // Two knowledge writes (one per reviewed proposal)
    assertEqual(mocks.knowledgeWrites.length, 2, "knowledgeWrites.length");
    // endSession writes exactly one session log
    assertEqual(mocks.sessionLogs.length, 1, "sessionLogs.length");
    // Budget-exceeded message surfaced to caller
    const hasExceeded = progressMessages.some((m) => m.includes("budget exceeded"));
    if (!hasExceeded) {
      throw new Error(
        `Expected budget-exceeded message. Got: ${JSON.stringify(progressMessages)}`,
      );
    }
  },
);

// Test 17 — uncertainty threshold: two consecutive uncertain rationales → break
await testAsync(
  "Test 17 — runSession: consecutive uncertainty at threshold → break with handoff note",
  async () => {
    resetLmMock();
    const p1 = makeProposal({
      proposal_id: "p-u1",
      path: "src/utils/alpha.py",
      branch: "feat/u1",
      submitted_at: "2024-01-01T00:00:00.000Z",
    });
    const p2 = makeProposal({
      proposal_id: "p-u2",
      path: "src/utils/beta.py",
      branch: "feat/u2",
      submitted_at: "2024-01-01T00:01:00.000Z",
    });

    setSelectChatModels(async () => [
      createMockModel("This approach is unclear about the best forward path."),
    ]);

    const budget = {
      ...DEFAULT_SESSION_BUDGET,
      max_proposals: 10,
      self_uncertainty_threshold: 2,
    };
    const mocks = makeRunSessionFs({ proposals: [p1, p2] });
    const progressMessages: string[] = [];
    const execFn = makeExecFileFn(async () => ({ stdout: "", stderr: "" }));
    const service = new OrchestratorService(
      mocks.fs,
      MOCK_CTX,
      budget,
      makeAgreementVerifier(),
      undefined,
      execFn,
    );

    await service.runSession((msg) => {
      progressMessages.push(msg);
    });
    resetLmMock();

    // Uncertainty threshold message surfaced
    const hasUncertain = progressMessages.some((m) =>
      m.includes("Self-uncertainty threshold"),
    );
    if (!hasUncertain) {
      throw new Error(
        `Expected uncertainty threshold message. Got: ${JSON.stringify(progressMessages)}`,
      );
    }
    // Normal endSession (one session log)
    assertEqual(mocks.sessionLogs.length, 1, "sessionLogs.length");
  },
);

// Test 18 — merge conflict: session continues, conflict surfaced via onProgress
await testAsync(
  "Test 18 — runSession: merge conflict reported via onProgress, session not aborted",
  async () => {
    resetLmMock();
    const p1 = makeProposal({
      proposal_id: "p-mc1",
      path: "src/merge/thing.py",
      branch: "feat/mc1",
      submitted_at: "2024-01-01T00:00:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });

    const execFn = makeExecFileFn(async (_file: string, args: string[]) => {
      if (args.includes("--no-ff")) {
        throw Object.assign(new Error("merge conflict"), {
          stderr: "CONFLICT (content): Merge conflict in src/merge/thing.py",
        });
      }
      return { stdout: "", stderr: "" }; // --abort succeeds
    });

    const mocks = makeRunSessionFs({ proposals: [p1] });
    const progressMessages: string[] = [];
    const service = new OrchestratorService(
      mocks.fs,
      MOCK_CTX,
      DEFAULT_SESSION_BUDGET,
      makeAgreementVerifier(),
      undefined,
      execFn,
    );

    await service.runSession((msg) => {
      progressMessages.push(msg);
    });

    // Conflict message reported to caller
    const hasConflict = progressMessages.some(
      (m) => m.includes("⚠️") || m.includes("Merge conflict"),
    );
    if (!hasConflict) {
      throw new Error(
        `Expected merge-conflict message. Got: ${JSON.stringify(progressMessages)}`,
      );
    }
    // Session ends normally after conflict — endSession called once
    assertEqual(mocks.sessionLogs.length, 1, "sessionLogs.length");
  },
);

// Test 19 — write failure: emergency log written, original error rethrown
await testAsync(
  "Test 19 — runSession: writeKnowledge failure → FATAL progress, emergency log, error propagated",
  async () => {
    resetLmMock();
    const p1 = makeProposal({
      proposal_id: "p-wf1",
      path: "src/wf/main.py",
      branch: "feat/wf1",
      submitted_at: "2024-01-01T00:00:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });

    const diskError = new Error("ENOSPC: no space left on device");
    const mocks = makeRunSessionFs({
      proposals: [p1],
      writeKnowledgeFn: async () => {
        throw diskError;
      },
    });
    const progressMessages: string[] = [];
    const execFn = makeExecFileFn(async () => ({ stdout: "", stderr: "" }));
    const service = new OrchestratorService(
      mocks.fs,
      MOCK_CTX,
      DEFAULT_SESSION_BUDGET,
      makeAgreementVerifier(),
      undefined,
      execFn,
    );

    let caughtError: Error | null = null;
    try {
      await service.runSession((msg) => {
        progressMessages.push(msg);
      });
    } catch (err) {
      caughtError = err as Error;
    }

    if (caughtError === null) {
      throw new Error("Expected runSession to throw on write failure");
    }
    if (caughtError !== diskError) {
      throw new Error(
        `Expected original disk error rethrown. Got: ${caughtError.message}`,
      );
    }
    // FATAL progress message emitted before throw
    const hasFatal = progressMessages.some((m) => m.includes("FATAL:"));
    if (!hasFatal) {
      throw new Error(`Expected FATAL message. Got: ${JSON.stringify(progressMessages)}`);
    }
    // Emergency log via writeEmergencyHandoffLog → endSession called exactly once
    assertEqual(mocks.sessionLogs.length, 1, "sessionLogs.length");
  },
);

// Test 20 — happy path: all proposals processed, endSession called once
await testAsync(
  "Test 20 — runSession: happy path — all proposals processed, endSession once",
  async () => {
    resetLmMock();
    const p1 = makeProposal({
      proposal_id: "p-hp1",
      path: "src/hp/alpha.py",
      branch: "feat/hp1",
      submitted_at: "2024-01-01T00:00:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });
    const p2 = makeProposal({
      proposal_id: "p-hp2",
      path: "src/hp/beta.py",
      branch: "feat/hp2",
      submitted_at: "2024-01-01T00:01:00.000Z",
      change_type: "mechanical",
      risk_signals: makeRiskSignals({ mechanical_only: true, ast_change_type: "mechanical" }),
    });

    const mocks = makeRunSessionFs({ proposals: [p1, p2] });
    const execFn = makeExecFileFn(async () => ({ stdout: "", stderr: "" }));
    const service = new OrchestratorService(
      mocks.fs,
      MOCK_CTX,
      DEFAULT_SESSION_BUDGET,
      makeAgreementVerifier(),
      undefined,
      execFn,
    );

    await service.runSession(() => { /* no-op */ });

    // Both proposals written atomically
    assertEqual(mocks.knowledgeWrites.length, 2, "knowledgeWrites.length");
    // endSession called exactly once
    assertEqual(mocks.sessionLogs.length, 1, "sessionLogs.length");
  },
);

// ---------------------------------------------------------------------------
// runTaskAssignment tests (Substage 5.3)
// ---------------------------------------------------------------------------

function makeTaskAssignmentFs(): SKLFileSystem {
  return {
    repoRoot: "/repo",
    readKnowledge: async () => makeKnowledge([], []),
    readScopeDefinitions: async (): Promise<ScopeDefinition> => ({
      scope_definitions: {
        version: "1.0",
        scopes: {
          auth: {
            description: "Authentication scope",
            allowed_path_prefixes: ["src/auth"],
            forbidden_path_prefixes: [],
            permitted_responsibilities: [],
            forbidden_responsibilities: [],
            owner: "agent-alpha",
          },
        },
      },
    }),
    listADRs: async () => [] as string[],
    readADR: async () => ({ id: "adr-1", title: "ADR 1", status: "accepted", context: "", decision: "", consequences: "", created_at: "2024-01-01T00:00:00.000Z" }) as never,
    readHookConfig: async () => HOOK_CFG,
    writeKnowledge: async () => { /* no-op */ },
    writeSessionLog: async () => { /* no-op */ },
    getNextSessionId: async () => "sess-ta-001",
    readMostRecentSessionLog: async () => null,
  } as unknown as SKLFileSystem;
}

const VALID_ASSIGNMENT = {
  agent_id: "agent-alpha",
  semantic_scope: "auth",
  file_scope: "src/auth/tokens.py",
  task_description: "Refactor token logic",
  assignment_rationale: "Improves expiry handling",
};

// TA-1 — valid JSON array of 2 assignments → returns TaskAssignment[] of length 2
await testAsync(
  "TA-1 — runTaskAssignment: valid JSON array of 2 assignments → length 2",
  async () => {
    resetLmMock();
    const two = [VALID_ASSIGNMENT, { ...VALID_ASSIGNMENT, agent_id: "agent-beta" }];
    setSelectChatModels(async () => [createMockModel(JSON.stringify(two))]);
    const service = new OrchestratorService(
      makeTaskAssignmentFs(), MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const result: TaskAssignment[] = await service.runTaskAssignment("Add password reset");
    if (result.length !== 2) throw new Error(`Expected 2 assignments, got ${result.length}`);
    if (result[0]!.agent_id !== "agent-alpha") throw new Error("Wrong agent_id on first assignment");
    resetLmMock();
  },
);

// TA-2 — 1 valid + 1 invalid element → returns array of length 1
await testAsync(
  "TA-2 — runTaskAssignment: 1 valid + 1 invalid element → length 1",
  async () => {
    resetLmMock();
    const mixed = [VALID_ASSIGNMENT, { agent_id: 42, bad_field: true }];
    setSelectChatModels(async () => [createMockModel(JSON.stringify(mixed))]);
    const service = new OrchestratorService(
      makeTaskAssignmentFs(), MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const result: TaskAssignment[] = await service.runTaskAssignment("Add feature");
    if (result.length !== 1) throw new Error(`Expected 1 assignment, got ${result.length}`);
    resetLmMock();
  },
);

// TA-3 — malformed JSON → returns [] without throwing
await testAsync(
  "TA-3 — runTaskAssignment: malformed JSON → returns [] without throwing",
  async () => {
    resetLmMock();
    setSelectChatModels(async () => [createMockModel("NOT VALID JSON {{{")]);
    const service = new OrchestratorService(
      makeTaskAssignmentFs(), MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const result: TaskAssignment[] = await service.runTaskAssignment("Add feature");
    if (result.length !== 0) throw new Error(`Expected [], got length ${result.length}`);
    resetLmMock();
  },
);

// TA-4 — LLM unavailable → returns [] without throwing
await testAsync(
  "TA-4 — runTaskAssignment: LLM unavailable → returns [] without throwing",
  async () => {
    resetLmMock(); // default: no models
    const service = new OrchestratorService(
      makeTaskAssignmentFs(), MOCK_CTX, DEFAULT_SESSION_BUDGET, makeAgreementVerifier(),
    );
    const result: TaskAssignment[] = await service.runTaskAssignment("Add feature");
    if (result.length !== 0) throw new Error(`Expected [], got length ${result.length}`);
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
