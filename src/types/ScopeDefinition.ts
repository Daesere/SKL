import { z } from "zod";

/**
 * Individual Scope Definition (Section 4.1)
 */
export const ScopeEntrySchema = z.object({
  /** Human-readable description of what this scope covers. */
  description: z.string(),

  /** Explicit file paths allowed in this scope. */
  allowed_paths: z.array(z.string()).optional(),

  /** Path prefixes that files in this scope may match. */
  allowed_path_prefixes: z.array(z.string()),

  /** Path prefixes that files in this scope must NOT match. */
  forbidden_path_prefixes: z.array(z.string()),

  /** Plain-language responsibilities permitted under this scope. */
  permitted_responsibilities: z.array(z.string()),

  /** Plain-language responsibilities explicitly forbidden under this scope. */
  forbidden_responsibilities: z.array(z.string()),

  /** Who maintains this scope definition. */
  owner: z.string(),
});
export type ScopeEntry = z.infer<typeof ScopeEntrySchema>;

/**
 * Scope Definitions file schema (Section 4.1 — scope_definitions.json)
 *
 * Semantic scopes are formally defined and machine-validated.
 * Maintained by the human operator alongside Invariants.
 */
export const ScopeDefinitionSchema = z.object({
  scope_definitions: z.object({
    /** Version of the scope definitions taxonomy. */
    version: z.string(),

    /** Map of scope name → scope entry. */
    scopes: z.record(z.string(), ScopeEntrySchema),
  }),
});

export type ScopeDefinition = z.infer<typeof ScopeDefinitionSchema>;
