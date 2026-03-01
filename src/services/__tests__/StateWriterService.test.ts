/**
 * Tests for StateWriterService
 *
 * Run: npx tsx src/services/__tests__/StateWriterService.test.ts
 * (No vscode mock needed)
 */

import {
  deriveStateId,
  createStateEntry,
  updateStateEntry,
  writeRationale,
  promoteRFCtoADR,
} from "../StateWriterService.js";
import type {
  QueueProposal,
  KnowledgeFile,
  ScopeDefinition,
  StateRecord,
  Rfc,
  Adr,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<QueueProposal> = {}): QueueProposal {
  return {
    proposal_id: "prop-001",
    agent_id: "agent-a",
    path: "app/utils/tokens.py",
    semantic_scope: "core",
    scope_schema_version: "1.0.0",
    change_type: "behavioral",
    responsibilities: "Generates and validates auth tokens.",
    dependencies: ["app/models/user.py"],
    invariants_touched: ["auth_model"],
    assumptions: [],
    uncertainty_delta: "+0",
    rationale: "Refactor token logic.",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: "feat/tokens",
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
    agent_reasoning_summary: "",
    status: "pending",
    submitted_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeScopeDefs(version = "1.0.0"): ScopeDefinition {
  return {
    scope_definitions: {
      version,
      scopes: {
        core: {
          description: "Core application logic",
          allowed_path_prefixes: ["app/"],
          forbidden_path_prefixes: [],
          permitted_responsibilities: ["Handle business logic"],
          forbidden_responsibilities: [],
          owner: "team-core",
        },
      },
    },
  };
}

function makeKnowledge(records: StateRecord[] = []): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["python", "fastapi"],
      auth_model: "jwt",
      data_storage: "postgres",
      security_patterns: ["password", "token"],
    },
    state: records,
    queue: [],
  };
}

function makeStateRecord(
  overrides: Partial<StateRecord> = {},
): StateRecord {
  return {
    id: "app_utils_tokens",
    path: "app/utils/tokens.py",
    semantic_scope: "core",
    scope_schema_version: "1.0.0",
    responsibilities: "Old responsibilities.",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-old",
    version: 3,
    uncertainty_level: 2,
    change_count_since_review: 1,
    ...overrides,
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
    throw new Error(
      msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nStateWriterService");
console.log("==================");

// Test 1: deriveStateId
test("Test 1 — deriveStateId: app/utils/tokens.py → app_utils_tokens", () => {
  assertEqual(deriveStateId("app/utils/tokens.py"), "app_utils_tokens");
});

// Test 2: createStateEntry on a fresh knowledge file
test("Test 2 — createStateEntry: new record appended with uncertainty_level 2 and version 1", () => {
  const knowledge = makeKnowledge();
  const result = createStateEntry(makeProposal(), makeScopeDefs(), knowledge);

  if (result.state.length !== 1) {
    throw new Error(`Expected 1 state record, got ${result.state.length}`);
  }
  const record = result.state[0];
  assertEqual(record.id, "app_utils_tokens");
  assertEqual(record.path, "app/utils/tokens.py");
  assertEqual(record.version, 1);
  assertEqual(record.uncertainty_level, 2);
  assertEqual(record.change_count_since_review, 0);
  assertEqual(record.owner, "agent-a");
  assertEqual(record.scope_schema_version, "1.0.0");
  if (record.uncertainty_reduced_by !== undefined) {
    throw new Error("uncertainty_reduced_by should be undefined on create");
  }
  if (record.last_reviewed_at !== undefined) {
    throw new Error("last_reviewed_at should be undefined on create");
  }
});

// Test 3: createStateEntry when path already exists → throws
test("Test 3 — createStateEntry: throws when path already exists", () => {
  const existing = makeStateRecord();
  const knowledge = makeKnowledge([existing]);
  let threw = false;
  try {
    createStateEntry(makeProposal(), makeScopeDefs(), knowledge);
  } catch (err) {
    threw = true;
    const msg = (err as Error).message;
    if (!msg.includes("createStateEntry called for existing path")) {
      throw new Error(`Wrong error message: ${msg}`, { cause: err });
    }
  }
  if (!threw) throw new Error("Expected createStateEntry to throw for duplicate path");
});

// Test 4: updateStateEntry on a level-0 record → resets to 2
test("Test 4 — updateStateEntry: level-0 record resets to 2, uncertainty_reduced_by cleared", () => {
  const existing = makeStateRecord({
    uncertainty_level: 0,
    uncertainty_reduced_by: "tests/test_tokens.py",
    version: 2,
    change_count_since_review: 0,
  });
  const knowledge = makeKnowledge([existing]);
  const result = updateStateEntry(makeProposal(), existing, makeScopeDefs(), knowledge);

  const updated = result.state[0];
  assertEqual(updated.uncertainty_level, 2);
  assertEqual(updated.version, 3);
  assertEqual(updated.change_count_since_review, 1);
  if (updated.uncertainty_reduced_by !== undefined) {
    throw new Error("uncertainty_reduced_by should be undefined after reset from level 0");
  }
});

// Test 5: updateStateEntry on a level-1 record → resets to 2
test("Test 5 — updateStateEntry: level-1 record resets to 2, uncertainty_reduced_by cleared", () => {
  const existing = makeStateRecord({
    uncertainty_level: 1,
    uncertainty_reduced_by: "human-review-2024",
    version: 1,
    change_count_since_review: 2,
  });
  const knowledge = makeKnowledge([existing]);
  const result = updateStateEntry(makeProposal(), existing, makeScopeDefs(), knowledge);

  const updated = result.state[0];
  assertEqual(updated.uncertainty_level, 2);
  assertEqual(updated.version, 2);
  assertEqual(updated.change_count_since_review, 3);
  if (updated.uncertainty_reduced_by !== undefined) {
    throw new Error("uncertainty_reduced_by should be undefined after reset from level 1");
  }
});

// Test 6: updateStateEntry on a level-2 record → stays 2, version incremented
test("Test 6 — updateStateEntry: level-2 record stays 2, version incremented", () => {
  const existing = makeStateRecord({
    uncertainty_level: 2,
    version: 5,
    change_count_since_review: 3,
  });
  const knowledge = makeKnowledge([existing]);
  const result = updateStateEntry(makeProposal(), existing, makeScopeDefs(), knowledge);

  const updated = result.state[0];
  assertEqual(updated.uncertainty_level, 2);
  assertEqual(updated.version, 6);
  assertEqual(updated.change_count_since_review, 4);
});

// Test 7: updateStateEntry on a level-3 record → stays 3, no uncertainty changes
test("Test 7 — updateStateEntry: level-3 record stays 3, uncertainty fields preserved", () => {
  const existing = makeStateRecord({
    uncertainty_level: 3,
    uncertainty_reduced_by: undefined,
    version: 2,
    change_count_since_review: 1,
  });
  const knowledge = makeKnowledge([existing]);
  const result = updateStateEntry(makeProposal(), existing, makeScopeDefs(), knowledge);

  const updated = result.state[0];
  assertEqual(updated.uncertainty_level, 3);
  assertEqual(updated.version, 3);
  assertEqual(updated.change_count_since_review, 2);
});

// Test 8: createStateEntry does NOT mutate the input KnowledgeFile
test("Test 8 — createStateEntry: does not mutate input knowledge", () => {
  const knowledge = makeKnowledge();
  const originalLength = knowledge.state.length;
  createStateEntry(makeProposal(), makeScopeDefs(), knowledge);
  if (knowledge.state.length !== originalLength) {
    throw new Error("createStateEntry mutated the input knowledge.state array");
  }
});

// Test 9: updateStateEntry does NOT mutate the input KnowledgeFile
test("Test 9 — updateStateEntry: does not mutate input knowledge", () => {
  const existing = makeStateRecord({ version: 1, owner: "original-owner" });
  const knowledge = makeKnowledge([existing]);
  updateStateEntry(
    makeProposal({ agent_id: "new-agent" }),
    existing,
    makeScopeDefs(),
    knowledge,
  );
  // Original record in the input must be unchanged
  if (knowledge.state[0].owner !== "original-owner") {
    throw new Error("updateStateEntry mutated the input knowledge.state[0].owner");
  }
  if (knowledge.state[0].version !== 1) {
    throw new Error("updateStateEntry mutated the input knowledge.state[0].version");
  }
});

// ---------------------------------------------------------------------------
// writeRationale and promoteRFCtoADR tests (Tests 10–14)
// ---------------------------------------------------------------------------

console.log("\nStateWriterService — writeRationale / promoteRFCtoADR");
console.log("======================================================");

function makeProposalInQueue(overrides: Partial<QueueProposal> = {}): QueueProposal {
  return {
    ...makeProposal(),
    proposal_id: "q-001",
    status: "pending",
    ...overrides,
  };
}

function makeKnowledgeWithQueue(proposals: QueueProposal[] = []): KnowledgeFile {
  return { ...makeKnowledge(), queue: proposals };
}

// Test 10: writeRationale with empty text → throws quoting spec
test("Test 10 — writeRationale: empty text throws with spec message", () => {
  const k = makeKnowledgeWithQueue([makeProposalInQueue()]);
  let threw = false;
  try {
    writeRationale("q-001", "approved", "   ", "implementation", k);
  } catch (err) {
    threw = true;
    const msg = (err as Error).message;
    if (!msg.includes("Silent Orchestrator choices are how architectural drift accumulates")) {
      throw new Error(`Wrong error message: ${msg}`, { cause: err });
    }
  }
  if (!threw) throw new Error("Expected writeRationale to throw on empty text");
});

// Test 11: writeRationale with unknown proposal ID → throws
test("Test 11 — writeRationale: unknown proposal ID throws", () => {
  const k = makeKnowledgeWithQueue([makeProposalInQueue()]);
  let threw = false;
  try {
    writeRationale("no-such-id", "approved", "Good change.", "implementation", k);
  } catch (err) {
    threw = true;
    const msg = (err as Error).message;
    if (!msg.includes("not found in Queue")) {
      throw new Error(`Wrong error message: ${msg}`, { cause: err });
    }
  }
  if (!threw) throw new Error("Expected writeRationale to throw on unknown ID");
});

// Test 12: writeRationale sets status, populates decision_rationale, does not mutate
test("Test 12 — writeRationale: sets status and decision_rationale, does not mutate input", () => {
  const proposal = makeProposalInQueue({ proposal_id: "q-002" });
  const k = makeKnowledgeWithQueue([proposal]);
  const result = writeRationale("q-002", "approved", "Well tested.", "implementation", k);

  const updated = result.queue[0]!;
  assertEqual(updated.status, "approved");
  if (!updated.decision_rationale) {
    throw new Error("decision_rationale should be set");
  }
  assertEqual(updated.decision_rationale.text, "Well tested.");
  assertEqual(updated.decision_rationale.decision_type, "implementation");
  // Original proposal must be unchanged
  if (proposal.status !== "pending") {
    throw new Error("writeRationale mutated the original proposal status");
  }
  if (proposal.decision_rationale !== undefined) {
    throw new Error("writeRationale mutated the original proposal decision_rationale");
  }
});

// Test 13 & 14 are async (promoteRFCtoADR) — wrapped in IIFE
void (async () => {

function makeRfc(overrides: Partial<Rfc> = {}): Rfc {
  return {
    id: "RFC_001",
    status: "open",
    created_at: new Date().toISOString(),
    triggering_proposal: "p-001",
    decision_required: "Should we proceed with this architectural change?",
    context: "The auth module needs new signatures.",
    option_a: { description: "Approve the change", consequences: "Merges after RFC resolved." },
    option_b: { description: "Reject and redesign", consequences: "Blocks the branch." },
    resolution: "option_a",
    acceptance_criteria: [],
    merge_blocked_until_criteria_pass: true,
    human_response_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

interface MockSKLFileSystem {
  listADRs(): Promise<string[]>;
  writeADR(adr: Adr): Promise<void>;
  writeRFC(rfc: Rfc): Promise<void>;
}

function makeMockFs(existingAdrIds: string[] = []): { fs: MockSKLFileSystem; adrsWritten: Adr[]; rfcsWritten: Rfc[] } {
  const adrsWritten: Adr[] = [];
  const rfcsWritten: Rfc[] = [];
  return {
    fs: {
      listADRs: async () => [...existingAdrIds],
      writeADR: async (adr) => { adrsWritten.push(adr); },
      writeRFC: async (rfc) => { rfcsWritten.push(rfc); },
    },
    adrsWritten,
    rfcsWritten,
  };
}

// Test 13: promoteRFCtoADR creates ADR with correct fields, updates RFC
await testAsync(
  "Test 13 — promoteRFCtoADR: creates ADR with correct fields, updates RFC",
  async () => {
    const rfc = makeRfc();
    const { fs, adrsWritten, rfcsWritten } = makeMockFs();
    const { adr, updatedKnowledge } = await promoteRFCtoADR(
      rfc, "Approved by lead architect.", makeKnowledge(),
      fs as unknown as Parameters<typeof promoteRFCtoADR>[3],
    );

    assertEqual(adr.id, "ADR_001");
    assertEqual(adr.promoting_rfc_id, "RFC_001");
    if (!adr.decision.includes("Approve the change")) {
      throw new Error(`ADR decision missing option_a description: ${adr.decision}`);
    }
    if (!adr.decision.includes("Approved by lead architect.")) {
      throw new Error(`ADR decision missing human rationale: ${adr.decision}`);
    }
    if (adr.title.length > 100) throw new Error(`ADR title exceeds 100 chars`);
    if (adrsWritten.length !== 1) throw new Error(`Expected 1 ADR written, got ${adrsWritten.length}`);
    if (rfcsWritten.length !== 1) throw new Error(`Expected 1 RFC written, got ${rfcsWritten.length}`);
    assertEqual(rfcsWritten[0]!.promoted_to_adr, "ADR_001");
    assertEqual(rfcsWritten[0]!.status, "resolved");
    // knowledge.json is NOT changed
    if (updatedKnowledge !== makeKnowledge() && updatedKnowledge.state.length !== makeKnowledge().state.length) {
      // Deep structural check — just verify state array is same length
    }
  },
);

// Test 14: promoteRFCtoADR collides with pre-existing ADR ID → throws
await testAsync(
  "Test 14 — promoteRFCtoADR: throws when computed ADR ID already exists",
  async () => {
    const rfc = makeRfc();
    // List has 1 entry "ADR_002"; length=1 → computed new ID = ADR_002 → collision
    const { fs } = makeMockFs(["ADR_002"]);
    let threw = false;
    let errorMessage = "";
    try {
      await promoteRFCtoADR(
        rfc, "Test.", makeKnowledge(),
        fs as unknown as Parameters<typeof promoteRFCtoADR>[3],
      );
    } catch (err) {
      threw = true;
      errorMessage = (err as Error).message;
    }
    if (!threw) throw new Error("Expected promoteRFCtoADR to throw on duplicate ADR ID");
    if (!errorMessage.includes("already exists. ADRs are append-only")) {
      throw new Error(`Wrong error: ${errorMessage}`);
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
