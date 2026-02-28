import { ZodError } from "zod";

/**
 * Thrown when knowledge.json fails Zod schema validation.
 *
 * Wraps the underlying ZodError so callers can inspect individual issues
 * while getting a human-readable message at the top level.
 */
export class SKLValidationError extends Error {
  public readonly zodError: ZodError;
  public readonly filePath: string;

  constructor(filePath: string, zodError: ZodError) {
    const brief = zodError.issues
      .map((i) => `  [${i.path.join(".")}] ${i.message}`)
      .join("\n");

    super(
      `SKLValidationError: knowledge.json failed schema validation.\n` +
        `  File: ${filePath}\n` +
        `  Issues:\n${brief}`,
    );

    this.name = "SKLValidationError";
    this.zodError = zodError;
    this.filePath = filePath;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, SKLValidationError.prototype);
  }
}
