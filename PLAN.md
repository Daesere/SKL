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

## Stage 3 — Orchestrator ⏳

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

## Stage 4 — CI Integration and Acceptance Criteria ⏳

**Goal:** RFC acceptance criteria status updates driven by CI results.
ADR promotion. uncertainty_level reduction via passing tests.

### Completion Criteria
- TBD when Stage 4 prompts are written

---

## Accepted Risks and Known Limitations

See SPEC.md Section 13 for the full list. Key points:
- Scope definition quality is a load-bearing assumption
- Import scanning has a low ceiling (static imports only)
- The verifier reduces but does not eliminate misclassification
- Human review fatigue degrades the system over time
