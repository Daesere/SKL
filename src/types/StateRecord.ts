import { z } from "zod";
import { AssumptionSchema, UncertaintyLevelSchema } from "./shared.js";

/**
 * State Record Schema (Section 3.2.1)
 *
 * The live map of all registered files and modules.
 * Written only by the Orchestrator.
 */
export const StateRecordSchema = z.object({
  /** Unique identifier for this State entry. */
  id: z.string(),

  /** Relative file path from repo root. */
  path: z.string(),

  /** Must match a key in scope_definitions.json. */
  semantic_scope: z.string(),

  /** Scope definition version used at last validation. */
  scope_schema_version: z.string(),

  /** Plain-language description of the file's single responsibility. */
  responsibilities: z.string(),

  /** Direct dependencies; validated by import scanner. */
  dependencies: z.array(z.string()),

  /** Which Invariant keys this file's behavior depends on. */
  invariants_touched: z.array(z.string()),

  /** Explicit assumptions agents declared about this module. */
  assumptions: z.array(AssumptionSchema),

  /** Agent ID of last approved proposer. */
  owner: z.string(),

  /** Increments on every approved change. */
  version: z.number().int().nonnegative(),

  /** See Section 3.2.3 — can only decrease via external proof. */
  uncertainty_level: UncertaintyLevelSchema,

  /** Test file or check that last reduced uncertainty. */
  uncertainty_reduced_by: z.string().optional(),

  /** Date of last human review of this entry (ISO 8601 date). */
  last_reviewed_at: z.string().optional(),

  /** Increments per approved change; reset on human review. */
  change_count_since_review: z.number().int().nonnegative(),
});

export type StateRecord = z.infer<typeof StateRecordSchema>;
