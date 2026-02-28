import { z } from "zod";

/**
 * RFC Option — a proposed resolution path (Section 9.2)
 */
export const RfcOptionSchema = z.object({
  /** Description of the proposed approach. */
  description: z.string(),

  /** Expected consequences if this option is chosen. */
  consequences: z.string(),
});
export type RfcOption = z.infer<typeof RfcOptionSchema>;

/**
 * RFC Status
 */
export const RfcStatusSchema = z.union([
  z.literal("open"),
  z.literal("resolved"),
  z.literal("rejected"),
]);
export type RfcStatus = z.infer<typeof RfcStatusSchema>;

/**
 * RFC Schema (Section 9.2)
 *
 * Architectural decisions require human pre-clearance before the implementing
 * branch is merged. An RFC captures the decision context, options, and
 * resolution including mechanically checkable acceptance criteria.
 */
export const RfcSchema = z.object({
  /** Unique RFC identifier. */
  id: z.string(),

  /** Current status of the RFC. */
  status: RfcStatusSchema,

  /** ISO 8601 datetime when the RFC was created. */
  created_at: z.string().datetime(),

  /** Proposal ID that triggered this RFC. */
  triggering_proposal: z.string(),

  /** The architectural question requiring a human decision. */
  decision_required: z.string(),

  /** Background context for the decision. */
  context: z.string(),

  /** First resolution option. */
  option_a: RfcOptionSchema,

  /** Second resolution option. */
  option_b: RfcOptionSchema,

  /** Optional third resolution option. */
  option_c: RfcOptionSchema.optional(),

  /** Orchestrator's recommended option key (e.g. "option_b"). */
  orchestrator_recommendation: z.string().optional(),

  /** Orchestrator's written rationale for the recommendation. */
  orchestrator_rationale: z.string().optional(),

  /** Chosen resolution option key (populated on resolution). */
  resolution: z.string().optional(),

  /** Human operator's rationale for the resolution. */
  human_rationale: z.string().optional(),

  /** Optional list of acceptance criteria descriptions (Section 9.3). */
  acceptance_criteria: z.array(z.string()).optional(),

  /** Hard merge gate — branch cannot merge until all criteria pass. */
  merge_blocked_until_criteria_pass: z.boolean().optional(),

  /** ISO 8601 deadline for human response (default: 24h from creation). */
  human_response_deadline: z.string().datetime().optional(),

  /** ADR ID if the resolution was promoted to an Architecture Decision Record. */
  promoted_to_adr: z.string().optional(),
});

export type Rfc = z.infer<typeof RfcSchema>;
