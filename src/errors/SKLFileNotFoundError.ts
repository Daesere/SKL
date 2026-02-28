/**
 * Thrown when a required .skl file is not found on disk.
 */
export class SKLFileNotFoundError extends Error {
  public readonly path: string;

  constructor(filePath: string) {
    super(`SKLFileNotFoundError: file not found — ${filePath}`);
    this.name = "SKLFileNotFoundError";
    this.path = filePath;
    Object.setPrototypeOf(this, SKLFileNotFoundError.prototype);
  }
}
