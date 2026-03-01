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