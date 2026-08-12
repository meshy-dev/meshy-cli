# meshy-cli

A small, well-structured command-line interface for the [Meshy AI API](https://docs.meshy.ai/) — text-to-3D, image-to-3D (standard and smart-topology), remesh, convert, resize, rigging, animation, retexture, 2D image generation, multi-color print output, and the `balance` endpoint. Built for humans and AI agents.

Two layers. `meshy make` chains the documented flows so that one command
produces one model. Underneath, a per-endpoint command for every resource
shares a uniform `create / get / list / wait / delete` verb surface, with a raw
`api` passthrough for endpoints the CLI doesn't model yet and a `skills/`
directory of agent-facing documentation.

The flag surface is deliberately curated rather than a 1:1 mirror of the API: deprecated parameters (`symmetry_mode`, `hd_texture`, `is_a_t_pose`) are not exposed, geometry knobs live on `remesh` and sizing on `resize` instead of every generation command, and defaults are pinned to game-ready values (PBR maps on, 4k textures — same credit cost as the bare defaults). Everything the API accepts remains reachable through `--data`.

## Install

Requires Node 20+.

```bash
npm i -g meshy-cli       # installs `meshy-cli` and `meshy`
meshy --help
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
```

Get a key at <https://www.meshy.ai/settings/api>.

**Resolution order:** `--api-key` › `MESHY_API_KEY` › the active stored profile.
The environment variable stays ahead of the stored credential on purpose, so a
CI runner is never overridden by whatever a developer once logged into on that
machine. With none of the three, commands exit `3` and print the command that
fixes it.

**Where it lives:** `~/.config/meshy/credentials.json`, mode `0600`, on every
platform (`MESHY_CONFIG_DIR` or `MESHY_CREDENTIALS_PATH` move it). Writes go
through a cross-process lock and a temp-file rename, because several agents
driving this CLI at once is the normal case. A non-production `--base-url-v1`
reads and writes `credentials.dev.json` instead, so staging cannot clobber a
production login.

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
meshy make "a red sports car" --dry-run          # the steps and the estimate, no spend
meshy make "a red sports car" --max-credits 25   # refuse to start when over budget
```

Both guards run before the first task is created. If a later step fails, the
error's `hint` is the command that resumes from the finished step — running it
beats starting over, which would pay for that step twice.

## At a glance

```bash
# account
meshy-cli balance

# text → 3D (sync by default: blocks until the task finishes)
meshy-cli text-to-3d create --mode preview --prompt "a red sports car"
meshy-cli text-to-3d create --mode refine  --preview-task-id <id>

# image → 3D
meshy-cli image-to-3d create --image-url https://example.com/cat.png

# smart topology: component-aware low-poly with a native polycount
meshy-cli image-to-3d create --image-url cat.png --model-type smart-topology --target-polycount 10000

# fire-and-forget (--async): returns the task_id immediately, query later
TASK=$(meshy-cli text-to-image create --prompt "mountain landscape" --async | jq -r .task_id)
meshy-cli text-to-image get  "$TASK"
meshy-cli text-to-image wait "$TASK" -o /tmp/result.json

# raw passthrough for any endpoint
meshy-cli api GET  /balance
meshy-cli api POST /text-to-3d --data '{"mode":"preview","prompt":"a cactus"}'
```

## Resources

One command per endpoint. They are all registered and all supported, but they
are indexed by `meshy resources` rather than listed in `meshy --help` — that
help text is read on every invocation (an agent pays for the whole surface each
time), so it should not grow with the API. `meshy <resource> --help` documents
each one in full.

| Command | Meshy endpoint | Docs |
|---|---|---|
| `balance` | `GET /balance` | [docs](https://docs.meshy.ai/en/api/balance) |
| `text-to-3d` | `/text-to-3d` (v2) | [docs](https://docs.meshy.ai/en/api/text-to-3d) |
| `image-to-3d` | `/image-to-3d` | [docs](https://docs.meshy.ai/en/api/image-to-3d) |
| `multi-image-to-3d` | `/multi-image-to-3d` | [docs](https://docs.meshy.ai/en/api/multi-image-to-3d) |
| `remesh` | `/remesh` | [docs](https://docs.meshy.ai/en/api/remesh) |
| `convert` | `/convert` | [docs](https://docs.meshy.ai/en/api/convert) |
| `resize` | `/resize` | [docs](https://docs.meshy.ai/en/api/resize) |
| `rigging` | `/rigging` | [docs](https://docs.meshy.ai/en/api/rigging) |
| `animate` | `/animations` | [docs](https://docs.meshy.ai/en/api/animations) |
| `retexture` | `/retexture` | [docs](https://docs.meshy.ai/en/api/retexture) |
| `text-to-image` | `/text-to-image` | [docs](https://docs.meshy.ai/en/api/text-to-image) |
| `image-to-image` | `/image-to-image` | [docs](https://docs.meshy.ai/en/api/image-to-image) |
| `multi-color-print` | `/print/multi-color` | [docs](https://docs.meshy.ai/en/api/multi-color-print) |
| `analyze-printability` | `/print/analyze` | [docs](https://docs.meshy.ai/en/api/analyze-printability) |
| `repair-printability` | `/print/repair` | [docs](https://docs.meshy.ai/en/api/repair-printability) |

Per-resource actions (all single-HTTP-call):

```
meshy-cli <resource> create [flags] [--data <json>] [--async] [--timeout <s>]
meshy-cli <resource> get    <task-id>
meshy-cli <resource> list   [--page <n>] [--page-size <n>] [--sort-by <field>]
meshy-cli <resource> wait   <task-id> [--timeout <s>]
meshy-cli <resource> delete <task-id>
```

Top-level shortcut:

```
meshy-cli delete <task-id>
    # Meshy's DELETE is unified across resources, but GET is not, so
    # `get`/`wait` live only on their resource.
```

`create` is **synchronous by default** — it polls until the task reaches a
terminal status (`SUCCEEDED` / `FAILED` / `CANCELED`) or `--timeout` hits.
Pass `--async` to return the `task_id` immediately; then call
`<resource> get <id>` or `<resource> wait <id>` when you need the result.

## Saving artifacts with `-o`

When `-o` is set on a `create`/`wait`/`get`, the CLI downloads every artifact
the task produced, writes a sidecar metadata file, and prints a status report
instead of JSON. Single-file outputs get a per-file `<stem>_meta.json`
(e.g. `front.jpeg` → `front_meta.json`) so two outputs can share one
directory; directory-mode outputs share a single `meta.json`.

```bash
# Single-artifact task — pass a file path. Extension is autocorrected
# against the response Content-Type; sharp transcodes between
# jpg/png/webp/gif/tiff/avif so the file truly has the requested format.
meshy-cli text-to-image create --ai-model nano-banana --prompt "a leaf" \
  -o assets/leaf.jpeg

# Multi-artifact task (3D, multi-view 2D, animation) — pass a directory.
# Files land with role-based names: model.glb, thumbnail.png,
# texture_0_base_color.png, animation_glb.glb, …
meshy-cli image-to-3d wait <id> -o out/robot/
```

Existing files at the target abort with a clear `UsageError` — no silent
overwrite. Without `-o`, the CLI keeps its pre-download JSON behavior
(machine-readable summary on stdout).

## Image and 3D-model inputs

Flags that take a media source (`--image-url`, `--image-urls`,
`--reference-image-urls`, `--texture-image-url`, `--image-style-url`,
`--model-url`) accept:

- **http(s) URLs** — preflighted with HEAD so unreachable sources fail fast.
- **Local file paths** — absolute or relative to cwd. MIME-sniffed via magic
  bytes (with extension fallback) and inlined as `data:` URIs on the wire.

You do not need to host files. `data:` URIs on the command line are rejected
explicitly — pass a local path instead. Missing files and 4xx/5xx responses
exit with code `2` and a flag-prefixed message before any task is created.

## Global flags

| Flag | Purpose |
|------|---------|
| `--api-key <key>` | Override `MESHY_API_KEY` |
| `--base-url-v1 <url>` / `--base-url-v2 <url>` | Override endpoints (staging/proxy) |
| `--format json\|pretty\|ndjson` | Stdout format when `-o` is not set (default `json`) |
| `-o, --output <path>` | Download artifacts to a file/directory; write `meta.json`; switch stdout to a status report |
| `-v, --verbose` | Debug logging to stderr |
| `--log-level <level>` | `debug \| info \| warn \| error \| silent` |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | generic / server |
| 2 | usage (flag parse error) |
| 3 | auth (`401`) |
| 4 | validation (`400`, `422`) |
| 5 | not found (`404`) |
| 6 | rate limit (`429`) |
| 7 | network |
| 8 | timed out waiting for a task |
| 9 | credit exhausted (`402`) |

## Environment variables

| Variable | Default |
|---|---|
| `MESHY_API_KEY` | — (required unless a profile is stored) |
| `MESHY_BASE_URL_V1` | `https://api.meshy.ai/openapi/v1` |
| `MESHY_BASE_URL_V2` | `https://api.meshy.ai/openapi/v2` |
| `MESHY_OAUTH_AUTHORIZE_URL` | `https://www.meshy.ai/oauth/authorize` — override for staging/testing |
| `MESHY_CLI_NO_BROWSER` | unset — set to `1` to suppress browser open (URL still printed to stderr) |
| `MESHY_CONNECT_TIMEOUT_MS` | `10000` |
| `MESHY_READ_TIMEOUT_MS` | `120000` |
| `MESHY_POLL_INTERVAL_MS` | `3000` |
| `MESHY_LOG_LEVEL` | `warn` |
| `MESHY_CLI_NO_UPDATE_NOTIFIER` | unset — any non-empty value disables update checks; CI envs (`CI`, `GITHUB_ACTIONS`, `BUILD_NUMBER`, `RUN_ID`) auto-skip |

## Update notifications

meshy-cli checks the npm registry for a newer version at most once per 24 hours. The result is cached at `~/.config/meshy/update-state.json`. The refresh runs in a detached background process so it can never slow down or fail a command.

When a newer version is available:

- **JSON object outputs** (`--format json` when the result is an object) carry a top-level `_notice.update = { current, latest, message, command }` so agents can relay it to the user.
- **ndjson arrays** carry `_notice.update` on the **first line only** (the first element, if it is a plain object).
- **Plain JSON arrays** (`--format json` with an array result) are intentionally left untouched — there is no clean metadata slot in a JSON array without breaking the schema.
- **Humans on an interactive terminal** get a single line on stderr after the command output.
- **stdout is never polluted** — the notice never appears on stdout.
- **Skipped automatically** in CI environments and for development builds.

## Agent skills

The `skills/` directory contains markdown-based skills for AI coding agents
(Claude Code, etc.):

- [`skills/meshy-cli`](skills/meshy-cli/SKILL.md) — a single skill covering
  setup, `make`, the shared verb contract, the API constraints that produce
  failed tasks when ignored, and the exit-code table.

  It is deliberately short. A skill is loaded into an agent's context on every
  invocation, so length is a running cost; anything an agent can look up on
  demand (`meshy resources`, `meshy <resource> --help`,
  <https://docs.meshy.ai/en/api/>) is linked rather than copied.

## Project layout

```
meshy-cli/
├── src/
│   ├── index.ts             # CLI entry
│   ├── root.ts              # root command + global flag wiring
│   ├── cmd/                 # make + resources + api/balance/delete + one file per endpoint
│   ├── client/              # Meshy HTTP client (v1 + v2 fetchers, typed endpoints)
│   └── internal/
│       ├── config.ts        # env + flag → runtime config
│       ├── runtime.ts       # lazy client/config construction
│       ├── make-plan.ts     # make's route choice + step list (pure, offline)
│       ├── pricing.ts       # credit estimates for the chains make runs
│       ├── task-command.ts  # create/get/list/wait/delete factory
│       ├── poll.ts          # backoff polling until terminal
│       ├── file-input.ts    # image + 3D-model flag resolution (URL or local)
│       ├── download.ts      # -o artifact download, meta.json, extension fix
│       ├── report.ts        # Status: SUCCESS / FAIL stdout formatter
│       ├── output.ts        # json / pretty / ndjson writers
│       ├── payload.ts       # --data parsing, mergePayload, dropNullish
│       ├── flags.ts         # parseBool / parseInt10 / parseCsv helpers
│       ├── errors.ts        # UsageError + exit-code mapping
│       ├── global-options.ts  # mirror --format etc. onto subcommands
│       └── logger.ts        # leveled stderr logger
├── tests/                   # node:test unit + integration tests
├── skills/                  # agent-facing skill: SKILL.md + bundled animation catalog (published)
├── package.json
├── tsconfig.json
└── README.md
```

## Design notes

- **Two layers, one of them opinion-free.** `make` chains endpoints; the
  resource commands expose them one at a time. `make` picks its chain from the
  input type alone and stops there. Every richer decision — going through an
  image first, confirming a shape before texturing, a polycount that rigs well
  — is a judgement about someone else's asset and someone else's credits, so it
  stays with the caller rather than being baked into a default.
- **Plan first, then spend.** `make` computes the whole chain before creating
  anything, so `--dry-run` and a real run share one code path and one estimate.
  `--max-credits` refuses on that estimate; a budget enforced after step one has
  billed is not a budget.
- **Two fetchers.** `text-to-3d` lives under `/openapi/v2`, everything else on
  `/openapi/v1`. The client holds both and routes per endpoint.
- **Uniform verbs.** A single `buildResourceCommand` factory generates
  `get`/`list`/`wait`/`delete` for every resource. Resource modules only
  contribute their unique `create` flag shape.
- **`--data` escape hatch.** Every `create` accepts a raw JSON object (or
  `@file.json`) that merges with structured flags. Use this when Meshy ships a
  new field before the CLI models it.
- **Stdout is reserved for command output.** Logs and errors go to stderr so
  pipes (`| jq`, `-o file`) stay clean.

## License

MIT — see [LICENSE](LICENSE).
