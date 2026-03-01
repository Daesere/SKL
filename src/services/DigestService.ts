/**
 * DigestService — human review digest generation (Section 11, 13.6)
 *
 * generateDigest is a PURE FUNCTION — no I/O, no LLM, no side effects.
 * shouldTriggerDigest is also pure.
 *
 * Both functions operate only on the KnowledgeFile passed in —
 * the caller is responsible for reading the current knowledge.
 */

import type { KnowledgeFile, StateRecord, QueueProposal } from "../types/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of architectural decisions that trigger a digest notification. */
export const DIGEST_INTERVAL = 10;

/**
 * Change count threshold before a State entry is flagged for drift.
 * Must match the value used in SKLDiagnosticsProvider.ts (currently 5).
 */
export const REVIEW_THRESHOLD = 5;

// ── DigestReport type ─────────────────────────────────────────────────────────

export type DigestReport = {
  generated_at: string;
  architectural_decisions_since_last_digest: Array<{
    proposal_id: string;
    path: string;
    rationale_text: string;
    decision: string;
    recorded_at: string;
  }>;
  state_entries_for_review: StateRecord[];
  state_entries_flagged: StateRecord[];
  contested_entries: StateRecord[];
  open_rfc_ids: string[];
  summary: string;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the proposal has an approved or auto-approved status.
 *
 * Note: "auto_approve" is stored verbatim (via cast in writeRationale) even
 * though it is not a formal member of ProposalStatus — we cast to string here
 * to allow the comparison without introducing an explicit `any`.
 */
function isApprovedProposal(p: QueueProposal): boolean {
  return p.status === "approved" || (p.status as string) === "auto_approve";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a DigestReport from the current KnowledgeFile and a list of open RFC IDs.
 *
 * Pure function — deterministic given the same inputs.
 *
 * @param knowledge   Current knowledge.json contents.
 * @param openRfcIds  RFC IDs currently open (caller resolves these from RFC files).
 */
export function generateDigest(
  knowledge: KnowledgeFile,
  openRfcIds: string[],
): DigestReport {
  // ── Architectural decisions (most recent DIGEST_INTERVAL, descending) ──────
  const architecturalDecisions = knowledge.queue
    .filter(
      (p) =>
        p.decision_rationale?.decision_type === "architectural" &&
        isApprovedProposal(p),
    )
    .sort((a, b) => {
      const aAt = a.decision_rationale?.recorded_at ?? "";
      const bAt = b.decision_rationale?.recorded_at ?? "";
      return bAt.localeCompare(aAt); // descending
    })
    .slice(0, DIGEST_INTERVAL)
    .map((p) => ({
      proposal_id: p.proposal_id,
      path: p.path,
      rationale_text: p.decision_rationale?.text ?? "",
      decision: p.status as string,
      recorded_at: p.decision_rationale?.recorded_at ?? "",
    }));

  // ── State categorisation ──────────────────────────────────────────────────
  const stateEntriesForReview = knowledge.state.filter(
    (r) => r.uncertainty_level === 2,
  );

  const stateEntriesFlagged = knowledge.state.filter(
    (r) => r.change_count_since_review >= REVIEW_THRESHOLD,
  );

  const contestedEntries = knowledge.state.filter(
    (r) => r.uncertainty_level === 3,
  );

  // ── Summary string ────────────────────────────────────────────────────────
  const summary =
    `Digest ${new Date().toLocaleDateString()}. ` +
    `${stateEntriesForReview.length} entries pending review, ` +
    `${stateEntriesFlagged.length} flagged for drift, ` +
    `${contestedEntries.length} contested, ` +
    `${openRfcIds.length} open RFCs, ` +
    `${architecturalDecisions.length} architectural decisions since last digest.`;

  return {
    generated_at: new Date().toISOString(),
    architectural_decisions_since_last_digest: architecturalDecisions,
    state_entries_for_review: stateEntriesForReview,
    state_entries_flagged: stateEntriesFlagged,
    contested_entries: contestedEntries,
    open_rfc_ids: openRfcIds,
    summary,
  };
}

/**
 * Return true if enough architectural decisions have been approved since
 * the last digest to justify triggering a new one.
 *
 * @param knowledge     Current knowledge.json contents.
 * @param lastDigestAt  ISO 8601 datetime of the last digest review, or null.
 */
export function shouldTriggerDigest(
  knowledge: KnowledgeFile,
  lastDigestAt: string | null,
): boolean {
  if (lastDigestAt === null) return true;

  const count = knowledge.queue.filter(
    (p) =>
      p.decision_rationale?.decision_type === "architectural" &&
      isApprovedProposal(p) &&
      (p.decision_rationale?.recorded_at ?? "") > lastDigestAt,
  ).length;

  return count >= DIGEST_INTERVAL;
}
