/**
 * Tests for RFCService — detectRFCTrigger (Tests 1-10), generateRFC (Tests 11-14),
 * and checkRFCDeadlines (Tests 15-17)
 *
 * Run: npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/RFCService.test.ts
 * (vscode mock required for generateRFC tests)
 */

import { detectRFCTrigger, generateRFC, checkRFCDeadlines } from "../RFCService.js";
import {
  setSelectChatModels,
  resetLmMock,
  createMockModel,
} from "../../testing/configure-lm-mock.js";
import type {
  QueueProposal,
  KnowledgeFile,
  AssumptionConflictResult,
  Rfc,
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
// generateRFC tests (Tests 11–14) — require vscode LM mock
// ---------------------------------------------------------------------------

console.log("\nRFCService.generateRFC");
console.log("======================");

/** Minimal shape that satisfies the two SKLFileSystem methods used by generateRFC. */
interface MockSKLFileSystem {
  listRFCs(): Promise<string[]>;
  writeRFC(rfc: Rfc): Promise<void>;
}

function makeMockFs(existingCount = 0): { fs: MockSKLFileSystem; written: Rfc[] } {
  const written: Rfc[] = [];
  return {
    fs: {
      listRFCs: async () =>
        Array.from({ length: existingCount }, (_, i) =>
          `RFC_${String(i + 1).padStart(3, "0")}`,
        ),
      writeRFC: async (rfc: Rfc) => {
        written.push(rfc);
      },
    },
    written,
  };
}

const VALID_LLM_JSON = JSON.stringify({
  decision_required: "Can this architectural change proceed?",
  context: "The proposal changes auth module signatures used by 4 consumers.",
  option_a: { description: "Approve with RFC", consequences: "Change proceeds under RFC oversight." },
  option_b: { description: "Reject until tests added", consequences: "Blocked until acceptance criteria pass." },
  option_c: { description: "Defer to next sprint", consequences: "Delayed; no immediate impact." },
  orchestrator_recommendation: "option_b",
  orchestrator_rationale: "Public API change needs acceptance criteria before merge.",
});

// Test 11: valid LLM response → RFC written with correct ID, status, flags
void (async () => {
await testAsync(
  "Test 11 — generateRFC: valid LLM response produces correct RFC",
  async () => {
    const { fs, written } = makeMockFs(2); // 2 existing → new ID is RFC_003
    setSelectChatModels(async () => [createMockModel(VALID_LLM_JSON)]);
    const rfc = await generateRFC(
      makeProposal({ change_type: "architectural" }),
      "architectural_change_type",
      null,
      makeKnowledge(),
      fs as unknown as Parameters<typeof generateRFC>[4],
    );
    assertEqual(rfc.id, "RFC_003");
    assertEqual(rfc.status, "open");
    assertEqual(rfc.merge_blocked_until_criteria_pass, true);
    assertEqual(rfc.triggering_proposal, "p-001");
    if (written.length !== 1) throw new Error(`Expected writeRFC called once, got ${written.length}`);
    resetLmMock();
  },
);

// Test 12: first LLM response fails Zod → retry made with error text appended
await testAsync(
  "Test 12 — generateRFC: Zod failure on first attempt triggers retry",
  async () => {
    const { fs } = makeMockFs(0);
    let callCount = 0;
    let secondPrompt = "";
    setSelectChatModels(async () => [{
      sendRequest: async (messages: unknown[]) => {
        callCount++;
        if (callCount === 2) {
          // Capture the retry prompt (content field from LanguageModelChatMessage.User)
          const msg = messages[0] as { content: string };
          secondPrompt = msg.content;
        }
        return {
          text: (async function* () {
            yield callCount === 1
              ? JSON.stringify({ decision_required: "only this field" }) // missing required fields
              : VALID_LLM_JSON;
          })(),
        };
      },
    }]);
    await generateRFC(
      makeProposal(),
      "architectural_change_type",
      null,
      makeKnowledge(),
      fs as unknown as Parameters<typeof generateRFC>[4],
    );
    if (callCount !== 2) throw new Error(`Expected 2 LLM calls, got ${callCount}`);
    if (!secondPrompt.includes("failed validation with these errors")) {
      throw new Error("Retry prompt should contain validation error message");
    }
    resetLmMock();
  },
);

// Test 13: both LLM attempts fail validation → throws with descriptive message
await testAsync(
  "Test 13 — generateRFC: both attempts fail → throws RFC generation error",
  async () => {
    const { fs } = makeMockFs(0);
    setSelectChatModels(async () => [createMockModel("{ \"bad\": true }")]);
    let threw = false;
    let errorMessage = "";
    try {
      await generateRFC(
        makeProposal(),
        "architectural_change_type",
        null,
        makeKnowledge(),
        fs as unknown as Parameters<typeof generateRFC>[4],
      );
    } catch (err) {
      threw = true;
      errorMessage = (err as Error).message;
    }
    if (!threw) throw new Error("Expected generateRFC to throw when both attempts fail");
    if (!errorMessage.includes("RFC generation failed after retry")) {
      throw new Error(`Error message missing expected prefix; got: ${errorMessage}`);
    }
    resetLmMock();
  },
);

// Test 14: shared_assumption_conflict trigger → prompt contains both assumption texts
await testAsync(
  "Test 14 — generateRFC: shared_assumption_conflict includes both assumption texts in prompt",
  async () => {
    const { fs } = makeMockFs(0);
    let capturedPrompt = "";
    setSelectChatModels(async () => [{
      sendRequest: async (messages: unknown[]) => {
        const msg = messages[0] as { content: string };
        capturedPrompt = msg.content;
        return {
          text: (async function* () { yield VALID_LLM_JSON; })(),
        };
      },
    }]);
    const conflict = makeConflict();
    await generateRFC(
      makeProposal(),
      "shared_assumption_conflict",
      conflict,
      makeKnowledge(),
      fs as unknown as Parameters<typeof generateRFC>[4],
    );
    const textA = conflict.assumption_a!.text;
    const textB = conflict.assumption_b!.text;
    if (!capturedPrompt.includes(textA)) {
      throw new Error(`Prompt missing assumption A text: "${textA}"`);
    }
    if (!capturedPrompt.includes(textB)) {
      throw new Error(`Prompt missing assumption B text: "${textB}"`);
    }
    if (!capturedPrompt.includes("Promote assumption to Invariant")) {
      throw new Error("Prompt missing forced option_a instruction");
    }
    resetLmMock();
  },
);

// ---------------------------------------------------------------------------
// checkRFCDeadlines tests (Tests 15–17)
// ---------------------------------------------------------------------------

console.log("\nRFCService.checkRFCDeadlines");
console.log("=============================");

/** Minimal valid RFC fixture. */
function makeRfc(overrides: Partial<Rfc> = {}): Rfc {
  const now = new Date();
  return {
    id: "RFC_001",
    status: "open",
    created_at: now.toISOString(),
    triggering_proposal: "p-001",
    decision_required: "Should we proceed?",
    context: "Context for the decision.",
    option_a: { description: "Approve", consequences: "Proceed." },
    option_b: { description: "Reject", consequences: "Block." },
    acceptance_criteria: [],
    merge_blocked_until_criteria_pass: true,
    human_response_deadline: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

/** Build a mock SKLFileSystem stub with a fixed RFC list. */
function makeFsWithRFCs(rfcs: Rfc[]): Parameters<typeof checkRFCDeadlines>[0] {
  return {
    listRFCs: async () => rfcs.map((r) => r.id),
    readRFC: async (id: string) => {
      const found = rfcs.find((r) => r.id === id);
      if (!found) throw new Error(`RFC ${id} not found`);
      return found;
    },
  } as unknown as Parameters<typeof checkRFCDeadlines>[0];
}

// Test 15: open RFC with past deadline → returned
await testAsync(
  "Test 15 — checkRFCDeadlines: open RFC with past deadline is returned",
  async () => {
    const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const rfc = makeRfc({ id: "RFC_001", status: "open", human_response_deadline: pastDeadline });
    const result = await checkRFCDeadlines(makeFsWithRFCs([rfc]));
    if (result.length !== 1 || result[0].id !== "RFC_001") {
      throw new Error(`Expected RFC_001 in result, got: ${JSON.stringify(result.map((r) => r.id))}`);
    }
  },
);

// Test 16: open RFC with future deadline → not returned
await testAsync(
  "Test 16 — checkRFCDeadlines: open RFC with future deadline is not returned",
  async () => {
    const futureDeadline = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    const rfc = makeRfc({ id: "RFC_002", status: "open", human_response_deadline: futureDeadline });
    const result = await checkRFCDeadlines(makeFsWithRFCs([rfc]));
    if (result.length !== 0) {
      throw new Error(`Expected empty result, got: ${JSON.stringify(result.map((r) => r.id))}`);
    }
  },
);

// Test 17: resolved RFC with past deadline → not returned
await testAsync(
  "Test 17 — checkRFCDeadlines: resolved RFC with past deadline is not returned",
  async () => {
    const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const rfc = makeRfc({ id: "RFC_003", status: "resolved", human_response_deadline: pastDeadline });
    const result = await checkRFCDeadlines(makeFsWithRFCs([rfc]));
    if (result.length !== 0) {
      throw new Error(`Expected empty result for resolved RFC, got: ${JSON.stringify(result.map((r) => r.id))}`);
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
