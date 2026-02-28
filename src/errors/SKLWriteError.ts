/**
 * Thrown when an atomic write operation fails.
 *
 * Carries the target path plus the underlying cause so callers can
 * decide whether to retry or surface the error.
 */
export class SKLWriteError extends Error {
  public readonly path: string;
  public override readonly cause: unknown;

  constructor(filePath: string, cause: unknown) {
    const reason =
      cause instanceof Error ? cause.message : String(cause);
    super(`SKLWriteError: failed to write ${filePath} — ${reason}`);
    this.name = "SKLWriteError";
    this.path = filePath;
    this.cause = cause;
    Object.setPrototypeOf(this, SKLWriteError.prototype);
  }
}
