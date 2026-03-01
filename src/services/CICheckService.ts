/**
 * CICheckService — CI test runner and uncertainty_level 0 reduction (Section 3.2.3, 9.3)
 *
 * runCheck is the SOLE path to uncertainty_level 0 in the entire codebase.
 * A State record's uncertainty_level is set to 0 only when:
 *   - The record has a non-empty uncertainty_reduced_by reference, AND
 *   - The referenced test suite exits with code 0.
 *
 * Failed checks return a result without modifying State.
 * All file I/O is delegated to SKLFileSystem (atomic write).
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { SKLFileSystem } from "./SKLFileSystem.js";
import { SKLFileNotFoundError } from "../errors/index.js";
import type { CICheckResult } from "../types/index.js";

// ── Promisified execFile ──────────────────────────────────────────────────────

/**
 * Promisified execFile signature — injected so tests can mock CI invocations.
 *
 * Note: execFile resolves with { stdout, stderr } on exit code 0, and
 * REJECTS with an error that also carries { stdout, stderr, code } on
 * non-zero exit. We catch that rejection and treat it as a failed check.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile = promisify(execFileCb) as ExecFileFn;

// ── Test runner resolution ────────────────────────────────────────────────────

interface TestRunner {
  executable: string;
  args: string[];
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * CICheckService
 *
 * Resolves a test runner from a file extension, executes the test, and
 * on success atomically reduces the matching State record's
 * uncertainty_level to 0.
 */
export class CICheckService {
  private readonly execFileFn: ExecFileFn;

  constructor(
    private readonly sklFileSystem: SKLFileSystem,
    private readonly outputChannel: vscode.OutputChannel,
    execFileFn?: ExecFileFn,
  ) {
    this.execFileFn = execFileFn ?? defaultExecFile;
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Resolve the test runner executable and arguments from a file reference.
   *
   * Extension → runner mapping:
   *   .py               → python3 -m pytest <ref> --tb=short -q
   *   .test.ts / .spec.ts → npx jest <ref> --no-coverage
   *   .test.js / .spec.js → npx jest <ref> --no-coverage
   *   (other)           → python3 <ref>  (fallback)
   */
  private resolveTestRunner(testReference: string): TestRunner {
    if (testReference.endsWith(".py")) {
      return {
        executable: "python3",
        args: ["-m", "pytest", testReference, "--tb=short", "-q"],
      };
    }
    if (
      testReference.endsWith(".test.ts") ||
      testReference.endsWith(".spec.ts") ||
      testReference.endsWith(".test.js") ||
      testReference.endsWith(".spec.js")
    ) {
      return {
        executable: "npx",
        args: ["jest", testReference, "--no-coverage"],
      };
    }
    // Fallback: run directly via python3
    return {
      executable: "python3",
      args: [testReference],
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Run the CI check associated with `stateRecordId` and, if it passes,
   * reduce the record's uncertainty_level to 0.
   *
   * @throws SKLFileNotFoundError — if no State record exists with that id
   * @throws Error                — if the record has no uncertainty_reduced_by
   * @throws Error                — if the repository root cannot be determined
   *
   * All errors AFTER the initial validation (i.e. during execution) are
   * caught and returned as a failed CICheckResult — they are never rethrown.
   */
  async runCheck(stateRecordId: string): Promise<CICheckResult> {
    // ── 1. Validation phase (may throw) ──────────────────────────
    const knowledge = await this.sklFileSystem.readKnowledge();

    const record = knowledge.state.find((r) => r.id === stateRecordId);
    if (record === undefined) {
      throw new SKLFileNotFoundError(stateRecordId);
    }

    if (!record.uncertainty_reduced_by) {
      throw new Error(
        `State record ${stateRecordId} has no uncertainty_reduced_by reference. ` +
        `Set this field before running a CI check.`,
      );
    }

    const repoRoot = this.sklFileSystem.repoRoot;

    const testReference = record.uncertainty_reduced_by;
    const runner = this.resolveTestRunner(testReference);

    // ── 2. Execution phase (never throws) ────────────────────────
    const checkedAt = new Date().toISOString();
    let stdout: string;
    let stderr: string;
    let exitCode: number;

    try {
      const result = await this.execFileFn(runner.executable, runner.args, {
        cwd: repoRoot,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    } catch (err: unknown) {
      // execFile rejects on non-zero exit; the error carries stdout/stderr/code.
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      stdout = execErr.stdout ?? "";
      stderr = execErr.stderr ?? "";
      exitCode = typeof execErr.code === "number" ? execErr.code : 1;
    }

    const passed = exitCode === 0;

    // Truncate combined output to 2000 characters.
    const combinedOutput = (stdout + stderr).slice(0, 2000);

    // Log summary.
    this.outputChannel.appendLine(
      `SKL CI Check [${stateRecordId}] — ${passed ? "PASSED" : "FAILED"} ` +
      `(exit ${exitCode}) — ${testReference}`,
    );

    // ── 3. State update on pass ───────────────────────────────────
    if (passed) {
      // Re-read current knowledge — it may have changed during the run.
      const currentKnowledge = await this.sklFileSystem.readKnowledge();
      const idx = currentKnowledge.state.findIndex((r) => r.id === stateRecordId);

      if (idx !== -1) {
        // uncertainty_level 0 is set ONLY here — do NOT change other fields.
        currentKnowledge.state[idx] = {
          ...currentKnowledge.state[idx],
          uncertainty_level: 0,
          // uncertainty_reduced_by is preserved (spread above keeps existing value)
        };
        await this.sklFileSystem.writeKnowledge(currentKnowledge);
      }
    }

    return {
      state_record_id: stateRecordId,
      test_reference: testReference,
      passed,
      exit_code: exitCode,
      output: combinedOutput,
      checked_at: checkedAt,
    };
  }
}
