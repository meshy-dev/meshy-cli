---
name: meshy-cli
description: "Generate 3D models and 2D images with the Meshy API through the meshy-cli command — text-to-3D, image-to-3D, remesh, rigging, animation, retexture, printability. Use for any Meshy asset request."
license: MIT
compatibility: Requires meshy-cli on PATH and a stored credential or MESHY_API_KEY; network access to api.meshy.ai
metadata:
  version: "1.0.0"
  cli-help: "meshy --help"
---

# meshy-cli

## Setup

`npm i -g meshy-cli`, then `meshy auth login` (browser) or
`meshy auth login --with-key msy_...`. `MESHY_API_KEY` also works and wins over
a stored profile, which is what CI wants. Never echo the key back or write it
into a shell profile.

## One model, one command

```bash
meshy make "a red sports car" -o car.glb     # prompt → text-to-3d preview → refine
meshy make ./cat.png -o out/cat/             # image  → image-to-3d, textured
meshy make "a red sports car" --dry-run      # planned steps + estimate, no spend
meshy make "..." --max-credits 25            # refuse to start over budget
```

The input decides the chain and nothing else does. If step 2 fails, the error's
`hint` is the command that resumes from step 1's task — run it verbatim rather
than starting over, or the finished step is paid for twice.

## Everything else

`meshy resources` indexes the 16 endpoint commands; each carries the same verbs:

```bash
meshy <resource> create [flags] [--data '<json>'] [--async] [--timeout <s>]
meshy <resource> get|wait|delete <task-id>
meshy <resource> list [--page-size <n>]
```

`create` blocks until the task is terminal; `--async` returns the id instead.
`-o <path>` downloads artifacts (a directory for multi-file results) and writes
a `meta.json` sidecar; without `-o`, stdout is the task JSON — parse ids from
there, never from text shown in chat. `--data '<json>'` reaches any field the
CLI has no flag for, and `meshy api <METHOD> <PATH>` reaches any endpoint it has
no command for.

## Constraints that will bite

These are API rules, not preferences — ignoring them produces failed tasks:

- **`refine` only works on a `text-to-3d` preview** (it consumes that task's
  latents). Uploaded models, `image-to-3d` output and remeshed meshes are
  textured with `retexture` instead.
- **`rigging` needs a textured biped GLB** under 300k faces, with clear limbs —
  not props, quadrupeds or untextured drafts. Too dense? `remesh` first. A
  successful rigging task already bundles walking and running clips, so check
  its result before calling `animate`.
- **`animate` takes a rigging task id**, not a model task id, plus an integer
  `--action-id`.
- **`repair-printability` drops textures and invalidates UVs.** Run it before
  texturing, or re-`retexture` afterwards.
- **`multi-image-to-3d` is beta**; use `image-to-3d` unless multi-view input was
  explicitly asked for.
- `image-to-3d` defaults to an untextured draft mesh; `--should-texture true`
  (what `make` uses) produces a textured model in one task.

## Finding an animation id

`--action-id` is an integer from Meshy's animation library. Look it up from the
public catalog — no key required:

```bash
curl -s "https://api.meshy.ai/web/public/animations/resources" \
  | jq -r '.result.list[] | select(.category=="Fighting") | "\(.id)\t\(.name)"'
```

Categories: WalkAndRun, BodyMovements, DailyActions, Fighting, Dancing.
`?category=Fighting` narrows the response; other query parameters are ignored.

## When something fails

Exit codes: `0` ok · `2` usage · `3` auth · `4` validation · `5` not found ·
`6` rate limit · `7` network · `8` timed out · `9` out of credits.

- Exit 9 → run `meshy balance`, relay the number, do not retry.
- Exit 6 → back off; the CLI does not retry for you.
- A `FAILED` task → relay `task_error.message` verbatim; do not guess a cause.
- Any error payload may carry `hint` — a command to run. Prefer it over
  improvising.

JSON object output may also carry `_notice.update` when a newer meshy-cli
exists; pass its `command` on to the user.

## Docs

Endpoint reference and pricing: https://docs.meshy.ai/en/api/
