import { z } from "zod";

/**
 * Session Log Schema (Section 7.5.1)
 *
 * Written by the Orchestrator when a session ends. A new Orchestrator instance
 * initializes from knowledge.json plus the most recent session log only.
 */
export const SessionLogSchema = z.object({
  /** Unique session identifier (e.g. "session_003"). */
  session_id: z.string(),

  /** Number of proposals reviewed in this session. */
  proposals_reviewed: z.number().int().nonnegative(),

  /** ISO 8601 datetime when the session started. */
  session_start: z.string().datetime(),

  /** ISO 8601 datetime when the session ended. */
  session_end: z.string().datetime(),

  /** Patterns the Orchestrator noticed recurring across proposals. */
  recurring_patterns_flagged: z.array(z.string()),

  /** Proposal IDs that were escalated during this session. */
  escalations: z.array(z.string()),

  /** RFC IDs opened during this session. */
  rfcs_opened: z.array(z.string()),

  /** Proposals where the Orchestrator was uncertain about its decision. */
  uncertain_decisions: z.array(z.string()),

  /** Agent IDs whose circuit breakers were triggered. */
  circuit_breakers_triggered: z.array(z.string()),
});

export type SessionLog = z.infer<typeof SessionLogSchema>;
