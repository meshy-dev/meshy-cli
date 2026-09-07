---
name: meshy-cli
description: "Generate 3D models, motion clips, 2D images and Creative Lab print products with the Meshy API through the meshy-cli command — text-to-3D, image-to-3D, text-to-motion, remesh, UV unwrap, rigging, animation, retexture, printability, selective downloads, project folders, face checks, OBJ print preparation and slicer launch. Use for any Meshy asset or 3D-printing request."
license: MIT
compatibility: Requires meshy-cli on PATH (Node 24+, no Python) and a stored credential, MESHY_API_KEY or --api-key-file for API commands; network access to api.meshy.ai. Local helpers work offline.
metadata:
  version: "1.1.0"
  cli-help: "meshy --help"
---

# meshy-cli

## Setup

`npm i -g meshy-cli`, then `meshy auth login` (browser) or
`meshy auth login --with-key msy_...`. `MESHY_API_KEY` also works and wins over
a stored profile, which is what CI wants; `--api-key-file ./keys.env` reads only
`MESHY_API_KEY` from an explicit dotenv-style file (nothing is auto-discovered or
executed; do not use Node's `--env-file`). Never echo the key back or write it
into a shell profile. `meshy doctor` checks the environment without touching the
network; `meshy doctor --check-api` makes one free balance call.

## Always ask for the stable envelope

Add `--output-schema v1 --format json` to every command you parse. stdout is then
exactly one JSON object with six keys — `schema_version, command, ok, result,
error, warnings` — and nothing else; progress goes to stderr. `ok` is whether the
CLI operation completed; `result.task.status` is the server's task state (a `get`
of a FAILED task is `ok:true`). Fields the server did not send are `null` —
never treat a `null` `face_count` or `consumed_credits` as 0. `error.code` and
the exit code (below) are stable; `error.recovery.command`, when present, is a
command you can run verbatim.

## One model, one command

```bash
meshy make "a red sports car" -o car.glb --output-schema v1     # prompt → text-to-3d preview → refine
meshy make ./cat.png -o out/cat/ --output-schema v1             # image  → image-to-3d, textured
meshy make "a red sports car" --dry-run --output-schema v1      # planned steps + estimate, no spend, no network
meshy make "..." --max-credits 25                               # refuse to start over budget
meshy make "..." --async --output-schema v1                     # one POST, returns step 1's task_id + pending_steps
```

The input decides the chain and nothing else does. If a later step fails, the
result carries the finished step's task id and the `resume` command — run it
verbatim rather than starting over, or the finished step is paid for twice.

## Everything else

`meshy resources --output-schema v1` indexes every command (kind `task`, `query`
or `local`); each task resource carries the same verbs:

```bash
meshy <resource> create [flags] [--data '<json>'] [--async] [--timeout <s>] [--operation-id <id>] --output-schema v1
meshy <resource> get|wait|stream|delete <task-id> --output-schema v1
meshy <resource> list [--page-size <n>] --output-schema v1
```

- `create` blocks until the task is terminal; `--async` submits **exactly one
  POST** and returns `result.submission.task_id` — parse ids from stdout, never
  from text shown in chat. `wait <id>` polls (`--timeout 0` = one query, exit 8 on
  timeout with the last status kept; a reply that lands after the deadline is a
  timeout, not a success); `stream <id> --format ndjson` follows Server-Sent
  Events (one line per event, last line `event:"outcome"`, which carries the `-o`
  download manifest).
- **Never re-run a create after exit 10** (`submission_unknown`): the request was
  sent and the server may have created the task. Run the `error.recovery.command`
  (`… list`) and reconcile first. Pass `--operation-id <your-id>` to a create so a
  repeat of the same request replays the recorded outcome instead of billing again;
  a different key/account, payload or image under the same id is refused (exit 2).
  An OAuth profile without an account id or login id (saved before `login_id` existed)
  is refused a replay (`credential_unverified`) — run `meshy auth login` once first.
- **An error after `create` was accepted still names the task**: read
  `result.task_id` / `result.submission.task_id` and `result.next` from any
  non-zero exit (11 local I/O, 1 polling failure, 130 interrupt) before deciding
  anything; never create again because a later step failed.
- `--save-json <file>` stores the raw API task (use it as the input of `download`,
  `inspect faces` and `project record`); `--include-raw` puts the raw response under
  `result.task.raw`; `--project <dir>` records the task in a project folder.
- `--data '<json>'` reaches any field the CLI has no flag for (flags win, explicit
  `false`/`0` survive); `meshy api <METHOD> <PATH>` reaches any endpoint it has no
  command for. Media flags and the same fields inside `--data` accept URLs, local
  files and `data:` URIs.

## Creative Lab, UV, catalog, showcases

```bash
meshy uv-unwrap create --input-task-id <id> --async --output-schema v1              # GLB only, ≤40k faces (server enforces)
meshy creative-lab <figure|lamp|keychain|fridge-magnet> prototype create --image-url ./photo.png --name demo --async --output-schema v1
meshy creative-lab <product> build create --input-task-id <prototype-id> [--model-format …] [--options '<json>'] --async --output-schema v1
meshy animation-catalog list --category DailyActions --search wave --output-schema v1   # public, no key; search is local
meshy showcases list --search car --page-size 3 --output-schema v1                      # Enterprise only; EVERY request is billed
```

Prototype meanings differ: figure/keychain/fridge-magnet yield a concept image,
lamp also yields a lampshade GLB. Build consumes a SUCCEEDED prototype made
through this API with the same key (web-app prototypes → 404). Lamp builds output
`lamp_stl`/`base_stl` or `bundle_zip`; keychain/fridge-magnet `obj` output is a
ZIP bundle saved as `.zip`. Never call `showcases` in a health check.

## Downloads, projects, printing (local, no key)

```bash
meshy download --task-json ./task.json --list --output-schema v1
meshy download --task-json ./task.json --model-format glb --output ./model.glb --output-schema v1
meshy download --task-json ./rig.json --asset result.basic_animations.walking_glb_url --output ./walking.glb --output-schema v1
meshy download --resource image-to-3d --task-id <id> --all --output-dir ./out/ --output-schema v1
meshy project init --root ./meshy_output --name "<prompt>" --task-id <id> --output-schema v1
meshy project record --project <dir> --task-id <id> --resource text-to-3d --stage preview --file preview.glb --output-schema v1
meshy inspect faces --task-json ./task.json --max-faces 300000 --output-schema v1   # exit 0 pass | 12 fail | 13 unknown
meshy mesh prepare-print ./model.obj --height-mm 75 --output-schema v1              # writes ./model.print.obj (Y-up → Z-up, grounded)
meshy slicer detect --output-schema v1
meshy slicer open --slicer OrcaSlicer --file ./model.print.obj --output-schema v1  # launch only; not proof of import
```

`download` needs an explicit selector when a task has several assets (it lists
them and exits 2 otherwise); it never overwrites without `--overwrite`. `inspect
faces` answers only the face-count question — `unknown` (exit 13) means the task
carries no usable `face_count`; do not treat it as a pass and do not start a
remesh unless the user agrees. `prepare-print` never edits the input unless
`--in-place`.

## Constraints that will bite

These are API rules, not preferences — ignoring them produces failed tasks:

- **`refine` only works on a `text-to-3d` preview** (it consumes that task's
  latents). Uploaded models, `image-to-3d` output and remeshed meshes are
  textured with `retexture` instead.
- **`rigging` needs a textured biped GLB** under 300k faces, with clear limbs —
  not props, quadrupeds or untextured drafts. Too dense? `remesh` first. A
  successful rigging task already bundles walking and running clips
  (`result.basic_animations.*`), so check its result before calling `animate`.
- **`animate` takes a rigging task id**, not a model task id, plus an integer
  `--action-id` from the catalog.
- **`text-to-motion` produces a standalone skeletal clip**, not an animated
  character. Pass a 2–10 second duration in 0.5-second increments.
- **`repair-printability` drops textures and invalidates UVs.** Run it before
  texturing, or re-`retexture` afterwards.
- **`uv-unwrap` takes one source** (`--input-task-id` or `--model-url`, GLB only).
- **`multi-image-to-3d` is beta**; use `image-to-3d` unless multi-view input was
  explicitly asked for.
- `image-to-3d` defaults to an untextured draft mesh; `--should-texture true`
  (what `make` uses) produces a textured model in one task.
- **The model set is not the same on every endpoint.** The image-driven
  endpoints run Meshy 7 by default; `text-to-3d` has no Meshy 7 at all and its
  default is still Meshy 6. `--ultra-mode` exists on `image-to-3d` alone, and
  `retexture`'s `--multiview-image-urls` needs Meshy 7 — it takes 1-4 views of
  **the same object**, not style references.

## Finding an animation id

`--action-id` is an integer from Meshy's animation library. Ask the live public
catalog (no key): `meshy animation-catalog list --category Fighting --search kick
--output-schema v1` → `result.items[].action_id`. Ids are not `1..N` (the catalog
contains `-2`, `-1` and `0`) — never guess one. This skill also bundles a
snapshot as `animation-library.json` (with hand-written descriptions the API does
not return; it can lag behind the live catalog).

Categories: WalkAndRun, BodyMovements, DailyActions, Fighting, Dancing.

## When something fails

Exit codes: `0` ok · `1` task FAILED/CANCELED while waiting, or unclassified ·
`2` usage · `3` auth · `4` validation · `5` not found · `6` rate limit ·
`7` network · `8` timed out (task keeps running) · `9` out of credits ·
`10` submission unknown (do not re-create) · `11` local I/O · `12` check failed ·
`13` check unknown · `130` interrupted.

- Exit 9 → run `meshy balance`, relay the number, do not retry.
- Exit 6 → back off; the CLI does not retry for you.
- Exit 8 → `wait`/`stream` the same task id again; it was not cancelled.
- Exit 130 after `-o` → the transfer was cancelled; `result.downloads.files` lists what
  already landed (`status: written`), the rest can be fetched with `meshy download`.
- `result.downloads.material_links.status: "incomplete"` → name the references that
  stayed unresolved or ambiguous (`texture_maps[].method`) instead of claiming the model loads.
- Exit 10 → reconcile with `<resource> list`; never submit the same create again blindly.
- A `FAILED` task → relay `result.task.task_error.message` verbatim; do not guess a cause.
- Any error may carry `error.recovery.command` — prefer it over improvising.

Legacy JSON output (without `--output-schema v1`) may carry `_notice.update` when
a newer meshy-cli exists; pass its `command` on to the user.

## Docs

Endpoint reference and pricing: https://docs.meshy.ai/en/api/
