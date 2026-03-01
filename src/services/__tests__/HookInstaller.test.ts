/**
 * HookInstaller.test.ts
 *
 * Run with:
 *   npx tsx --require ./src/testing/register-vscode-mock.cjs src/services/__tests__/HookInstaller.test.ts
 */

import { HookInstaller } from "../HookInstaller.js";
import type { ExecFileFn } from "../HookInstaller.js";
import type { HookConfig } from "../../types/index.js";
import { DEFAULT_HOOK_CONFIG } from "../../types/index.js";
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
// Helpers
// ---------------------------------------------------------------------------

/** Minimal vscode.ExtensionContext mock — only extensionPath is read. */
const fakeExtCtx = {
  extensionPath: "/fake/extension",
} as unknown as import("vscode").ExtensionContext;

/**
 * Build a minimal SKLFileSystem mock that records writeHookConfig calls.
 * All other methods throw to ensure they are never accidentally invoked.
 */
function makeSkl(): { skl: SKLFileSystem; written: HookConfig[] } {
  const written: HookConfig[] = [];
  const skl = {
    writeHookConfig: async (c: HookConfig): Promise<void> => {
      written.push({ ...c });
    },
  } as unknown as SKLFileSystem;
  return { skl, written };
}

/** Fresh copy of DEFAULT_HOOK_CONFIG (python_executable: "python3"). */
function defaultConfig(): HookConfig {
  return { ...DEFAULT_HOOK_CONFIG };
}

/**
 * Build a mock ExecFileFn.
 * `responses` maps a command name to either a resolved value or `null`
 * (meaning throw). Any command not in the map succeeds with empty output.
 */
function makeExecFile(
  responses: Record<string, { stdout: string; stderr: string } | null>,
): { execFile: ExecFileFn; calls: string[] } {
  const calls: string[] = [];
  const execFile: ExecFileFn = async (cmd, _args) => {
    calls.push(cmd);
    const result = responses[cmd];
    if (result === null) {
      throw new Error(`${cmd}: command not found`);
    }
    return result ?? { stdout: "", stderr: "" };
  };
  return { execFile, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void (async () => {

console.log("\nHookInstaller");
console.log("=============");

// ── detectPythonExecutable (tested via install()) ─────────────────────────

await testAsync("python3 fails, python succeeds → updates python_executable to 'python'", async () => {
  const { execFile } = makeExecFile({
    python3: null,                              // fails
    python: { stdout: "Python 3.11.0", stderr: "" }, // succeeds
  });
  const { skl, written } = makeSkl();
  const hookConfig = defaultConfig(); // python_executable: "python3"

  const installer = new HookInstaller(fakeExtCtx, execFile);

  // install() will fail at .git/hooks access (expected), but writeHookConfig
  // must be called BEFORE that point.
  try {
    await installer.install("/no-such-repo", hookConfig, skl);
  } catch {
    // Expected — no .git/hooks dir in test env.
  }

  assertEqual(written.length, 1, "writeHookConfig called once");
  assertEqual(written[0]!.python_executable, "python", "persisted executable");
});

await testAsync("python3 fails, python fails, py succeeds → updates python_executable to 'py'", async () => {
  const { execFile } = makeExecFile({
    python3: null,
    python:  null,
    py:      { stdout: "Python 3.12.0", stderr: "" },
  });
  const { skl, written } = makeSkl();
  const hookConfig = defaultConfig();

  const installer = new HookInstaller(fakeExtCtx, execFile);

  try {
    await installer.install("/no-such-repo", hookConfig, skl);
  } catch {
    // Expected.
  }

  assertEqual(written.length, 1, "writeHookConfig called once");
  assertEqual(written[0]!.python_executable, "py", "persisted executable");
});

await testAsync("all three candidates fail → install returns early, nothing written", async () => {
  const { execFile, calls } = makeExecFile({
    python3: null,
    python:  null,
    py:      null,
  });
  const { skl, written } = makeSkl();
  const hookConfig = defaultConfig();

  const installer = new HookInstaller(fakeExtCtx, execFile);

  // install() must return without throwing.
  let threw = false;
  try {
    await installer.install("/no-such-repo", hookConfig, skl);
  } catch {
    threw = true;
  }

  assertEqual(threw, false, "install() did not throw");
  assertEqual(written.length, 0, "writeHookConfig not called");
  // All three candidates were tried.
  assertEqual(calls.includes("python3"), true, "python3 was tried");
  assertEqual(calls.includes("python"),  true, "python was tried");
  assertEqual(calls.includes("py"),      true, "py was tried");
});

await testAsync("hook_config has non-default python_executable → detection skipped entirely", async () => {
  const { execFile, calls } = makeExecFile({});
  const { skl, written } = makeSkl();
  const hookConfig: HookConfig = { ...DEFAULT_HOOK_CONFIG, python_executable: "python" };

  const installer = new HookInstaller(fakeExtCtx, execFile);

  try {
    await installer.install("/no-such-repo", hookConfig, skl);
  } catch {
    // Expected — no .git/hooks dir.
  }

  // No Python detection calls.
  const pythonCalls = calls.filter(c => ["python3", "python", "py"].includes(c));
  assertEqual(pythonCalls.length, 0, "no detection calls made");
  assertEqual(written.length, 0, "writeHookConfig not called");
});

await testAsync("python3 succeeds (default) → python_executable unchanged, writeHookConfig not called", async () => {
  const { execFile } = makeExecFile({
    python3: { stdout: "Python 3.11.0", stderr: "" },
  });
  const { skl, written } = makeSkl();
  const hookConfig = defaultConfig(); // python_executable: "python3"

  const installer = new HookInstaller(fakeExtCtx, execFile);

  try {
    await installer.install("/no-such-repo", hookConfig, skl);
  } catch {
    // Expected — no .git/hooks dir.
  }

  assertEqual(written.length, 0, "writeHookConfig not called when already correct");
  assertEqual(hookConfig.python_executable, "python3", "config value unchanged");
});

await testAsync("detection probes candidates in order: python3 first, then python, then py", async () => {
  const callOrder: string[] = [];
  const execFile: ExecFileFn = async (cmd) => {
    if (["python3", "python", "py"].includes(cmd)) {
      callOrder.push(cmd);
      throw new Error("not found");
    }
    return { stdout: "", stderr: "" };
  };
  const { skl } = makeSkl();
  const hookConfig = defaultConfig();
  const installer = new HookInstaller(fakeExtCtx, execFile);

  await installer.install("/no-such-repo", hookConfig, skl);

  assertEqual(callOrder[0], "python3", "first candidate is python3");
  assertEqual(callOrder[1], "python",  "second candidate is python");
  assertEqual(callOrder[2], "py",      "third candidate is py");
});

// ── getPythonVersion (unchanged API) ─────────────────────────────────────

await testAsync("getPythonVersion returns stdout when executable exists", async () => {
  const { execFile } = makeExecFile({
    "/usr/bin/python3": { stdout: "Python 3.11.2", stderr: "" },
  });
  const installer = new HookInstaller(fakeExtCtx, execFile);
  const version = await installer.getPythonVersion("/usr/bin/python3");
  assertEqual(version, "Python 3.11.2", "version string returned");
});

await testAsync("getPythonVersion returns null when executable is missing", async () => {
  const { execFile } = makeExecFile({ "/missing": null });
  const installer = new HookInstaller(fakeExtCtx, execFile);
  const version = await installer.getPythonVersion("/missing");
  assertEqual(version, null, "null returned for missing executable");
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
