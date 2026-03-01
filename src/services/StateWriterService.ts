/**
 * StateWriterService — pure state mutation helpers (Section 3.2, 7.4, 9.5)
 *
 * createStateEntry, updateStateEntry, writeRationale: pure — no I/O.
 * promoteRFCtoADR: async, performs I/O via injected SKLFileSystem.
 *
 * uncertainty_level rules (Section 3.2.3):
 *   - New entries always start at 2 (Proposed). No exceptions.
 *   - Updates reset level 0 or 1 to 2 (a code change resets to Proposed).
 *   - Level 2 updates keep it at 2.
 *   - Level 3 (Contested) is NEVER modified by the Orchestrator.
 *
 * NOTE: This file is excluded from the project-wide path ban so that
 * deriveStateId may call path.normalize(). No other fs/path usage is
 * permitted here.
 */

import path from "node:path";
import type {
  QueueProposal,
  KnowledgeFile,
  ScopeDefinition,
  StateRecord,
  Rfc,
  Adr,
  RationaleRecord,
} from "../types/index.js";
import type { SKLFileSystem } from "./SKLFileSystem.js";

// ─── ID derivation ────────────────────────────────────────────────────────────

/**
 * Derive a stable, filesystem-safe State record identifier from a file path.
 *
 * Algorithm:
 *  1. Normalise path separators using path.normalize().
 *  2. Replace all remaining `/` and `\` with `_`.
 *  3. Strip the file extension (e.g. `.py`, `.ts`).
 *  4. Strip any leading `_` characters.
 *
 * Examples:
 *   "app/utils/tokens.py"   → "app_utils_tokens"
 *   "app/routers/auth.py"   → "app_routers_auth"
 */
export function deriveStateId(filePath: string): string {
  const normalized = path.normalize(filePath);
  const withUnderscores = normalized.replace(/[/\\]/g, "_");
  const withoutExt = withUnderscores.replace(/\.[^_.]+$/, "");
  return withoutExt.replace(/^_+/, "");
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a new State record from an approved proposal.
 *
 * Returns a NEW KnowledgeFile with the record appended to `state`.
 * Does NOT mutate the input.
 *
 * @throws Error if a State record already exists for `proposal.path`.
 *   This is a programming-error guard — the decision engine must check
 *   first (use updateStateEntry for existing paths).
 */
export function createStateEntry(
  proposal: QueueProposal,
  scopeDefinitions: ScopeDefinition,
  knowledge: KnowledgeFile,
): KnowledgeFile {
  // Guard: path must not already exist
  const alreadyExists = knowledge.state.some(
    (r) => path.normalize(r.path) === path.normalize(proposal.path),
  );
  if (alreadyExists) {
    throw new Error(
      `createStateEntry called for existing path ${proposal.path}. Use updateStateEntry.`,
    );
  }

  const newRecord: StateRecord = {
    id: deriveStateId(proposal.path),
    path: proposal.path,
    semantic_scope: proposal.semantic_scope,
    scope_schema_version: scopeDefinitions.scope_definitions.version,
    responsibilities: proposal.responsibilities,
    dependencies: proposal.dependencies,
    invariants_touched: proposal.invariants_touched,
    assumptions: proposal.assumptions,
    owner: proposal.agent_id,
    version: 1,
    // § 3.2.3 — ALL new entries start at Proposed (2). No exceptions.
    uncertainty_level: 2,
    // uncertainty_reduced_by and last_reviewed_at are intentionally absent
    // (undefined) — they are set only by external proof or human action.
    change_count_since_review: 0,
  };

  return {
    ...knowledge,
    state: [...knowledge.state, newRecord],
  };
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Update an existing State record with the changes from an approved proposal.
 *
 * Returns a NEW KnowledgeFile with the record replaced. Does NOT mutate the
 * input.
 *
 * uncertainty_level rules (Section 3.2.3):
 *   - Level 3: preserved unchanged. A warning is logged — the decision engine
 *     should have escalated this proposal before it reached here.
 *   - Level 0 or 1: reset to 2 (a code change resets certainty to Proposed).
 *     uncertainty_reduced_by is cleared.
 *   - Level 2: kept at 2. uncertainty_reduced_by is preserved.
 */
export function updateStateEntry(
  proposal: QueueProposal,
  existing: StateRecord,
  scopeDefinitions: ScopeDefinition,
  knowledge: KnowledgeFile,
): KnowledgeFile {
  let newUncertaintyLevel: StateRecord["uncertainty_level"];
  let newUncertaintyReducedBy: string | undefined;

  if (existing.uncertainty_level === 3) {
    // § 3.2.3 — level 3 is never modified by the Orchestrator.
    console.warn(
      `[StateWriterService] updateStateEntry called on uncertainty_level 3 record ` +
        `${existing.id}. Level preserved.`,
    );
    newUncertaintyLevel = 3;
    newUncertaintyReducedBy = existing.uncertainty_reduced_by;
  } else if (existing.uncertainty_level === 0 || existing.uncertainty_level === 1) {
    // A code change resets to Proposed — uncertainty_reduced_by is cleared.
    newUncertaintyLevel = 2;
    newUncertaintyReducedBy = undefined;
  } else {
    // Existing level is 2 — keep it; preserve uncertainty_reduced_by.
    newUncertaintyLevel = 2;
    newUncertaintyReducedBy = existing.uncertainty_reduced_by;
  }

  const updatedRecord: StateRecord = {
    // Stable fields
    id: existing.id,
    path: existing.path,
    // last_reviewed_at is only changed by human action — preserve it.
    ...(existing.last_reviewed_at !== undefined
      ? { last_reviewed_at: existing.last_reviewed_at }
      : {}),

    // Fields updated from proposal
    semantic_scope: proposal.semantic_scope,
    scope_schema_version: scopeDefinitions.scope_definitions.version,
    responsibilities: proposal.responsibilities,
    dependencies: proposal.dependencies,
    invariants_touched: proposal.invariants_touched,
    assumptions: proposal.assumptions,
    owner: proposal.agent_id,

    // Counters
    version: existing.version + 1,
    change_count_since_review: existing.change_count_since_review + 1,

    // Uncertainty (see rules above)
    uncertainty_level: newUncertaintyLevel,
    ...(newUncertaintyReducedBy !== undefined
      ? { uncertainty_reduced_by: newUncertaintyReducedBy }
      : {}),
  };

  return {
    ...knowledge,
    state: knowledge.state.map((r) =>
      r.id === existing.id ? updatedRecord : r,
    ),
  };
}

// ─── Rationale recording (Section 7.4) ───────────────────────────────────────

/**
 * Record the Orchestrator's decision rationale on a Queue proposal.
 *
 * Sets the proposal's status to `decision` and attaches a structured
 * RationaleRecord. Returns a new KnowledgeFile — does NOT mutate input.
 *
 * @throws Error if proposalId is not in knowledge.queue
 * @throws Error if rationaleText is empty (silent decisions create drift)
 */
export function writeRationale(
  proposalId: string,
  decision: string,
  rationaleText: string,
  decisionType: "implementation" | "architectural",
  knowledge: KnowledgeFile,
): KnowledgeFile {
  const proposalIndex = knowledge.queue.findIndex(
    (p) => p.proposal_id === proposalId,
  );
  if (proposalIndex === -1) {
    throw new Error(
      `writeRationale: proposal ${proposalId} not found in Queue`,
    );
  }

  if (rationaleText.trim().length === 0) {
    throw new Error(
      `writeRationale: rationale text is required for proposal ${proposalId}. ` +
        `Silent Orchestrator choices are how architectural drift accumulates.`,
    );
  }

  const rationaleRecord: RationaleRecord = {
    decision_type: decisionType,
    text: rationaleText,
    recorded_at: new Date().toISOString(),
  };

  const updatedProposal: QueueProposal = {
    ...knowledge.queue[proposalIndex]!,
    status: decision as QueueProposal["status"],
    decision_rationale: rationaleRecord,
  };

  return {
    ...knowledge,
    queue: knowledge.queue.map((p, i) =>
      i === proposalIndex ? updatedProposal : p,
    ),
  };
}

// ─── RFC → ADR promotion (Section 9.5) ───────────────────────────────────────

/** Maximum character length for an ADR title. */
const ADR_TITLE_MAX_LENGTH = 100;

/**
 * Promote a resolved RFC to an Architecture Decision Record.
 *
 * Writes the new ADR, then updates the RFC with `promoted_to_adr` and
 * `status: "resolved"`. ADRs are append-only — throws if the derived
 * ID already exists.
 *
 * Returns the new ADR and the unchanged KnowledgeFile (ADR promotion
 * does not modify knowledge.json directly).
 */
export async function promoteRFCtoADR(
  rfc: Rfc,
  humanRationale: string,
  knowledge: KnowledgeFile,
  sklFileSystem: SKLFileSystem,
): Promise<{ adr: Adr; updatedKnowledge: KnowledgeFile }> {
  // Step 1: Assign ADR ID
  const existingAdrIds = await sklFileSystem.listADRs();
  const adrId = `ADR_${String(existingAdrIds.length + 1).padStart(3, "0")}`;

  // Step 2: Guard — ADRs are append-only
  if (existingAdrIds.includes(adrId)) {
    throw new Error(`ADR ${adrId} already exists. ADRs are append-only.`);
  }

  // Step 3: Resolve the chosen option
  const resolution = rfc.resolution;
  const optionMap: Record<string, { description: string; consequences: string } | undefined> = {
    option_a: rfc.option_a,
    option_b: rfc.option_b,
    option_c: rfc.option_c,
  };
  const chosenOption = resolution ? optionMap[resolution] : undefined;

  // Step 4: Construct the ADR
  const rawTitle = `Decision: ${rfc.decision_required}`;
  const adr: Adr = {
    id: adrId,
    created_at: new Date().toISOString(),
    title: rawTitle.length > ADR_TITLE_MAX_LENGTH
      ? rawTitle.slice(0, ADR_TITLE_MAX_LENGTH)
      : rawTitle,
    context: rfc.context,
    decision:
      (chosenOption?.description ?? "") +
      "\n\nHuman rationale: " +
      humanRationale,
    consequences: chosenOption?.consequences ?? "",
    ...(rfc.id ? { promoting_rfc_id: rfc.id } : {}),
  };

  // Step 5: Write the ADR
  await sklFileSystem.writeADR(adr);

  // Step 6: Update and write the RFC
  const updatedRfc: Rfc = {
    ...rfc,
    promoted_to_adr: adrId,
    status: "resolved",
  };
  await sklFileSystem.writeRFC(updatedRfc);

  // ADR promotion does not change knowledge.json
  return { adr, updatedKnowledge: knowledge };
}
