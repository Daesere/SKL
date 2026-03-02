/**
 * HookInstaller — manages the SKL pre-push Git hook lifecycle.
 *
 * **Deliberate ESLint exception:** This service operates on `.git/hooks/`,
 * which lives outside the `.skl/` directory managed by {@link SKLFileSystem}.
 * Direct `fs/promises` and `path` imports are therefore intentional and
 * covered by an ESLint override for this file only.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { SKLFileSystem } from "./SKLFileSystem.js";
import { SKLWriteError } from "../errors/index.js";
import type { HookConfig } from "../types/index.js";

const _defaultExecFile = promisify(execFileCb);

/**
 * Promisified execFile signature — injected so tests can mock Python
 * detection without touching the real file system or process table.
 */
export type ExecFileFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Marker written as the very first line of the managed hook script. */
const HOOK_MARKER = "# SKL_HOOK_V1.4";
/** Second-line comment embedded in the Windows bootstrap to prevent backup. */
const BOOTSTRAP_MARKER = "# SKL_BOOTSTRAP_V1.4";

/**
 * Installs, detects, and removes the SKL pre-push hook inside a
 * repository's `.git/hooks/` directory.
 */
export class HookInstaller {
  private readonly extensionContext: vscode.ExtensionContext;
  private readonly _execFile: ExecFileFn;

  constructor(
    extensionContext: vscode.ExtensionContext,
    execFileFn?: ExecFileFn,
  ) {
    this.extensionContext = extensionContext;
    this._execFile = execFileFn ?? (_defaultExecFile as unknown as ExecFileFn);
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Run `executablePath --version` and return the version string
   * (e.g. `"Python 3.11.2"`), or `null` if the executable cannot be
   * found or exits with a non-zero code.
   */
  async getPythonVersion(executablePath: string): Promise<string | null> {
    try {
      const { stdout, stderr } = await this._execFile(executablePath, [
        "--version",
      ]);
      // Python 2 prints to stderr, Python 3 prints to stdout.
      const output = (stdout || stderr || "").trim();
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Return `true` when a managed SKL pre-push hook is already present
   * in the repository.
   */
  async isInstalled(repoRoot: string): Promise<boolean> {
    const hooksDir = await this.getHooksDir(repoRoot);

    if (process.platform === "win32") {
      // Windows install writes three files:
      //   pre-push       — Python bootstrap (shebang, delegates to pre-push.py)
      //   pre-push.py    — real SKL hook (contains HOOK_MARKER)
      //   pre-push.cmd   — cmd.exe fallback
      // All three must be present for the hook to be considered installed.
      const pyPath = path.join(hooksDir, "pre-push.py");
      const bootstrapPath = path.join(hooksDir, "pre-push");
      const cmdPath = path.join(hooksDir, "pre-push.cmd");
      try {
        const [pyContent, bootstrapContent] = await Promise.all([
          fs.readFile(pyPath, "utf-8"),
          fs.readFile(bootstrapPath, "utf-8"),
          fs.access(cmdPath),
        ]);
        return (
          pyContent.slice(0, 50).includes(HOOK_MARKER) &&
          bootstrapContent.slice(0, 80).includes(BOOTSTRAP_MARKER)
        );
      } catch {
        return false;
      }
    } else {
      // Unix: single bare pre-push file with shebang and HOOK_MARKER.
      const hookPath = path.join(hooksDir, "pre-push");
      try {
        const content = await fs.readFile(hookPath, "utf-8");
        return content.slice(0, 50).includes(HOOK_MARKER);
      } catch {
        return false;
      }
    }
  }

  /**
   * Install the SKL pre-push hook into the repository.
   *
   * - Backs up any existing non-SKL `pre-push` file.
   * - On Unix: sets the executable bit via `chmod +x`.
   * - On Windows: writes a `pre-push.cmd` wrapper so that Git for
   *   Windows invokes the Python script.
   *
   * @throws {SKLWriteError} if the hooks directory is missing / not
   *   writable, or `chmod` fails.
   */
  async install(
    repoRoot: string,
    hookConfig: HookConfig,
    sklFileSystem: SKLFileSystem,
  ): Promise<void> {
    // ── Step 1: Resolve the Python executable ─────────────────────────────
    let pythonExecutable: string;

    if (hookConfig.python_executable !== "python3") {
      // User has manually set a non-default value — honour it as-is.
      pythonExecutable = hookConfig.python_executable;
    } else {
      // Default value — probe for a working Python binary.
      const detected = await this.detectPythonExecutable();
      if (detected === null) {
        void vscode.window.showErrorMessage(
          "SKL: Python not found. Tried: python3, python, py.\n" +
            "To fix this manually: open .skl/hook_config.json and set\n" +
            '"python_executable" to the correct name for your system\n' +
            '(usually "python" on Windows, "python3" on Mac/Linux).\n' +
            "Then run 'SKL: Install Hook' again.",
        );
        return;
      }
      if (detected !== "python3") {
        // Persist the working executable so future hook runs use it directly.
        hookConfig.python_executable = detected;
        await sklFileSystem.writeHookConfig(hookConfig);
      }
      pythonExecutable = detected;
    }

    const hooksDir = await this.getHooksDir(repoRoot);
    const targetPath = path.join(hooksDir, "pre-push");

    // Ensure the hooks directory exists and is writable.
    try {
      await fs.access(hooksDir, fs.constants.W_OK);
    } catch {
      throw new SKLWriteError(
        hooksDir,
        new Error(
          `Hooks directory does not exist or is not writable: ${hooksDir}`,
        ),
      );
    }

    // Back up any pre-existing non-SKL hook.
    await this.backupExistingHook(targetPath);

    // Resolve the bundled hook script shipped with the extension.
    const sourcePath = path.join(
      this.extensionContext.extensionPath,
      "hook",
      "pre-push.py",
    );

    if (process.platform !== "win32") {
      // ── Unix / Mac ───────────────────────────────────────────────────────
      // Copy the Python script to the extensionless `pre-push` hook file and
      // set the executable bit. Git executes this file directly via the
      // shebang or treats it as a shell script depending on content.
      // Back up any pre-existing non-SKL hook.
      await this.backupExistingHook(targetPath);

      try {
        await fs.copyFile(sourcePath, targetPath);
      } catch (cause) {
        throw new SKLWriteError(targetPath, cause);
      }

      try {
        await this._execFile("chmod", ["+x", targetPath]);
      } catch {
        throw new SKLWriteError(
          targetPath,
          new Error(
            `Failed to set executable permission on ${targetPath}`,
          ),
        );
      }
    } else {
      // ── Windows ─────────────────────────────────────────────────────────
      // Git for Windows (MinGW bash) executes the bare `pre-push` hook.
      // It supports `#!/usr/bin/env python` shebangs when Python is in PATH.
      //
      // Strategy:
      //   • copy hook source as `pre-push.py` (the real implementation)
      //   • write a bare `pre-push` Python bootstrap (LF line endings,
      //     no BOM) that delegates to `pre-push.py` via subprocess
      //   • write `pre-push.cmd` as a fallback for cmd.exe environments
      const pyTargetPath = targetPath + ".py";
      const cmdPath = targetPath + ".cmd";

      // Back up any pre-existing non-SKL hook files.
      await this.backupExistingHook(targetPath);
      await this.backupExistingHook(pyTargetPath);

      try {
        await fs.copyFile(sourcePath, pyTargetPath);
      } catch (cause) {
        throw new SKLWriteError(pyTargetPath, cause);
      }

      // Bare bootstrap — must use LF only so MinGW bash can read the shebang.
      const bootstrapLines = [
        "#!/usr/bin/env python",
        BOOTSTRAP_MARKER,
        "import os, sys, subprocess",
        "",
        "script = os.path.join(os.path.dirname(os.path.abspath(__file__)), \"pre-push.py\")",
        "result = subprocess.run([sys.executable, script] + sys.argv[1:], stdin=sys.stdin)",
        "sys.exit(result.returncode)",
        "",
      ];
      const bootstrapContent = Buffer.from(bootstrapLines.join("\n"), "utf-8");
      try {
        await fs.writeFile(targetPath, bootstrapContent);
      } catch (cause) {
        throw new SKLWriteError(targetPath, cause);
      }

      const cmdContent = `@echo off\r\n"${pythonExecutable}" "%~dp0pre-push.py" %*\r\n`;
      try {
        await fs.writeFile(cmdPath, cmdContent, "utf-8");
      } catch (cause) {
        throw new SKLWriteError(cmdPath, cause);
      }
    }
  }

  /**
   * Remove the managed SKL pre-push hook.
   *
   * If a `.skl-backup` file exists it is restored to `pre-push`.
   * Silently returns when the hook is not present.
   */
  async uninstall(repoRoot: string): Promise<void> {
    const hooksDir = await this.getHooksDir(repoRoot);
    const hookPath = path.join(hooksDir, "pre-push");

    if (process.platform === "win32") {
      // Windows install wrote pre-push (bootstrap) + pre-push.py + pre-push.cmd.
      const pyPath = hookPath + ".py";
      const cmdPath = hookPath + ".cmd";
      await this.silentUnlink(hookPath);
      await this.silentUnlink(pyPath);
      await this.silentUnlink(cmdPath);
      // Restore bare hook backup if one exists.
      const hookBackup = hookPath + ".skl-backup";
      try {
        await fs.access(hookBackup);
        await fs.rename(hookBackup, hookPath);
      } catch {
        // No backup.
      }
      // Restore .py backup if one exists.
      const pyBackup = pyPath + ".skl-backup";
      try {
        await fs.access(pyBackup);
        await fs.rename(pyBackup, pyPath);
      } catch {
        // No backup.
      }
    } else {
      const backupPath = hookPath + ".skl-backup";
      await this.silentUnlink(hookPath);
      try {
        await fs.access(backupPath);
        await fs.rename(backupPath, hookPath);
      } catch {
        // No backup to restore — nothing to do.
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Resolve the directory Git will actually read hooks from.
   *
   * Reads `core.hooksPath` from git config. If it is set to a relative
   * path it is resolved against `repoRoot`. Falls back to the
   * traditional `.git/hooks` location when unset or when the git
   * command fails (e.g. git is not on PATH).
   */
  private async getHooksDir(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await this._execFile("git", [
        "-C",
        repoRoot,
        "config",
        "--local",
        "core.hooksPath",
      ]);
      const configured = stdout.trim();
      if (configured) {
        return path.isAbsolute(configured)
          ? configured
          : path.join(repoRoot, configured);
      }
    } catch {
      // git not available or config key absent — use default.
    }
    return path.join(repoRoot, ".git", "hooks");
  }

  /**
   * Try each Python candidate in order and return the first one that
   * exits successfully, or `null` if all fail.
   */
  private async detectPythonExecutable(): Promise<string | null> {
    const candidates = ["python3", "python", "py"];
    for (const candidate of candidates) {
      try {
        await this._execFile(candidate, ["--version"]);
        return candidate;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  /**
   * If a `pre-push` file exists at *hookPath* and does **not** contain
   * the SKL marker, rename it to `pre-push.skl-backup`.
   */
  private async backupExistingHook(hookPath: string): Promise<void> {
    try {
      const content = await fs.readFile(hookPath, "utf-8");
      const head = content.slice(0, 80);
      if (!head.includes(HOOK_MARKER) && !head.includes(BOOTSTRAP_MARKER)) {
        await fs.rename(hookPath, hookPath + ".skl-backup");
      }
    } catch {
      // File does not exist — nothing to back up.
    }
  }

  /** Delete a file if it exists; swallow ENOENT. */
  private async silentUnlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // Already absent — nothing to do.
    }
  }
}
