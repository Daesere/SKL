# SKL Extension — Build Plan

This document records the staged build plan for the SKL VS Code extension.
Each stage has a corresponding set of Copilot prompts. Consult this file
and SPEC.md before every agent session.

---

## Stage 1 — Data Layer and Initialization ✅

**Goal:** TypeScript types, Zod schemas, SKLFileSystem abstraction,
project initialization commands, scope definition generator with human
review gate, and diagnostics provider.

### Substages
- 1.1 Extension scaffold and TypeScript interfaces
- 1.2 SKLFileSystem service
- 1.3 Project initialization command
- 1.4 Scope definition generator with LLM call and review gate
- 1.5 Schema validation and diagnostics provider

### Completion Criteria
- `SKL: Initialize Project` produces a valid `.skl/` structure
- `SKL: Generate Scope Definitions` only writes after human confirmation
- Malformed `.skl/` files produce Problems panel diagnostics
- TypeScript compiles under strict mode with zero `any` escapes
- `SKLFileSystem` is the only module with file system access (ESLint enforced)

---

## Stage 2 — Enforcement Hook and Queue Panel ✅

**Goal:** Python pre-push Git hook implementing all five checks, hook
installation service, agent configuration command, and Queue panel UI.

### Substages
- 2.1 AgentContext and HookConfig types, SKLFileSystem extension
- 2.2 Python hook: startup, checks 1, 2, and 5
- 2.3 Python hook: AST risk signals part 1
- 2.4 Python hook: AST risk signals part 2
- 2.5 Python hook: import scanning
- 2.6 Python hook: dependency validation, proposal assembly, atomic write
- 2.7 HookInstaller service
- 2.8 Install hook and configure agent commands
- 2.9 Queue panel and status bar

### Completion Criteria
- Agent sets SKL_AGENT_ID, pushes, proposals appear in Queue panel
- Queue budget exceeded blocks the push with a clear message
- Out-of-scope file modifications produce automatic proposals
- Cross-scope undeclared imports set a blocking flag on the proposal
- AST correctly identifies structural vs behavioral vs mechanical changes
- All three hook test scripts pass
- Status bar updates within 2 seconds of a new proposal

---

## Stage 3 — Orchestrator ✅ _(completed 2026-02-28)_

**Goal:** LLM-based Orchestrator that reviews the Queue, applies
classification verification, makes approve/reject/escalate/RFC decisions,
writes State, and produces session handoff logs.

### Substages
- 3.1 Orchestrator session service and session state types
- 3.2 Classification service: Stage 1 deterministic overrides
- 3.3 Verifier pass and circuit breaker
- 3.4 Conflict detection (State conflicts and assumption conflicts)
- 3.5 RFC trigger detection and RFC generator
- 3.6 State writer and ADR promotion
- 3.7 Decision engine
- 3.8 Session runner and handoff log
- 3.9 Orchestrator panel UI

### Completion Criteria
- "SKL: Open Orchestrator Panel" → "Start Session" processes all pending
  proposals and writes decisions with rationales to knowledge.json
- A mechanical_only proposal with no risk signals is auto-approved without
  an LLM rationale call
- A proposal classified as architectural triggers an RFC written to .skl/rfcs/
- Two proposals with conflicting assumptions trigger an RFC automatically
- A proposal targeting uncertainty_level 3 is escalated without review
- Session budget enforced: stops at 15 proposals or 90 minutes, writes handoff log
- New session initialises from knowledge.json plus most recent session log only
- Approving a proposal runs git merge on the agent's branch
- A merge conflict sets merge_conflict: true without crashing the session
- npm run lint clean, all TypeScript compiles under strict mode

---

## Stage 4 — CI Integration and Acceptance Criteria ✅

**Goal:** RFC acceptance criteria status updates driven by CI results.
ADR promotion. uncertainty_level reduction via passing tests.

### Substages
- 4.1 Python hook: Check 6 (acceptance criteria gate) and Check 7 (RFC scope pause)
- 4.2 CI check service: test detection and uncertainty_level 0
- 4.3 Human digest: digest generator and HookConfig extension
- 4.4 Human digest: review command, DigestPanel, and uncertainty_level 1
- 4.5 Change heatmap and final extension wiring

### Completion Criteria
- Push on a branch linked to an RFC with uncompleted criteria is blocked
  by Check 6 with the failing criteria named
- Push in a scope with an expired RFC deadline is blocked by Check 7
  with the RFC ID named
- skl.runCICheck on a passing test reduces uncertainty_level to 0
- CI file watcher detects pytest XML results and reduces level to 0 automatically
- skl.reviewDigest opens Digest panel showing all level-2 State entries
- Mark Reviewed reduces level-2 to level-1, resets change_count_since_review
- Mark All Reviewed updates all level-2 entries in one atomic write
- level-0 and level-3 entries are unaffected by Mark Reviewed
- After 10 architectural decisions, a notification prompts digest review
- Queue panel heatmap shows State records sorted by change_count descending
- hook/test_hook_checks.py covers all six check cases and passes
- npm run lint clean, TypeScript compiles under strict mode
- Remote up to date with all four stages marked complete in PLAN.md

---

## Implementation Complete

All four stages of the SKL v1.4 reference specification are implemented.
The system guarantees that coordination-relevant uncertainty, assumptions,
and cross-scope dependencies cannot propagate implicitly. It does not
promise correctness. It ensures that when things go wrong, they do so
locally, transparently, and with bounded blast radius.

For extension work beyond v1.4, see SPEC.md Section 12 (Operational
Limits) for the constraints any extension must respect.

---

## Accepted Risks and Known Limitations

See SPEC.md Section 13 for the full list. Key points:
- Scope definition quality is a load-bearing assumption
- Import scanning has a low ceiling (static imports only)
- The verifier reduces but does not eliminate misclassification
- Human review fatigue degrades the system over time
