import { z } from "zod";

/**
 * AST Change Type (Section 5.1, Check 3)
 *
 * Distinct from the proposal-level ChangeType:
 *   - mechanical  — AST-identical to base; only whitespace/comments changed.
 *   - behavioral  — Function bodies change without signature changes.
 *   - structural  — Class or function signatures change; new dependencies introduced.
 *
 * Note: The AST analysis uses "structural" while the proposal-level
 * change_type uses "architectural" (Section 3.3.2). These are intentionally
 * different vocabularies.
 */
export const AstChangeTypeSchema = z.union([
  z.literal("mechanical"),
  z.literal("behavioral"),
  z.literal("structural"),
]);
export type AstChangeType = z.infer<typeof AstChangeTypeSchema>;

/**
 * Risk Signals Schema (Section 5.1, Check 3)
 *
 * Produced by AST diff analysis in the enforcement hook.
 * Each signal has specific routing consequences for the Orchestrator.
 */
export const RiskSignalsSchema = z.object({
  /** Known security-sensitive identifiers found in diff. */
  touched_auth_or_permission_patterns: z.boolean(),

  /** Function/class definition signature changed between base and head. */
  public_api_signature_changed: z.boolean(),

  /** Modified file appears in dependencies of a State entry with invariants_touched. */
  invariant_referenced_file_modified: z.boolean(),

  /** Modified file appears as dependency in 3+ State records. */
  high_fan_in_module_modified: z.boolean(),

  /** AST-level classification of change scope. */
  ast_change_type: AstChangeTypeSchema,

  /** True when ast_change_type is mechanical AND no other signals are set. */
  mechanical_only: z.boolean(),
});
export type RiskSignals = z.infer<typeof RiskSignalsSchema>;
