import { z } from "zod";

/**
 * Architecture Decision Record Schema (Section 9.5)
 *
 * ADRs are append-only and permanent. They are promoted from resolved RFCs
 * and included in every future Orchestrator session's initialization context.
 *
 * Immutability invariant: an ADR must never contain an `updated_at` field.
 * The Zod refinement enforces this at the schema level.
 */
export const AdrSchema = z
  .object({
    /** Unique ADR identifier (e.g. "ADR_003"). */
    id: z.string(),

    /** ISO 8601 datetime when the ADR was created. */
    created_at: z.string().datetime(),

    /** Short title summarizing the decision. */
    title: z.string(),

    /** Background context that led to the decision. */
    context: z.string(),

    /** The decision that was made. */
    decision: z.string(),

    /** Expected consequences of the decision. */
    consequences: z.string(),

    /** RFC ID that promoted this ADR (optional if manually created). */
    promoting_rfc_id: z.string().optional(),
  })
  .passthrough()
  .refine(
    (data) => !("updated_at" in data),
    {
      message:
        "ADRs are immutable once written — updated_at is not allowed",
      path: ["updated_at"],
    },
  );

export type Adr = z.infer<typeof AdrSchema>;
