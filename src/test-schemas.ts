/**
 * test-schemas.ts
 *
 * Validates the Zod schemas by parsing a valid and an invalid KnowledgeFile.
 * Run with: npx tsx src/test-schemas.ts
 */

import {
  KnowledgeFileSchema,
  RfcSchema,
  AdrSchema,
  SessionLogSchema,
  RiskSignalsSchema,
} from "./types/index.js";

// ─── Valid KnowledgeFile ────────────────────────────────────────────

const validKnowledgeFile = {
  invariants: {
    tech_stack: ["Python 3.11", "FastAPI", "SQLAlchemy 2.0"],
    auth_model: "JWT over Bearer header",
    data_storage: "PostgreSQL only",
    security_patterns: [
      "@require_auth",
      "@login_required",
      "verify_",
      "check_permission",
      "is_authorized",
    ],
  },
  state: [
    {
      id: "router_auth",
      path: "app/routers/auth.py",
      semantic_scope: "auth",
      scope_schema_version: "1.0",
      responsibilities: "Login, token refresh, password reset endpoints.",
      dependencies: ["app/utils/tokens.py", "app/schemas.py"],
      invariants_touched: ["auth_model"],
      assumptions: [
        {
          id: "assume_jwt_secret_env",
          text: "JWT secret is always available as an environment variable at startup.",
          declared_by: "Agent-1",
          scope: "auth",
          shared: false,
        },
      ],
      owner: "Agent-1",
      version: 4,
      uncertainty_level: 1,
      uncertainty_reduced_by: "tests/test_auth.py",
      last_reviewed_at: "2025-06-01",
      change_count_since_review: 2,
    },
  ],
  queue: [
    {
      proposal_id: "prop_042",
      agent_id: "Agent-1",
      path: "app/utils/tokens.py",
      semantic_scope: "auth",
      scope_schema_version: "1.0",
      change_type: "behavioral",
      responsibilities: "Token generation for password reset links.",
      dependencies: ["app/routers/auth.py"],
      invariants_touched: [],
      assumptions: [
        {
          id: "assume_token_ttl_config",
          text: "Token TTL is configurable via APP_TOKEN_TTL env variable.",
          declared_by: "Agent-1",
          scope: "auth",
          shared: false,
        },
      ],
      uncertainty_delta: "+1",
      rationale:
        "No existing utility covered secure reset token generation.",
      out_of_scope: false,
      cross_scope_flag: false,
      branch: "feature/auth-reset",
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
      agent_reasoning_summary:
        "Considered using PyJWT directly in the router but extracted to utility to keep router thin and allow reuse.",
      status: "pending",
      submitted_at: "2025-06-01T14:23:00Z",
    },
  ],
};

// ─── Invalid KnowledgeFile — multiple violations ────────────────────

const invalidKnowledgeFile = {
  invariants: {
    tech_stack: "not-an-array", // ← should be string[]
    auth_model: 123, // ← should be string
    // data_storage missing entirely
    security_patterns: [],
  },
  state: [
    {
      id: "router_auth",
      path: "app/routers/auth.py",
      semantic_scope: "auth",
      scope_schema_version: "1.0",
      responsibilities: "Login endpoints.",
      dependencies: ["app/utils/tokens.py"],
      invariants_touched: ["auth_model"],
      assumptions: [],
      owner: "Agent-1",
      version: -1, // ← negative version
      uncertainty_level: 5, // ← invalid: must be 0-3
      change_count_since_review: 0,
    },
  ],
  queue: [],
};

// ─── Run tests ──────────────────────────────────────────────────────

console.log("=== Test 1: Valid KnowledgeFile ===");
const validResult = KnowledgeFileSchema.safeParse(validKnowledgeFile);
if (validResult.success) {
  console.log("PASS — Valid KnowledgeFile parsed successfully.");
  console.log(
    `  State entries: ${validResult.data.state.length}`,
  );
  console.log(
    `  Queue proposals: ${validResult.data.queue.length}`,
  );
  console.log(
    `  First state uncertainty_level: ${validResult.data.state[0].uncertainty_level}`,
  );
} else {
  console.error("FAIL — Valid KnowledgeFile was rejected:");
  console.error(validResult.error.format());
  process.exit(1);
}

console.log("");
console.log("=== Test 2: Invalid KnowledgeFile ===");
const invalidResult = KnowledgeFileSchema.safeParse(invalidKnowledgeFile);
if (!invalidResult.success) {
  console.log("PASS — Invalid KnowledgeFile was correctly rejected.");
  console.log("  Errors found:");
  for (const issue of invalidResult.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — Invalid KnowledgeFile should have been rejected but was accepted.");
  process.exit(1);
}

console.log("");
console.log("All KnowledgeFile tests passed.");

// ═══════════════════════════════════════════════════════════════════
// RFC Tests (Section 9.2)
// ═══════════════════════════════════════════════════════════════════

const validRfc = {
  id: "RFC_004",
  status: "open",
  created_at: "2025-06-01T14:23:00Z",
  triggering_proposal: "prop_039",
  decision_required: "Whether to introduce a Redis cache layer.",
  context: "Agent-2 proposes Redis for session management.",
  option_a: {
    description: "Approve. Add Redis to tech stack.",
    consequences: "Requires updating Invariants.",
  },
  option_b: {
    description: "Reject. Keep PostgreSQL.",
    consequences: "Maintains single data store.",
  },
};

console.log("");
console.log("=== Test 3: Valid RFC ===");
const rfcValid = RfcSchema.safeParse(validRfc);
if (rfcValid.success) {
  console.log("PASS — Valid RFC parsed successfully.");
} else {
  console.error("FAIL — Valid RFC was rejected:");
  console.error(rfcValid.error.format());
  process.exit(1);
}

console.log("");
console.log("=== Test 4: Invalid RFC — missing decision_required ===");
const { decision_required: _unused, ...rfcMissingField } = validRfc;
void _unused;
const rfcInvalid = RfcSchema.safeParse(rfcMissingField);
if (!rfcInvalid.success) {
  console.log("PASS — RFC missing decision_required was correctly rejected.");
  for (const issue of rfcInvalid.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — RFC without decision_required should have been rejected.");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// ADR Tests (Section 9.5)
// ═══════════════════════════════════════════════════════════════════

const validAdr = {
  id: "ADR_003",
  created_at: "2025-06-02T15:00:00Z",
  title: "Use PostgreSQL for session storage",
  context: "Redis was considered but rejected to maintain single data store.",
  decision: "Keep all session data in PostgreSQL.",
  consequences: "May need query optimization if auth load increases.",
  promoting_rfc_id: "RFC_004",
};

console.log("");
console.log("=== Test 5: Valid ADR ===");
const adrValid = AdrSchema.safeParse(validAdr);
if (adrValid.success) {
  console.log("PASS — Valid ADR parsed successfully.");
} else {
  console.error("FAIL — Valid ADR was rejected:");
  console.error(adrValid.error.format());
  process.exit(1);
}

console.log("");
console.log("=== Test 6: Invalid ADR — updated_at field present ===");
const adrWithUpdatedAt = {
  ...validAdr,
  updated_at: "2025-07-01T10:00:00Z",
};
const adrInvalid = AdrSchema.safeParse(adrWithUpdatedAt);
if (!adrInvalid.success) {
  console.log("PASS — ADR with updated_at was correctly rejected by refinement.");
  for (const issue of adrInvalid.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — ADR with updated_at should have been rejected.");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// SessionLog Tests (Section 7.5.1)
// ═══════════════════════════════════════════════════════════════════

const validSessionLog = {
  session_id: "session_003",
  proposals_reviewed: 12,
  session_start: "2025-06-01T09:00:00Z",
  session_end: "2025-06-01T10:23:00Z",
  recurring_patterns_flagged: [
    "Agent-2 consistently misclassifies cross-scope utility imports as behavioral",
  ],
  escalations: ["prop_038 escalated: uncertainty level 3 on router_auth"],
  rfcs_opened: ["RFC_005"],
  uncertain_decisions: ["prop_041 — two valid approaches; recommend human review"],
  circuit_breakers_triggered: [],
};

console.log("");
console.log("=== Test 7: Valid SessionLog ===");
const slValid = SessionLogSchema.safeParse(validSessionLog);
if (slValid.success) {
  console.log("PASS — Valid SessionLog parsed successfully.");
} else {
  console.error("FAIL — Valid SessionLog was rejected:");
  console.error(slValid.error.format());
  process.exit(1);
}

console.log("");
console.log("=== Test 8: Invalid SessionLog — non-ISO date string ===");
const badDateSessionLog = {
  ...validSessionLog,
  session_start: "June 1st 2025 at 9am", // ← not ISO 8601
};
const slInvalid = SessionLogSchema.safeParse(badDateSessionLog);
if (!slInvalid.success) {
  console.log("PASS — SessionLog with non-ISO date was correctly rejected.");
  for (const issue of slInvalid.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — SessionLog with bad date should have been rejected.");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// RiskSignals Tests (Section 5.1, Check 3)
// ═══════════════════════════════════════════════════════════════════

console.log("");
console.log("=== Test 9: Valid RiskSignals (ast_change_type: structural) ===");
const validRisk = {
  touched_auth_or_permission_patterns: true,
  public_api_signature_changed: false,
  invariant_referenced_file_modified: false,
  high_fan_in_module_modified: false,
  ast_change_type: "structural",
  mechanical_only: false,
};
const riskValid = RiskSignalsSchema.safeParse(validRisk);
if (riskValid.success) {
  console.log("PASS — Valid RiskSignals parsed successfully.");
} else {
  console.error("FAIL — Valid RiskSignals was rejected:");
  console.error(riskValid.error.format());
  process.exit(1);
}

console.log("");
console.log("=== Test 10: Invalid RiskSignals — ast_change_type 'architectural' ===");
const badRisk = {
  ...validRisk,
  ast_change_type: "architectural", // ← wrong enum for AST context
};
const riskInvalid = RiskSignalsSchema.safeParse(badRisk);
if (!riskInvalid.success) {
  console.log("PASS — RiskSignals with 'architectural' ast_change_type was correctly rejected.");
  for (const issue of riskInvalid.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — RiskSignals with 'architectural' should have been rejected.");
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════
// Test 11: Invalid AgentContext — session_start not ISO datetime
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Test 11: Invalid AgentContext — bad session_start ===");

import { AgentContextSchema } from "./types/index.js";

const badAgentDate = AgentContextSchema.safeParse({
  agent_id: "agent-1",
  semantic_scope: "core",
  file_scope: ["src/index.ts"],
  session_start: "not-a-date",
  circuit_breaker_count: 0,
});
if (!badAgentDate.success) {
  console.log("PASS — AgentContext with 'not-a-date' session_start was correctly rejected.");
  for (const issue of badAgentDate.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — AgentContext with bad session_start should have been rejected.");
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════
// Test 12: Invalid AgentContext — circuit_breaker_count negative
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== Test 12: Invalid AgentContext — negative circuit_breaker_count ===");

const badAgentCount = AgentContextSchema.safeParse({
  agent_id: "agent-1",
  semantic_scope: "core",
  file_scope: ["src/index.ts"],
  session_start: "2026-02-28T12:00:00Z",
  circuit_breaker_count: -1,
});
if (!badAgentCount.success) {
  console.log("PASS — AgentContext with circuit_breaker_count: -1 was correctly rejected.");
  for (const issue of badAgentCount.error.issues) {
    console.log(`    - [${issue.path.join(".")}] ${issue.message}`);
  }
} else {
  console.error("FAIL — AgentContext with negative circuit_breaker_count should have been rejected.");
  process.exit(1);
}

console.log("");
console.log("════════════════════════════════════");
console.log("All 12 tests passed.");
console.log("════════════════════════════════════");
