import { z } from "zod";

/**
 * Agent Context Schema
 *
 * Captures the runtime context for a single agent session.
 * Stored at .skl/scratch/{agent_id}_context.json.
 */
export const AgentContextSchema = z.object({
  /** Unique identifier for this agent. */
  agent_id: z.string(),

  /** Must match a key in scope_definitions.json. */
  semantic_scope: z.string(),

  /** Explicit file paths this agent is permitted to touch. */
  file_scope: z.array(z.string()),

  /** ISO 8601 timestamp of session start. */
  session_start: z.string().datetime(),

  /** Number of circuit-breaker trips in this session. */
  circuit_breaker_count: z.number().int().min(0),
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
