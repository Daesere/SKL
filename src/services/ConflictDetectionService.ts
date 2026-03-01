/**
 * ConflictDetectionService — State conflict detection (Sections 7.2, 7.3)
 *
 * Pure functions only, no I/O, no LLM calls.
 * Detects ownership conflicts and downstream impact conflicts
 * by comparing a proposal against the current State records.
 *
 * **ESLint note:** Uses `path.normalize()` for cross-platform path
 * comparison. Added to the ESLint ignores list for the path ban.
 */

import * as path from "node:path";
import type {
  QueueProposal,
  StateRecord,
  StateConflictResult,
} from "../types/index.js";

/**
 * Normalize a file path for consistent comparison.
 */
function normPath(p: string): string {
  return path.normalize(p);
}

/**
 * Detect State conflicts for a proposal.
 *
 * Check A — Direct ownership: another agent owns the same file
 *           (uncertainty_level 3 excluded — those escalate instead).
 * Check B — Downstream impact: proposal changes a public API that
 *           another agent's file depends on.
 *
 * Returns on the first conflict found.
 */
export function detectStateConflict(
  proposal: QueueProposal,
  stateRecords: StateRecord[],
): StateConflictResult {
  const proposalPath = normPath(proposal.path);

  // Check A — Direct ownership conflict
  for (const record of stateRecords) {
    if (
      normPath(record.path) === proposalPath &&
      record.owner !== proposal.agent_id &&
      record.uncertainty_level !== 3
    ) {
      return {
        has_conflict: true,
        conflicting_record: record,
        conflict_description:
          `File ${proposal.path} is owned by ${record.owner}. ` +
          `Proposing agent ${proposal.agent_id} does not own this file.`,
      };
    }
  }

  // Check B — Downstream impact conflict
  if (proposal.risk_signals.public_api_signature_changed) {
    for (const record of stateRecords) {
      const depMatch = record.dependencies.some(
        (dep) => normPath(dep) === proposalPath,
      );
      if (depMatch && record.owner !== proposal.agent_id) {
        return {
          has_conflict: true,
          conflicting_record: record,
          conflict_description:
            `Proposal changes public API of ${proposal.path} which is a dependency of ` +
            `${record.id} (owned by ${record.owner}). ` +
            `Coordinate with the owning agent before merging.`,
        };
      }
    }
  }

  return {
    has_conflict: false,
    conflicting_record: null,
    conflict_description: null,
  };
}

/**
 * Returns true if the State record for `proposal.path` exists
 * and has `uncertainty_level === 3`.
 *
 * A new file (no matching State record) cannot be at level 3.
 */
export function isUncertaintyLevel3(
  proposal: QueueProposal,
  stateRecords: StateRecord[],
): boolean {
  const proposalPath = normPath(proposal.path);
  const record = stateRecords.find(
    (r) => normPath(r.path) === proposalPath,
  );
  return record !== undefined && record.uncertainty_level === 3;
}
