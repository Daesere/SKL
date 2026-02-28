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
import type * as vscode from "vscode";
import { SKLWriteError } from "../errors/index.js";

const execFile = promisify(execFileCb);

/** Marker written as the very first line of the managed hook script. */
const HOOK_MARKER = "# SKL_HOOK_V1.4";

/**
 * Installs, detects, and removes the SKL pre-push hook inside a
 * repository's `.git/hooks/` directory.
 */
export class HookInstaller {
  private readonly extensionContext: vscode.ExtensionContext;

  constructor(extensionContext: vscode.ExtensionContext) {
    this.extensionContext = extensionContext;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Run `executablePath --version` and return the version string
   * (e.g. `"Python 3.11.2"`), or `null` if the executable cannot be
   * found or exits with a non-zero code.
   */
  async getPythonVersion(executablePath: string): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFile(executablePath, [
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
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-push");
    try {
      const content = await fs.readFile(hookPath, "utf-8");
      return content.slice(0, 50).includes(HOOK_MARKER);
    } catch {
      return false;
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
    pythonExecutable: string,
  ): Promise<void> {
    const hooksDir = path.join(repoRoot, ".git", "hooks");
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

    // Copy hook script to target.
    try {
      await fs.copyFile(sourcePath, targetPath);
    } catch (cause) {
      throw new SKLWriteError(targetPath, cause);
    }

    // Platform-specific post-install.
    if (process.platform !== "win32") {
      try {
        await execFile("chmod", ["+x", targetPath]);
      } catch {
        throw new SKLWriteError(
          targetPath,
          new Error(
            `Failed to set executable permission on ${targetPath}`,
          ),
        );
      }
    } else {
      // Git for Windows invokes .cmd hooks — write a thin wrapper.
      const cmdPath = targetPath + ".cmd";
      const cmdContent = `@"${pythonExecutable}" "${targetPath}" %*\n`;
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
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const hookPath = path.join(hooksDir, "pre-push");
    const backupPath = hookPath + ".skl-backup";
    const cmdPath = hookPath + ".cmd";

    // Remove the hook file (and optional .cmd wrapper).
    await this.silentUnlink(hookPath);
    await this.silentUnlink(cmdPath);

    // Restore any backup.
    try {
      await fs.access(backupPath);
      await fs.rename(backupPath, hookPath);
    } catch {
      // No backup to restore — nothing to do.
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * If a `pre-push` file exists at *hookPath* and does **not** contain
   * the SKL marker, rename it to `pre-push.skl-backup`.
   */
  private async backupExistingHook(hookPath: string): Promise<void> {
    try {
      const content = await fs.readFile(hookPath, "utf-8");
      if (!content.slice(0, 50).includes(HOOK_MARKER)) {
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
