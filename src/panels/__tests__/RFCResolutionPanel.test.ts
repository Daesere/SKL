/**
 * RFCResolutionPanel.test.ts
 *
 * Tests for confirm_resolution validation and cancel behaviour.
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/panels/__tests__/RFCResolutionPanel.test.ts
 */

import { RFCResolutionPanel } from "../RFCResolutionPanel.js";
import type { Rfc, DraftAcceptanceCriterion, KnowledgeFile } from "../../types/index.js";
import type { SKLFileSystem } from "../../services/SKLFileSystem.js";
import type * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

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

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMockRfc(overrides: Partial<Rfc> = {}): Rfc {
  return {
    id: "RFC_001",
    status: "open",
    created_at: "2024-01-01T00:00:00.000Z",
    triggering_proposal: "PROP_001",
    decision_required: "Which DB to use?",
    context: "We need a database.",
    option_a: { description: "PostgreSQL", consequences: "Strong consistency." },
    option_b: { description: "MongoDB", consequences: "Flexible schema." },
    ...overrides,
  };
}

function makeKnowledge(): KnowledgeFile {
  return {
    invariants: {
      tech_stack: ["TypeScript"],
      auth_model: "JWT",
      data_storage: "PostgreSQL",
      security_patterns: [],
    },
    state: [],
    queue: [],
  };
}

function makeCriterion(overrides: Partial<DraftAcceptanceCriterion> = {}): DraftAcceptanceCriterion {
  return {
    id: "AC_001",
    description: "Tests pass",
    check_type: "test",
    check_reference: "npm test",
    rationale: "Must be green",
    status: "pending",
    ...overrides,
  };
}

/** Webview panel mock that captures postMessage calls and tracks dispose. */
function makeMockPanel(): {
  webviewPanel: vscode.WebviewPanel;
  postedMessages: unknown[];
  isDisposed: () => boolean;
} {
  const postedMessages: unknown[] = [];
  let disposed = false;
  const webviewPanel: vscode.WebviewPanel = {
    webview: {
      html: "",
      postMessage: async (msg: unknown) => { postedMessages.push(msg); return true; },
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    reveal: () => {},
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => { disposed = true; },
    viewType: "test",
    title: "test",
    viewColumn: 1,
    options: {},
    active: true,
    visible: true,
    onDidChangeViewState: () => ({ dispose: () => {} }),
  } as unknown as vscode.WebviewPanel;

  return {
    webviewPanel,
    postedMessages,
    isDisposed: () => disposed,
  };
}

/** SKLFileSystem mock. */
function makeMockSkl(opts: {
  rfc?: Rfc;
  knowledge?: KnowledgeFile;
  writeRFCCapture?: Rfc[];
}): SKLFileSystem {
  return {
    readRFC: async () => opts.rfc ?? makeMockRfc(),
    readKnowledge: async () => opts.knowledge ?? makeKnowledge(),
    writeKnowledge: async () => {},
    listRFCs: async () => [],
    listADRs: async () => [],
    writeADR: async () => {},
    writeRFC: async (r: Rfc) => { opts.writeRFCCapture?.push(r); },
    onKnowledgeChanged: () => ({ dispose: () => {} }),
  } as unknown as SKLFileSystem;
}

/** Access private members without casting through any. */
type RFCResolutionPanelInternal = {
  _handleMessage: (msg: {
    command: string;
    option?: string;
    rationale?: string;
    criteria?: DraftAcceptanceCriterion[];
  }) => Promise<void>;
  _rfc: Rfc;
  _ready: Promise<void>;
};

function internal(panel: RFCResolutionPanel): RFCResolutionPanelInternal {
  return panel as unknown as RFCResolutionPanelInternal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

  console.log("\nRFCResolutionPanel — message handling");
  console.log("=======================================");

  await testAsync(
    "Test 1 — confirm_resolution with valid option/rationale/criterion → promoteRFCtoADR called, panel disposed",
    async () => {
      const writeRFCCapture: Rfc[] = [];
      const { webviewPanel, isDisposed } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeRFCCapture });
      const panel = new RFCResolutionPanel("RFC_001", webviewPanel, mockSkl);

      // Wait for RFC to be loaded by _init
      await internal(panel)._ready;

      await internal(panel)._handleMessage({
        command: "confirm_resolution",
        option: "option_a",
        rationale: "PostgreSQL is battle-tested.",
        criteria: [makeCriterion()],
      });

      assertEqual(writeRFCCapture.length, 1, "writeRFC call count");
      assertEqual(isDisposed(), true, "panel should be disposed");
    },
  );

  await testAsync(
    "Test 2 — confirm_resolution with empty rationale → validation_error posted, no write, not disposed",
    async () => {
      const writeRFCCapture: Rfc[] = [];
      const { webviewPanel, postedMessages, isDisposed } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeRFCCapture });
      const panel = new RFCResolutionPanel("RFC_001", webviewPanel, mockSkl);

      await internal(panel)._ready;

      await internal(panel)._handleMessage({
        command: "confirm_resolution",
        option: "option_a",
        rationale: "   ",
        criteria: [makeCriterion()],
      });

      const validationErrors = (postedMessages as Array<{ command: string }>).filter(
        (m) => m.command === "validation_error",
      );
      if (validationErrors.length === 0) {
        throw new Error("Expected validation_error to be posted");
      }
      assertEqual(writeRFCCapture.length, 0, "writeRFC should not be called");
      assertEqual(isDisposed(), false, "panel should not be disposed");
    },
  );

  await testAsync(
    "Test 3 — confirm_resolution with empty criteria array → validation_error posted, no write",
    async () => {
      const writeRFCCapture: Rfc[] = [];
      const { webviewPanel, postedMessages } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeRFCCapture });
      const panel = new RFCResolutionPanel("RFC_001", webviewPanel, mockSkl);

      await internal(panel)._ready;

      await internal(panel)._handleMessage({
        command: "confirm_resolution",
        option: "option_b",
        rationale: "MongoDB is flexible.",
        criteria: [],
      });

      const validationErrors = (postedMessages as Array<{ command: string }>).filter(
        (m) => m.command === "validation_error",
      );
      if (validationErrors.length === 0) {
        throw new Error("Expected validation_error to be posted");
      }
      assertEqual(writeRFCCapture.length, 0, "writeRFC should not be called");
    },
  );

  await testAsync(
    "Test 4 — cancel → panel disposed, writeRFC not called",
    async () => {
      const writeRFCCapture: Rfc[] = [];
      const { webviewPanel, isDisposed } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeRFCCapture });
      const panel = new RFCResolutionPanel("RFC_001", webviewPanel, mockSkl);

      await internal(panel)._ready;

      await internal(panel)._handleMessage({ command: "cancel" });

      assertEqual(isDisposed(), true, "panel should be disposed on cancel");
      assertEqual(writeRFCCapture.length, 0, "writeRFC should not be called on cancel");
    },
  );

  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})();
