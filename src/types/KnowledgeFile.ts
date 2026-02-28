import { z } from "zod";
import { StateRecordSchema } from "./StateRecord.js";
import { QueueProposalSchema } from "./QueueProposal.js";

/**
 * Invariants Section (Section 3.1)
 *
 * Defined once at project initialization. Modifiable only by a human operator via RFC.
 * Agents may reference them but never change them directly.
 */
export const InvariantsSchema = z.object({
  /** Technology stack constraints. */
  tech_stack: z.array(z.string()),

  /** Authentication model identifier. */
  auth_model: z.string(),

  /** Data storage constraint. */
  data_storage: z.string(),

  /** Security-sensitive identifier patterns for AST risk signal detection. */
  security_patterns: z.array(z.string()),
});
export type Invariants = z.infer<typeof InvariantsSchema>;

/**
 * Knowledge File Schema — knowledge.json
 *
 * The top-level structure that contains the three core sections of SKL:
 *   1. Invariants — immutable project-level constraints
 *   2. State — the live map of all registered files/modules
 *   3. Queue — pending proposals submitted by agents
 */
export const KnowledgeFileSchema = z.object({
  /** Project-level invariants (Section 3.1). */
  invariants: InvariantsSchema,

  /** Array of State records for all registered files (Section 3.2). */
  state: z.array(StateRecordSchema),

  /** Array of pending Queue proposals (Section 3.3). */
  queue: z.array(QueueProposalSchema),
});

export type KnowledgeFile = z.infer<typeof KnowledgeFileSchema>;
