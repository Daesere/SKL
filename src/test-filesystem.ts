/**
 * test-filesystem.ts
 *
 * End-to-end smoke test for SKLFileSystem:
 *   1. findRepoRoot — locates the .git directory
 *   2. writeKnowledge — atomic temp-and-rename write
 *   3. readKnowledge — reads back and Zod-validates
 *   4. Corrupt file — proves SKLValidationError is thrown
 *   5. ensureSKLStructure — creates subdirectories + .gitkeep files
 *   6. listRFCs on empty dir — returns [] rather than throwing
 *   7. SKLFileNotFoundError on missing knowledge.json
 *   8. readHookConfig on missing file — returns DEFAULT_HOOK_CONFIG
 *
 * Run with: npx tsx --require ./src/testing/register-vscode-mock.cjs src/test-filesystem.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKLFileSystem } from "./services/index.js";
import {
  SKLValidationError,
  SKLFileNotFoundError,
} from "./errors/index.js";
import type { KnowledgeFile } from "./types/index.js";

const VALID_KNOWLEDGE: KnowledgeFile = {
  invariants: {
    tech_stack: ["Python 3.11", "FastAPI"],
    auth_model: "JWT over Bearer header",
    data_storage: "PostgreSQL only",
    security_patterns: ["@require_auth"],
  },
  state: [
    {
      id: "router_auth",
      path: "app/routers/auth.py",
      semantic_scope: "auth",
      scope_schema_version: "1.0",
      responsibilities: "Login endpoints.",
      dependencies: [],
      invariants_touched: ["auth_model"],
      assumptions: [],
      owner: "Agent-1",
      version: 1,
      uncertainty_level: 2,
      change_count_since_review: 0,
    },
  ],
  queue: [],
};

async function main(): Promise<void> {
  // 1. findRepoRoot
  console.log("=== Test 1: findRepoRoot ===");
  const skl = await SKLFileSystem.create();
  console.log(`PASS — Repo root found. sklDir: ${skl.sklDir}`);

  // 2. writeKnowledge (atomic)
  console.log("\n=== Test 2: writeKnowledge (atomic) ===");
  await skl.writeKnowledge(VALID_KNOWLEDGE);
  console.log(`PASS — knowledge.json written at ${skl.knowledgePath}`);

  // Verify no .tmp file is left behind
  try {
    await fs.stat(skl.knowledgePath + ".tmp");
    console.error("FAIL — .tmp file still exists after rename");
    process.exit(1);
  } catch {
    console.log("PASS — No leftover .tmp file");
  }

  // 3. readKnowledge
  console.log("\n=== Test 3: readKnowledge ===");
  const data = await skl.readKnowledge();
  console.log(`PASS — Read back ${data.state.length} state record(s), ${data.queue.length} queue proposal(s).`);

  // 4. Corrupt the file and read again
  console.log("\n=== Test 4: SKLValidationError on corrupt file ===");
  await fs.writeFile(skl.knowledgePath, '{"invariants": "bad"}', "utf-8");
  try {
    await skl.readKnowledge();
    console.error("FAIL — Should have thrown SKLValidationError");
    process.exit(1);
  } catch (err) {
    if (err instanceof SKLValidationError) {
      console.log("PASS — SKLValidationError thrown as expected:");
      console.log(`  ${err.zodError.issues.length} Zod issue(s)`);
    } else {
      throw err;
    }
  }

  // ── Test 5: ensureSKLStructure ──────────────────────────────────
  console.log("\n=== Test 5: ensureSKLStructure ===");
  // Clean slate — remove .skl entirely, then rebuild structure
  await fs.rm(skl.sklDir, { recursive: true, force: true });
  await skl.ensureSKLStructure();

  const expectedDirs = ["rfcs", "adrs", "orchestrator_log", "scratch"];
  for (const sub of expectedDirs) {
    const dirPath = path.join(skl.sklDir, sub);
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      console.error(`FAIL — ${sub}/ is not a directory`);
      process.exit(1);
    }

    const gitkeep = path.join(dirPath, ".gitkeep");
    try {
      await fs.stat(gitkeep);
    } catch {
      console.error(`FAIL — ${sub}/.gitkeep does not exist`);
      process.exit(1);
    }
  }
  console.log(
    `PASS — All 4 subdirectories and .gitkeep files created: ${expectedDirs.join(", ")}`,
  );

  // Run a second time to prove idempotency (never overwrites)
  await skl.ensureSKLStructure();
  console.log("PASS — Second call is idempotent (no errors)");

  // ── Test 6: listRFCs returns [] on empty rfcs/ ─────────────────
  console.log("\n=== Test 6: listRFCs on empty directory ===");
  const rfcIds = await skl.listRFCs();
  if (Array.isArray(rfcIds) && rfcIds.length === 0) {
    console.log("PASS — listRFCs() returned empty array on empty rfcs/");
  } else {
    console.error("FAIL — expected empty array, got:", rfcIds);
    process.exit(1);
  }

  // ── Test 7: readKnowledge on missing file → SKLFileNotFoundError ─
  console.log("\n=== Test 7: SKLFileNotFoundError on missing knowledge.json ===");
  // knowledge.json was removed by the rm above
  try {
    await skl.readKnowledge();
    console.error("FAIL — Should have thrown SKLFileNotFoundError");
    process.exit(1);
  } catch (err) {
    if (err instanceof SKLFileNotFoundError) {
      console.log("PASS — SKLFileNotFoundError thrown as expected");
      console.log(`  path: ${err.path}`);
    } else {
      throw err;
    }
  }

  // ── Test 8: readHookConfig returns DEFAULT_HOOK_CONFIG if absent ─
  console.log("\n=== Test 8: readHookConfig on missing file ===" );
  // hook_config.json does not exist — should return defaults, not throw
  const { DEFAULT_HOOK_CONFIG } = await import("./types/index.js");
  const config = await skl.readHookConfig();
  if (
    config.skl_version === DEFAULT_HOOK_CONFIG.skl_version &&
    config.queue_max === DEFAULT_HOOK_CONFIG.queue_max &&
    config.circuit_breaker_threshold === DEFAULT_HOOK_CONFIG.circuit_breaker_threshold &&
    config.review_threshold === DEFAULT_HOOK_CONFIG.review_threshold &&
    config.base_branch === DEFAULT_HOOK_CONFIG.base_branch &&
    config.python_executable === DEFAULT_HOOK_CONFIG.python_executable
  ) {
    console.log("PASS — readHookConfig() returned DEFAULT_HOOK_CONFIG when file absent");
  } else {
    console.error("FAIL — readHookConfig() did not return expected defaults:", config);
    process.exit(1);
  }

  // ── Test 9: getNextSessionId on empty orchestrator_log/ ────────
  console.log("\n=== Test 9: getNextSessionId on empty orchestrator_log/ ===");
  // ensureSKLStructure already ran above, so orchestrator_log/ exists but is empty
  await skl.ensureSKLStructure();
  const nextId = await skl.getNextSessionId();
  if (nextId === "session_001") {
    console.log(`PASS — getNextSessionId() returned "${nextId}" on empty dir`);
  } else {
    console.error(`FAIL — expected "session_001", got "${nextId}"`);
    process.exit(1);
  }

  // ── Test 10: readMostRecentSessionLog returns null on empty dir ─
  console.log("\n=== Test 10: readMostRecentSessionLog on empty dir ===");
  const recentLog = await skl.readMostRecentSessionLog();
  if (recentLog === null) {
    console.log("PASS — readMostRecentSessionLog() returned null without throwing");
  } else {
    console.error("FAIL — expected null, got:", recentLog);
    process.exit(1);
  }

  // ── Test 11: isSessionBudgetExceeded — proposals_reviewed at max ─
  console.log("\n=== Test 11: isSessionBudgetExceeded — proposals at max ===");
  const { OrchestratorService } = await import("./services/index.js");
  const { DEFAULT_SESSION_BUDGET: budget } = await import("./types/index.js");

  // Minimal vscode.ExtensionContext stub for construction
  const fakeContext = {} as import("vscode").ExtensionContext;
  const orch = new OrchestratorService(skl, fakeContext, budget);

  const sessionAtMax: import("./types/index.js").OrchestratorSession = {
    session_id: "session_001",
    session_start: new Date().toISOString(),
    proposals_reviewed: budget.max_proposals,
    circuit_breaker_counts: {},
    consecutive_uncertain: 0,
    escalations: [],
    rfcs_opened: [],
    uncertain_decisions: [],
    circuit_breakers_triggered: [],
    recurring_patterns_flagged: [],
  };

  if (orch.isSessionBudgetExceeded(sessionAtMax)) {
    console.log("PASS — isSessionBudgetExceeded() returns true at max_proposals");
  } else {
    console.error("FAIL — expected true when proposals_reviewed === max_proposals");
    process.exit(1);
  }

  // ── Test 12: isSessionBudgetExceeded — elapsed time exceeded ────
  console.log("\n=== Test 12: isSessionBudgetExceeded — time exceeded ===");
  const sessionOldStart: import("./types/index.js").OrchestratorSession = {
    session_id: "session_001",
    session_start: new Date(Date.now() - 91 * 60_000).toISOString(),
    proposals_reviewed: 0,
    circuit_breaker_counts: {},
    consecutive_uncertain: 0,
    escalations: [],
    rfcs_opened: [],
    uncertain_decisions: [],
    circuit_breakers_triggered: [],
    recurring_patterns_flagged: [],
  };

  if (orch.isSessionBudgetExceeded(sessionOldStart)) {
    console.log("PASS — isSessionBudgetExceeded() returns true when elapsed > max_duration_minutes");
  } else {
    console.error("FAIL — expected true when elapsed time exceeds max_duration_minutes");
    process.exit(1);
  }

  // ── Test 13: recordClassificationDisagreement — immutable, counts ─
  console.log("\n=== Test 13: recordClassificationDisagreement ===" );
  const baseSession: import("./types/index.js").OrchestratorSession = {
    session_id: "session_001",
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
  const after1 = orch.recordClassificationDisagreement(baseSession, "agent-x");
  const after2 = orch.recordClassificationDisagreement(after1, "agent-x");
  if (
    after2.circuit_breaker_counts["agent-x"] === 2 &&
    (baseSession.circuit_breaker_counts["agent-x"] ?? 0) === 0
  ) {
    console.log("PASS — count is 2, original session unchanged");
  } else {
    console.error("FAIL — expected count 2 and original untouched");
    process.exit(1);
  }

  // ── Test 14: isCircuitBreakerTriggered with threshold ────────────
  console.log("\n=== Test 14: isCircuitBreakerTriggered ===" );
  const { DEFAULT_HOOK_CONFIG: hookCfg } = await import("./types/index.js");
  // hookCfg.circuit_breaker_threshold defaults to 3
  const sessionAt2: import("./types/index.js").OrchestratorSession = {
    ...baseSession,
    circuit_breaker_counts: { "agent-y": 2 },
  };
  const sessionAt3: import("./types/index.js").OrchestratorSession = {
    ...baseSession,
    circuit_breaker_counts: { "agent-y": 3 },
  };
  const notTriggered = orch.isCircuitBreakerTriggered(sessionAt2, "agent-y", hookCfg);
  const triggered = orch.isCircuitBreakerTriggered(sessionAt3, "agent-y", hookCfg);
  if (!notTriggered && triggered) {
    console.log("PASS — count 2 < threshold 3 → false; count 3 >= threshold 3 → true");
  } else {
    console.error(`FAIL — expected false/true, got ${notTriggered}/${triggered}`);
    process.exit(1);
  }

  // ── Test 15: flagCircuitBreakerTriggered — no duplicates ─────────
  console.log("\n=== Test 15: flagCircuitBreakerTriggered no duplicates ===" );
  const flagged1 = orch.flagCircuitBreakerTriggered(baseSession, "agent-z", "prop-001");
  const flagged2 = orch.flagCircuitBreakerTriggered(flagged1, "agent-z", "prop-002");
  if (
    flagged2.circuit_breakers_triggered.length === 1 &&
    flagged2.circuit_breakers_triggered[0] === "agent-z circuit breaker triggered at prop-001"
  ) {
    console.log("PASS — only one entry for agent-z despite two calls");
  } else {
    console.error("FAIL — expected single entry", flagged2.circuit_breakers_triggered);
    process.exit(1);
  }

  // Cleanup
  await fs.rm(skl.sklDir, { recursive: true, force: true });
  console.log("\nAll filesystem tests passed. Cleaned up .skl/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
