/**
 * DigestPanel.test.ts
 *
 * Tests for markReviewed and markAllReviewed safety logic.
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/panels/__tests__/DigestPanel.test.ts
 */

import { DigestPanel } from "../DigestPanel.js";
import type { KnowledgeFile, StateRecord } from "../../types/index.js";
import type { SKLFileSystem } from "../../services/SKLFileSystem.js";
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
// Fixtures
// ---------------------------------------------------------------------------

function makeStateRecord(overrides: Partial<StateRecord> = {}): StateRecord {
  return {
    id: "app_auth",
    path: "src/auth/Auth.ts",
    semantic_scope: "auth",
    scope_schema_version: "1.0",
    responsibilities: "Authentication logic",
    dependencies: [],
    invariants_touched: [],
    assumptions: [],
    owner: "agent-alpha",
    version: 1,
    uncertainty_level: 2,
    change_count_since_review: 3,
    ...overrides,
  };
}

function makeKnowledge(stateRecords: StateRecord[] = []): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["TypeScript"],
      auth_model: "JWT",
      data_storage: "PostgreSQL",
      security_patterns: [],
    },
    state: stateRecords,
    queue: [],
  };
}

/** Minimal OutputChannel mock capturing log lines. */
function makeOutputChannel(): { appendLine: (s: string) => void; lines: string[] } & vscode.OutputChannel {
  const lines: string[] = [];
  return {
    lines,
    appendLine(msg: string) { lines.push(msg); },
    name: "test",
    show: () => {},
    hide: () => {},
    clear: () => {},
    append: () => {},
    replace: () => {},
    dispose: () => {},
  } as unknown as { appendLine: (s: string) => void; lines: string[] } & vscode.OutputChannel;
}

/** Minimal WebviewPanel mock. */
function makeMockPanel(): vscode.WebviewPanel {
  let _html = "";
  return {
    webview: {
      get html() { return _html; },
      set html(v: string) { _html = v; },
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    reveal: () => {},
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => {},
    viewType: "test",
    title: "test",
    viewColumn: 1,
    options: {},
    active: true,
    visible: true,
    onDidChangeViewState: () => ({ dispose: () => {} }),
  } as unknown as vscode.WebviewPanel;
}

/** Minimal SKLFileSystem mock. */
function makeMockFs(options: {
  knowledge?: KnowledgeFile;
  writeCapture?: KnowledgeFile[];
}): SKLFileSystem {
  return {
    readKnowledge: async () => options.knowledge ?? makeKnowledge(),
    writeKnowledge: async (k: KnowledgeFile) => { options.writeCapture?.push(k); },
    listRFCs: async () => [],
    readRFC: async () => { throw new Error("no RFC"); },
    readMostRecentSessionLog: async () => null,
    onKnowledgeChanged: () => ({ dispose: () => {} }),
  } as unknown as SKLFileSystem;
}

/** Access private methods without any. */
type DigestPanelInternal = {
  markReviewed: (id: string) => Promise<void>;
  markAllReviewed: () => Promise<void>;
  markSelectedReviewed: (ids: string[]) => Promise<void>;
  currentKnowledge: KnowledgeFile;
};

function internal(panel: DigestPanel): DigestPanelInternal {
  return panel as unknown as DigestPanelInternal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

console.log("\nDigestPanel — markReviewed");
console.log("============================");

await testAsync("Test 1 — markReviewed on level-2 record → uncertainty_level becomes 1", async () => {
  const record = makeStateRecord({ id: "app_auth", uncertainty_level: 2, change_count_since_review: 5 });
  const knowledge = makeKnowledge([record]);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(
    makeMockPanel(),
    makeMockFs({ knowledge, writeCapture }),
    makeOutputChannel(),
    knowledge,
  );

  await internal(panel).markReviewed("app_auth");

  assertEqual(writeCapture.length, 1, "writeKnowledge call count");
  assertEqual(writeCapture[0].state[0].uncertainty_level, 1, "uncertainty_level");
  assertEqual(writeCapture[0].state[0].change_count_since_review, 0, "change_count_since_review reset");
  if (!writeCapture[0].state[0].last_reviewed_at) {
    throw new Error("last_reviewed_at should be set");
  }
});

await testAsync("Test 2 — markReviewed on level-0 record → no write, log message contains 'level 0'", async () => {
  const record = makeStateRecord({ id: "verified", uncertainty_level: 0 });
  const knowledge = makeKnowledge([record]);
  const writeCapture: KnowledgeFile[] = [];
  const channel = makeOutputChannel();
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), channel, knowledge);

  await internal(panel).markReviewed("verified");

  assertEqual(writeCapture.length, 0, "writeKnowledge should not be called");
  const logged = channel.lines.some((l) => l.includes("level 0"));
  if (!logged) throw new Error(`Expected 'level 0' in log. Got: ${JSON.stringify(channel.lines)}`);
});

await testAsync("Test 3 — markReviewed on level-3 record → no write, log message contains 'level 3'", async () => {
  const record = makeStateRecord({ id: "contested", uncertainty_level: 3 });
  const knowledge = makeKnowledge([record]);
  const writeCapture: KnowledgeFile[] = [];
  const channel = makeOutputChannel();
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), channel, knowledge);

  await internal(panel).markReviewed("contested");

  assertEqual(writeCapture.length, 0, "writeKnowledge should not be called");
  const logged = channel.lines.some((l) => l.includes("level 3"));
  if (!logged) throw new Error(`Expected 'level 3' in log. Got: ${JSON.stringify(channel.lines)}`);
});

await testAsync("Test 4 — markReviewed on level-1 record → no write, log message contains 'already at level 1'", async () => {
  const record = makeStateRecord({ id: "reviewed", uncertainty_level: 1 });
  const knowledge = makeKnowledge([record]);
  const writeCapture: KnowledgeFile[] = [];
  const channel = makeOutputChannel();
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), channel, knowledge);

  await internal(panel).markReviewed("reviewed");

  assertEqual(writeCapture.length, 0, "writeKnowledge should not be called");
  const logged = channel.lines.some((l) => l.includes("already at level 1"));
  if (!logged) throw new Error(`Expected 'already at level 1' in log. Got: ${JSON.stringify(channel.lines)}`);
});

console.log("\nDigestPanel — markAllReviewed");
console.log("================================");

await testAsync("Test 5 — markAllReviewed with 3 level-2 records → all updated, writeKnowledge called exactly once", async () => {
  const records = [
    makeStateRecord({ id: "a", uncertainty_level: 2 }),
    makeStateRecord({ id: "b", uncertainty_level: 2 }),
    makeStateRecord({ id: "c", uncertainty_level: 2 }),
  ];
  const knowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(
    makeMockPanel(),
    makeMockFs({ knowledge, writeCapture }),
    makeOutputChannel(),
    knowledge,
  );

  await internal(panel).markAllReviewed();

  assertEqual(writeCapture.length, 1, "writeKnowledge should be called exactly once");
  for (const r of writeCapture[0].state) {
    assertEqual(r.uncertainty_level, 1, `${r.id} uncertainty_level`);
    assertEqual(r.change_count_since_review, 0, `${r.id} change_count_since_review`);
  }
});

await testAsync("Test 6 — markAllReviewed with no level-2 records → writeKnowledge not called", async () => {
  const records = [
    makeStateRecord({ id: "a", uncertainty_level: 1 }),
    makeStateRecord({ id: "b", uncertainty_level: 0 }),
  ];
  const knowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];
  const channel = makeOutputChannel();
  const panel = new DigestPanel(
    makeMockPanel(),
    makeMockFs({ knowledge, writeCapture }),
    channel,
    knowledge,
  );

  await internal(panel).markAllReviewed();

  assertEqual(writeCapture.length, 0, "writeKnowledge should not be called");
});

await testAsync("Test 7 — Input KnowledgeFile is not mutated by markReviewed or markAllReviewed", async () => {
  const records = [
    makeStateRecord({ id: "a", uncertainty_level: 2 }),
    makeStateRecord({ id: "b", uncertainty_level: 2 }),
  ];
  const originalKnowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];

  const panel = new DigestPanel(
    makeMockPanel(),
    makeMockFs({ knowledge: originalKnowledge, writeCapture }),
    makeOutputChannel(),
    originalKnowledge,
  );

  await internal(panel).markReviewed("a");
  await internal(panel).markAllReviewed();

  // Original KnowledgeFile should be unmutated
  assertEqual(originalKnowledge.state[0].uncertainty_level, 2, "original state[0] not mutated");
  assertEqual(originalKnowledge.state[1].uncertainty_level, 2, "original state[1] not mutated");
  assertEqual(originalKnowledge.state[0].change_count_since_review, 3, "original change_count not mutated");
});

// ---------------------------------------------------------------------------
// markSelectedReviewed tests
// ---------------------------------------------------------------------------

console.log("\nDigestPanel — markSelectedReviewed");
console.log("====================================");

await testAsync("Test 8 — markSelectedReviewed with level-2, level-0, level-3 IDs → only level-2 updated, writeKnowledge called once", async () => {
  const records = [
    makeStateRecord({ id: "l2", uncertainty_level: 2, change_count_since_review: 3 }),
    makeStateRecord({ id: "l0", uncertainty_level: 0, change_count_since_review: 0 }),
    makeStateRecord({ id: "l3", uncertainty_level: 3, change_count_since_review: 1 }),
  ];
  const knowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), makeOutputChannel(), knowledge);

  await internal(panel).markSelectedReviewed(["l2", "l0", "l3"]);

  assertEqual(writeCapture.length, 1, "writeKnowledge call count");
  const written = writeCapture[0];
  const l2 = written.state.find((r) => r.id === "l2");
  const l0 = written.state.find((r) => r.id === "l0");
  const l3 = written.state.find((r) => r.id === "l3");
  if (!l2) throw new Error("l2 record missing");
  if (!l0) throw new Error("l0 record missing");
  if (!l3) throw new Error("l3 record missing");
  assertEqual(l2.uncertainty_level, 1, "l2 updated to 1");
  assertEqual(l0.uncertainty_level, 0, "l0 unchanged");
  assertEqual(l3.uncertainty_level, 3, "l3 unchanged");
});

await testAsync("Test 9 — markSelectedReviewed with all level-1 IDs → writeKnowledge not called", async () => {
  const records = [
    makeStateRecord({ id: "r1", uncertainty_level: 1 }),
    makeStateRecord({ id: "r2", uncertainty_level: 1 }),
  ];
  const knowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), makeOutputChannel(), knowledge);

  await internal(panel).markSelectedReviewed(["r1", "r2"]);

  assertEqual(writeCapture.length, 0, "writeKnowledge should not be called");
});

await testAsync("Test 10 — markSelectedReviewed with non-existent ID → silent skip, no error", async () => {
  const knowledge = makeKnowledge([]);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), makeOutputChannel(), knowledge);

  // Should not throw
  await internal(panel).markSelectedReviewed(["does_not_exist"]);

  assertEqual(writeCapture.length, 0, "writeKnowledge should not be called");
});

await testAsync("Test 11 — markSelectedReviewed with 3 level-2 records → all updated, writeKnowledge called once", async () => {
  const records = [
    makeStateRecord({ id: "a", uncertainty_level: 2, change_count_since_review: 2 }),
    makeStateRecord({ id: "b", uncertainty_level: 2, change_count_since_review: 4 }),
    makeStateRecord({ id: "c", uncertainty_level: 2, change_count_since_review: 1 }),
  ];
  const knowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge, writeCapture }), makeOutputChannel(), knowledge);

  await internal(panel).markSelectedReviewed(["a", "b", "c"]);

  assertEqual(writeCapture.length, 1, "writeKnowledge call count");
  for (const r of writeCapture[0].state) {
    assertEqual(r.uncertainty_level, 1, `${r.id} updated to 1`);
    assertEqual(r.change_count_since_review, 0, `${r.id} change count reset`);
  }
});

await testAsync("Test 12 — markSelectedReviewed does not mutate input KnowledgeFile", async () => {
  const records = [
    makeStateRecord({ id: "x", uncertainty_level: 2, change_count_since_review: 3 }),
  ];
  const originalKnowledge = makeKnowledge(records);
  const writeCapture: KnowledgeFile[] = [];
  const panel = new DigestPanel(makeMockPanel(), makeMockFs({ knowledge: originalKnowledge, writeCapture }), makeOutputChannel(), originalKnowledge);

  await internal(panel).markSelectedReviewed(["x"]);

  assertEqual(originalKnowledge.state[0].uncertainty_level, 2, "original not mutated");
  assertEqual(originalKnowledge.state[0].change_count_since_review, 3, "original change_count not mutated");
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
