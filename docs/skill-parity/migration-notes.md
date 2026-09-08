# Skill-parity S1 — migration notes

Mapping from the legacy Python helpers bundled with the Meshy Skills
(`meshy_task.py`, `fix_obj.py`, `slicers.py` at `b9db44b`) to `meshy-cli`, plus every
intentional difference. S2 (Skill rewrite) must use `--output-schema v1 --format json`
explicitly in its examples.

## 1. Command mapping

| Legacy call | CLI equivalent | Notes |
| --- | --- | --- |
| `meshy_task.py check-env` | `meshy doctor [--api-key-file .env] [--check-api]` | Local by default; `--check-api` does one free balance call. No `.env` auto-scan (see 2.6). |
| `meshy_task.py balance` | `meshy balance --output-schema v1` | unchanged endpoint |
| `meshy_task.py create --endpoint E --payload J` | `meshy <resource> create --data '<json>' --async --output-schema v1` | one POST, no poll; `result.task.task_id` |
| `meshy_task.py poll --endpoint E --task-id ID [--project-dir D]` | `meshy <resource> wait ID --timeout 600 [--project D] --output-schema v1` | saves `task_<id>.json` into the project when `--project` is given |
| `meshy_task.py get --endpoint E --task-id ID [--save F]` | `meshy <resource> get ID [--save-json F] [--include-raw] --output-schema v1` | non-terminal status exits 0 |
| SSE curl/Python examples | `meshy <resource> stream ID --format ndjson --output-schema v1` | new |
| `meshy_task.py download --task-json F --format glb --output P` | `meshy download --task-json F --model-format glb --output P --output-schema v1` | selection is explicit |
| `meshy_task.py download --url U --output P` | `meshy download --url U --output P --output-schema v1` | no Authorization is sent to asset hosts |
| nested `result.basic_animations.walking_glb_url` via python | `meshy download --task-json F --asset result.basic_animations.walking_glb_url --output walking.glb` | stable asset keys |
| `meshy_task.py thumbnail --project-dir D --task-json F` | `meshy download --task-json F --kind thumbnail --output-dir D` | fails loudly instead of swallowing errors |
| `meshy_task.py project-dir --task-id ID --prompt P` | `meshy project init --root ./meshy_output --task-id ID --name P --output-schema v1` | folder slug + timestamp + random suffix |
| `meshy_task.py record --project-dir D --task-id ID --task-type T --stage S --files a,b` | `meshy project record --project D --task-id ID --resource T --stage S --file a --file b` | `--file` repeats; `(task_id, stage)` de-duplicates |
| — | `meshy project show / list / rebuild-index` | new; history is a rebuildable index |
| `meshy_task.py check-faces --endpoint E --task-id ID --max-faces N` | `meshy inspect faces --resource R --task-id ID --max-faces N` | `--max-faces` is required; missing face count = `unknown` (exit 13), never 0 |
| `fix_obj.py model.obj --height-mm 75` | `meshy mesh prepare-print model.obj --height-mm 75 [--output F | --in-place]` | default writes `model.print.obj`, no in-place overwrite unless asked |
| `slicers.py detect` | `meshy slicer detect --output-schema v1` | same seven slicers + `multicolor` |
| `slicers.py open --file F --slicer S` | `meshy slicer open --slicer S --file F --output-schema v1` | no default-app fallback; detected path only; `launch_requested` is not proof of import |
| curl `/web/public/animations/resources?category=C` + python filter | `meshy animation-catalog list --category C --search wave` | no key, no Authorization; search is local |
| curl `/openapi/v1/showcases?...` | `meshy showcases list --search car --page-size 3 --model-format glb` | billable GET, single request, no retry |
| curl `/openapi/v1/uv-unwrap` | `meshy uv-unwrap create --input-task-id ID` or `--model-url m.glb` | exactly one source |
| curl `/openapi/creative-lab/{product}/v1/prototype` | `meshy creative-lab <product> prototype create --image-url photo.png [--name N] [--remove-background] [--image-subject …]` | per-product schema |
| curl `/openapi/creative-lab/{product}/v1/build` | `meshy creative-lab <product> build create --input-task-id ID [--options '<json>'] [--model-format …]` | per-product options |

## 2. Intentional differences

Each difference names the legacy behaviour, the CLI behaviour, and the evidence.

### 2.1 Missing `face_count` is `unknown`, not 0
- Legacy: `task.get("face_count", 0)` then `0 > max` → prints a passing line.
- CLI: `verdict: unknown`, exit 13, `reason: face_count missing`. Evidence: public task
  DTO has no `face_count` (meshyd `httpapi/dto.go`, read-only 2026-09-07); Rigging docs
  only describe the server-side 300k gate.

### 2.2 OBJ transform never overwrites by default
- Legacy `fix_obj.py`: default `output_path = input_path`; degenerate height silently
  used scale 1.0; NaN passed through.
- CLI: default sibling `<stem>.print.obj`; `--in-place` opt-in; NaN/Infinity, empty or
  degenerate (height ≤ 1e-6) input is a validation error and no file is written.
  Numbers follow the same rotation/scale/translation formulas (fixture oracle
  `box-height-80.expected.json`).

### 2.3 Slicer launch uses the detected executable
- Legacy Windows path looked up the exe on PATH and fell back to `os.startfile`
  (default application); Linux fell back to `xdg-open`.
- CLI: launches only registered slicers at their detected path; missing slicer or
  file is an explicit error (exit 11 / 5), no default-application fallback.

### 2.4 Downloads are selective
- Legacy `download --format` defaulted to `glb`; thumbnails were swallowed on error.
- CLI `download` requires a selector (`--asset`, `--model-format`, `--kind`, `--all`)
  when more than one asset exists and reports every failure. The legacy `-o` on task
  commands keeps downloading everything for compatibility.

### 2.5 Keychain / fridge-magnet OBJ output is a ZIP
- Legacy docs generalised "textured GLB / OBJ+MTL" for every build.
- CLI records `model_format: obj, container_format: zip, extracted: false` and saves the
  file as `.zip`; lamp parts `lamp_stl`/`base_stl`/`bundle_zip` are saved as `.stl` /
  `.zip`. Evidence: official lamp/keychain/fridge-magnet pages and meshyd artifact keys.

### 2.6 No implicit `.env` discovery
- Legacy: read `.env` / `.env.local` from cwd automatically.
- CLI: `--api-key-file <path>` must be explicit; `doctor` may report that a candidate
  file exists in cwd but never reads it. Priority: `--api-key` > `MESHY_API_KEY` >
  `--api-key-file` > stored profile. A named file that is missing, malformed or
  key-less is an error, never a fall-through to another account. Empty/placeholder
  `--api-key` and `MESHY_API_KEY` still mean "unset" (0.2.0 behaviour).
- The flag is not called `--env-file` because Node.js itself intercepts that name
  anywhere in argv (loads the whole file into the environment, exits 9 when missing);
  see decisions D-025. Passing `--env-file` to the CLI yields a usage error.

### 2.7 `showcase_type` spelling
- Docs/Skill: `animated`. Server enum: `animate`. CLI accepts both, sends `animate`, and
  warns (`showcase_type_alias`). Needs live confirmation (not_run).

### 2.8 Lamp `text` prototype input is rejected
- The server struct still carries a deprecated `text` field; the CLI rejects `text` in
  `--data` for lamp prototypes before submission and points to `--image-url`.

### 2.9 Rigging `list`
- CLI 0.2.0 said "Meshy does not expose a list endpoint for rigging". Official docs and
  the server route table do; `meshy rigging list` now works. (Difference from 0.2.0,
  not from the Skills.)

### 2.10 Data URIs
- CLI 0.2.0 rejected `data:` URIs on typed media flags while accepting them inside
  `--data`. S1 accepts well-formed `data:` URIs on both paths with the same size/format
  checks (Skill examples build data URIs in Python).

### 2.11 No automatic retries
- Legacy troubleshooting suggested auto-retrying 429/5xx creates. The CLI never
  re-sends a billable POST or the billable showcases GET; retries are the caller's
  decision with the recorded task/operation id.

### 2.12 Webhooks stay documentation
- No webhook management endpoint exists in the frozen baseline; the CLI adds no daemon.

## 3. Compatibility notes for existing CLI users (legacy schema)

| Behaviour | 0.2.0 | S1 | Why |
| --- | --- | --- | --- |
| `get` of PENDING/IN_PROGRESS task | exit 1 | exit 0 | a successful query is not a failure |
| `make --async` | POST + poll step 1, then stop | POST only, return `pending_steps` | contract; old behaviour is `--stop-after-first` |
| Commander parse errors | exit 1 | exit 2 | README already documented `2 usage` |
| `rigging list` | usage error | works | see 2.9 |
| everything else (flags, payload defaults, `-o` download layout, `meta.json`, auth) | unchanged | unchanged | legacy output preserved; v1 is opt-in |

### 3.1 Corrections from Codex review round 1 (visible in both schemas)

| Behaviour | before the fix | after | Finding |
| --- | --- | --- | --- |
| `create`/`make -o <existing file>` or `--save-json <existing file>` | refused after the task ran (exit 2 / 11) | refused **before** the POST, exit 11, "nothing was submitted" | F01 |
| failure after the server accepted a task (save, poll 5xx, download, record) | `result: null` / bare API error | same exit code, `result.task_id` + `submission` + `next` kept | F01, F02 |
| `wait`: reply arriving after `--timeout` | reported as in-time success; one extra GET possible | exit 8 (`timed_out`), no GET after the deadline | F07 |
| `--workspace` on `-o` (task verbs, `make`), `project`, `--project` | not enforced | exit 11 before any write | F03 |
| `mesh prepare-print` material copy through a symlinked `materials/` | written outside | exit 11, nothing written | F04 |
| `--operation-id` with another API key / account or another image of equal size | replayed the old task | `operation_conflict` (exit 2), no request | F05, F06 |
| Creative Lab `--data.options` + `--options` | `--options` replaced the object | merged field by field | F08 |
| downloaded OBJ/MTL references | pointed at server-side names | rewritten to the saved names, reported | F09 |
| `stream --format ndjson -o` | assets not downloaded | downloaded; `outcome` carries the manifest | F10 |

### 3.2 Corrections from Codex review round 2 (visible in both schemas)

| Behaviour | before the fix | after | Finding |
| --- | --- | --- | --- |
| report-only task `-o` outside `--workspace` | file written | exit 11, no directory created | R2-F01 |
| `--workspace` = project dir, implicit history root | `history.json` written in the parent | metadata recorded, `index.updated=false` with the reason, parent untouched | R2-F01 |
| refused `download` target | directory created before the refusal | nothing created | R2-F01 |
| OBJ with several material groups | every same-channel map → first texture | mapped by the server-side file name; ambiguous maps kept as written + `material_reference_ambiguous`, `material_links.status=incomplete` | R2-F02 |
| `stream` + `--save-json`/`--project` failure | bare error envelope after the task events | one `outcome` line (sequence continues) / one envelope | R2-F03 |
| task `-o` fails on the 2nd asset | `downloads.files: []`, `local_io` | `downloads.state=partial` with a per-file manifest; HTTP class and status kept (legacy error payload gains `code`/`status`/`result.downloads`) | R2-F04 |
| Ctrl-C during a task `-o` transfer | download completes, exit 0 | exit 130 `interrupted`, manifest of what landed, temp file removed | R2-F05 |
| OAuth profile without `user_id` and the same `--operation-id` | replayed the other login's task | `login_id` minted at login binds the journal; profiles with neither are refused a replay (exit 2, `credential_unverified`) until `meshy auth login` | R2-F06 |

### 3.3 Corrections from Codex review round 3 (visible in both schemas)

| Behaviour | before the fix | after | Finding |
| --- | --- | --- | --- |
| a file/symlink/directory appears at `meta.json` (or `<stem>_meta.json`) during the transfer | followed or truncated, even outside `--workspace` | refused at publication (`local_io`), model kept in the manifest, nothing outside touched | R3-F01 |
| legacy-schema `-o` failure after a `create`/`wait`/`get`/`stream`/`make` | payload without the task | additive `task_id`/`operation_id` fields, `result.submission`/`next`/manifest, hint names the task on stderr | R3-F02 |
| MTL reference equal to a generated texture name that belongs to another source | rewritten to the wrong image, `complete` | mapped by the server-side name; a generated-name reference with a different source is `ambiguous` (kept, warned, `incomplete`) | R3-F03 |
| relink/digest/sidecar failure after every asset landed | `downloads.files: []` | `downloads.state=partial`, full manifest with on-disk digests, `failed_step` | R3-F04 |
| Ctrl-C during the OBJ/MTL rewrite | download completes, exit 0 | exit 130 `interrupted`, committed files kept, no sidecar, no temp file | R3-F05 |
| `download --project` through an alias path | files not recorded, false `files_outside_project` | files recorded relative to the real project directory | R3-F06 |

### 3.4 Corrections from Codex review round 4 (visible in both schemas)

| Behaviour | before the fix | after | Finding |
| --- | --- | --- | --- |
| MTL whose different references reach the sole texture only through channel fallbacks (name channel for one, key channel for the other) | both rewritten to the one texture, `material_links.status=complete` | both kept as written, `method: ambiguous` with one shared `note`, `status=incomplete`, one `material_reference_ambiguous` warning; identity matches (source name) keep their texture | R4-F01 |
| `download --project` when the project record fails after the transfer (metadata.json replaced by a symlink, damaged, unwritable directory, lock) | exit 11 with `result: null` | exit 11 (same class), full `result` incl. `downloads` manifest and `saved_json`, `project.action="failed"` with `error`, `error.recovery.action="record_project"` and `hint` = the `meshy project record …` command; assets kept, nothing re-downloaded or re-submitted | R4-F02 |
| `download --project` with a metadata.json that is a symlink or not valid JSON, or a blank `--stage` | detected after the transfer | refused before any request ("nothing was downloaded") | R4-F02 |
| task verbs `--project` record failure | `local_io` without a recovery | same class, plus `recovery.action="record_project"` and the record command as hint | R4-F02 |

### 3.5 Corrections from Codex review round 5 (visible in both schemas)

| Behaviour | before the fix | after | Finding |
| --- | --- | --- | --- |
| `record_project` recovery command after `--project P --workspace P` | no `--workspace`; replayed, it refreshed the parent's history.json and locked outside the boundary | carries `--workspace <resolved path>` (shell-quoted); replayed verbatim it records metadata, skips the parent index with `index_dirty`, writes nothing outside; no workspace → nothing appended | R5-F01 |
| MTL reference used under two keys where one key hits a texture and the other is ambiguous (`map_Kd shared.png` + `map_Bump shared.png`, one base color, two normals) | the hit line rewritten, the other left | neither line rewritten; both `ambiguous` with their own candidates and one cross-key note ("one reference names one file") | R5-F02 |
| task verbs `--project` when metadata.json disappears (or the project leaves the workspace) after the preflight | `local_io`, `recovery: null`, hint = `wait` | missing/damaged/locked → `record_project` command with `--operation-id` and `--workspace` (hint too); project outside the workspace → explicit boundary message, task and journal named, no command | R5-F03 |
| `download --project` when metadata.json disappears during the transfer | `not_found` (exit 5) from the record step | `local_io` (exit 11) with the full result and the record_project recovery | R5-F03 |

### 3.6 Corrections from Codex review round 6 (visible in both schemas)

| Behaviour | before the fix | after | Finding |
| --- | --- | --- | --- |
| `--workspace W` directory (or the alias it was given through) replaced by a symlink to an outside tree while a request is in flight; task verbs with `--project` | root re-resolved at check time → snapshot/metadata/history written outside, exit 0 | boundary frozen with the flags (real path + directory identity); exit 11 `local_io`, task/journal kept, single POST, nothing written outside, `recovery: null`, no record command | R6-F02 |
| `download --project P --workspace W --output-dir W/assets` with P or its parent replaced by a symlink to an outside project during the transfer | outside metadata.json rewritten, exit 0 with `files_outside_project` | exit 11 `local_io`, completed manifest kept, `project.action="failed"` with the reason, `recovery: null`, outside tree untouched | R6-F01 |
| `get`/`wait`/`stream` with `--project` that is not an initialised project | refused after the request | refused before any request | R6-F02 (D-057) |

New global flags: `--output-schema`, `--api-key-file`, `--workspace`, `--no-update-check`,
`--base-url-creative-lab`. New per-command flags on task verbs: `--save-json`,
`--include-raw`, `--project`, `--stage`, `--operation-id`, `--stop-after-first` (make),
`--idle-timeout` (stream). New commands: `uv-unwrap`, `creative-lab`, `animation-catalog`,
`showcases`, `download`, `project`, `inspect`, `mesh`, `slicer`, `doctor`.
