# Baseline delta

Checked 2026-09-07 before any change:

- `meshy-dev/meshy-cli` remote `main` = `fd94490916376e691efcea51324ac4326b459e1f`,
  identical to the implementation-package baseline. No mapping of plan line references
  is needed; the symbols named in IMPLEMENTATION_PLAN.md §2.1 exist as described
  (`makeFetcher` in `src/client/index.ts`, `buildResourceCommand` /
  `emitTerminalOutcome` in `src/internal/task-command.ts`, `runChain` in
  `src/cmd/make.ts`, `enumerateArtifacts` / `downloadArtifact` in
  `src/internal/download.ts`, `buildRuntime` cache in `src/internal/runtime.ts`,
  `refreshCache()` first in `src/index.ts`).
- `meshy-dev/meshy-3d-agent` remote HEAD = `b9db44b5663e6e92d89828bf2e4fe1dc1b3f6610`,
  identical to the package baseline.
- Work happens on branch `feat/skill-parity-s1` in a fresh clone; the user's research
  checkout under `meshy-agent-integrations-research/sources/` is untouched.
