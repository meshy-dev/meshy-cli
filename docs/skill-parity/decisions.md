# Skill-parity S1 — design decisions

Each entry records a choice that is not derivable from the code alone, the evidence
behind it, and what a reviewer should check. IDs are stable; append, do not renumber.

## D-001 Workspace and toolchain

- Fresh clone of `meshy-dev/meshy-cli` at `fd94490` (main == plan baseline, no delta),
  branch `feat/skill-parity-s1`. Skills baseline `b9db44b` is read-only.
- Node 24.20.0 via fnm (`.node-version` = 24, `engines >=24`); pnpm 11.24.0 via corepack
  from `package.json#packageManager`. Baseline `pnpm test` = 363 pass / 0 fail before any change.
- No AGENTS.md / CLAUDE.md exist in the repo; the existing conventions (TypeScript ESM,
  Commander, Zod, node:test + tsx, no lint script) are followed.

## D-002 `--output-schema v1` is a root-parsed global flag

- Commander parses options declared on the root command wherever they appear in argv
  (positional options are disabled), so `meshy text-to-3d get ID --output-schema v1`
  and `meshy --output-schema v1 text-to-3d get ID` resolve identically. Verified
  empirically on 0.2.0 (`resources --format pretty` renders pretty).
- Existing commands default to `legacy`; new commands (uv-unwrap, creative-lab,
  animation-catalog, showcases, download, project, inspect, mesh, slicer, doctor)
  always emit v1. Passing `--output-schema legacy` to a v1-only command is a usage
  error (exit 2) rather than a silent no-op.
- `--json` keeps its existing priority over `--format`.

## D-003 Commander parse errors are usage errors (exit 2)

- Unknown options/commands, missing arguments and invalid choices are routed through
  `exitOverride()` into the unified error exit: exit 2, error payload on stdout
  (legacy shape or v1 envelope depending on the resolved schema), human line on stderr.
- 0.2.0 exited 1 for these while README already documented `2 usage`; this is a
  documented bug fix, listed in migration-notes.
- `--help` / `--version` remain plain text with exit 0.

## D-004 `get` never fails on task status

- `get` returning a valid task exits 0 in both schemas (0.2.0 exited 1 for
  PENDING/IN_PROGRESS — the probe in the implementation package reproduces it).
- Legacy `get` of a FAILED/CANCELED task keeps exit 1 (existing consumers may rely on
  it). v1 `get` is a query: `ok:true`, exit 0, `task.status` carries the server state.
- `wait`/`stream`/sync `create` ending in FAILED/CANCELED exit 1 with the full task in
  `result.task`.

## D-005 `make --async` returns after the first POST

- `--async` submits step 1 and returns `accepted` + `pending_steps`; zero polling.
- The previous behaviour (poll step 1, then stop) is available as `--stop-after-first`.
  Both flags together are a usage error before any request.
- Default sync behaviour is unchanged (text: preview → refine; image: textured).

## D-006 Registry-driven resources; `rigging list` enabled

- `src/client/resource-registry.ts` is the single source for command paths, API
  base, relative path, supported verbs, billing and media fields. `docs/skill-parity/
  endpoint-contracts.json` documents the same data and a test asserts they agree.
- 0.2.0 marked `rigging list` unsupported. The official rigging page lists
  `GET /openapi/v1/rigging` and the server route table registers it, so `list` is
  enabled. Recorded as an intentional difference from 0.2.0, not from the Skills.

## D-007 `showcases --showcase-type animated` is sent as `animate`

- The public docs and the Skill reference say `all | animated | static`; the server
  binding (checked read-only, meshyd `ListShowcasesForOpenAPIRequest`) accepts
  `all | animate | static` and would reject `animated` with 400.
- The CLI accepts both spellings, sends `animate`, and adds a warning
  `showcase_type_alias` so the translation is visible. Live verification is not_run.

## D-008 Animation catalog search is local

- The frozen Skill baseline only uses `?category=`. The server also accepts `q` and
  `subCategory`, but those are outside the baseline and are not exposed in S1.
- `--search` filters the fetched batch case-insensitively over `name`, `key` and
  `subCategory`; the result says `search_scope: "local"` so nobody mistakes it for a
  server-side search. No pagination exists on this endpoint (`total` == list length).

## D-009 `face_count` is unknown unless the server sends it

- The public task DTO has no `face_count` field (meshyd `httpapi/dto.go`, read-only
  check). `inspect faces --resource … --task-id …` therefore usually yields
  `verdict: unknown`, exit 13. The legacy `check-faces` defaulted a missing value to 0
  and printed a passing line for a model it never measured; that is not reproduced.
- `--task-json` files that carry `face_count` (e.g. saved tasks from a future server
  version, or fixtures) produce pass/fail normally.

## D-010 Operation journal

- Location: `<MESHY_CONFIG_DIR or ~/.config/meshy>/operations/<operation_id>.json`,
  private mode, written atomically under a lock (`operations/locks/`). Tests inject a
  root through the existing `MESHY_CONFIG_DIR` variable — no new env var.
- States: `started` → `accepted | rejected | unknown | not_submitted`. Records hold
  resource, endpoint, API origin, credential fingerprint (sha256 of profile/origin,
  never the key), payload fingerprint (sha256 of canonical JSON with media data URIs
  replaced by their length), timestamps and, when known, task id / request id.
- A second invocation with the same `--operation-id` and identical fingerprints returns
  the stored record without a new POST; a mismatch is `operation_conflict` (exit 2).
  This is a local record only and is never described as server idempotency.

## D-011 Exclusive file publish

- No-overwrite writes go to a temp file in the target directory, then
  `fs.linkSync(tmp, target)` (atomic EEXIST failure on POSIX and NTFS) followed by
  unlinking the temp. Where hard links are unsupported (EPERM/ENOTSUP/EXDEV) the
  fallback opens the target with `wx` and copies — still exclusive, not atomic, and
  reported in `warnings`.
- `--overwrite` uses `rename` over a target that `lstat` reports as a regular file;
  directories and symlinks are never replaced.

## D-012 Multi-file downloads are per-file atomic with a manifest

- Every asset is published individually; the envelope lists each file with
  `status: written | skipped | failed`. A failure after some files were written
  returns `ok:false` with the completed list — no rollback deletes user data and no
  cross-file transaction is claimed.

## D-013 Credential origin policy

- Stored profiles (OAuth or API key from `credentials*.json`) are sent only to the v1
  origin they were resolved for, to the v2 origin, and to a creative-lab base whose
  origin equals the v1 origin. A creative-lab override on a different origin requires
  an explicit key (`--api-key`, `MESHY_API_KEY`, or `--api-key-file`).
- Pre-existing behaviour: a `--base-url-v2` on a different origin than v1 already
  receives the stored profile. Unchanged in S1 and listed as a compatibility
  difference for review.
- Public catalog, media preflight and asset downloads use a transport with no
  Authorization header and refuse cross-origin redirects.

## D-014 Update-check policy

- The background npm check is skipped when `--no-update-check` is given, when the
  existing `MESHY_CLI_NO_UPDATE_NOTIFIER` / CI variables are set, for local commands
  (`resources`, `project`, `inspect`, `mesh`, `slicer`, `doctor`, `download` from a
  local source, `animation-catalog`), and for `make --dry-run`. The decision is taken
  from argv before `refreshCache()` runs.

## D-015 SSE handling

- Parser follows the WHATWG EventSource algorithm: UTF-8 across chunks, CR/LF/CRLF
  line endings, multi-line `data:` joined with `\n`, comments ignored, `event`, `id`,
  `retry` fields honoured for bookkeeping only.
- `event: message` → task; `event: error` → `{message,status_code}` mapped like an
  HTTP status; other event names → warning. No reconnect in S1; recovery is `get` or
  `wait`.
- `--timeout` is the total deadline; `--idle-timeout` (default 60 s) is reset by any
  bytes including keep-alives. Terminal status aborts the reader immediately.

## D-016 `--api-key-file` (the contract's `--env-file`)

- Only `MESHY_API_KEY` is read. Grammar: optional `export `, `KEY=value`, `#` comments,
  blank lines, single/double quotes (inner text verbatim), unquoted `#` after
  whitespace starts a comment. `${…}`, backticks and `$(…)` are never expanded; a key
  containing them is invalid. Duplicate `MESHY_API_KEY` lines are an error.
- An unreadable or malformed explicit file is an error even when a higher-priority key
  is present. No `.env` auto-discovery, ever.
- The flag is named `--api-key-file`, not `--env-file` — see D-025.

## D-017 Timeouts

- `requestJson` keeps the deadline armed until the body is fully consumed.
- `MESHY_CONNECT_TIMEOUT_MS` is still read for compatibility but fetch offers no
  separate connect timeout; the README says so instead of claiming one.

## D-018 Engineering limits

- Media 50 MiB, task JSON 16 MiB, SSE event 1 MiB, download/OBJ 2 GiB, 5 redirects,
  preflight 10 s, download 300 s, lock wait 10 s. Enforced while reading, never by
  truncation. Tests inject smaller values through function parameters.

## D-019 v1 envelope identity

- `schema_version: "meshy.cli/v1"`. `command` is the dotted command path plus the verb
  (`text-to-3d.get`, `creative-lab.figure.prototype.create`, `animation-catalog.list`,
  `project.record`, `inspect.faces`, `mesh.prepare-print`, `slicer.open`, `doctor`).
- Fixed keys: `schema_version, command, ok, result, error, warnings`. Stream ndjson adds
  `event` and `sequence`.

## D-020 Tests build `dist/` first

- Subprocess tests spawn `dist/index.js` (the existing pattern in runtime.test.ts).
  A `pretest` script runs `tsc` so `pnpm test` always exercises the current sources.

## D-021 Project store

- `metadata.json` gains `schema_version: 2` plus `resource`, `endpoint`,
  `parent_task_id`, `status`, `task_json`, `operation_id` per task; legacy files
  without `schema_version` are read as v1, migrated on first write with a
  `metadata.json.bak-<timestamp>` copy, unknown fields preserved.
- `history.json` keeps `{version: 1, projects: [...]}` and is an index only;
  `rebuild-index` regenerates it from the project folders. The CLI download `meta.json`
  is a third format and is never written to either of the other two paths.
- Locking: project lock (`<project>/.meshy.lock`) → commit metadata → release → root
  lock (`<root>/.meshy-history.lock`) → update index. Never nested the other way.

## D-022 OBJ transform

- Two passes over the file: pass 1 computes the rotated bounding box, pass 2 rewrites
  lines through a stream. Default output is `<stem>.print.obj` beside the input;
  `--in-place` is an explicit replacement via temp file + rename; `--output` to another
  directory requires the referenced `mtllib` files to be copied alongside (done for
  local relative references) or `--geometry-only`.
- Numbers use the fixture oracle tolerance `1e-5 mm + 1e-9 * height`.

## D-023 Slicers

- Seven registered slicers with the legacy `multicolor` capability flag. macOS checks
  `/Applications` and `~/Applications` bundles; Windows checks `%ProgramFiles%` and
  `%ProgramFiles(x86)%` including glob suffixes; Linux checks PATH for the three
  registered executables only (others report `unsupported_on_platform`).
- `open` spawns the detected path with `shell: false`, detached, and reports
  `launch_requested` + pid. No default-application fallback, no shell strings.

## D-024 doctor

- Default is fully local: versions, command inventory, config sources present (without
  reading secrets), workspace writability. `--check-api` performs one `GET /balance`;
  `--check-slicers` runs detection. Nothing else is contacted.

## D-025 `--env-file` cannot be offered: Node.js intercepts it

- Verified on Node 22.23.2 and 24.20.0 (`node script.js balance --env-file X`): Node
  scans the *whole* argv for `--env-file`, even after the script name. When the file
  exists Node loads every variable into `process.env` before the CLI starts
  (`NODE_OPTIONS` included, which Node then honours); when it is missing Node exits 9
  with its own message and the CLI never runs. Both contradict the contract ("only
  `MESHY_API_KEY`, never executed, no process reconfiguration").
- Therefore the CLI flag is `--api-key-file <path>` with exactly the contract's
  semantics. `--env-file` stays registered as a hidden option whose only behaviour is a
  usage error pointing at `--api-key-file`; the CLI cannot undo what Node already did,
  so the error also explains that. S2 Skill examples must use `--api-key-file`.
- Empty or placeholder `--api-key` / `MESHY_API_KEY` values keep meaning "unset"
  (0.2.0 behaviour that CI and the runtime tests depend on); only the explicit key
  file is strict.
