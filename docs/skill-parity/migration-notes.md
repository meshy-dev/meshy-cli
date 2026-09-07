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
| `slicers.py open --file F --slicer S` | `meshy slicer open --slicer S --file F --output-schema v1` | no default-app fallback; detected path only |
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

New global flags: `--output-schema`, `--api-key-file`, `--workspace`, `--no-update-check`,
`--base-url-creative-lab`. New per-command flags on task verbs: `--save-json`,
`--include-raw`, `--project`, `--operation-id`, `--stop-after-first` (make),
`--idle-timeout` (stream).
