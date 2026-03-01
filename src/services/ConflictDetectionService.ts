/**
 * ConflictDetectionService — State & Assumption conflict detection (Sections 7.2, 7.3, 8.1)
 *
 * detectStateConflict and isUncertaintyLevel3 are pure functions with no I/O.
 * detectAssumptionConflict uses a deterministic pre-filter before any LLM call.
 *
 * **ESLint note:** Uses `path.normalize()` for cross-platform path
 * comparison. Added to the ESLint ignores list for the path ban.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type {
  QueueProposal,
  StateRecord,
  StateConflictResult,
  AssumptionConflictResult,
  Assumption,
} from "../types/index.js";
import type { OutputChannelLike } from "./VerifierService.js";

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

// ── Assumption conflict (Section 8.1) ────────────────────────────

/** No-conflict result constant for convenience. */
const NO_ASSUMPTION_CONFLICT: AssumptionConflictResult = {
  has_conflict: false,
  proposal_a_id: null,
  proposal_b_id: null,
  assumption_a: null,
  assumption_b: null,
  conflict_description: null,
};

/**
 * Detect assumption conflicts between a proposal and other pending proposals.
 *
 * Runs a deterministic pre-filter first to avoid LLM calls for proposals
 * that cannot possibly conflict. For surviving candidates, asks the LLM
 * whether the two assumption sets create a mutual dependency risk.
 *
 * LLM unavailability degrades gracefully to no-conflict (logged, not thrown).
 */
export async function detectAssumptionConflict(
  currentProposal: QueueProposal,
  otherPendingProposals: QueueProposal[],
  outputChannel: OutputChannelLike,
): Promise<AssumptionConflictResult> {
  // Pre-filter: nothing to check if this proposal has no assumptions
  if (currentProposal.assumptions.length === 0) {
    return NO_ASSUMPTION_CONFLICT;
  }

  const currentHasShared = currentProposal.assumptions.some((a) => a.shared);
  const currentDepsSet = new Set(currentProposal.dependencies);

  // Build candidate list — deterministic, no LLM
  const candidates = otherPendingProposals.filter((other) => {
    if (other.assumptions.length === 0) return false;

    const otherHasShared = other.assumptions.some((a) => a.shared);
    if (currentHasShared || otherHasShared) return true;

    if (other.semantic_scope === currentProposal.semantic_scope) return true;

    const sharedDep = other.dependencies.some((dep) => currentDepsSet.has(dep));
    if (sharedDep) return true;

    return false;
  });

  if (candidates.length === 0) {
    return NO_ASSUMPTION_CONFLICT;
  }

  // LLM pass
  const models = await vscode.lm.selectChatModels({ family: "gpt-4o" });

  if (models.length === 0) {
    outputChannel.appendLine(
      "[ConflictDetectionService] No LLM available for assumption conflict check; skipping (degraded mode).",
    );
    return NO_ASSUMPTION_CONFLICT;
  }

  const model = models[0];

  for (const candidate of candidates) {
    const prompt =
      `Do these two sets of assumptions potentially conflict or create a mutual ` +
      `dependency that would break if either assumption is wrong? ` +
      `Respond with exactly: YES or NO, then a newline, then one sentence of explanation.\n\n` +
      `Set A:\n${JSON.stringify(currentProposal.assumptions)}\n\n` +
      `Set B:\n${JSON.stringify(candidate.assumptions)}`;

    let responseText = "";
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
      );
      for await (const chunk of response.text) {
        responseText += chunk;
      }
    } catch (err: unknown) {
      outputChannel.appendLine(
        `[ConflictDetectionService] LLM request error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    const firstLine = responseText.trim().split("\n")[0].trim().toUpperCase();
    if (firstLine.startsWith("YES")) {
      const explanation = responseText.trim().split("\n").slice(1).join(" ").trim();
      const assumptionA: Assumption = currentProposal.assumptions[0];
      const assumptionB: Assumption = candidate.assumptions[0];
      return {
        has_conflict: true,
        proposal_a_id: currentProposal.proposal_id,
        proposal_b_id: candidate.proposal_id,
        assumption_a: assumptionA,
        assumption_b: assumptionB,
        conflict_description: explanation,
      };
    }
  }

  return NO_ASSUMPTION_CONFLICT;
}
