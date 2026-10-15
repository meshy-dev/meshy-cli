---
name: meshy-cli
description: "Generate 3D models, motion clips, 2D images and Creative Lab print products with the Meshy API through the meshy-cli command — text-to-3D, image-to-3D, text-to-motion, remesh, UV unwrap, rigging, animation, retexture, printability, auto split into printable parts, per-task credit usage, selective downloads, project folders, face checks, OBJ print preparation and slicer launch. Use for any Meshy asset or 3D-printing request."
license: MIT
compatibility: Requires meshy-cli on PATH (Node 22.12+, no Python) and a stored credential, MESHY_API_KEY or --api-key-file for API commands; network access to api.meshy.ai. Local helpers work offline.
metadata:
  version: "1.2.0"
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

Add `--output-schema v1 --format json` to every command you parse. Untyped,
`--format` is `pretty` at a terminal and `json` elsewhere; say both and the
shape is fixed however you are spawned. `pretty` is a human view that drops
fields, so never parse it; `json` and `ndjson` carry no colour codes. stdout is then
exactly one JSON object with six keys — `schema_version, command, ok, result,
error, warnings` — and nothing else. Progress goes to stderr as plain lines
(none under `ndjson`); it is for people, so read ids from stdout, not from it. `ok` is whether the
CLI operation completed; `result.task.status` is the server's task state (a `get`
of a FAILED task is `ok:true`). Fields the server did not send are `null` —
never treat a `null` `face_count` or `consumed_credits` as 0. `error.code` and
the exit code (below) are stable; `error.recovery.command`, when present, is a
command you can run verbatim, once a `<dir>`/`<file>` placeholder in it (download
recoveries) is replaced with a real path.

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

`meshy resources --output-schema v1` indexes every command (kind `task`, `query`,
`action` or `local`); each task resource carries the same verbs:

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
  non-zero exit (11 local I/O, 8 timeout, 130 interrupt) before deciding
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
meshy creative-lab <figure|vinyl-figure|brick-figure|lamp|keychain|fridge-magnet|keycap|fidget-pixel> prototype create --image-url ./photo.png --name demo --async --output-schema v1
meshy creative-lab <product> build create --input-task-id <prototype-id> [--model-format …] [--options '<json>'] --async --output-schema v1
meshy creative-lab fidget-collapsible create --image-url ./photo.png --async --output-schema v1   # one stage → STL
meshy animation-catalog list --category DailyActions --search wave --output-schema v1   # free; search is server-side
meshy auto-split create --input-task-id <id> --mode by_parts --prompt "head, torso" --async --output-schema v1   # printable parts
meshy usage tasks --start-time 2026-08-01T00:00:00Z --output-schema v1                 # Studio/Enterprise; credits per task
meshy showcases list --search car --page-size 3 --output-schema v1                      # Enterprise only; EVERY request is billed
```

Prototype meanings differ: most yield a concept image, lamp also yields a
lampshade GLB, keycap yields `candidate_ids` (pass one as the build's
`--candidate-id`), fidget-pixel needs `--type person|other`; keychain takes
`--name-text` (≤10 characters, engraved). Build consumes a SUCCEEDED prototype
made through this API with the same key (web-app prototypes → 404). Lamp builds
output `lamp_stl`/`base_stl` or `bundle_zip`; keychain/fridge-magnet `obj` and
keycap `obj_zip` are ZIP bundles saved as `.zip`; fidget-pixel builds a 3MF.
Never call `showcases` in a health check.

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
- **`animate` takes a rigging task id**, not a model task id, plus exactly one
  of: an integer `--action-id` from the catalog, `--action-ids` (up to 10, one
  file with one clip each, billed per action) or a text-to-motion
  `--motion-task-id` (biped rigs).
- **`text-to-motion` produces a standalone skeletal clip**, not an animated
  character. Pass a 2–10 second duration in 0.5-second increments.
- **`repair-printability` drops textures and invalidates UVs.** Run it before
  texturing, or re-`retexture` afterwards.
- **A local `--model-url` must be `.glb`/`.gltf`** (multi-color-print: `.glb`)
  on every command: the API takes inline models as glTF only. Pass
  `.stl`/`.obj`/`.fbx` as an http(s) URL, or use `--input-task-id`.
- **`meshy delete <id>` never reaches Creative Lab tasks**; `meshy creative-lab
  <product> <stage> delete <id>` cancels one instead (`canceled: true`).
- **`uv-unwrap` takes one source** (`--input-task-id` or `--model-url`, GLB only).
- `multi-image-to-3d` takes 1-4 views of one object; use `image-to-3d` unless
  multi-view input was asked for. Both accept `--input-task-id` of a SUCCEEDED
  `text-to-image` / `image-to-image` task, so a generated image chains to 3D.
- `image-to-3d` defaults to an untextured draft mesh; `--should-texture true`
  (what `make` uses) produces a textured model in one task.
- **The default model is `latest` = Meshy 7.1** on all three generators.
  `--geometry-resolution 2k|4k` runs the Ultra geometry pass (+5 credits;
  text-to-3d: preview only; multi-image: `2k` only; not with smart-topology);
  `--ultra-mode` on image-to-3d is its deprecated spelling of `2k`.
  `--model-type smart-topology` (text-to-3d and image-to-3d) has a native
  `--target-polycount`: meshy-t2.5 is the CLI default, 100-30000 (default
  15000); `--ai-model meshy-t2` selects T2, 100-15000 (default 10000). `retexture`'s
  `--multiview-image-urls` needs Meshy 7 — it takes 1-4 views of **the same
  object**, not style references.
- Printing: `analyze-`/`repair-printability` take `--printer-type
  fdm|sla|full_color` and one `--intended-print-height-mm` /
  `--intended-print-longest-side-mm`; `multi-color-print` takes `--style
  realistic|cartoon` and `--printer-brand`. `text-to-image` / `image-to-image`
  take `--remove-background true` (transparent PNG).
- **A standalone refine defaults to 2k textures**: 4k/8k and `--remove-lighting`
  are refused for a meshy-6-lite preview, so pass `--texture-resolution 4k` only
  for a meshy-6 / meshy-7.1 / latest preview (`make` does).

## Finding an animation id

`--action-id` is an integer from Meshy's animation library. Ask the live
library (free): `meshy animation-catalog list --category Fighting --search kick
--output-schema v1` → `result.items[].action_id`; `--action-ids 92,4` checks
stored ids. Ids are not `1..N` (the catalog contains `-2`, `-1` and `0`) — never
guess one. This skill also bundles a
snapshot as `animation-library.json` (with hand-written descriptions the API does
not return; it can lag behind the live catalog).

Categories: WalkAndRun, BodyMovements, DailyActions, Fighting, Dancing.

## When something fails

Exit codes: `0` ok · `1` task FAILED/CANCELED while waiting, or unclassified ·
`2` usage · `3` auth · `4` validation · `5` not found · `6` rate limit ·
`7` network · `8` timed out (task keeps running) · `9` out of credits ·
`10` submission unknown (do not re-create) · `11` local I/O · `12` check failed ·
`13` check unknown · `14` conflict (delete of an IN_PROGRESS task) · `130` interrupted.

- Exit 9 → run `meshy balance`, relay the number, do not retry.
- Exit 6 → back off; the CLI does not retry for you.
- Exit 8 → `wait`/`stream` the same task id again; it was not cancelled. A
  429/5xx/timeout on a status request is already retried while waiting; the
  default `--timeout` is 600 s, the API advises waiting up to 60 min.
- Exit 14 → the task is running: it cannot be stopped and its credits are spent.
  `wait` for the result; delete it afterwards only if the user wants the result
  gone (permanent, no refund).
- Exit 130 after `-o` → the transfer (or the material rewrite) was cancelled;
  `result.downloads.files` lists what already landed (`status: written`), the rest can
  be fetched with `meshy download`. `downloads.failed_step` (`relink` | `digest` |
  `sidecar`) means every asset is on disk and only that step is missing.
- Legacy-schema errors (no `--output-schema v1`) after a create carry additive
  `task_id` / `operation_id` fields and a `hint` with the resume command — never re-create.
- `result.downloads.material_links.status: "incomplete"` → name the references that
  stayed unresolved or ambiguous (`texture_maps[].method`, `note`) instead of claiming the
  model loads; two material groups that would share one texture without evidence are
  deliberately left as written.
- `result.project.action: "failed"` (download `--project`, exit 11) → the assets are on
  disk (`result.downloads.files`); repair the project's `metadata.json`, then run
  `error.recovery.command` (`meshy project record …`, it already carries the original
  `--workspace` and `--operation-id`) verbatim — do not download or create again. The same
  command appears after a task verb's `--project` record failure (legacy: `hint`); when the
  error says the project is *no longer a target inside the authorised boundary* (it moved
  mid-request) there is deliberately no command and `recovery` is null — restore the
  directory first, then record with `meshy project record` from inside the original workspace.
- Exit 10 → reconcile with `<resource> list`; never submit the same create again blindly.
- A `FAILED` task → relay `result.task.task_error.message` verbatim; do not guess a cause.
- Any error may carry `error.recovery.command` — prefer it over improvising.

Legacy JSON output (without `--output-schema v1`) may carry `_notice.update` when
a newer meshy-cli exists; pass its `command` on to the user.

## Docs

Endpoint reference and pricing: https://docs.meshy.ai/en/api/
