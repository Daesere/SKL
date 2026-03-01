# SKL — Structured Knowledge Layer

Stop AI agents from breaking your architecture without you noticing.
A coordination layer for repos with multiple LLM coding agents.

## Is this for you?

SKL is worth trying if you are running two or more AI coding agents on the
same repo and have been surprised by what one of them changed, or want to
know when agents make architectural decisions without asking.

SKL is probably not worth it if you use one agent at a time, review all
agent output before it reaches your repo, or your codebase is small enough
to hold in one context window.

## Quick start

1. Install the VS Code extension
2. Run **SKL: Init (Phase 0)** from the command palette
3. Set `export SKL_AGENT_ID=Agent-1` in your agent's terminal
4. Push a branch

You will see what your agent changed, what risk signals fired, and whether
it touched files outside its expected scope — without configuring anything
else. When you are ready for scope enforcement, RFCs, and the full
governance layer: run **SKL: Upgrade to Full SKL**.

**CLI alternative:**
```bash
npm install -g @skl/cli
skl init
skl status
```

## How it works

SKL is a Git hook plus a shared state file. When an agent pushes code,
the hook records what changed, runs static analysis to flag risk signals,
and checks whether the change crosses scope boundaries. You see the activity
in plain language. If a change is architectural, an RFC is generated and the
merge is blocked until you resolve it. If two agents make conflicting
assumptions, SKL surfaces the conflict before either change lands.

## Phase 0 vs Full SKL

| Feature | Phase 0 | Full SKL |
|---|---|---|
| Activity logging | ✓ | ✓ |
| Risk signals on push | ✓ | ✓ |
| Scope definitions required | ✗ | ✓ |
| Scope enforcement on push | ✗ | ✓ |
| RFC gate for architectural changes | ✗ | ✓ |
| Orchestrator review session | ✗ | ✓ |
| Human digest review | ✗ | ✓ |
| Queue max | 50 | Configurable |

## Known limitations

- Import scanning is static only — dynamic imports are not detected
- Scope definition quality is load-bearing — a poorly defined scope
  produces false confidence in enforcement
- The Orchestrator requires an LLM (uses your existing Copilot model)
  and degrades to template fallbacks if none is available
- Full SKL adds review overhead — this is intentional, not a bug
- Not suitable for deep refactors, framework migrations, or cross-cutting
  changes where the correct scope is unknowable until implementation is underway

## Contributing

SKL is in active development. See `PLAN.md` for the full build history
and `SPEC.md` for the v1.4 reference specification that this extension
implements.

Issues and pull requests welcome. Please read `PLAN.md` before
contributing to understand the architecture and constraints.

A VS Code extension implementing the SKL v1.4 coordination protocol
for small concurrent LLM agent teams.

SKL makes parallelism debuggable. It is not a safety system. It is a
fail-stop coordination layer with bounded damage and explicit uncertainty.

## Status

| Stage | Description | Status |
|-------|-------------|--------|
| 1 | Data layer, schemas, initialization | ✅ Complete |
| 2 | Enforcement hook, Queue panel | ✅ Complete |
| 3 | Orchestrator | 🔄 In progress |
| 4 | CI integration, acceptance criteria | ⏳ Planned |

## Specification

The full SKL v1.4 reference specification is in `SPEC.md`.

## Windows

### Pre-push hook

Git for Windows cannot reliably execute extensionless hook scripts when
invoked from a PowerShell or CMD terminal because the Unix interpreter
(`/bin/sh`, `/usr/bin/env`) is not on the standard Windows `PATH`.
SKL uses a `.cmd` file instead, which `cmd.exe` can execute natively.

| File | Purpose |
|---|---|
| `.githooks/pre-push.cmd` | Windows — batch wrapper that calls `python pre-push.py` |
| `.githooks/pre-push.py` | The actual Python hook (used by both platforms) |

**Mac/Linux developers:** Git only considers the extensionless `pre-push`
file. Create a thin shell wrapper once after cloning:

```sh
printf '#!/bin/sh\nexec python3 "$(dirname "$0")/pre-push.py" "$@"\n' \
  > .githooks/pre-push && chmod +x .githooks/pre-push
```

**Repos where you install SKL via the extension:** `HookInstaller` detects
`process.platform === 'win32'` and writes a `pre-push.cmd` wrapper alongside
the `pre-push` Python script. It also reads `core.hooksPath` from local git
config so it installs to the correct directory regardless of whether the repo
uses the default `.git/hooks/` path or a custom one.

If a push fails with `cannot spawn … pre-push: No such file or directory`
on Windows, confirm that `pre-push.cmd` exists in the hooks directory and that
`core.hooksPath` is set correctly:

```powershell
git config core.hooksPath   # should print .githooks or similar
dir .githooks\pre-push.cmd  # should exist
```

Reinstall with **SKL: Install Hook** from the command palette if needed.

## Development

Built using spec-driven development with a single Copilot agent.
See `PLAN.md` for the staged build plan.

## Contributing

This project is in early development. Contributions are welcome once
Stage 3 is complete. Check back soon.
