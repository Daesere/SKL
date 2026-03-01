/**
 * CICheckService.test.ts
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/CICheckService.test.ts
 */

import { CICheckService } from "../CICheckService.js";
import type { ExecFileFn } from "../CICheckService.js";
import { SKLFileNotFoundError } from "../../errors/index.js";
import type { KnowledgeFile, StateRecord } from "../../types/index.js";
import type { SKLFileSystem } from "../SKLFileSystem.js";

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
// Fixtures
// ---------------------------------------------------------------------------

function makeStateRecord(overrides: Partial<StateRecord> = {}): StateRecord {
  return {
    id: "app_auth_tokens",
    path: "app/auth/tokens.py",
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

function makeKnowledge(stateRecords: StateRecord[] = []): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["Python"],
      auth_model: "JWT",
      data_storage: "PostgreSQL",
      security_patterns: [],
    },
    state: stateRecords,
    queue: [],
  };
}

/** Build a minimal vscode.OutputChannel mock (appendLine only). */
function makeOutputChannel(): { appendLine: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(msg: string) {
      lines.push(msg);
    },
  };
}

/** Build a mock SKLFileSystem for CICheckService. */
function makeMockFs(options: {
  knowledge?: KnowledgeFile;
  repoRoot?: string;
  writeCapture?: KnowledgeFile[];
  readSequence?: KnowledgeFile[];  // if set, pop from front on each readKnowledge call
}): SKLFileSystem {
  const reads = options.readSequence ?? [];
  let readCount = 0;

  return {
    get repoRoot() {
      return options.repoRoot ?? "/repo";
    },
    readKnowledge: async () => {
      if (reads.length > 0) {
        const k = reads[readCount % reads.length];
        readCount++;
        return k;
      }
      return options.knowledge ?? makeKnowledge();
    },
    writeKnowledge: async (k: KnowledgeFile) => {
      options.writeCapture?.push(k);
    },
  } as unknown as SKLFileSystem;
}

/** A default stub execFile that resolves with empty output (exit 0). */
const EXEC_PASS: ExecFileFn = async () => ({ stdout: "1 passed", stderr: "" });

/** A stub execFile that rejects with a non-zero exit code. */
const EXEC_FAIL: ExecFileFn = async () => {
  const err = Object.assign(new Error("Process exited with code 1"), {
    code: 1,
    stdout: "1 failed",
    stderr: "",
  });
  throw err;
};

// ---------------------------------------------------------------------------
// CICheckService — Test 1: no uncertainty_reduced_by → throws
// ---------------------------------------------------------------------------

void (async () => {

console.log("\nCICheckService — runCheck validation");
console.log("=====================================");

await testAsync("Test 1 — record with no uncertainty_reduced_by throws descriptive error", async () => {
  const record = makeStateRecord({ id: "app_auth_tokens", uncertainty_reduced_by: "" });
  const fs = makeMockFs({ knowledge: makeKnowledge([record]) });
  const svc = new CICheckService(fs, makeOutputChannel() as never, EXEC_PASS);

  let threw = false;
  try {
    await svc.runCheck("app_auth_tokens");
  } catch (err) {
    threw = true;
    const msg = (err as Error).message;
    if (!msg.includes("no uncertainty_reduced_by")) {
      throw new Error(`Expected message about missing uncertainty_reduced_by, got: ${msg}`, { cause: err });
    }
  }
  if (!threw) throw new Error("Expected runCheck to throw");
});

await testAsync("Test 2 — state record not found → throws SKLFileNotFoundError", async () => {
  const fs = makeMockFs({ knowledge: makeKnowledge([]) });
  const svc = new CICheckService(fs, makeOutputChannel() as never, EXEC_PASS);

  let threw = false;
  try {
    await svc.runCheck("nonexistent_id");
  } catch (err) {
    threw = true;
    if (!(err instanceof SKLFileNotFoundError)) {
      throw new Error(`Expected SKLFileNotFoundError, got ${(err as Error).constructor.name}`, { cause: err });
    }
  }
  if (!threw) throw new Error("Expected runCheck to throw SKLFileNotFoundError");
});

// ---------------------------------------------------------------------------
// CICheckService — Test 3: exit code 0 → level 0
// ---------------------------------------------------------------------------

console.log("\nCICheckService — runCheck execution");
console.log("=====================================");

await testAsync("Test 3 — exit code 0 → passed: true, uncertainty_level set to 0", async () => {
  const record = makeStateRecord({
    id: "app_auth_tokens",
    uncertainty_level: 2,
    uncertainty_reduced_by: "tests/test_tokens.py",
  });
  const k = makeKnowledge([record]);
  const writeCapture: KnowledgeFile[] = [];
  // Provide the same knowledge for both readKnowledge calls
  const fs = makeMockFs({ readSequence: [k, k], writeCapture });

  const svc = new CICheckService(fs, makeOutputChannel() as never, EXEC_PASS);
  const result = await svc.runCheck("app_auth_tokens");

  assertEqual(result.passed, true, "result.passed");
  assertEqual(result.exit_code, 0, "result.exit_code");
  assertEqual(result.state_record_id, "app_auth_tokens", "result.state_record_id");
  assertEqual(result.test_reference, "tests/test_tokens.py", "result.test_reference");

  // Verify knowledge was written
  if (writeCapture.length !== 1) {
    throw new Error(`Expected 1 write, got ${writeCapture.length}`);
  }
  const writtenRecord = writeCapture[0].state.find((r) => r.id === "app_auth_tokens");
  if (!writtenRecord) throw new Error("Written record not found");
  assertEqual(writtenRecord.uncertainty_level, 0, "written uncertainty_level");
  // uncertainty_reduced_by must be preserved
  assertEqual(
    writtenRecord.uncertainty_reduced_by,
    "tests/test_tokens.py",
    "uncertainty_reduced_by preserved",
  );
});

// ---------------------------------------------------------------------------
// CICheckService — Test 4: exit code 1 → level unchanged
// ---------------------------------------------------------------------------

await testAsync("Test 4 — exit code 1 → passed: false, uncertainty_level unchanged", async () => {
  const record = makeStateRecord({
    id: "app_auth_tokens",
    uncertainty_level: 2,
    uncertainty_reduced_by: "tests/test_tokens.py",
  });
  const writeCapture: KnowledgeFile[] = [];
  const fs = makeMockFs({
    knowledge: makeKnowledge([record]),
    writeCapture,
  });

  const svc = new CICheckService(fs, makeOutputChannel() as never, EXEC_FAIL);
  const result = await svc.runCheck("app_auth_tokens");

  assertEqual(result.passed, false, "result.passed");
  assertEqual(result.exit_code, 1, "result.exit_code");
  // No write should have occurred
  if (writeCapture.length !== 0) {
    throw new Error(`Expected no writes on failure, got ${writeCapture.length}`);
  }
});

// ---------------------------------------------------------------------------
// CICheckService — Test 5: .py file → python3 -m pytest runner
// ---------------------------------------------------------------------------

console.log("\nCICheckService — resolveTestRunner");
console.log("=====================================");

await testAsync("Test 5 — .py file → runner is python3 -m pytest", async () => {
  let capturedExecutable = "";
  let capturedArgs: string[] = [];

  const mockExec: ExecFileFn = async (file, args) => {
    capturedExecutable = file;
    capturedArgs = args;
    return { stdout: "1 passed", stderr: "" };
  };

  const record = makeStateRecord({
    id: "app_auth_tokens",
    uncertainty_reduced_by: "tests/test_tokens.py",
  });
  const k = makeKnowledge([record]);
  const fs = makeMockFs({ readSequence: [k, k] });
  const svc = new CICheckService(fs, makeOutputChannel() as never, mockExec);
  await svc.runCheck("app_auth_tokens");

  assertEqual(capturedExecutable, "python3", "executable");
  assertEqual(capturedArgs[0], "-m", "args[0]");
  assertEqual(capturedArgs[1], "pytest", "args[1]");
  assertEqual(capturedArgs[2], "tests/test_tokens.py", "args[2]");
});

await testAsync("Test 6 — .test.ts file → runner is npx jest", async () => {
  let capturedExecutable = "";
  let capturedArgs: string[] = [];

  const mockExec: ExecFileFn = async (file, args) => {
    capturedExecutable = file;
    capturedArgs = args;
    return { stdout: "PASS", stderr: "" };
  };

  const record = makeStateRecord({
    id: "src_auth_tokens",
    uncertainty_reduced_by: "src/auth/tokens.test.ts",
  });
  const k = makeKnowledge([record]);
  const fs = makeMockFs({ readSequence: [k, k] });
  const svc = new CICheckService(fs, makeOutputChannel() as never, mockExec);
  await svc.runCheck("src_auth_tokens");

  assertEqual(capturedExecutable, "npx", "executable");
  assertEqual(capturedArgs[0], "jest", "args[0]");
  assertEqual(capturedArgs[1], "src/auth/tokens.test.ts", "args[1]");
});

// ---------------------------------------------------------------------------
// CICheckService — Test 7: execFile throws → returns failed result
// ---------------------------------------------------------------------------

await testAsync("Test 7 — execFile throws → returns failed result without rethrowing", async () => {
  const execThrows: ExecFileFn = async () => {
    throw new Error("ENOENT: python3 not found");
  };

  const record = makeStateRecord({
    id: "app_auth_tokens",
    uncertainty_reduced_by: "tests/test_tokens.py",
  });
  const fs = makeMockFs({ knowledge: makeKnowledge([record]) });
  const svc = new CICheckService(fs, makeOutputChannel() as never, execThrows);

  // Must resolve (not reject)
  const result = await svc.runCheck("app_auth_tokens");
  assertEqual(result.passed, false, "result.passed");
  // No uncertainty_level change — no write should have occurred
  if (result.exit_code === 0) {
    throw new Error("exit_code should not be 0 on execFile throw");
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log();
const total = passed + failed;
if (failed === 0) {
  console.log(`${total} tests: ${passed} passed, 0 failed`);
} else {
  console.log(`${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

})();
