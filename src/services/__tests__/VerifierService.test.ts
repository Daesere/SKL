/**
 * VerifierService.test.ts
 *
 * Tests for the LLM-based verifier pass (Section 6.2).
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/VerifierService.test.ts
 */

import {
  setSelectChatModels,
  resetLmMock,
  createMockModel,
} from "../../testing/configure-lm-mock.js";
import { VerifierService } from "../VerifierService.js";
import type { QueueProposal, RiskSignals, ChangeType } from "../../types/index.js";
import type { OutputChannelLike } from "../VerifierService.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function defaultRiskSignals(): RiskSignals {
  return {
    touched_auth_or_permission_patterns: false,
    public_api_signature_changed: false,
    invariant_referenced_file_modified: false,
    high_fan_in_module_modified: false,
    ast_change_type: "mechanical",
    mechanical_only: false,
  };
}

function makeProposal(change_type: ChangeType = "behavioral"): QueueProposal {
  return {
    proposal_id: "test-v-001",
    agent_id: "agent-a",
    path: "src/foo.ts",
    semantic_scope: "core",
    scope_schema_version: "1.0.0",
    change_type,
    responsibilities: "handles foo logic",
    dependencies: ["bar.ts"],
    invariants_touched: [],
    assumptions: [],
    uncertainty_delta: "+0",
    rationale: "refactored foo for clarity",
    out_of_scope: false,
    cross_scope_flag: false,
    branch: "feat/test",
    risk_signals: defaultRiskSignals(),
    classification_verification: {
      agent_classification: change_type,
      verifier_classification: "mechanical",
      agreement: true,
      stage1_override: false,
    },
    dependency_scan: {
      undeclared_imports: [],
      stale_declared_deps: [],
      cross_scope_undeclared: [],
    },
    agent_reasoning_summary: "minor cleanup",
    status: "pending",
    submitted_at: new Date().toISOString(),
  };
}

/** Collects appendLine calls for verification. */
function createMockOutputChannel(): OutputChannelLike & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(value: string) {
      lines.push(value);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Test runner                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2714  ${label}`);
  } else {
    failed++;
    console.error(`  \u2718  FAIL: ${label}`);
  }
}

async function runTests(): Promise<void> {
  console.log("VerifierService \u2014 LLM verifier pass\n");

  /* ---------------------------------------------------------------- */
  /*  Test 1: Agreement — model returns behavioral, agent said same   */
  /* ---------------------------------------------------------------- */
  {
    resetLmMock();
    const model = createMockModel(
      JSON.stringify({ classification: "behavioral", justification: "test" }),
    );
    setSelectChatModels(async () => [model]);

    const svc = new VerifierService(createMockOutputChannel());
    const result = await svc.runVerifierPass(
      makeProposal("behavioral"),
      "behavioral",
      "diff content",
    );
    assert(result.verifier_classification === "behavioral", "Test 1: verifier says behavioral");
    assert(result.agreement === true, "Test 1: agreement is true");
    assert(result.resolved_classification === "behavioral", "Test 1: resolved to behavioral");
    assert(result.justification === "test", "Test 1: justification preserved");
  }

  /* ---------------------------------------------------------------- */
  /*  Test 2: Disagreement — model says architectural, agent said     */
  /*          behavioral → resolved to architectural (higher risk)    */
  /* ---------------------------------------------------------------- */
  {
    resetLmMock();
    const model = createMockModel(
      JSON.stringify({ classification: "architectural", justification: "new deps" }),
    );
    setSelectChatModels(async () => [model]);

    const svc = new VerifierService(createMockOutputChannel());
    const result = await svc.runVerifierPass(
      makeProposal("behavioral"),
      "behavioral",
      "diff content",
    );
    assert(result.verifier_classification === "architectural", "Test 2: verifier says architectural");
    assert(result.agreement === false, "Test 2: disagreement");
    assert(result.resolved_classification === "architectural", "Test 2: resolved to higher risk");
  }

  /* ---------------------------------------------------------------- */
  /*  Test 3: Disagreement — model says mechanical, agent said        */
  /*          behavioral → resolved to behavioral (higher risk)       */
  /* ---------------------------------------------------------------- */
  {
    resetLmMock();
    const model = createMockModel(
      JSON.stringify({ classification: "mechanical", justification: "whitespace only" }),
    );
    setSelectChatModels(async () => [model]);

    const svc = new VerifierService(createMockOutputChannel());
    const result = await svc.runVerifierPass(
      makeProposal("behavioral"),
      "behavioral",
      "diff content",
    );
    assert(result.verifier_classification === "mechanical", "Test 3: verifier says mechanical");
    assert(result.agreement === false, "Test 3: disagreement");
    assert(result.resolved_classification === "behavioral", "Test 3: resolved to higher risk (behavioral)");
  }

  /* ---------------------------------------------------------------- */
  /*  Test 4: Unparseable response → fallback to behavioral           */
  /* ---------------------------------------------------------------- */
  {
    resetLmMock();
    const model = createMockModel("This is not JSON at all!");
    setSelectChatModels(async () => [model]);

    const svc = new VerifierService(createMockOutputChannel());
    const result = await svc.runVerifierPass(
      makeProposal("behavioral"),
      "behavioral",
      "diff content",
    );
    assert(result.verifier_classification === "behavioral", "Test 4: fallback to behavioral");
    assert(result.justification.includes("unparseable"), "Test 4: justification mentions unparseable");
    assert(result.agreement === true, "Test 4: agreement true (both behavioral)");
  }

  /* ---------------------------------------------------------------- */
  /*  Test 5: JSON with invalid classification value → fallback       */
  /* ---------------------------------------------------------------- */
  {
    resetLmMock();
    const model = createMockModel(
      JSON.stringify({ classification: "nuclear", justification: "wrong" }),
    );
    setSelectChatModels(async () => [model]);

    const svc = new VerifierService(createMockOutputChannel());
    const result = await svc.runVerifierPass(
      makeProposal("mechanical"),
      "mechanical",
      "diff content",
    );
    assert(result.verifier_classification === "behavioral", "Test 5: fallback to behavioral");
    assert(result.justification.includes("unparseable"), "Test 5: justification mentions unparseable");
    // behavioral !== mechanical → disagreement, resolved to behavioral (higher)
    assert(result.agreement === false, "Test 5: disagreement (behavioral != mechanical)");
    assert(result.resolved_classification === "behavioral", "Test 5: resolved to behavioral");
  }

  /* ---------------------------------------------------------------- */
  /*  Test 6: getFileDiff with failing git command → empty string     */
  /* ---------------------------------------------------------------- */
  {
    const channel = createMockOutputChannel();
    const svc = new VerifierService(channel);
    const result = await svc.getFileDiff(
      "nonexistent-file.ts",
      "nonexistent-branch-abc123",
      "also-nonexistent-xyz789",
    );
    assert(result === "", "Test 6: returns empty string on git error");
    assert(channel.lines.length > 0, "Test 6: error was logged to output channel");
  }

  /* ---------------------------------------------------------------- */
  /*  Summary                                                          */
  /* ---------------------------------------------------------------- */

  resetLmMock();
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
