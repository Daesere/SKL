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
import type { SKLFileSystem } from "./SKLFileSystem.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of architectural decisions that trigger a digest notification. */
export const DIGEST_INTERVAL = 10;

/**
 * Change count threshold before a State entry is flagged for drift.
 * Must match the value used in SKLDiagnosticsProvider.ts (currently 5).
 */
export const REVIEW_THRESHOLD = 5;

// ── DigestReport type ─────────────────────────────────────────────────────────

export type ScoredStateRecord = StateRecord & { priority_score: number };

export type DigestReport = {
  generated_at: string;
  architectural_decisions_since_last_digest: Array<{
    proposal_id: string;
    path: string;
    rationale_text: string;
    decision: string;
    recorded_at: string;
  }>;
  state_entries_for_review: ScoredStateRecord[];
  state_entries_flagged: ScoredStateRecord[];
  contested_entries: ScoredStateRecord[];
  open_rfc_ids: string[];
  patterns_from_session_log: string[];
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

// ── Priority scoring ──────────────────────────────────────────────────────────

/**
 * Compute a priority score for a State record.
 * Higher scores surface in the digest first.
 */
export function computePriorityScore(record: StateRecord): number {
  return (
    record.change_count_since_review * 2 +
    (record.uncertainty_level === 3 ? 100 : 0) +
    (record.uncertainty_level === 2 ? 10 : 0) +
    (record.change_count_since_review >= REVIEW_THRESHOLD ? 20 : 0) +
    (record.assumptions ?? []).filter((a) => a.shared).length * 3
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a DigestReport from the current KnowledgeFile and a list of open RFC IDs.
 *
 * @param knowledge      Current knowledge.json contents.
 * @param openRfcIds     RFC IDs currently open (caller resolves these from RFC files).
 * @param sklFileSystem  File system for reading the session log.
 */
export async function generateDigest(
  knowledge: KnowledgeFile,
  openRfcIds: string[],
  sklFileSystem: SKLFileSystem,
): Promise<DigestReport> {
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
  const stateEntriesForReview: ScoredStateRecord[] = knowledge.state
    .filter((r) => r.uncertainty_level === 2)
    .map((r) => ({ ...r, priority_score: computePriorityScore(r) }))
    .sort((a, b) => b.priority_score - a.priority_score);

  const stateEntriesFlagged: ScoredStateRecord[] = knowledge.state
    .filter((r) => r.change_count_since_review >= REVIEW_THRESHOLD)
    .map((r) => ({ ...r, priority_score: computePriorityScore(r) }))
    .sort((a, b) => b.priority_score - a.priority_score);

  const contestedEntries: ScoredStateRecord[] = knowledge.state
    .filter((r) => r.uncertainty_level === 3)
    .map((r) => ({ ...r, priority_score: computePriorityScore(r) }))
    .sort((a, b) => b.priority_score - a.priority_score);

  // ── Session log patterns ──────────────────────────────────────────────────
  const sessionLog = await sklFileSystem.readMostRecentSessionLog();
  const patternsFromSessionLog = sessionLog?.recurring_patterns_flagged ?? [];
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
    patterns_from_session_log: patternsFromSessionLog,
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
