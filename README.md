# meshy-cli

A small, well-structured command-line interface for the [Meshy AI API](https://docs.meshy.ai/) — text-to-3D, image-to-3D (standard and smart-topology), text-to-motion, remesh, convert, resize, UV unwrap, rigging, animation, retexture, 2D image generation, multi-color print output, Creative Lab products, the public animation catalog, Enterprise showcases, and the `balance` endpoint — plus the local helpers a 3D-printing or agent workflow needs (selective downloads, project folders, face-count checks, OBJ print preparation, slicer launch, environment diagnosis). Built for humans and AI agents.

Two layers. `meshy make` chains the documented flows so that one command
produces one model. Underneath, a per-endpoint command for every resource
shares a uniform `create / get / list / wait / stream / delete` verb surface, with a raw
`api` passthrough for endpoints the CLI doesn't model yet and a `skills/`
directory of agent-facing documentation.

The flag surface is deliberately curated rather than a 1:1 mirror of the API: deprecated parameters (`symmetry_mode`, `hd_texture`, `is_a_t_pose`) are not exposed, geometry knobs live on `remesh` and sizing on `resize` instead of every generation command, and defaults are pinned to game-ready values (PBR maps on, 4k textures — same credit cost as the bare defaults). Everything the API accepts remains reachable through `--data`.

## Install

Requires Node 24+. No Python, no other runtime.

```bash
npm i -g meshy-cli       # installs `meshy-cli` and `meshy`
meshy --help
meshy doctor             # local diagnosis: versions, credential sources, base URLs (no network)
```

The same build is also published under the scoped alias
[`@meshy-ai/cli`](https://www.npmjs.com/package/@meshy-ai/cli)
(`npm i -g @meshy-ai/cli`) — identical contents, pick whichever name you
remember; don't install both.

### Development

```bash
# straight from git (`prepare` builds dist for you)
npm i -g git+https://github.com/meshy-dev/meshy-cli.git

# or clone for local development
pnpm install
pnpm build
node dist/index.js --help
pnpm link --global       # exposes `meshy` / `meshy-cli` on $PATH
pnpm typecheck && pnpm test   # `pnpm test` rebuilds dist first (subprocess tests run it)
```

## Auth

Log in once and the credential is stored for you:

```bash
meshy auth login                                # opens the browser (OAuth, loopback + PKCE)
meshy auth login --with-key msy_your_key_here   # paste an existing API key instead
meshy auth status                               # what's in effect, and does it work
```

The default `auth login` opens `https://www.meshy.ai/oauth/authorize` in your
browser, starts a loopback server on port 8765 (override with `--port`), and
waits for the callback. The authorize URL is always printed to **stderr** so you
can copy-paste it if the browser doesn't open automatically.

In headless or agent contexts where a browser is not available, use
`--with-key` or set `MESHY_API_KEY` instead. Set `MESHY_CLI_NO_BROWSER=1` to
suppress the browser-open attempt (the URL is still printed to stderr).

Or keep it in the environment — unchanged, and still the right choice for CI:

```bash
export MESHY_API_KEY=msy_your_key_here
meshy-cli --api-key msy_... balance             # or per-call
meshy balance --api-key-file ./keys.env         # dotenv-style file; only MESHY_API_KEY is read
```

Get a key at <https://www.meshy.ai/settings/api>.

**Resolution order:** `--api-key` › `MESHY_API_KEY` › `--api-key-file` › the active stored profile.
The environment variable stays ahead of the stored credential on purpose, so a
CI runner is never overridden by whatever a developer once logged into on that
machine. With none of the four, commands exit `3` and print the command that
fixes it. An empty or placeholder `--api-key` / `MESHY_API_KEY` counts as unset.

**`--api-key-file`** reads exactly one variable, `MESHY_API_KEY`, from a
dotenv-style file (`export` prefix, quotes and `#` comments accepted; nothing is
expanded or executed, other keys are ignored). A file you name but that is
missing, malformed or key-less is an error — never a silent fall-through to
another account. There is no automatic `.env` discovery. The flag is not called
`--env-file` because Node.js itself intercepts that name anywhere in argv and
loads the whole file into the environment before the CLI starts.

**Where it lives:** `~/.config/meshy/credentials.json`, mode `0600`, on every
platform (`MESHY_CONFIG_DIR` or `MESHY_CREDENTIALS_PATH` move it). Writes go
through a cross-process lock and a temp-file rename, because several agents
driving this CLI at once is the normal case. A non-production `--base-url-v1`
reads and writes `credentials.dev.json` instead, so staging cannot clobber a
production login. Stored profiles are only ever sent to the v1/v2 origins they
were resolved for (and to a Creative Lab base on the same origin).

**OAuth token refresh:** when the stored OAuth access token is within 60 seconds
of expiry (or already expired), the CLI silently refreshes it using the stored
refresh token before running the command. A refresh failure with an unexpired
token is swallowed (the existing token is used); a failure with an expired token
exits `3` with a hint to run `meshy auth login`.

**Profiles:** `auth login --profile work`, `auth list`, `auth use work`,
`auth logout [--all]`.

## One model, one command

`make` chains the documented flows so a caller who wants a model does not have
to pick an endpoint and carry task ids between steps:

```bash
meshy make "a red sports car" -o car.glb   # text-to-3d preview → refine
meshy make ./cat.png -o out/cat/           # image-to-3d, textured
```

The input decides the chain: a prompt runs the two-stage text flow, an image
runs the single textured `image-to-3d` task. There is no third judgement — no
route picked by inspecting the input, no image step inserted ahead of a prompt,
no pause between stages. Those are opinions, and a CLI that acts on its own
opinions spends someone else's credits. Compose anything else from the resource
commands below.

```bash
meshy make "a red sports car" --dry-run            # the steps and the estimate, no spend, no network
meshy make "a red sports car" --max-credits 25     # refuse to start when over budget
meshy make "a red sports car" --async              # submit step 1 (one POST), return its id + pending_steps
meshy make "a red sports car" --stop-after-first   # wait for step 1, then return the resume command
```

All guards run before the first task is created. If a later step fails, the
error carries the finished step's task id and the command that resumes from it —
running that beats starting over, which would pay for the finished step twice.
`--async` and `--stop-after-first` are mutually exclusive.

## At a glance

```bash
# account
meshy-cli balance

# text → 3D (sync by default: blocks until the task finishes)
meshy-cli text-to-3d create --mode preview --prompt "a red sports car"
meshy-cli text-to-3d create --mode refine  --preview-task-id <id>

# image → 3D
meshy-cli image-to-3d create --image-url https://example.com/cat.png

# text → standalone motion clip (Prime/FBX by default; Swift produces BVH)
meshy-cli text-to-motion create --prompt "a character waving" --duration 3

# smart topology: component-aware low-poly with a native polycount
meshy-cli image-to-3d create --image-url cat.png --model-type smart-topology --target-polycount 10000

# fire-and-forget (--async): exactly one POST, returns the task_id, query later
TASK=$(meshy-cli text-to-image create --prompt "mountain landscape" --async --output-schema v1 | jq -r .result.submission.task_id)
meshy-cli text-to-image get  "$TASK" --output-schema v1
meshy-cli text-to-image wait "$TASK" --output-schema v1 --save-json ./task.json
meshy-cli text-to-image stream "$TASK" --format ndjson --output-schema v1   # Server-Sent Events

# UV unwrap and Creative Lab (photo → printable product, two stages)
meshy uv-unwrap create --input-task-id <id> --async
meshy creative-lab figure prototype create --image-url ./photo.png --name demo --async
meshy creative-lab figure build create --input-task-id <prototype-id> --async
meshy creative-lab lamp build create --input-task-id <id> --model-format zip --options '{"diameter_mm":180}'

# public animation catalog (no key) and Enterprise showcases (billed per request)
meshy animation-catalog list --category DailyActions --search wave
meshy showcases list --search car --page-size 3 --model-format glb

# local helpers (no key, no network)
meshy download --task-json ./task.json --asset result.basic_animations.walking_glb_url --output walking.glb
meshy project init --root ./meshy_output --name demo
meshy inspect faces --task-json ./task.json --max-faces 300000
meshy mesh prepare-print ./model.obj --height-mm 75
meshy slicer detect
meshy doctor

# raw passthrough for any endpoint
meshy-cli api GET  /balance
meshy-cli api POST /text-to-3d --data '{"mode":"preview","prompt":"a cactus"}'
```

## Stable machine output: `--output-schema v1`

Existing commands keep their 0.2.0 output (`legacy`) unless told otherwise; the
commands added in this release always speak `v1`. Pass `--output-schema v1` to
get one envelope with six fixed keys on stdout, in `json` (default), `pretty`
or `ndjson`:

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "image-to-3d.get",
  "ok": true,
  "result": {
    "task": { "task_id": "…", "resource": "image-to-3d", "status": "IN_PROGRESS", "progress": 52,
              "face_count": null, "consumed_credits": null, "model_urls": {}, "task_error": null, "…": "…" },
    "submission": { "state": "accepted", "operation_id": null },
    "downloads": { "state": "not_requested", "files": [], "metadata_path": null },
    "saved_json": null
  },
  "error": null,
  "warnings": []
}
```

`ok` says whether the CLI operation completed; `result.task.status` is the
server's task state. A `get` of a FAILED task is `ok:true` (the query worked);
a `wait` that ends on FAILED is `ok:false` with the whole task kept in `result`.
Fields the server did not send are `null` — a missing `face_count` is never `0`.
`--include-raw` adds the untouched response under `result.task.raw`;
`--save-json <file>` writes the raw API JSON (never the envelope) and refuses to
overwrite. Progress and update notices go to stderr, so stdout is always exactly
one JSON document (`ndjson` streams emit one line per event plus a final
`outcome` line). Errors are envelopes too:

```json
{ "schema_version": "meshy.cli/v1", "command": "text-to-3d.create", "ok": false,
  "result": { "submission": { "state": "unknown", "operation_id": "…" }, "task": null },
  "error": { "code": "submission_unknown", "message": "…", "http_status": null, "retryable": false,
             "recovery": { "action": "reconcile", "automatic": false, "command": "meshy text-to-3d list …" } },
  "warnings": [] }
```

### Create, wait, stream and money

- `create` sends **exactly one POST**, journaled locally before it leaves
  (`~/.config/meshy/operations/<operation-id>.json`, no key material). A lost
  response, a 5xx or a malformed success is `submission_unknown` (exit 10): the
  server may have created the task, so the CLI never retries and never suggests
  re-running the create. Reconcile with `list`, then decide.
- `--operation-id <id>` replays the recorded outcome of an identical earlier
  request instead of submitting again; a different request under the same id is
  refused (`operation_conflict`, exit 2, naming what differs). "Identical" means
  the same resource, API origin, credential — a one-way digest of the API key,
  or the OAuth account (its user id, else the login id `meshy auth login` mints
  for the profile) — and payload, with every inline image or model hashed by
  content. An OAuth profile saved before login ids existed carries no verifiable
  identity: it can start operations but is refused a replay (exit 2,
  `credential_unverified`) until you log in again. This is a local record, not a
  server-side idempotency key.
- Local targets that would fail after the POST are checked before it: an
  existing `--save-json` file, an `-o` path outside `--workspace`, a missing
  `--project` all exit 11 with "nothing was submitted" and cost no request.
- Once the server has accepted a task, every later failure — saving JSON,
  polling (a 503), downloading, recording, Ctrl-C — still reports
  `result.task_id`, `result.submission` and `result.next` (the `get`/`wait`/
  `stream` commands that pick the task up). A bookkeeping problem never reads
  as "no task was created".
- `--async` returns after the POST (no polling). `get` is a query: any status
  exits 0. `wait --timeout N` polls with a monotonic deadline (`0` = one query)
  that also bounds every in-flight GET: a response arriving after the deadline
  is a timeout (exit 8, last status kept, `result.task` null when none arrived
  in time), never a late success, and no request starts once the budget is
  spent. `stream` follows Server-Sent Events with `--timeout` (total) and
  `--idle-timeout` (silence, keep-alives reset it); `-o` downloads the assets
  in every output format, and in `ndjson` the final `outcome` line carries the
  download manifest.
- `-o` on `get`/`wait`/`stream`/`make` downloads every artifact of a SUCCEEDED
  task; `result.downloads.files` is a per-file manifest (key, path, bytes,
  sha256, status). When the second asset fails, the state is `partial`, the files
  already written stay listed and on disk, and the error keeps the asset host's
  class and HTTP status (a 503 is `network`, exit 7, not a local I/O error). The
  same holds for a failure *after* the transfers — relinking, digesting or
  publishing the `meta.json` sidecar: `downloads.failed_step` names the step, the
  manifest carries the digests actually on disk. The sidecar itself is published
  like an asset (exclusive, no symlink, inside the root), so a file that appears
  at its path during the download is never overwritten. The legacy schema
  reports the same failures with additive `task_id`/`operation_id` fields and the
  resume command as `hint`, so the accepted task is never lost from a default
  `create -o` error.
- Ctrl-C stops waiting, streaming or downloading (exit 130) and sends no DELETE;
  the envelope carries the task id, the command that resumes and the files that
  had already landed. An interrupted transfer leaves no temp file behind.

## Resources

One command per endpoint. They are all registered and all supported, but they
are indexed by `meshy resources` rather than listed in `meshy --help` — that
help text is read on every invocation (an agent pays for the whole surface each
time), so it should not grow with the API. `meshy <resource> --help` documents
each one in full; `meshy resources --output-schema v1` also lists the query and
local commands with their kind.

| Command | Meshy endpoint | Docs |
|---|---|---|
| `balance` | `GET /balance` | [docs](https://docs.meshy.ai/en/api/balance) |
| `text-to-3d` | `/text-to-3d` (v2) | [docs](https://docs.meshy.ai/en/api/text-to-3d) |
| `image-to-3d` | `/image-to-3d` | [docs](https://docs.meshy.ai/en/api/image-to-3d) |
| `multi-image-to-3d` | `/multi-image-to-3d` | [docs](https://docs.meshy.ai/en/api/multi-image-to-3d) |
| `remesh` | `/remesh` | [docs](https://docs.meshy.ai/en/api/remesh) |
| `convert` | `/convert` | [docs](https://docs.meshy.ai/en/api/convert) |
| `resize` | `/resize` | [docs](https://docs.meshy.ai/en/api/resize) |
| `uv-unwrap` | `/uv-unwrap` | [docs](https://docs.meshy.ai/en/api/uv-unwrap) |
| `rigging` | `/rigging` | [docs](https://docs.meshy.ai/en/api/rigging) |
| `animate` | `/animations` | [docs](https://docs.meshy.ai/en/api/animations) |
| `text-to-motion` | `/text-to-motion` | [docs](https://docs.meshy.ai/en/api/text-to-motion) |
| `retexture` | `/retexture` | [docs](https://docs.meshy.ai/en/api/retexture) |
| `text-to-image` | `/text-to-image` | [docs](https://docs.meshy.ai/en/api/text-to-image) |
| `image-to-image` | `/image-to-image` | [docs](https://docs.meshy.ai/en/api/image-to-image) |
| `multi-color-print` | `/print/multi-color` | [docs](https://docs.meshy.ai/en/api/multi-color-print) |
| `analyze-printability` | `/print/analyze` | [docs](https://docs.meshy.ai/en/api/analyze-printability) |
| `repair-printability` | `/print/repair` | [docs](https://docs.meshy.ai/en/api/repair-printability) |
| `creative-lab <product> prototype\|build` | `/openapi/creative-lab/<product>/v1/<stage>` | [figure](https://docs.meshy.ai/en/api/creative-lab-figure) · [lamp](https://docs.meshy.ai/en/api/creative-lab-lamp) · [keychain](https://docs.meshy.ai/en/api/creative-lab-keychain) · [fridge-magnet](https://docs.meshy.ai/en/api/creative-lab-fridge-magnet) |
| `animation-catalog list` | `GET /web/public/animations/resources` (no key) | [docs](https://docs.meshy.ai/en/api/animations) |
| `showcases list` | `GET /showcases` (Enterprise; every request is billed) | [docs](https://docs.meshy.ai/en/api/enterprise-api) |

Per-resource actions (all single-HTTP-call except `wait`/`stream`):

```
meshy-cli <resource> create [flags] [--data <json>] [--async] [--timeout <s>] [--operation-id <id>]
meshy-cli <resource> get    <task-id> [--save-json <file>] [--include-raw] [--project <dir>]
meshy-cli <resource> list   [--page <n>] [--page-size <n>] [--sort-by <field>]
meshy-cli <resource> wait   <task-id> [--timeout <s>]
meshy-cli <resource> stream <task-id> [--timeout <s>] [--idle-timeout <s>]
meshy-cli <resource> delete <task-id>
```

Top-level shortcut:

```
meshy-cli delete <task-id>
    # Meshy's DELETE is unified across resources, but GET is not, so
    # `get`/`wait`/`stream` live only on their resource.
```

`create` is **synchronous by default** — it polls until the task reaches a
terminal status (`SUCCEEDED` / `FAILED` / `CANCELED`) or `--timeout` hits.
Pass `--async` to return the `task_id` immediately; then call
`<resource> get <id>`, `wait <id>` or `stream <id>` when you need the result.

### Creative Lab

Four products (`figure`, `lamp`, `keychain`, `fridge-magnet`), each with a
`prototype` stage (photo → styled concept image; the lamp prototype also yields
a lampshade GLB) and a `build` stage that consumes a SUCCEEDED prototype created
through this API with the same key. Build options are validated per product
before anything is sent: lamp `--options` (diameter, thickness, light-source
preset, rotations …) with `--model-format stl|zip`; keychain and fridge-magnet
relief options with `--model-format glb|obj|zip` — their `obj` output is a ZIP
bundle and is saved as `.zip`; figure has no options. Prototypes made in the
web app are rejected by the server (404).

## Saving artifacts with `-o` (legacy) and `meshy download` (selective)

When `-o` is set on a `create`/`wait`/`get`, the CLI downloads every artifact
the task produced, writes a sidecar metadata file, and (legacy schema) prints a
status report instead of JSON. Single-file outputs get a per-file
`<stem>_meta.json`; directory-mode outputs share a single `meta.json`. Under
`--output-schema v1` the same download is reported in `result.downloads`, and a
task that is not yet SUCCEEDED yields `downloads.state: "not_ready"` with exit 0.

```bash
meshy-cli text-to-image create --ai-model nano-banana --prompt "a leaf" -o assets/leaf.jpeg
meshy-cli image-to-3d wait <id> -o out/robot/
```

`meshy download` is the selective, scriptable counterpart:

```bash
meshy download --task-json ./task.json --list                                    # what is there?
meshy download --task-json ./task.json --model-format glb --output ./model.glb
meshy download --task-json ./rig.json --asset result.basic_animations.walking_glb_url --output ./walking.glb
meshy download --task-json ./task.json --kind thumbnail --output-dir ./previews/
meshy download --resource image-to-3d --task-id <id> --all --output-dir ./out/   # one GET, then the assets
meshy download --url https://assets.meshy.ai/... --output ./file.glb
```

Sources are `--task-json` (an API task, a legacy `meta.json`, or a v1 envelope),
`--url`, or `--resource` + `--task-id`; selectors are `--asset <key>` (repeatable),
`--model-format`, `--kind`, `--all`. With several assets and no selector the
command lists the candidates and exits 2 instead of guessing. Selecting an OBJ
pulls its MTL and textures (`--geometry-only` to skip); once the set has landed
the OBJ's `mtllib` and the MTL's `map_*` references are rewritten to the names
actually saved (`model.mtl`, `texture_0_base_color.png`, …) so the model loads
from that directory. Textures are matched by the name the server served them
under (then by channel), one candidate only: with several material groups a
reference that could mean two files is left as written and reported as
ambiguous, and a reference that merely equals one of the CLI's generated names
(`texture_0_base_color.png`) while the server called that image something else
is ambiguous too — identity follows the source, never the file name on disk.
Channel fallbacks (a channel word in the reference, the MTL key's channel, the
only texture there is) are heuristics and compete on the texture they actually
reach: when two different references would both fall back to the same image, or
one reference would go to different images under different keys, they all stay
as written and are reported as ambiguous — the CLI never merges material groups
without evidence that they name the same file. Every link is listed under `result.downloads.material_links`
(`status: complete | incomplete`, the `newmtl` group of each map), rewritten
files carry `relinked: true` with their final sha256, and a reference that
matches no or several downloaded files stays as written and is warned
(`material_reference_unresolved` / `material_reference_ambiguous`). Files are published
exclusively (never overwritten without `--overwrite`), checked against the
content type and magic bytes, kept inside the output directory (or `--workspace`),
and listed with size and sha256 in `result.downloads.files`. With `--project <dir>`
the files that landed inside the project are recorded in its `metadata.json`;
when that record fails after the transfer (metadata.json replaced by a symlink,
damaged, or locked) the command exits 11 with the complete `result` — manifest,
`saved_json`, `project.action: "failed"` — and `error.recovery.command` is the
one `meshy project record …` invocation that redoes the record — carrying the
original `--workspace`, so a recovery never writes further than the command that
failed; the assets stay where they landed. Problems visible before the transfer (no metadata.json, a
symlink or invalid JSON in its place, a blank `--stage`) are refused with no
request made. Asset hosts never
receive the API credential; an expired signed URL is refreshed once when the
task came from the API and reported as unrefreshable when it came from a file.

## Projects (`meshy_output/`)

The Skills' project layout, without Python:

```bash
meshy project init --root ./meshy_output --name "demo" --task-id <id>
meshy text-to-3d wait <id> --project ./meshy_output/<folder>          # saves task_<id>.json, records the stage
meshy project record --project ./meshy_output/<folder> --task-id <id> --resource text-to-3d --stage preview --file preview.glb
meshy project show --project ./meshy_output/<folder>
meshy project list --root ./meshy_output
meshy project rebuild-index --root ./meshy_output
```

`metadata.json` (schema 2; legacy files are read as-is and migrated on the first
write with a backup) is the source of truth; `history.json` is a rebuildable
index. A repeat `(task_id, stage)` merges instead of duplicating.

## Printing helpers

```bash
meshy inspect faces --task-json ./task.json --max-faces 300000    # pass (0) | fail (12) | unknown (13)
meshy mesh prepare-print ./model.obj --height-mm 75                # writes ./model.print.obj
meshy mesh prepare-print ./model.obj --height-mm 80 --in-place
meshy slicer detect
meshy slicer open --slicer OrcaSlicer --file ./model.print.obj
```

`inspect faces` answers only whether the task's `face_count` is within the
limit you pass (`--max-faces` is required); a missing count is `unknown`, never
0, and a failing verdict only *describes* a remesh. `prepare-print` rotates a
Y-up OBJ to Z-up, scales it to the target height, centres it on XY and rests it
on Z=0, preserving faces, UVs, normals (rotated only) and material references;
it never overwrites without `--in-place`, and the MTL/texture copies it makes
beside the output are proven — on real paths, before any directory is created —
to lie inside the output directory (or `--workspace`), so a symlinked
`materials/` cannot redirect them. `slicer open` launches only a
registered slicer at its detected path with the file as a single argument — no
shell, no default-application fallback; `launch_requested` is not proof that
the import succeeded.

## Image and 3D-model inputs

Flags that take a media source (`--image-url`, `--image-urls`,
`--reference-image-urls`, `--texture-image-url`, `--image-style-url`,
`--multiview-image-urls`, `--model-url`) — and the same fields inside `--data` —
accept:

- **http(s) URLs** — preflighted with an unauthenticated HEAD so unreachable sources fail fast.
- **Local file paths** — absolute or relative to cwd. MIME-sniffed via magic
  bytes (with extension fallback), size-capped, and inlined as `data:` URIs on the wire.
- **`data:` URIs** — validated (base64, MIME kind, size) and passed through.

Missing files and 4xx/5xx preflights exit with code `2` and a flag-prefixed
message before any task is created. GLB-only fields (`uv-unwrap`, `rigging`
`--model-url`) reject other formats locally.

## Global flags

| Flag | Purpose |
|------|---------|
| `--api-key <key>` | Override `MESHY_API_KEY` |
| `--api-key-file <path>` | Read `MESHY_API_KEY` from an explicit dotenv-style file (only that key) |
| `--base-url-v1 <url>` / `--base-url-v2 <url>` | Override endpoints (staging/proxy) |
| `--base-url-creative-lab <url>` | Override the Creative Lab base (default: `<v1 origin>/openapi/creative-lab`) |
| `--output-schema legacy\|v1` | Stdout data model (existing commands default to `legacy`; new commands are `v1`) |
| `--format json\|pretty\|ndjson` | Stdout rendering (default `json`) |
| `-o, --output <path>` | Download artifacts to a file/directory (task commands); output file for `mesh prepare-print` |
| `--workspace <dir>` | Confine every written file to this directory: `download`, `-o` on task verbs and `make` (report-only tasks included), `--save-json`, `--project`/project folders and the history index (skipped with `index_dirty` when its root would fall outside), `mesh prepare-print` outputs and their copied materials — checked on real paths before anything, even a directory, is created. The boundary is frozen when the command starts (real path and directory identity): a workspace or project replaced by a symlink while a request is in flight is refused, never followed |
| `--no-update-check` | Skip the background npm version check in this process |
| `-v, --verbose` | Debug logging to stderr |
| `--log-level <level>` | `debug \| info \| warn \| error \| silent` |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success (including `get` of any task status, empty lists, local checks that pass) |
| 1 | task ended FAILED/CANCELED while waiting, or an unclassified error |
| 2 | usage (flag parse error, conflicting or missing arguments) |
| 3 | auth (`401`, no usable credential) |
| 4 | validation (`400`, `422`, locally rejected payload) |
| 5 | not found (`404`; the cause is not guessed) |
| 6 | rate limit (`429`) |
| 7 | network (read failures, stream disconnects) |
| 8 | timed out waiting for or streaming a task (the task keeps running) |
| 9 | credit exhausted (`402`) |
| 10 | submission unknown — a create was sent but its outcome could not be confirmed |
| 11 | local I/O — refused overwrite, path outside the authorised root, journal/project write failure |
| 12 | check failed (`inspect faces` over the limit) |
| 13 | check unknown (`inspect faces` without a usable face count) |
| 130 | interrupted (Ctrl-C); nothing was deleted server-side |

## Environment variables

| Variable | Default |
|---|---|
| `MESHY_API_KEY` | — (required unless a profile is stored or `--api-key-file` is given) |
| `MESHY_BASE_URL_V1` | `https://api.meshy.ai/openapi/v1` |
| `MESHY_BASE_URL_V2` | `https://api.meshy.ai/openapi/v2` |
| `MESHY_BASE_URL_CREATIVE_LAB` | derived from the v1 origin (`/openapi/creative-lab`) |
| `MESHY_OAUTH_AUTHORIZE_URL` | `https://www.meshy.ai/oauth/authorize` — override for staging/testing |
| `MESHY_CLI_NO_BROWSER` | unset — set to `1` to suppress browser open (URL still printed to stderr) |
| `MESHY_CONFIG_DIR` | `~/.config/meshy` (credentials, operation journal, update cache) |
| `MESHY_CONNECT_TIMEOUT_MS` | `10000` (read for compatibility; fetch has no separate connect timeout) |
| `MESHY_READ_TIMEOUT_MS` | `120000` — covers headers *and* body |
| `MESHY_POLL_INTERVAL_MS` | `3000` |
| `MESHY_LOG_LEVEL` | `warn` |
| `MESHY_CLI_NO_UPDATE_NOTIFIER` | unset — any non-empty value disables update checks; CI envs (`CI`, `GITHUB_ACTIONS`, `BUILD_NUMBER`, `RUN_ID`) auto-skip |

## Update notifications

meshy-cli checks the npm registry for a newer version at most once per 24 hours. The result is cached at `<MESHY_CONFIG_DIR>/update-state.json`. The refresh runs in a detached background process so it can never slow down or fail a command, and it never runs for local commands (`resources`, `project`, `inspect`, `mesh`, `slicer`, `doctor`, `download`, `animation-catalog`), for `make --dry-run`, or with `--no-update-check`.

When a newer version is available:

- **Legacy JSON object outputs** carry a top-level `_notice.update = { current, latest, message, command }` so agents can relay it to the user.
- **v1 envelopes are never decorated** — the six keys are the contract; humans get the hint on stderr.
- **ndjson arrays** (legacy) carry `_notice.update` on the **first line only**.
- **Humans on an interactive terminal** get a single line on stderr after the command output.
- **stdout is never polluted** — the notice never appears on stdout.

## Agent skills

The `skills/` directory contains markdown-based skills for AI coding agents
(Claude Code, etc.):

- [`skills/meshy-cli`](skills/meshy-cli/SKILL.md) — a single skill covering
  setup, `make`, the shared verb contract, the v1 envelope, the API constraints
  that produce failed tasks when ignored, the local helpers, and the exit-code table.

  It is deliberately short. A skill is loaded into an agent's context on every
  invocation, so length is a running cost; anything an agent can look up on
  demand (`meshy resources`, `meshy <resource> --help`,
  <https://docs.meshy.ai/en/api/>) is linked rather than copied.

## Skill-parity documentation

`docs/skill-parity/` records how this release covers the execution capabilities
of the Meshy Skills without Python: the frozen baseline, the endpoint contracts,
the capability matrix, design decisions, migration notes with every intentional
difference, and the verification record.

## Project layout

```
meshy-cli/
├── src/
│   ├── index.ts             # CLI entry: update-check policy, SIGINT, unified error exit
│   ├── root.ts              # root command + global flag wiring
│   ├── cmd/                 # make, auth, balance, resources, api, one file per endpoint,
│   │                        # uv-unwrap, creative-lab, animation-catalog, showcases,
│   │                        # download, project, inspect, mesh, slicer, doctor
│   ├── client/
│   │   ├── resource-registry.ts  # every resource: path, family, verbs, billing, media fields
│   │   ├── transport.ts     # per-family HTTP transport (auth scope, deadlines, redirects)
│   │   ├── endpoints/       # TaskEndpoint + balance / catalog / showcases
│   │   └── types.ts         # Zod task schemas
│   └── internal/
│       ├── result.ts / errors.ts   # v1 envelope, error codes, exit codes
│       ├── task-command.ts  # create/get/list/wait/stream/delete factory
│       ├── operation-store.ts      # submission journal (single POST, unknown outcomes)
│       ├── stream.ts / poll.ts     # SSE parser + cancellable polling
│       ├── artifacts.ts / download.ts  # asset keys, safe downloads, legacy -o
│       ├── project-store.ts # meshy_output metadata + history
│       ├── inspect.ts / obj-transform.ts / slicers.ts / doctor.ts
│       ├── config.ts / runtime.ts / env-file.ts / credentials.ts / oauth.ts
│       └── atomic-file.ts / paths.ts / lock.ts
├── tests/                   # node:test unit, contract and black-box tests
├── skills/                  # agent-facing skill (published)
├── docs/skill-parity/       # baseline, contracts, matrix, decisions, verification
├── package.json
└── README.md
```

## Design notes

- **Two layers, one of them opinion-free.** `make` chains endpoints; the
  resource commands expose them one at a time. `make` picks its chain from the
  input type alone and stops there.
- **Plan first, then spend.** `make` computes the whole chain before creating
  anything, so `--dry-run` and a real run share one code path and one estimate.
- **One POST, journaled.** Every billable create is recorded before it is sent;
  a lost answer is reported as unknown, never re-sent.
- **One registry.** `src/client/resource-registry.ts` is the only place a path,
  API family, verb set or media field is declared; commands, the `resources`
  index and the transport all read from it.
- **Credentials have a scope.** The API credential goes to the API origins it
  was resolved for and nowhere else — not to asset hosts, not to the public
  catalog, not across redirects.
- **`--data` escape hatch.** Every `create` accepts a raw JSON object (or
  `@file.json`) that merges with structured flags (flags win, explicit `false`
  and `0` survive).
- **Stdout is reserved for command output.** Logs, progress and errors' prose go
  to stderr so pipes (`| jq`, `-o file`) stay clean.

## License

MIT — see [LICENSE](LICENSE).
