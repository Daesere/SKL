/**
 * TaskAssignmentPanel.test.ts
 *
 * Tests for TaskAssignmentPanel message handling.
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/panels/__tests__/TaskAssignmentPanel.test.ts
 */

import { TaskAssignmentPanel } from "../TaskAssignmentPanel.js";
import type { AgentContext, ScopeDefinition, TaskAssignment } from "../../types/index.js";
import type { SKLFileSystem, OrchestratorService } from "../../services/index.js";
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

function assertDeepEqual<T>(actual: T, expected: T, label?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMockPanel(): {
  webviewPanel: vscode.WebviewPanel;
  postedMessages: unknown[];
} {
  const postedMessages: unknown[] = [];
  const webviewPanel: vscode.WebviewPanel = {
    webview: {
      html: "",
      postMessage: async (msg: unknown) => { postedMessages.push(msg); return true; },
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
  return { webviewPanel, postedMessages };
}

function makeMockSkl(opts: {
  writeContextCapture?: AgentContext[];
} = {}): SKLFileSystem {
  return {
    writeAgentContext: async (ctx: AgentContext) => {
      opts.writeContextCapture?.push(ctx);
    },
    onKnowledgeChanged: () => ({ dispose: () => {} }),
  } as unknown as SKLFileSystem;
}

function makeMockOrchestratorService(): OrchestratorService {
  return {} as unknown as OrchestratorService;
}

function makeScopeDefs(): ScopeDefinition {
  return {
    scope_definitions: {
      version: "1.0",
      scopes: {
        auth: {
          description: "Authentication",
          allowed_path_prefixes: ["src/auth"],
          forbidden_path_prefixes: [],
          permitted_responsibilities: [],
          forbidden_responsibilities: [],
          owner: "human-operator",
        },
        api: {
          description: "API layer",
          allowed_path_prefixes: ["src/api"],
          forbidden_path_prefixes: [],
          permitted_responsibilities: [],
          forbidden_responsibilities: [],
          owner: "human-operator",
        },
      },
    },
  };
}

function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    agent_id: "Agent-1",
    semantic_scope: "auth",
    file_scope: undefined,
    task_description: "Implement login",
    assignment_rationale: "Auth scope owns login",
    ...overrides,
  };
}

type TaskAssignmentPanelInternal = {
  _handleMessage: (msg: { command: string; [key: string]: unknown }) => Promise<void>;
};

function internal(panel: TaskAssignmentPanel): TaskAssignmentPanelInternal {
  return panel as unknown as TaskAssignmentPanelInternal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

  console.log("\nTaskAssignmentPanel — message handling");
  console.log("=========================================");

  // Reset singleton before each test group
  (TaskAssignmentPanel as unknown as { _instance: undefined })._instance = undefined;

  await testAsync(
    "Test 1 — apply_assignment with valid assignment → writeAgentContext called with correct agent_id, semantic_scope, file_scope as array",
    async () => {
      const writeContextCapture: AgentContext[] = [];
      const { webviewPanel } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeContextCapture });

      const panel = new TaskAssignmentPanel(
        webviewPanel,
        [makeAssignment({ file_scope: "src/auth/login.ts\nsrc/auth/logout.ts" })],
        mockSkl,
        makeMockOrchestratorService(),
        makeScopeDefs(),
      );

      await internal(panel)._handleMessage({
        command: "apply_assignment",
        index: 0,
        assignment: makeAssignment({ file_scope: "src/auth/login.ts\nsrc/auth/logout.ts" }),
      });

      assertEqual(writeContextCapture.length, 1, "writeAgentContext call count");
      assertEqual(writeContextCapture[0]!.agent_id, "Agent-1", "agent_id");
      assertEqual(writeContextCapture[0]!.semantic_scope, "auth", "semantic_scope");
      assertDeepEqual(
        writeContextCapture[0]!.file_scope,
        ["src/auth/login.ts", "src/auth/logout.ts"],
        "file_scope",
      );
    },
  );

  (TaskAssignmentPanel as unknown as { _instance: undefined })._instance = undefined;

  await testAsync(
    "Test 2 — apply_assignment with missing agent_id → validation_error posted, writeAgentContext not called",
    async () => {
      const writeContextCapture: AgentContext[] = [];
      const { webviewPanel, postedMessages } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeContextCapture });

      const panel = new TaskAssignmentPanel(
        webviewPanel,
        [makeAssignment()],
        mockSkl,
        makeMockOrchestratorService(),
        makeScopeDefs(),
      );

      await internal(panel)._handleMessage({
        command: "apply_assignment",
        index: 0,
        assignment: makeAssignment({ agent_id: "" }),
      });

      assertEqual(writeContextCapture.length, 0, "writeAgentContext should not be called");
      const errMsg = postedMessages.find(
        (m) => (m as { command: string }).command === "validation_error",
      );
      if (!errMsg) throw new Error("validation_error not posted");
    },
  );

  (TaskAssignmentPanel as unknown as { _instance: undefined })._instance = undefined;

  await testAsync(
    "Test 3 — apply_all_assignments with 2 valid assignments → writeAgentContext called twice, in order",
    async () => {
      const writeContextCapture: AgentContext[] = [];
      const { webviewPanel } = makeMockPanel();
      const mockSkl = makeMockSkl({ writeContextCapture });

      const a1 = makeAssignment({ agent_id: "Agent-1", semantic_scope: "auth" });
      const a2 = makeAssignment({ agent_id: "Agent-2", semantic_scope: "api" });

      const panel = new TaskAssignmentPanel(
        webviewPanel,
        [a1, a2],
        mockSkl,
        makeMockOrchestratorService(),
        makeScopeDefs(),
      );

      await internal(panel)._handleMessage({
        command: "apply_all_assignments",
        assignments: [a1, a2],
      });

      assertEqual(writeContextCapture.length, 2, "writeAgentContext call count");
      assertEqual(writeContextCapture[0]!.agent_id, "Agent-1", "first agent_id");
      assertEqual(writeContextCapture[1]!.agent_id, "Agent-2", "second agent_id");
    },
  );

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);

})();
