# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. **第 8 轮 Codex 结论（2026-09-08）：accepted** — L01/L02 关闭，前七轮 32 项 finding 在 `1d9f109` 未回退，G1-code 继续接受；证据 `…/reviews/cli-s1-1d9f109/`（0 findings）。随后所有者授权：分支经 PR 合并、通过 `release.yml` 发布 0.3.0，Windows x64 本次不验证；发布结果在发布后的 docs commit 中记录。本文件为 **Round 8**：第 7 轮 Codex review 已 **accepted**（G1-code，代码 `e567646`，docs `4da216d`，证据 `…/reviews/cli-s1-e567646/`）；本轮是 **真实账号 live verification** 及其发现的 2 个缺陷的修复，交给 Codex 复审这两个修复并核对 live 证据。七处 reviewer 证据目录均未被改动；第 7 轮的 15 个脚本副本在新 HEAD 上重跑。

## 0. Live verification 结论与本轮修复

- 执行方式：账号所有者在自己的终端完成 `meshy auth login --with-key`（profile `default`，API key）与 `meshy auth login`（profile `oauth`，浏览器 PKCE），凭据落在默认的 `~/.config/meshy/credentials.json`；CLI 通过 `npm install -g ~/Downloads/meshy-cli-0.3.0.tgz` 全局安装（与真实用户一致，每次修复后重新安装）；工作目录 `<home>/meshy-live`；所有者授权计费且不设上限。凭据从未经过 agent；记录中凭据一律脱敏（`auth status` 自带遮蔽；`credentials.json` 只读取键名与哈希）。
- 结果：**T-104 passed**（两种凭据、真实 token 端点无 `user_id` → login_id 身份、静默 refresh 观测到期后 expires_at 前移且 login_id 不变、journal 复用/凭据冲突/媒体指纹冲突真实复现）；**T-110 passed**；**T-111 passed**（UV / 全部 Creative Lab 产品 / showcases 为 403 enterprise-only 记录）；**T-112 passed**（真实 Bambu Studio 02.08.02.61 两次拉起）；**T-109 partial**（macOS arm64 + Linux arm64/x64 通过，Windows x64 not_run）。
- credits：开始 2806 → 结束 2479，共消耗 **327**（每步见 §4 表）。
- 发现并修复 2 个真实缺陷（commit `1d9f109`，`tests/live-verification.test.ts`，修复后重新安装并在真实任务上复验）：

| ID | 严重度 | 现象（真实账号） | 修复 | 决策 | 复验 |
| --- | --- | --- | --- | --- | --- |
| L01 | P1（Creative Lab 全流程阻断） | Creative Lab 端点在 IN_PROGRESS 时返回 `finished_at: null`（v2 端点返回 0）；schema 只接受 number → `creative-lab … get/wait` 每次轮询都以 "unexpected task shape"（`error.code=server`，HTTP 200，exit 1）失败，`wait` 永远轮询不到完成 | `progress/preceding_tasks/created_at/started_at/finished_at/expires_at` 接受 null 与缺省并归一为 0；v1 视图仍以 `null` 表示未发生 | D-059 | 真实捕获体作为 fixture；keychain prototype 创建后立即 `wait` 经 3 次 IN_PROGRESS 到 SUCCEEDED；lamp prototype get/wait 与 lamp build 完成 |
| L02 | P2（输出文件名错误） | 任务动词的 `-o`（legacy 布局）把 `model_urls` 键当扩展名：lamp build 落盘为 `model.lamp_stl`/`model.base_stl`；keychain 的 OBJ 实为 ZIP bundle 却存成 `model.obj` | legacy 枚举复用 artifacts.ts 的产品感知 `modelAsset` 映射得到文件名与格式（`lamp.stl`、`base.stl`、`bundle.zip`、`model.obj.zip`），slot key 与 relink 规则不变 | D-060 | 同一任务重新 `-o`：`lamp.stl`/`base.stl`（字节与误名文件一致）、`model.obj.zip`；fridge-magnet build 亦按映射命名 |

- 未修复的观察（P3，供 Codex 判断是否立项）：见 §6。
- 回归：`pnpm test` **558/558**；typecheck 通过；`git diff --check` 在 `fd94490..HEAD`、`4da216d..HEAD`、工作树均 exit 0；poll ×12 12/12、round1 ×8 8/8、round2–6 ×3 3/3；第 7 轮 15 个 reviewer 脚本副本在 `1d9f109` 上：round1–6 探针 0 复现（C03/D03 signal_sent=true exit 130），verify 20/20、8/8、24/24、5/5，矩阵 16/16、10/10、20/20，context 5/5，stream 通过；tarball smoke 29/29（sha256 `0d22647fd0568a7c6b44aba80ceb32a5de74781b6697d44986745ee78ddf9c8e`）。

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli` / `https://github.com/meshy-dev/meshy-cli.git`；分支 `feat/skill-parity-s1`（本地，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`
- 上一轮（accepted）代码 HEAD：`e567646d875e5f5a658b78e60b8cdfaed8b233e9`；docs HEAD：`4da216d3568fbd997bf85f8047ce3932672a25de`
- 本轮代码 HEAD：`1d9f10976b5f754502c81591c64c712e492188d1`（= live 修复 commit）；本文件与 verification.json / capability-matrix.json / live-verification.json 在其后的 **docs-only commit** 中
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- Node / pnpm / OS：Node v24.20.0 / pnpm 11.24.0 / macOS 26.6.2 arm64
- PR / 发布：所有者 2026-09-08 授权后，本 commit 之后推送分支并创建 PR 合入 `main`；发布经 `.github/workflows/release.yml`（workflow_dispatch，main）执行，不做本地 `npm publish`；结果见发布后的 docs commit

## 2. 完成状态

- G1-code：第 7 轮 accepted；第 8 轮 accepted（本轮 2 个 live 修复 L01/L02 已关闭，范围小：`src/client/types.ts` 6 个字段的 null 容忍；`src/internal/download.ts`+`artifacts.ts` 的文件名映射共享）。
- G1-release：**passed（2026-09-08）**。PR #5 以 merge commit `1d7ff01` 合入 `main`，tag `v0.3.0`（`1d7ff01`），`release.yml` 发布 `meshy-cli@0.3.0`（shasum `e852b682ee74fb82fe201c78e0445556856d6b0b`）与 `@meshy-ai/cli@0.3.0`，并以真实用户方式 `npm install -g meshy-cli@0.3.0` 复验。原状态记录：**尚未满足（发布进行中）**。已完成：Codex review（第 7、8 轮 accepted）、真实账号/UV/Creative Lab/showcases/切片器/macOS+Linux 验证、所有者发布授权（2026-09-08）；未完成：正式发布与可追溯记录（PR 合并后经 release.yml 发布 0.3.0，随后记录）；Windows x64 由所有者决定本次不验证，保持 not_run。
- mandatory 能力 35/35 已实现；`capability-matrix.json` 每项新增 `live_verification`（33 项 live passed / passed_after_live_fixes，CAP-014 showcases 为账号门控 403 记录，CAP-034 打包为 partial（Windows not_run））。
- 离线测试：`pnpm test` 558/558，0 跳过。

## 3. 本次具体改动

```
1d9f109 fix(live): parse Creative Lab null timestamps; name Creative Lab parts and bundles in the legacy -o layout
4da216d docs(skill-parity): round-7 handoff after Codex review round 6 fixes
e567646 fix(review): address Codex review round 6 findings R6-F01, R6-F02 and test gap R6-T01
166492b docs(skill-parity): round-6 handoff after Codex review round 5 fixes
7b7c24c fix(review): address Codex review round 5 findings R5-F01–R5-F03
e7c0bbc docs(skill-parity): round-5 handoff after Codex review round 4 fixes
68690f9 test(wait): allow the deadline wake-up's one extra GET that D-044 permits
93e55bc fix(review): address Codex review round 4 findings R4-F01, R4-F02 and test gap R4-T01
9e43a77 docs(skill-parity): round-4 handoff after Codex review round 3 fixes
235d6de test(poll): judge the real-timer smoke with the loop's own clock reading
30536d8 fix(review): address Codex review round 3 findings R3-F01–R3-F06
566f3bd docs(skill-parity): round-3 handoff after Codex review round 2 fixes
cf8905d fix(review): address Codex review round 2 findings R2-F01–R2-F07
730132b docs(skill-parity): round-2 handoff after Codex review round 1 fixes
0388fe8 fix(review): address Codex review round 1 findings F01–F10
6273d9a docs(skill-parity): verification record and review handoff for the 0.3.0 candidate
e7c26fc chore(release): 0.3.0 candidate — README, bundled skill, env example, origin-policy test
da7e1dc feat(local): B06-B08 inspect faces, OBJ prepare-print, slicers and doctor
96ee188 feat(project): B05 meshy_output project store, project command and --project bookkeeping
3935f35 feat(download): B04 asset enumeration, selective download and safe file placement
6784309 feat(tasks): B03 task lifecycle — v1 verbs, journaled single POST, SSE stream, make async, uv-unwrap, creative-lab
f05ff87 feat(client): B02 transport, resource registry, catalog and showcases
e7ea577 feat(cli): B01 v1 envelope, exit codes, local runtime, --api-key-file and unified error exit
c75588e docs(skill-parity): B00 baseline, endpoint contracts, decisions and fixtures
```

```
1d9f109 fix(live): parse Creative Lab null timestamps; name Creative Lab parts and bundles in the legacy -o layout

 docs/skill-parity/decisions.md                     |  37 ++++++
 docs/skill-parity/migration-notes.md               |   7 ++
 src/client/types.ts                                |  24 ++--
 src/internal/artifacts.ts                          |   8 +-
 src/internal/download.ts                           |  14 ++-
 .../creative-lab-lamp-prototype.in-progress.json   |  17 +++
 tests/live-verification.test.ts                    | 128 +++++++++++++++++++++
 7 files changed, 225 insertions(+), 10 deletions(-)
```

- `src/client/types.ts`：`nullableNumberOr0`（null/缺省 → 0）用于 6 个时间戳/计数字段。
- `src/internal/artifacts.ts`：导出 `modelAsset`；`src/internal/download.ts`：legacy `enumerateArtifacts` 用产品感知映射得到 `filename`/`preferredExt`，`deriveFilename` 优先使用它。
- `tests/live-verification.test.ts`：L01（fixture 解析 + get/wait 轮询）、L02（lamp/keychain build `-o` 命名）；fixture `tests/fixtures/skill-parity/creative-lab-lamp-prototype.in-progress.json`（真实捕获体，id/name 已替换）。
- 文档：D-059、D-060；migration-notes §3.7；`docs/skill-parity/live-verification.json`（脱敏 live 记录：49 步 + Linux 双架构）。

## 4. Live verification 逐步记录（脱敏；完整字段见 `docs/skill-parity/live-verification.json`）

| 步骤 | 凭据 | 内容 | credits |
| --- | --- | --- | --- |
| T104-01 | oauth | auth status (OAuth active) — masked credential, verified balance |  |
| T104-02 | oauth | auth list — two profiles (api_key default, oauth) |  |
| T104-03 | oauth | credentials.json shape: oauth profile has access/refresh tokens and login_id, no user_id (the real token endpoint did not return one) |  |
| T104-04 | oauth | silent refresh observed: expires_at advanced, login_id kept, tokens rotated; refreshed token works |  |
| T104-05 | api_key | journal replay with the same key: operation_replayed, no new task, balance unchanged |  |
| T104-06 | oauth | same operation id under the OAuth profile → operation_conflict (credential), exit 2, nothing submitted |  |
| T104-07 | api_key | same operation id with a different image → operation_conflict (payload); same bytes under another file name → replayed |  |
| T104-08 | oauth | OAuth bearer on v2 get and v1 asset download — same bytes as the API-key download |  |
| T110-01 | api_key | project init (real workspace ~/meshy-live) |  |
| T110-02 | api_key | text-to-3d create --mode preview --async --project --save-json | 20 |
| T110-03 | api_key | stream (ndjson) on the finished preview: task + outcome, sequence contiguous |  |
| T110-04 | api_key | wait -o preview into the project (model.glb + thumbnail, meta.json, snapshot merged) |  |
| T110-05 | api_key | download --list on the preview |  |
| T110-06 | api_key | text-to-3d create --mode refine (glb,obj,fbx) --async | 10 |
| T110-07 | api_key | stream (ndjson) during the refine: 30 progress events + 1 outcome, contiguous sequence |  |
| T110-08 | api_key | wait -o refine: 9 files incl. OBJ+MTL+4 textures; real MTL map_Kd texture_0.png → texture_0_base_color.png by source_name; material_links complete |  |
| T110-09 | api_key | download --model-format obj (selective, dependencies) — material_links complete |  |
| T110-10 | api_key | download --asset thumbnail.primary --output file |  |
| T110-11 | api_key | image-to-3d create from a local synthetic PNG (data URI) — server-side FAILED, 0 credits, task_failed relayed, FAILED recorded in the project | 0 |
| T110-12 | api_key | download --list / get on the FAILED task (not_ready + task_not_ready warning; task_error relayed) |  |
| T110-13 | api_key | image-to-3d retry with the real refine thumbnail: SUCCEEDED, OBJ/MTL relinked | 30 |
| T110-14 | api_key | text-to-3d list --page-size 3 |  |
| T110-15 | oauth | image-to-3d delete (the FAILED task) then get → not_found 404 exit 5 |  |
| T111-01 | api_key | showcases list → 403 enterprise-only (account-gated): error.code server, http 403, exit 1 |  |
| T111-02 | api_key | animation-catalog list (public, free) |  |
| T111-03 | api_key | uv-unwrap on the 1.9M-face refine → API 400 (44k limit) mapped to validation exit 4; on the remeshed model SUCCEEDED | 5 |
| T111-04 | api_key | remesh (8000 faces, glb,obj) SUCCEEDED; OBJ set relinked | 5 |
| T111-05 | api_key | retexture (text style prompt, PBR) SUCCEEDED | 10 |
| T111-06 | api_key | analyze-printability SUCCEEDED (0 credits): report-only, meta.json written, status warning (degenerate faces) | 0 |
| T111-07 | api_key | rigging on the teapot → API 400 (face limit) then 422 (pose estimation failed) → validation exit 4 |  |
| T111-08 | api_key | text-to-motion: CLI requires --duration (2–10 s); with --duration 4 SUCCEEDED, motion.fbx | 10 |
| T111-09 | api_key | humanoid text-to-3d preview for the rig chain | 20 |
| T111-10 | oauth | remesh the humanoid to 30k faces (rigging refused 1.95M faces with 400) | 5 |
| T111-11 | oauth | rigging SUCCEEDED: rigged glb/fbx + walking/running clips (8 files) | 5 |
| T111-12 | oauth | animate create --action-id 28 (Big Wave Hello) on the rig: stream 10 events + outcome; wait -o glb+fbx | 3 |
| T111-13 | oauth | make 'a low-poly cactus…' -o: preview → refine, two journal records, downloads | 30 |
| T111-14 | oauth | creative-lab lamp prototype create; get/wait on the IN_PROGRESS task FAILED with 'unexpected task shape' (finished_at: null) → live finding L01 | 30 |
| T111-15 | oauth | after the L01 fix (reinstalled CLI): lamp prototype get/wait SUCCEEDED (lampshade glb + concept image) |  |
| T111-16 | oauth | keychain prototype create + immediate wait polled through 3 IN_PROGRESS states to SUCCEEDED (L01 verified live) | 6 |
| T111-17 | oauth | lamp build SUCCEEDED — legacy -o named the parts model.lamp_stl/model.base_stl → live finding L02 | 6 |
| T111-18 | oauth | meshy download --list/--all on the lamp build names lamp.stl / base.stl (selective path was right) |  |
| T111-19 | oauth | keychain builds: default (glb) and --model-format obj (ZIP bundle); legacy -o saved the bundle as model.obj → L02; selective path: model.obj.zip | 60 |
| T111-20 | oauth | after the L02 fix (reinstalled CLI): -o on the same builds → lamp.stl/base.stl (byte-identical) and model.obj.zip |  |
| T111-21 | oauth | figure prototype SUCCEEDED; first figure build FAILED server-side (0 credits, task_failed relayed); retry SUCCEEDED with OBJ/MTL relinked | 36 |
| T111-22 | oauth | fridge-magnet prototype + build (exposed product) SUCCEEDED with the fixed CLI: bundle named by the shared mapping | 36 |
| T112-01 | none | slicer detect finds Bambu Studio 02.08.02.61; slicer open on a prepared print OBJ launches it (macOS open -a, pid observed) |  |
| T112-02 | none | mesh prepare-print on the real remeshed OBJ (60 mm) → print OBJ + copied MTL/texture; slicer open again on that file |  |
| LOCAL-01 | none | project show/list on the real project: 11+ task entries with snapshots and operation ids; history index clean |  |
| LOCAL-02 | none | inspect faces on real task snapshots → check_unknown (13): the API task JSON carries no face_count |  |

Linux（OrbStack，`node:24-bookworm`）：linux/arm64 Debian GNU/Linux 12 (bookworm) node v24.20.0 → 29/29，sharp 0.35.4 (libvips 8.18.6); linux/x64 Debian GNU/Linux 12 (bookworm) node v24.20.0 → 29/29，sharp 0.35.4 (libvips 8.18.6)。

### 4.1 关键实际输出（脱敏）

L01 修复前（lamp prototype `wait`，IN_PROGRESS）：

```json
{
  "ok": false,
  "error.code": "server",
  "error.http_status": 200,
  "message_head": "unexpected task shape from GET /lamp/v1/prototype/01a07f79-e9f7-7347-89c7-c46fb7a11d06: [\n  {\n    \"expected\": \"number\",\n"
}
```

L01 修复后（keychain prototype 创建后立即 `wait`）：

```json
{
  "ok": true,
  "result.task.status": "SUCCEEDED",
  "result.task.consumed_credits": 6,
  "result.wait.polls": 4,
  "files": [
    {
      "key": "image_0",
      "bytes": 477978,
      "status": "written",
      "sha256_12": "e4eab2f32244"
    }
  ]
}
```

L02 修复前/后（lamp build 与 keychain obj build 的 `-o` 文件名）：

```json
{
  "before_lamp": [
    {
      "key": "model_base_stl",
      "bytes": 360284,
      "status": "written",
      "sha256_12": "5cbf2af2866c"
    },
    {
      "key": "model_lamp_stl",
      "bytes": 15162184,
      "status": "written",
      "sha256_12": "94f5809a85df"
    }
  ],
  "before_keychain_legacy": [
    {
      "key": "model_obj",
      "bytes": 46871892,
      "status": "written",
      "sha256_12": "bf665456914a"
    }
  ],
  "selective_download_was_right": [
    {
      "key": "model.obj",
      "relative_path": "keychain-build-selective/model.obj.zip",
      "format": "zip",
      "container_format": "zip"
    }
  ],
  "after_fix": {
    "lamp": [
      [
        "model_base_stl",
        "base.stl"
      ],
      [
        "model_lamp_stl",
        "lamp.stl"
      ]
    ],
    "keychain": [
      [
        "model_obj",
        "model.obj.zip"
      ]
    ]
  }
}
```

OAuth refresh 观测（T-104）：

```json
{
  "original_expires_at_iso": "2026-09-08T05:52:10.945000+00:00",
  "expires_at_now_iso": "2026-09-08T06:51:13.984000+00:00",
  "refreshed": true,
  "login_id_present": true,
  "login_id_sha": "ee55f2134c19",
  "created_at_unchanged": true,
  "balance_after": 2515
}
```

真实 refine 的材质重链接（T-110）：

```json
{
  "result.downloads.material_links.status": "complete",
  "result.downloads.material_links.texture_maps": [
    {
      "line": 12,
      "material": "Material.005",
      "reference": "texture_0.png",
      "resolved_to": "texture_0_base_color.png",
      "method": "source_name"
    }
  ],
  "files": [
    {
      "key": "model_glb",
      "bytes": 83900100,
      "status": "written",
      "sha256_12": "51d4b36507bc"
    },
    {
      "key": "model_fbx",
      "bytes": 99468604,
      "status": "written",
      "sha256_12": "915454648561"
    },
    {
      "key": "model_obj",
      "bytes": 195271847,
      "status": "written",
      "sha256_12": "d1e6f5bb707e"
    },
    {
      "key": "model_mtl",
      "bytes": 239,
      "status": "written",
      "sha256_12": "c9c73e2a3ec9"
    },
    {
      "key": "thumbnail",
      "bytes": 61083,
      "status": "written",
      "sha256_12": "e80a33787756"
    },
    {
      "key": "texture_0_base_color",
      "bytes": 19421816,
      "status": "written",
      "sha256_12": "5e0411a618eb"
    },
    {
      "key": "texture_0_metallic",
      "bytes": 19397,
      "status": "written",
      "sha256_12": "4fd4696a84f8"
    },
    {
      "key": "texture_0_normal",
      "bytes": 11884487,
      "status": "written",
      "sha256_12": "964426c0fc2e"
    },
    {
      "key": "texture_0_roughness",
      "bytes": 967530,
      "status": "written",
      "sha256_12": "60836dd75819"
    }
  ]
}
```

## 5. 实际验证记录（绑定 `1d9f10976b5f754502c81591c64c712e492188d1`）

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` / `pnpm typecheck` / `pnpm build` | exit 0 / 0 / 0 |
| `pnpm test` | **558/558**（45 s） |
| `git diff --check` fd94490 / 4da216d / 工作树 | 0 / 0 / 0 |
| poll ×12 / round1 ×8 / round2–6 ×3 | 12/12 / 8/8 / 3/3 |
| 第 7 轮 reviewer 脚本副本（15 个） | round1–6 探针复现 0/0/0/0/0/0；verify 20/20、8/8、24/24、5/5；矩阵 16/16、10/10、20/20；context 5/5；stream passed |
| tarball smoke（macOS） | **29/29**，`meshy-cli-0.3.0.tgz` sha256 `0d22647fd0568a7c6b44aba80ceb32a5de74781b6697d44986745ee78ddf9c8e`，398 files |

## 6. 未修复的观察（供复审判断）

- **OBS-1**（P3）：403 'enterprise only' from showcases maps to error.code server / exit 1; a dedicated permission code (or auth) may be clearer
- **OBS-2**（P3）：downloaded asset files are published mode 0600 while rewritten MTL and JSON sidecars are 0644
- **OBS-3**（P3）：task verbs' -o downloads are not recorded as files in the project entry (recorded only by meshy download --project); attachToProject.extra.files has no caller
- **OBS-4**（P3）：download --list on a FAILED task reports downloads.state not_ready with ok:true (a terminal failure reads as 'not yet')
- **OBS-5**（P3）：auth status/list/use ignore --output-schema v1 (legacy shape only)
- **OBS-6**（P3）：real task JSON carries no face_count, so inspect faces from a task JSON always ends in check_unknown (13) — by design, but worth stating in docs
- **OBS-7**（P3）：text-to-motion requires --duration client-side (2–10 s, 0.5 steps); confirm against the API default

## 7. 尚未完成 / not_run

- T-109 Windows x64：无主机。
- `MESHY_API_KEY` 环境变量 / `--api-key-file` 对真实 API 的路径：仅离线测试覆盖（live 使用了存储的 API key profile）。
- showcases 内容：账号非 enterprise（403 已记录）。
- `auth logout/revoke`：留给所有者。
- 正式发布：未授权、未执行。

## 8. 交给 Codex 的复审提示词

> 请对 `/Users/ark/Dev/meshy-cli` 分支 `feat/skill-parity-s1` 做 Meshy CLI S1 第 8 轮 review：复审 live verification 发现的两个修复。代码 HEAD `1d9f10976b5f754502c81591c64c712e492188d1`（上一轮 accepted 代码 `e567646`）；docs HEAD 为其后的 docs-only commit。请核对：(1) `src/client/types.ts` 的 null 容忍是否只影响 6 个"未发生"字段、v1 视图输出不变，`tests/live-verification.test.ts` L01 是否用真实捕获体（fixture）覆盖 schema 与 get/wait 轮询；(2) `src/internal/download.ts` + `artifacts.ts` 的命名共享是否保持 legacy slot key、relink 规则与既有测试（round1 R07、N04、C05、D01、E02）不变，L02 是否覆盖 lamp 与 keychain bundle；(3) `docs/skill-parity/live-verification.json` 与 verification.json/capability-matrix.json 的 live 结论是否与证据一致且无凭据/签名 URL 泄露；(4) 前七轮 32 项 finding 在 `1d9f109` 上仍保持通过（副本重跑记录见 §5）。禁止付费调用、发布、Skill/MCP 迁移；Windows 与发布仍为 not_run。
