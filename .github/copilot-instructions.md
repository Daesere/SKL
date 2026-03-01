# SKL Development Protocol
- NEVER use `any`. Use strict TypeScript.
- EVERY schema must have a Zod validator and an inferred Type.
- ATOMIC WRITES: All file writes to `.skl/` must use the temp-and-rename pattern.
- REACT LOOP: Before coding, state your THOUGHT, then ACTION, then VERIFY.
- PROJECT STATE: Consult `PLAN.md` and `SPEC.md` before every turn.

## Commit Protocol
After completing each substage (when its verification step passes), stage
and commit the work before moving to the next substage. Use the format:
  feat|chore|test: short description

  Body explaining why, not what. Reference the substage number.
Never use `git add .` — always add specific paths.
Do not push until explicitly instructed to do so.

## Stage 4 Context
Stage 4 implements CI integration, acceptance criteria enforcement,
human digest review, and the change heatmap. All four stages of the
SKL v1.4 spec will be complete after this stage. Key constraints:
- Check 6 and Check 7 are Python hook checks — they belong in
  hook/pre-push.py, not in any TypeScript service.
- uncertainty_level can ONLY decrease — never increase automatically.
- level 0 requires CI proof. level 1 requires human review. The
  Orchestrator and digest review must never touch level 0 records.