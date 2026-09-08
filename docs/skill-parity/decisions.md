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

## D-026 Asset URL policy

- Asset downloads (`meshy download`, legacy `-o`) accept `https:` to any host and
  `http:` only to loopback hosts (127.0.0.0/8, `localhost`, `::1`) so local test
  servers work without a global `--insecure`. Private-network literals (10/8,
  172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10) are refused, also as
  redirect targets; an https → http downgrade redirect is refused. Host names are
  not resolved before the request, so a DNS name pointing at a private address is
  not detected — documented limitation, not a claim.
- No Authorization or Cookie header is ever sent to an asset host; the API
  credential belongs to the API origins only.

## D-027 `--project` bookkeeping on task verbs and download

- `create/get/wait/stream --project <dir>` record the task in `metadata.json`
  (stage from `--stage`, else the payload `mode`, else the Creative Lab stage, else
  the task type suffix preview/refine/prototype/build, else the resource id) and
  save `task_<id>.json` whenever a full task is known. Async create records the
  id immediately without a snapshot. `download --project <dir>` defaults the
  output directory to the project and records the written files.
- A bookkeeping failure is `local_io` (exit 11) with the task id kept in
  `result` — it never reads as "no task was created".

## D-028 Tests that drive commands in-process

- The node test runner reports to its parent over the same stdout the CLI writes
  to, so in-process command tests forward non-string chunks (the runner's binary
  frames) to the real stdout and capture only the CLI's string writes. Black-box
  behaviour is still asserted through `dist/index.js` subprocesses wherever exit
  codes or stderr matter.

## D-029 Credential identity in the operation journal binds to the account

- Codex review round 1 (F05): `credential_fingerprint` hashed only
  source/profile/kind/origin, so two API keys exported through the same
  `MESHY_API_KEY` were one identity and a repeated `--operation-id` replayed the
  other account's task. It now includes a one-way digest of the API key
  (`sha256("meshy-cli/credential-binding/v1|<key>")`) for static keys, and the
  stable OAuth subject (`user_id` of the stored profile) for browser logins — never
  the access token, so a routine refresh keeps the identity while a different user
  under the same profile name does not. A profile without `user_id` binds to the
  profile name only (documented limitation). No key material is stored; the
  conflict message names what differs (`result.conflict`).

## D-030 Media content is part of the payload fingerprint

- Review F06: data URIs were reduced to `<mime>;len=<n>`, so two images of equal
  encoded length collided and a changed picture reused the old task. The
  fingerprint now hashes the *decoded bytes* of every data URI
  (`data:<mime>;sha256=<hex>`): the same file re-inlined (even with different
  base64 line wrapping) matches, different content of any length does not, and the
  journal still never holds the content. The previous test asserting the collision
  was wrong and was replaced.

## D-031 The wait deadline bounds every request

- Review F07: `pollUntilTerminal` passed only the abort signal to each GET and
  judged the deadline after the response, so a reply arriving late could be
  reported as an in-time SUCCEEDED and one more GET could start after the budget.
  Each request now carries `timeoutMs = min(remaining budget, read timeout)`; a
  deadline-bound request that times out *is* the timeout (exit 8), the sleep never
  overshoots, and no request starts once the budget is spent. `PollResult.task` is
  `null` only when no response arrived in time — the caller still knows the task id
  and reports it (`result.task_id`, `result.next`, legacy `{id, timed_out:true}`).
  `--timeout 0` keeps its single-query semantics bounded by the transport read
  timeout, not by a zero budget.

## D-032 `--workspace` is the root of every write, checked before the POST

- Review F03: the v1 `-o` path handed the legacy downloader the output directory
  as its own root, `project` ignored the flag, and `make` never looked at it.
  `downloadArtifacts` now takes the workspace as root (directory, every planned
  file and the sidecar are proven inside it before `mkdir`), `project
  init/record/rebuild-index` confine `--root`/`--project`, task verbs confine
  `--project`, `mesh prepare-print` confines its output and every copied
  dependency (D-033), `download --project` confines the project. Without a
  workspace the command's own root (output directory / project directory) applies
  as before. `create` and `make` check `-o`, `--save-json` and `--project` *before*
  the billable POST (containment, symlink leaf, existing file, initialised
  project): a detectable conflict is exit 11 with "nothing was submitted" and zero
  requests.

## D-033 Dependency copies are proven inside the write root on real paths

- Review F04: `copyDependency` only lstat'ed the leaf, so `<target>/materials`
  being a symlink to another directory let `materials/a.mtl` land outside the
  workspace. Every planned copy target is now resolved with `resolveWithinRoot`
  against the write root (workspace, else the output directory) — deepest existing
  ancestor realpath'd, no symlink leaf — before any directory is created, and again
  immediately before the copy is published. The report keeps the planned path
  (beside the output) so `copied` stays consistent with `output`.

## D-034 An accepted task survives every later failure; one submission state machine

- Review F01/F02: after the server returned a task id, `--save-json` on an existing
  file, a 503 while polling, and (in `make`) a journal write failure all produced
  `result: null` or `submission_unknown`. Every post-acceptance step now runs in
  the task's context (`withTaskContext`): the thrown error keeps its own
  classification (code, HTTP status, hint, recovery, exit code) and its partial
  result (files written, a failed download manifest), and always carries
  `result.task_id`, `result.submission` and `result.next`. `make` uses the same
  `submitCreate` primitive as the resource commands, so accepted / rejected /
  unknown / journal-failure-after-acceptance (`local_io`, exit 11, id kept) are
  decided in exactly one place.

## D-035 Nested option objects merge field by field

- Review F08: `mergePayload` is a shallow, later-wins merge (arrays and scalars
  replace wholesale, by design), so `--options` replaced the whole
  `--data.options` object and silently dropped the user's other settings before a
  billable build. A resource may declare `nestedObjectKeys` (Creative Lab build:
  `options`, `output`); those keys merge field by field across
  defaults < `--data` < flags, typed flags win, explicit `false`/`0` survive, and
  validation sees the combined object. Nothing else became a recursive merge.

## D-036 Downloaded OBJ sets are relinked, not renamed

- Review F09: the downloader saved `model.obj`/`model.mtl`/`texture_<n>_<channel>.png`
  while the OBJ still said `mtllib box.mtl` and the MTL named the server's texture
  files, so a complete download did not load. After a set has landed the CLI
  rewrites `mtllib` to the saved MTL and each `map_*` reference to the saved
  texture (exact name → channel word in the name → channel of the MTL key
  (`map_Kd` → base color) → the only texture when there is exactly one reference);
  what it cannot resolve stays as written and is reported
  (`material_reference_unresolved`). Only the two text files the CLI just wrote are
  touched, rewritten manifest entries carry `relinked: true` with their final
  digest, and `result.downloads.material_links` lists every link. ZIP bundles
  (keychain / fridge-magnet OBJ) and `--geometry-only` downloads are never
  rewritten. Stable file names were kept over "preserve the server's names" so
  scripts and the download manifest stay predictable.

## D-037 `stream -o` downloads in every output format

- Review F10: the ndjson branch printed the outcome and returned before the
  download ran, so changing `--format` changed the command's side effects. The
  download (and the project record) now happen before the format branch; the
  ndjson `outcome` line carries the manifest, a download failure is one `ok:false`
  outcome (exit code of the failure, task kept), and json/pretty behave the same.

## D-038 The write root also covers report-only tasks and the implicit history root

- Codex review round 2 (R2-F01): `-o` on a report-only task (analyze-printability)
  returned through `saveReportOnly` before the workspace check; `project record`
  with `--workspace` equal to the project directory wrote `history.json` into the
  parent; `downloadAssets` created the output directory before refusing it. Now
  `saveReportOnly` receives the workspace and proves the file/`meta.json` path
  inside it before any `mkdir`; `downloadAssets` checks directory and planned leaves
  first and creates the directory after; `indexRootFor` decides the history root
  (explicit `--root`, else the project's parent) and, when it resolves outside the
  workspace, the project verbs (`project record`, task `--project`, `download
  --project`) record `metadata.json` and skip the index with
  `index.updated=false` + the reason (`index_dirty` warning) — nothing is created,
  locked or temp-filed outside the boundary. An explicit `--root` outside the
  workspace stays a refusal before any write.

## D-039 Material relinking resolves by source name and never guesses between groups

- R2-F02: `byChannel` kept the first texture per channel, so two `newmtl` groups'
  `map_Kd` lines both pointed at `texture_0_base_color.png`. Every downloaded
  texture now carries the name the server served it under (`basenameOfUrl`), and a
  reference resolves only when exactly one texture matches, in this order: saved
  name; source name (case-insensitive); source stem (extension and directories
  ignored); channel word in the reference; channel of the MTL key; the only texture
  when the MTL has one distinct reference. Several matches for a rule are an
  ambiguity: the reference stays as written, the candidates are listed on the
  `texture_maps` entry (`method: "ambiguous"`), `material_links.status` is
  `incomplete` and `material_reference_ambiguous` is warned. The `newmtl` group of
  every map is recorded. The legacy `-o` layout uses the same resolver.

## D-040 Bookkeeping failures after a stream are part of its terminal outcome

- R2-F03: a `--save-json` conflict or `--project` failure after the SSE stream had
  emitted task events surfaced as a bare error envelope without `event`/`sequence`.
  `streamAndReport` now runs save/record inside the same terminal handling: the
  failure becomes the single `outcome` (ndjson, next sequence) or the single
  envelope (json/pretty), keeps the task context, and when the stream itself ended
  in a failure the bookkeeping error rides along as a `bookkeeping_failed` warning.

## D-041 Task `-o` downloads carry a per-file manifest and keep the failure class

- R2-F04: `maybeDownloadV1`/`make` reported `files: []` on any download failure
  and the legacy downloader turned every fetch error into a plain `Error`, so an
  asset host 503 read as `local_io` without status while `model.glb` sat on disk.
  `downloadArtifacts` now returns `files` (key, path, bytes, sha256, status) and,
  on failure, throws a CliError with the *original* code/HTTP status/recovery and
  `result.downloads = { state: partial|failed, files }`; `maybeDownloadV1` and
  `make` merge that manifest instead of replacing it. Legacy `-o` error payloads
  therefore now carry `code`, `status` and `result.downloads` (they used to be
  `{name:"Error", message}`); the file layout and success output are unchanged.

## D-042 Task `-o` downloads are cancellable

- R2-F05: the legacy downloader never received the abort signal, so Ctrl-C during
  an asset transfer printed "interrupted" and then finished the download with
  exit 0. The signal now travels from every task verb, `make` and the legacy
  reporter into `fetchToTemp`; an abort stops the transfer, deletes the temp file,
  skips relink/sidecar and surfaces as `interrupted` (130) with the task id,
  submission, `next` and the files already committed. `index.ts` re-wraps a
  post-SIGINT failure as `interrupted` *without* dropping `result`/`recovery`.

## D-043 OAuth logins are identified by user id or a per-login id — never "unknown"

- R2-F06: D-029 bound OAuth profiles without `user_id` to the profile name, so a
  different account logged into the same profile replayed the old journal record.
  `meshy auth login` now mints a random `login_id` on every OAuth profile; a silent
  refresh preserves it, a new login replaces it. The journal identity is
  `subject:<user_id>` when the token endpoint reported one, else
  `login:<login_id>`. A profile with neither (written before login ids existed) has
  no verifiable identity: it may start new operations, but `beginOperation` refuses
  to replay an existing record for it (`operation_conflict`, `result.conflict:
  ["credential_unverified"]`, recovery `meshy auth login`). Migration is a
  re-login; nothing secret (token, login id) is written to the journal — only the
  one-way fingerprint. Supersedes the "profile name only" limitation in D-029.

## D-044 Deadline tests are deterministic

- R2-F07: the round-1 test "one GET within a 250 ms budget" used real timers and
  failed intermittently when `setTimeout` woke a fraction early. `pollUntilTerminal`
  already injects `now`/`sleep`; the tests now drive a fake clock (exact expiry,
  early wake, late wake, deadline-bound request timeout, read-timeout-bound failure)
  and the one real-timer smoke asserts only the invariant a real clock can prove:
  no GET *starts* after the deadline. The subprocess tests with slow headers/bodies
  (R03) are kept.
- Round 4 (test-only): the R03 subprocess check "expiry during the sleep" capped
  the poll count at two, but the final budget-cut sleep may wake a fraction before
  the deadline and issue one more deadline-bound GET — the early-wake case above —
  so it failed about once in six runs. It now asserts what a real clock can prove:
  every GET the server saw started within the budget, the second waited the full
  interval, a third can only be the deadline wake-up, and the counted polls match
  the GETs seen (at most one cut off by the deadline).

## D-045 The legacy sidecar is published like an asset

- Codex review round 3 (R3-F01): `writeMeta` wrote `meta.json` / `<stem>_meta.json`
  with a truncating `writeFileSync` after a preflight that could be minutes old,
  so a symlink or file planted in the output directory during the transfer was
  followed or overwritten — even outside `--workspace`. The sidecar now goes
  through the same rules as every asset: the real path is re-proven inside the
  root at publication time (symlink leaf refused), the JSON is published
  exclusively and atomically (`writeJsonFile` → `link`), and an existing file,
  symlink or directory is a `local_io` refusal that keeps the committed model in
  the manifest. Preflight remains an early exit, never a substitute for the
  publication check. `saveReportOnly` (directory mode) uses the same path.

## D-046 Legacy-schema post-processing runs in the task's context

- R3-F02: only the v1 `maybeDownloadV1` wrapped download failures in the task
  context; the legacy reporter (`-o` on a default-schema `create`, `wait`, `get`,
  `stream`, `make`) let the raw error escape, so a paid create whose asset host
  answered 503 printed an error without the accepted task id. Every legacy
  post-processing call is now wrapped with `withTaskContext` / `wrapWithResult`:
  the legacy error payload keeps its shape (`name`, `message`, `code`, `status`,
  `hint`, `result`) and gains additive `task_id` and `operation_id` fields, the
  `result` carries the real `submission`, `next` and the partial manifest, and the
  `hint` (printed on stderr) is the resume/download command, which names the task.

## D-047 Source identity beats a generated file name

- R3-F03: a saved-name match ran before the source-name match, so an MTL that
  referenced `texture_1_base_color.png` — the *server's* name for the image the
  CLI saved as `texture_0_base_color.png` — kept pointing at the wrong file and
  was reported `unchanged`/`complete`. The order is now: the server-side source
  name; then a saved file of that name *only if* its own source is unknown or the
  same name (a generated name that belongs to a different source is an ambiguity
  with an explanatory `note`); then source stem, channel word, MTL-key channel and
  the single-texture rule. Channel rules additionally refuse to decide when two
  distinct references compete for the only texture of that channel. The
  conservative fallback without source evidence (unit callers) is unchanged.

## D-048 Download finalisation shares the transfer failure handling

- R3-F04: relink, digest refresh and sidecar publication ran outside the
  per-artifact `try`, so a failure there reached the caller as a bare error and
  the manifest collapsed to `files: []` although every asset was on disk. The
  three steps now run under one handler (`finalisationFailure`): the thrown
  CliError keeps the original class, re-takes every committed file's digest from
  disk (a relink may have rewritten some), marks `relinked` from the digest
  change, reports `downloads.state = "partial"` with the full `files` list and
  names the step in `downloads.failed_step` (`relink` | `digest` | `sidecar`).
  `downloadAssets` (`meshy download`) does the same for its relink step.

## D-049 The material rewrite is cooperative with SIGINT

- R3-F05: the abort signal stopped at the HTTP transfer; the asynchronous relink
  that followed did not receive it, so a Ctrl-C during a multi-megabyte OBJ
  rewrite printed "interrupted" and then exited 0 with a published sidecar.
  `relinkMaterials` now takes the signal and `rewriteLines` checks it before the
  first read, after every chunk and before publication, removing its temp file
  and throwing `interrupted`; `downloadArtifacts`/`downloadAssets` check it again
  before the sidecar. The result is exit 130 with the task id, `next`, the
  committed files (digests re-taken) and `failed_step: "relink"`; the OBJ on disk
  is either the original or the fully rewritten file, never a partial one.

## D-050 Project file records are computed in the real-path frame

- R3-F06: `download --project` compared the downloader's real paths with the
  project directory as given, so a project reached through an alias (a symlinked
  parent, macOS `/var` → `/private/var`) produced `../…` relative paths that were
  filtered out: the asset was inside the project but `metadata.tasks[].files`
  stayed empty and a false `files_outside_project` warning appeared. Both sides
  are now resolved with `realpathLenient` before the containment test and the
  relative path (as `saveTaskSnapshot` already did); the user-facing paths in the
  result are unchanged. Files genuinely outside the project are still not recorded.

## D-051 Material heuristics compete on the texture they actually reach

- R4-F01: channel competition was computed on the channel each reference
  *declared* (a channel word in its name, else the MTL key's channel), while
  resolution fell through: `map_Kd body_normal.png` declared normal, found no
  normal texture and fell back to the key's base color — the very texture
  `map_Kd eyes_diffuse.png` reached through its name — and the base-color
  competition set had never counted it. Two material groups were rewritten to
  one image and the report said `complete`. Resolution now runs in two passes
  over the whole MTL: every distinct (key, reference) pair is resolved on its
  own (`source_name` / `exact` / `source_stem` are *identity* evidence, the
  channel and only-texture rules are *heuristics*), then `arbitrate` vetoes a
  heuristic hit whenever any other distinct reference contends for that
  texture — by a hit of either kind, or as an ambiguity it could not decide —
  and when the same reference would land on different textures under different
  keys. Identity hits are never vetoed, so C05's source-name mapping, N04's
  multi-material set and the round-1 distinct-channel fallbacks are unchanged;
  a lone reference may still fall back by key. Vetoed references stay as
  written with `method: "ambiguous"`, `candidates: [<texture>]` and one `note`
  shared by the group; `material_links.status` is `incomplete` and the single
  `material_reference_ambiguous` warning states each reason once, naming the
  material groups. The order of the references is irrelevant.

## D-052 A project-record failure keeps the download result and says how to redo the record alone

- R4-F02: in `meshy download --project` the realpath / `indexRootFor` /
  `recordTask` phase ran after the download's try/catch, so a refused
  metadata.json replacement (a symlink planted during the transfer), a damaged
  metadata.json or a lock/permission failure surfaced as `local_io` with
  `result: null` although every asset was on disk. The phase is now wrapped
  (`projectRecordFailure`): the error keeps its class (code, exit code, HTTP
  status), carries the complete result — `source`, `selection`, `downloads`
  with the digests actually on disk, `unknown_urls`, `saved_json` — plus
  `project: { action: "failed", stage, recorded_files: [], error, recovery }`,
  and `error.recovery = { action: "record_project", automatic: false, command }`
  (also the `hint`), where `command` is the exact `meshy project record …`
  invocation with the task id, stage, resource, task type, status and the files
  that landed inside the project (`projectRecordCommand`). Nothing is rolled
  back, re-downloaded or re-submitted, and `index_dirty` keeps its meaning
  (metadata committed, history index not). What can be seen before the
  transfer is refused before it (`preflightProject`: metadata.json must exist,
  be a regular file and parse as a project; `--stage` must not be blank) with
  "nothing was downloaded" and no request. The task verbs' `--project`
  attachment reports the same `record_project` recovery and hint on failure.

## D-053 `make`'s reported identity is asserted against the journal (R4-T01)

- Test-only. The round-3 C06 make scenarios had both POSTs return the same task
  id and only checked `operation_id` for presence, so a future regression that
  reported step 1's id would have passed. `tests/codex-review-round4.test.ts`
  runs the two-step text chain with distinct step ids under both schemas, for an
  asset 503 and for a SIGINT during the final download, and checks
  `result.task_id`, `submission.operation_id`, `executed[-1].operation_id` and
  the legacy top-level `operation_id` against the *last* accepted journal
  record, `executed[0].operation_id` against step 1's record, the refine
  payload's `preview_task_id` against step 1, and the request sequence
  POST GET POST GET GET. C06 keeps the create/wait/get/sidecar/SIGINT scenarios.
