# meshy-cli for scripts and agents

The rule: **a terminal gets a readable view, everything else gets JSON.** An
untyped `--format` resolves to `pretty` when stdout is a TTY and to `json`
otherwise, so a pipe, a redirect, `$(...)`, CI and every agent subprocess read
JSON without asking. Say it anyway — `--format json` — and
the shape is yours however you are spawned. Progress and prose go to stderr;
stdout is only the result. Never parse `pretty`: it is a view that drops fields.

## Stable machine output: the envelope

Every command prints one envelope with six fixed keys on stdout, in `json` or
`ndjson` — there is no other data model. Add `--format pretty` to see the
human view instead:

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

## Create, wait, stream and money

- `create` sends **exactly one POST**, journaled locally before it leaves
  (`~/.config/meshy/operations/<operation-id>.json`, no key material). A lost
  response, a 5xx or a malformed success is `submission_unknown` (exit 10): the
  server may have created the task, so the CLI never retries and never suggests
  re-running the create. Reconcile with `list`, then record what it showed:
  `meshy operations resolve <operation-id> --task-id <id>` when the task is
  there (a replay of that `--operation-id` then returns it), or
  `--not-created` when it is not (the record moves to `operations/resolved/`
  and the same `--operation-id` submits again). A record still at `started`
  means the process was killed mid-request; resolve it the same way.
  `meshy operations list [--state …]` and `show <id>` read the journal. SIGINT,
  SIGTERM and SIGHUP all stop the command cooperatively (exit 130), so the
  journal records what is known; only a hard kill leaves `started`. After a
  SIGTERM or SIGHUP the process exits within 3 s even when the command cannot
  stop sooner (e.g. `auth login` waiting for the browser).
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
  spent. Between ticks it sleeps the server's `Retry-After` when one is sent;
  a status request that fails with a `429`, a `5xx`, a read timeout or a
  dropped connection is retried at the next tick (`result.wait.failed_polls`,
  `last_poll_error` and a `poll_retried` warning say so), while a `401`/`404`
  or a malformed task ends the wait at once. `stream` follows Server-Sent Events with `--timeout` (total) and
  `--idle-timeout` (silence, keep-alives reset it); `-o` downloads the assets
  in every output format, and in `ndjson` the final `outcome` line carries the
  download manifest.
- `-o` on `get`/`wait`/`stream`/`make` saves the primary files of a SUCCEEDED
  task: the model formats it produced, the primary thumbnail, images and
  reports, and the rig or animation result in GLB. `result.downloads.files` is a
  per-file manifest (stable `key` as `meshy download --asset` takes it, real
  `path`, bytes, sha256, status). `result.downloads.skipped` lists
  `{key, reason}` for what stayed on the server: `embedded_textures`,
  `bundled_animation`, `alternate_format`, `pre_remesh_variant`,
  `extra_thumbnail`, and `not_selected` for a file path. `--all-assets` saves everything, but needs a
  directory. A file path (`-o car.glb`) writes the one asset of that format.
  Between pipeline steps, pass the task id (`--input-task-id`, `--rig-task-id`)
  instead of downloading. When the second asset fails, the state is `partial`, the files
  already written stay listed and on disk, and the error keeps the asset host's
  class and HTTP status (a 503 is `network`, exit 7, not a local I/O error). The
  same holds for a failure *after* the transfers — relinking, digesting or
  publishing the `meta.json` sidecar: `downloads.failed_step` names the step, the
  manifest carries the digests actually on disk. The sidecar itself is published
  like an asset (exclusive, no symlink, inside the root), so a file that appears
  at its path during the download is never overwritten.
- Ctrl-C stops waiting, streaming or downloading (exit 130) and sends no DELETE;
  the envelope carries the task id, the command that resumes and the files that
  had already landed. An interrupted transfer leaves no temp file behind.

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
| 14 | conflict (`409`: `delete` of an IN_PROGRESS task — it cannot be stopped and its credits are spent; deleting it after it finishes is permanent, with no refund) |
| 130 | interrupted (Ctrl-C); nothing was deleted server-side |

## Agent skill

The agent-facing skill ships in this package at
[`skills/meshy-cli`](../skills/meshy-cli/SKILL.md). It is deliberately short: a
skill is loaded into an agent's context on every invocation, so length is a
running cost, and anything an agent can look up on demand (`meshy resources`,
`meshy <resource> --help`, <https://docs.meshy.ai/en/api/>) is linked rather
than copied. The Claude Code / Cursor plugin and ClawHub distribution is
[meshy-3d-agent](https://github.com/meshy-dev/meshy-3d-agent).
