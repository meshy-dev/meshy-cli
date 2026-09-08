# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. 本文件为 **Round 7**（Codex review 第 6 轮修复后的复审交接）。历次 review：第 1 轮 `…/reviews/cli-s1-6273d9a/`，第 2 轮 `…/reviews/cli-s1-730132b/`，第 3 轮 `…/reviews/cli-s1-cf8905d/`，第 4 轮 `…/reviews/cli-s1-235d6de/`，第 5 轮 `…/reviews/cli-s1-68690f9/`，第 6 轮 `…/reviews/cli-s1-7b7c24c/`；六处 reviewer 证据目录均未被改动，所有复现/核对脚本（14 个）逐字节复制到独立证据目录后运行（副本 sha256 与原件一致）。

## 0. 第 6 轮 review 结论与本轮修复

- 被 review 的 HEAD：`166492ba9691f093b302c1c114e782bceee14a1d`（代码 `7b7c24c`）；结论 **changes_requested**：2 项 P1 代码缺陷（R6-F01、R6-F02）+ 1 项 P3 测试缺口（R6-T01）；reviewer 全量 552/552，前两轮 20/20、R3+R4 正向 8/8、R5 正向 24/24、材质矩阵 16/16 + 补充 10/10、项目入口矩阵 20/20、上下文 5/5；新探针 4/4 复现。
- 修复 commit：`e567646`（`fix(review): address Codex review round 6 findings R6-F01, R6-F02 and test gap R6-T01`）。本轮没有测试稳定性提交。`23 files changed, 665 insertions(+), 105 deletions(-)`（相对 166492b，含 docs）。
- 复现脚本重跑（副本，`e567646`）：`round6-probes.mjs` F01 task-json/api、F02 get/create-async **全部 exit 11、外部 metadata/history 字节不变、recovery null**（reproduced=false 不是验收依据，正向断言见 `tests/codex-review-round6.test.ts`）；`round5-probes.mjs` 0/4；`round4-probes.mjs` 0/3（D03 signal_sent=true / exit 130）；`round3-probes.mjs` 0/6（fs.watch C03 signal_sent=true / exit 130，本轮触发成功）；`round2-probes.mjs` 0/8；`round1-probes.mjs` 0/12；`verify-original-regressions.py` **20/20**；`verify-round3-4-regressions.py` **8/8**；`verify-round5-positive.py` **24/24**；`material-matrix-check.mjs` **16/16**；`round6-material-check.mjs` **10/10**；`project-entry-matrix-check.mjs` **20/20**；`round4-context-checks.mjs` **5/5**；`stream-finalization-check.mjs` 通过。
- 正向回归：`tests/codex-review-round6.test.ts`（3 项：F01 download × task-json/API × 项目叶子/父目录换成外部链接 + 健康对照；F02 legacy/v1 × get/wait/stream/create-async/create-sync × workspace 目录被换/别名被重指向 = 20 组；稳定别名对照）；`tests/codex-review-round5.test.ts` E03 全部 20 组精确 method/path 序列、E02 候选按行与 key 绑定（R6-T01）；前五轮回归全部保留并通过。
- 全量：`pnpm typecheck` 通过；`pnpm test` **555/555**（0 失败、0 跳过）；`git diff --check` 在 `fd94490..HEAD`、`166492b..HEAD` 与工作树均 exit 0；`poll.test.ts` 连续 12 次 12/12；`codex-review-round1.test.ts` 连续 8 次 8/8；round2–6 套件连续 3 次 3/3。

| ID | 优先级 | 问题 | 修复 | 决策 | 回归测试 | 复现脚本重跑 |
| --- | --- | --- | --- | --- | --- | --- |
| R6-F02 | P1 | 授权根在每次检查时重新 realpath：请求期间把 workspace（或其别名）换成指向外部树的符号链接，root 与目标一起移动，检查通过，snapshot/metadata/history 写到外部，exit 0 | 授权根改为 `AuthorisedRoot`，在读取全局 flags 时冻结（`freezeRoot`：真实路径 + 目录 dev/inode）；`resolveWithinRoot` 收到冻结根时不再解析根，先证明同一目录仍在原路径（出现符号链接或不同目录 → "changed since the command started"），再证明目标真实路径在冻结的真实根内。冻结根贯穿 `--save-json`、`-o` 下载（downloadArtifacts/downloadAssets/sidecar/report-only）、`make`、`mesh prepare-print`、`project` 命令与任务动词的项目记账；无 workspace 时项目目录本身在首次请求前冻结（`beginProjectContext`），记账通过证明过的真实路径写入。越界为边界失败：exit 11、任务与 accepted journal 保留、单 POST、外部零写入、recovery null、无跨界命令。稳定别名照常通过 | D-057 | F02 矩阵（legacy/v1 × 5 动词 × 目录被换/别名重指向 = 20 组：exit 11、task_id、create 恰 1 POST 且 journal 恰 1 条 accepted、`submission.operation_id`/legacy 顶层 `operation_id` 对账、精确 method/path、外部树与原树整树摘要不变、recovery null、hint 非 record 命令）；稳定别名对照（snapshot 落在真实项目、index 刷新） | F02 get/create-async: exit 11, metadata/history 不变 |
| R6-F01 | P1 | 独立 `download --project` 记账阶段只 lstat 了 `P/metadata.json`：P 或其父目录在资产 GET 期间换成指向外部项目的符号链接时被跟随，外部 metadata 被改写，exit 0 | 项目阶段在任何项目锁/快照/metadata 写入之前用冻结边界重新定位项目（`resolveWithinRoot(projectDir, projectRoot)`；无 workspace 时项目目录本身在预检后冻结），记账通过真实路径写入；边界失败（`projectBoundaryFailure`）与可修复的 metadata 内容问题分开：exit 11 / local_io、完整下载 outcome（source/selection/manifest 磁盘摘要/saved_json）、`project.action="failed"` + error、`recovery: null`、不生成跨界 record 命令、不伪装成 index_dirty；已下载资产不回滚。metadata 缺失/损坏仍走 D-052/D-056 的 record_project | D-058 | F01（task-json/API × 叶子/父目录：exit 11、完整 v1 形状、downloads.completed 与 bytes/sha、project.failed + recovery null、外部整树摘要不变、原项目 metadata 不变、精确请求 task-json `GET /model.glb` / API `GET task, GET /model.glb`）；健康对照 exit 0 记账、`files_outside_project` | F01 task-json/api: exit 11, 外部 metadata 不变 |
| R6-T01 | P3 | E03 的 wait/create-sync 8 组没有精确 GET 数量/顺序断言；E02 候选按集合查找 | E03 20 组统一 deepEqual `[method, path]`（get/wait/stream 各 1 GET；create-async 单 POST；create-sync POST GET，路径含 task_id）；E02 按 line 2/3 与原 key 绑定候选集 | — | `tests/codex-review-round5.test.ts`（R6-T01）；新 round-6 矩阵同样精确断言序列 | verify-round5-positive 24/24 |

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`e567646d875e5f5a658b78e60b8cdfaed8b233e9`（= 修复 `e567646d875e5f5a658b78e60b8cdfaed8b233e9`）；本文件与 verification.json/capability-matrix.json 在其后的 **docs-only commit** 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`、`pnpm-lock.yaml`）
- 历次被 review 的 HEAD：round 1 `6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc`）；round 2 `730132bd99a471ed41d6bbf6b200219f13f569ba`（代码 `0388fe8`）；round 3 `566f3bdbcdd85d1139e48e3a87d4c6f5e844e43a`（代码 `cf8905d`）；round 4 `9e43a77ced4f84e1ab03c96ddc9a61ce349d44d4`（代码 `235d6de`）；round 5 `e7c0bbc4c39b26e77d48ab0979328ae8fa4a5b59`（代码 `68690f9`）；round 6 `166492ba9691f093b302c1c114e782bceee14a1d`（代码 `7b7c24c`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**第 6 轮 2 项 P1 已修复并有正向回归，P3 测试缺口已补；前五轮 29 项在新 HEAD 复核未回退（reviewer 正向脚本 20/20、8/8、24/24，六轮探针 0 复现，矩阵 16/16、10/10、20/20，上下文 5/5）；自评 passed，等待 Codex 复审确认**（上一轮结论 not_accepted）
- G1-release / ready-for-S2：**not_run**（无复审结论、无真实账号/多 OS/切片器验证、未发布；按用户要求不在本轮范围）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`；7 项带 `review_round_6`，8 项 `review_round_5`，5 项 `review_round_4`，10 项 `review_round_3`，13 项 `review_round_2`，21 项 `review_round_1`，`review_status` 均为 "re-review pending"）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **555 通过 / 0 失败 / 0 跳过**（555 项，含基线原有 363 项；覆盖 74 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权，在 e567646 重跑：exit 0）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归，含真实 token 端点是否返回 user_id）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（六个 reviewer 目录未被改动；未调用付费接口；未发布）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
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

修复 commit：

```
e567646 fix(review): address Codex review round 6 findings R6-F01, R6-F02 and test gap R6-T01

 README.md                            |   2 +-
 docs/skill-parity/decisions.md       |  45 +++++
 docs/skill-parity/migration-notes.md |   8 +
 skills/meshy-cli/SKILL.md            |   6 +-
 src/cmd/animation-catalog.ts         |   2 +-
 src/cmd/api.ts                       |   2 +-
 src/cmd/balance.ts                   |   2 +-
 src/cmd/doctor.ts                    |   2 +-
 src/cmd/download.ts                  |  72 ++++++--
 src/cmd/inspect.ts                   |   2 +-
 src/cmd/make.ts                      |   4 +-
 src/cmd/mesh.ts                      |   2 +-
 src/cmd/project.ts                   |  14 +-
 src/cmd/showcases.ts                 |   2 +-
 src/internal/command-helpers.ts      |   6 +-
 src/internal/download.ts             |  56 ++++---
 src/internal/obj-transform.ts        |  12 +-
 src/internal/paths.ts                |  99 ++++++++++-
 src/internal/project-store.ts        |   7 +-
 src/internal/runtime.ts              |   4 +
 src/internal/task-command.ts         |  86 ++++++----
 tests/codex-review-round5.test.ts    |  22 ++-
 tests/codex-review-round6.test.ts    | 313 +++++++++++++++++++++++++++++++++++
 23 files changed, 665 insertions(+), 105 deletions(-)
```

要点：

- `src/internal/paths.ts`：新增 `AuthorisedRoot`（given/real/anchor/dev/ino/directory/label）、`freezeRoot`（真实路径 + 最深已存在祖先的目录身份）、`assertRootIntact`（lstat 同一目录、非符号链接、dev/inode 相同）；`resolveWithinRoot(target, root: string | AuthorisedRoot)`：冻结根不再 realpath，先 `assertRootIntact` 再判定目标真实路径在 `root.real` 内。
- `src/internal/runtime.ts`：`GlobalFlags.workspaceRoot` 在 `readGlobalFlags` 中由 `--workspace` 冻结（首次 I/O 前）。
- `src/internal/command-helpers.ts`（`saveRawJson`）、`src/internal/project-store.ts`（`indexRootFor`）、`src/internal/download.ts`（`downloadAssets`/`downloadArtifacts`/`placeFetched`/`downloadArtifact`/`saveReportOnly`/`writeMeta`）、`src/internal/obj-transform.ts`（写根）、`src/cmd/project.ts`、`src/cmd/mesh.ts`、`src/cmd/make.ts`、`balance/doctor/api/inspect/animation-catalog/showcases` 的 `--save-json`：全部改为接收并使用冻结根。
- `src/internal/task-command.ts`：`beginProjectContext`（get/wait/stream 在 openCommand 后、create 在预检中冻结项目根并记住是否已初始化；不在此拒绝，未初始化的项目仍作为请求后的记账失败，保持 R2-F03 的单 outcome）；`attachToProject` 用冻结根定位项目（`located` 真实路径），边界失败 → `projectBoundaryFailure`（无命令），其余 → record_project；记账通过 `located` 写入。
- `src/cmd/download.ts`：`projectRoot`（workspace 或预检后冻结的项目目录）；项目阶段先 `resolveWithinRoot(projectDir, projectRoot)` → 失败走新 `projectBoundaryFailure`（recovery null、project.failed、完整 outcome）；通过后按真实路径算文件列表、断言 metadata、记账。
- 测试：`tests/codex-review-round6.test.ts`（新，3 项）；`tests/codex-review-round5.test.ts` R6-T01 精确请求序列与按行候选；`R5-F03` 边界用例的消息断言随文案更新（"authorised boundary"）。
- 文档：`decisions.md` D-057–D-058；`migration-notes.md` §3.6；README `--workspace` 行；SKILL.md 边界失败处置。

## 4. 能力与接口证据

### 4.1 第 6 轮 finding 修复后的实际输出（`round6-probes.mjs` 副本重跑，`e567646`，脱敏）

**F01-download-project-boundary-task-json**

```json
{
  "args": "download --task-json <tmp>/boundary-task-json.json --all --project <tmp>/ws-task-json/projects/<stamp>_escaped-project_0d2d --workspace <tmp>/ws-task-json --output-dir <tmp>/ws-task-json/assets",
  "exit": 11,
  "error": {
    "code": "local_io",
    "message": "1 file(s) were downloaded to <tmp>/ws-task-json/assets but --project <tmp>/ws-task-json/projects/<stamp>_escaped-project_0d2d is no longer a target inside the authorised boundary: --project <tmp>/ws-task-json/projects/<stamp>_escaped-project_0d2d is a symbolic link; refusing to write through it; nothing was recorded (no project lock, snapshot or metadata was written). Restore the project inside the workspace, then record task round2-task with `meshy project record` from that workspace",
    "recovery": null,
    "hint": null
  },
  "result.project": {
    "project_dir": "<tmp>/ws-task-json/projects/<stamp>_escaped-project_0d2d",
    "action": "failed",
    "stage": "preview",
    "recorded_files": [],
    "error": {
      "code": "local_io",
      "message": "--project <tmp>/ws-task-json/projects/<stamp>_escaped-project_0d2d is a symbolic link; refusing to write through it"
    },
    "recovery": null
  },
  "result.task_id": "round2-task",
  "downloads": {
    "state": "completed"
  },
  "external_metadata_changed": false,
  "external_history_changed": null,
  "external_listing": [
    "metadata.json"
  ],
  "requests": [
    "GET /model.glb"
  ]
}
```
**F01-download-project-boundary-api**

```json
{
  "args": "download --resource text-to-3d --task-id round2-task --all --project <tmp>/ws-api/projects/<stamp>_escaped-project_944d --workspace <tmp>/ws-api --output-dir <tmp>/ws-api/assets",
  "exit": 11,
  "error": {
    "code": "local_io",
    "message": "1 file(s) were downloaded to <tmp>/ws-api/assets but --project <tmp>/ws-api/projects/<stamp>_escaped-project_944d is no longer a target inside the authorised boundary: --project <tmp>/ws-api/projects/<stamp>_escaped-project_944d is a symbolic link; refusing to write through it; nothing was recorded (no project lock, snapshot or metadata was written). Restore the project inside the workspace, then record task round2-task with `meshy project record` from that workspace",
    "recovery": null,
    "hint": null
  },
  "result.project": {
    "project_dir": "<tmp>/ws-api/projects/<stamp>_escaped-project_944d",
    "action": "failed",
    "stage": "preview",
    "recorded_files": [],
    "error": {
      "code": "local_io",
      "message": "--project <tmp>/ws-api/projects/<stamp>_escaped-project_944d is a symbolic link; refusing to write through it"
    },
    "recovery": null
  },
  "result.task_id": "round2-task",
  "downloads": {
    "state": "completed"
  },
  "external_metadata_changed": false,
  "external_history_changed": null,
  "external_listing": [
    "metadata.json"
  ],
  "requests": [
    "GET /openapi/v2/text-to-3d/round2-task",
    "GET /model.glb"
  ]
}
```
**F02-mutable-workspace-boundary-get**

```json
{
  "args": "text-to-3d get mutable-root-task --output-schema v1 --project <tmp>/mutable-ws-get/projects/<stamp>_mutable-root_cef3 --workspace <tmp>/mutable-ws-get",
  "exit": 11,
  "error": {
    "code": "local_io",
    "message": "task mutable-root-task exists but --project <tmp>/mutable-ws-get/projects/<stamp>_mutable-root_cef3 is no longer a target inside the authorised boundary: --workspace <tmp>/mutable-ws-get changed since the command started: <tmp>/mutable-ws-get is now a symbolic link; refusing to write outside the authorised boundary; nothing was recorded (no project lock, snapshot or metadata was written). Restore the project inside the workspace, then record the task with `meshy project record` from that workspace",
    "recovery": null,
    "hint": "meshy text-to-3d wait mutable-root-task --output-schema v1"
  },
  "result.project": null,
  "result.task_id": "mutable-root-task",
  "downloads": {
    "state": "not_requested"
  },
  "external_metadata_changed": false,
  "external_history_changed": false,
  "external_listing": [
    "metadata.json"
  ],
  "requests": [
    "GET /openapi/v2/text-to-3d/mutable-root-task"
  ]
}
```
**F02-mutable-workspace-boundary-create-async**

```json
{
  "args": "text-to-3d create --mode preview --prompt fixture --async --output-schema v1 --project <tmp>/mutable-ws-create-async/projects/<stamp>_mutable-root_66f8 --workspace <tmp>/mutable-ws-create-async",
  "exit": 11,
  "error": {
    "code": "local_io",
    "message": "task mutable-root-task exists (operation 2ac86063-8cad-4294-8728-20fccc09a615) but --project <tmp>/mutable-ws-create-async/projects/<stamp>_mutable-root_66f8 is no longer a target inside the authorised boundary: --workspace <tmp>/mutable-ws-create-async changed since the command started: <tmp>/mutable-ws-create-async is now a symbolic link; refusing to write outside the authorised boundary; nothing was recorded (no project lock, snapshot or metadata was written). Restore the project inside the workspace, then record the task with `meshy project record` from that workspace",
    "recovery": null,
    "hint": "meshy text-to-3d wait mutable-root-task --output-schema v1"
  },
  "result.project": null,
  "result.task_id": "mutable-root-task",
  "downloads": {
    "state": "not_requested"
  },
  "external_metadata_changed": false,
  "external_history_changed": false,
  "external_listing": [
    "metadata.json"
  ],
  "requests": [
    "POST /openapi/v2/text-to-3d"
  ]
}
```

### 4.2 矩阵（reviewer 脚本副本，`e567646`）

`project-entry-matrix-check.mjs`：20/20 组有 `record_project` 恢复（metadata 缺失/损坏 = 可修复内容问题），全部 exit 11、task_id 保留。

| schema | verb | fault | exit | task_id | record_project |
| --- | --- | --- | --- | --- | --- |
| legacy | get | damaged | 11 | legacy-get-damaged | yes |
| legacy | get | missing | 11 | legacy-get-missing | yes |
| legacy | wait | damaged | 11 | legacy-wait-damaged | yes |
| legacy | wait | missing | 11 | legacy-wait-missing | yes |
| legacy | stream | damaged | 11 | legacy-stream-damaged | yes |
| legacy | stream | missing | 11 | legacy-stream-missing | yes |
| legacy | create-async | damaged | 11 | legacy-create-async-damaged | yes |
| legacy | create-async | missing | 11 | legacy-create-async-missing | yes |
| legacy | create-sync | damaged | 11 | legacy-create-sync-damaged | yes |
| legacy | create-sync | missing | 11 | legacy-create-sync-missing | yes |
| v1 | get | damaged | 11 | v1-get-damaged | yes |
| v1 | get | missing | 11 | v1-get-missing | yes |
| v1 | wait | damaged | 11 | v1-wait-damaged | yes |
| v1 | wait | missing | 11 | v1-wait-missing | yes |
| v1 | stream | damaged | 11 | v1-stream-damaged | yes |
| v1 | stream | missing | 11 | v1-stream-missing | yes |
| v1 | create-async | damaged | 11 | v1-create-async-damaged | yes |
| v1 | create-async | missing | 11 | v1-create-async-missing | yes |
| v1 | create-sync | damaged | 11 | v1-create-sync-damaged | yes |
| v1 | create-sync | missing | 11 | v1-create-sync-missing | yes |

`material-matrix-check.mjs` 16/16；`round6-material-check.mjs` 10/10（无候选通道不提供证据、相同多候选集、source_name/source_stem + 无通道、map key 大小写）。

### 4.3 tarball 安装 smoke（`e567646`，`meshy-cli-0.3.0.tgz`；`<verify>` 为临时 npm prefix）

`<verify>/prefix/bin/meshy resources --output-schema v1` → exit 0

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "resources",
  "ok": true,
  "result": {
    "items": [
      {
        "name": "text-to-3d",
        "kind": "task",
        "command": "meshy text-to-3d",
        "summary": "two-stage 3D generation from text (preview → refine)",
        "endpoint": "/openapi/v2/text-to-3d",
        "verbs": [
          "create",
          "get",
          "list",
          "wait",
          "stream",
          "delete"
        ]
      },
      {
        "name": "image-to-3d",
        "kind": "task",
        "command": "meshy image-to-3d",
        "summary": "3D from a single image (standard or smart-topology low-poly)",
        "endpoint": "/openapi/v1/image-to-3d",
        "verbs": [
          "create",
          "get",
          "list",
          "wait",
          "stream",
          "delete"
        ]
      },
      {
        "name": "multi-image-to-3d",
        "kind": "task",
        "command": "meshy multi-image-to-3d",
        "summary": "3D from multiple views (beta; prefer image-to-3d)",
        "endpoint": "/openapi/v1/multi-image-to-3d",
        "verbs": [
          "create",
          "get",
          "list",
          "wait",

… (truncated)
```

`<verify>/prefix/bin/meshy doctor --output-schema v1` → exit 0

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "doctor",
  "ok": true,
  "result": {
    "cli": {
      "version": "0.3.0",
      "node": "v24.20.0",
      "platform": "darwin",
      "arch": "arm64"
    },
    "local_ready": true,
    "api_ready": null,
    "checks": [
      {
        "id": "cli",
        "status": "ok",
        "detail": "meshy-cli 0.3.0 on node v24.20.0 (darwin arm64)"
      },
      {
        "id": "node",
        "status": "ok",
        "detail": "node v24.20.0 satisfies the required >=24"
      },
      {
        "id": "base_urls",
        "status": "ok",
        "detail": "v1 https://api.meshy.ai/openapi/v1; v2 https://api.meshy.ai/openapi/v2; creative-lab https://api.meshy.ai/openapi/creative-lab; public-web https://api.meshy.ai/web/public"
      },
      {
        "id": "api_key_file",
        "status": "skipped",
        "detail": "--api-key-file not given"
      },
      {
        "id": "credentials",
        "status": "warn",
        "detail": "sources present: --api-key=no, MESHY_API_KEY=no, --api-key-file=none, stored profile=absent (<verify>/config/credentials.json); values are never read by doctor. API commands need --api-key, MESHY_API_KEY, --api-key-file <file> or `meshy auth login`"
      },
      {
        "id": "workspace",
        "status": "skipped",
        "detail": "--workspace not given (files land next to their targets)"
      },
      {
        "id": "cwd_env_files",
        "status": "ok",
        "detail": "no .env or .env.local in /pri
… (truncated)
```

`<verify>/prefix/bin/meshy project record --project <verify>/work/meshy_output/<stamp>_smoke-demo_fixture- --task-id fixture-rig-1 --resource rigging --stage rigged --file rigged.glb --output-schema v1` → exit 0

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "project.record",
  "ok": true,
  "result": {
    "project_dir": "<verify>/work/meshy_output/<stamp>_smoke-demo_fixture-",
    "action": "added",
    "entry": {
      "task_id": "fixture-rig-1",
      "task_type": "rigging",
      "resource": "rigging",
      "endpoint": null,
      "stage": "rigged",
      "parent_task_id": null,
      "status": null,
      "files": [
        "rigged.glb"
      ],
      "task_json": null,
      "operation_id": null,
      "created_at": "2026-09-08T03:45:25.184Z",
      "updated_at": "2026-09-08T03:45:25.184Z"
    },
    "task_count": 1,
    "index": {
      "updated": true,
      "error": null
    },
    "migrated_from_legacy": false
  },
  "error": null,
  "warnings": [
    {
      "code": "recorded_file_missing",
      "message": "recorded file(s) not present in the project yet: rigged.glb"
    }
  ]
}
```

`<verify>/prefix/bin/meshy animation-catalog list --category DailyActions --search wave --output-schema v1` → exit 0

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "animation-catalog.list",
  "ok": true,
  "result": {
    "items": [
      {
        "action_id": 28,
        "name": "Big Wave Hello",
        "key": "Big_Wave_Hello",
        "category": "DailyActions",
        "sub_category": "Interacting",
        "preview_url": "https://cdn.meshy.ai/webapp-assets/feature-demo/animation/preview/biped/Big_Wave_Hello.gif",
        "rig_type": "style_02",
        "is_default": false,
        "is_free": false
      },
      {
        "action_id": 290,
        "name": "Wave One Hand",
        "key": "Wave_One_Hand",
        "category": "DailyActions",
        "sub_category": "Interacting",
        "preview_url": "https://cdn.meshy.ai/webapp-assets/feature-demo/animation/preview/biped/Wave_One_Hand.gif",
        "rig_type": "style_02",
        "is_default": false,
        "is_free": false
      },
      {

… (truncated)
```

## 5. 实际验证记录

全部绑定代码 HEAD `e567646d875e5f5a658b78e60b8cdfaed8b233e9`（Node v24.20.0，pnpm 11.24.0）；机器记录见 `docs/skill-parity/verification.json`。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 | |
| `pnpm typecheck` | exit 0 | src + tests |
| `pnpm build` | exit 0 | |
| `pnpm test` | **555 pass / 0 fail / 0 skip**（555 项，45 s） | 含 3 项 round-6 新回归 |
| `dist/index.js --version` = package.json | exit 0 | |
| `git diff --check fd94490` / `166492b` / 工作树 | exit 0 / 0 / 0 | 完整基线、本轮 diff、工作树 |
| `poll.test.ts` × 12 | 12/12 | |
| `codex-review-round1.test.ts` × 8 | 8/8 | |
| round2–6 套件 × 3 | 3/3 | 含 SIGINT/竞争/两个 20 组矩阵 |
| `round6-probes.mjs` 副本 | F01 ×2、F02 ×2 不再复现（exit 11，外部字节不变） | 正向验收在仓库测试 |
| `round5-probes.mjs` 副本 | 0/4 复现 | |
| `round4-probes.mjs` 副本 | 0/3 复现；D03 signal_sent=true exit 130 | |
| `round3-probes.mjs` 副本 | 0/6 复现（exit 1） | fs.watch C03 signal_sent=true, exit 130（触发成功） |
| `round2-probes.mjs` 副本 | 0/8 复现（exit 1） | |
| `round1-probes.mjs` 副本 | 0/12 复现（exit 1） | |
| `verify-original-regressions.py` | **20/20** | |
| `verify-round3-4-regressions.py` | **8/8** | C03 以 D03 补证 |
| `verify-round5-positive.py` | **24/24** | E01–E03 + 20 入口 |
| `material-matrix-check.mjs` / `round6-material-check.mjs` | **16/16** / **10/10** | |
| `project-entry-matrix-check.mjs` | **20/20** | |
| `round4-context-checks.mjs` 副本 | **5/5** | |
| `stream-finalization-check.mjs` 副本 | passed | |
| tarball smoke | **29/29** | `meshy-cli-0.3.0.tgz` sha256 `bd3d39e71cfd41f7b19a5fe0b4e71805ed1634e8e5e3afb88ca5aa3242f7cb98`，398 files，bins ['meshy', 'meshy-cli'] |

## 6. 真实环境验证

- 已执行：真实公开动画目录 GET（免费、无鉴权；`<verify>/prefix/bin/meshy animation-catalog list --category DailyActions --search wave --output-schema v1` → exit 0；public unauthenticated GET of the animation catalog; result keys: items,count,fetched,total,filters,search_scope,source,authenticated,saved_json; matched=8; total=157）；macOS arm64 tarball 安装 + 29 项本地命令 smoke。
- **not_run**（保持）：T-104 真实 API Key/OAuth 登录、重新登录、真实 token 端点 `user_id`；T-109 Windows x64 / Linux x64；T-110 鉴权 get / 已有任务资产下载；T-111 UV Unwrap / Creative Lab / showcases（付费或权限门控）；T-112 真实切片器 GUI；正式发布（未授权、未执行）。
- 不把离线通过写成 G1-release passed；不进入 S2。

## 7. 打包证据

- `npm pack` → `meshy-cli-0.3.0.tgz`，sha256 `bd3d39e71cfd41f7b19a5fe0b4e71805ed1634e8e5e3afb88ca5aa3242f7cb98`，398 个文件；必需文件齐全 = true；禁止内容不存在 = true。
- `npm install -g --prefix <tmp>` → bins ['meshy', 'meshy-cli']；无 Python 依赖。
- 未 `npm publish`，未推送。

## 8. 需要 Codex 复审的事项

1. R6-F02 的冻结语义：根身份 = 冻结时最深已存在祖先的 (dev, ino)（workspace 尚不存在时为其祖先）；`assertRootIntact` 要求该路径仍是同一目录且非符号链接。请确认"稳定 `/var` 别名 / 父目录别名 / 指向不变的 workspace 符号链接均通过，目录被换或别名被重指向均拒绝"符合预期。
2. 无 workspace 时项目目录本身作为冻结根（get/wait/stream 在首次请求前、create 在预检中、download 在预检后）；未初始化的项目**不**在请求前拒绝（保持 R2-F03 的"请求后单 outcome"语义与既有 project-store 测试）。
3. R6-F01 的边界失败形状：`project.action="failed"` + `error` + `recovery: null`，`error.recovery` 为 null，hint 不是 record 命令；与 metadata 缺失/损坏的 `record_project` 分支明确区分。
4. 任务动词的边界失败文案由 "inside the workspace" 改为 "inside the authorised boundary"（round-5 测试断言随之更新）；hint 回落为只读 `wait`。
5. 旧 `round3-probes.mjs` 的 fs.watch C03 本轮副本 signal_sent=true（触发）；稳定证据仍为 D03、context 的 standalone-relink-interrupt 与仓库 C03。

## 9. 最短复现步骤

```bash
cd /Users/ark/Dev/meshy-cli && git checkout e567646
export FNM_DIR="$HOME/.local/share/fnm"; eval "$(fnm env --shell bash)"; fnm use 24
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test          # 555/555
node --import tsx --test tests/codex-review-round6.test.ts             # F01 ×4 + control, F02 ×20, stable alias
mkdir -p /tmp/r6 && cp /Users/ark/Dev/meshy-agent-integrations-research/reviews/cli-s1-7b7c24c/round6-probes.mjs /tmp/r6/
node /tmp/r6/round6-probes.mjs /Users/ark/Dev/meshy-cli               # F01/F02 reproduced=false, exit 11, external bytes unchanged
git diff --check fd94490 && git diff --check 166492b
```

## 10. 交给 Codex 的复审提示词

> 请对 `/Users/ark/Dev/meshy-cli` 分支 `feat/skill-parity-s1` 做 Meshy CLI S1 第 7 轮 review。规范：2026-09-07 v1 实施包。代码 HEAD `e567646d875e5f5a658b78e60b8cdfaed8b233e9`（= 修复 `e567646d875e5f5a658b78e60b8cdfaed8b233e9`）；docs HEAD 为其后的 docs-only commit（`git log -1`）。上一轮（`…/reviews/cli-s1-7b7c24c/`）结论 changes_requested：R6-F01、R6-F02（P1）与 R6-T01（P3）。请核对：(1) `src/internal/paths.ts` 的 `AuthorisedRoot`/`freezeRoot`/`assertRootIntact` 与 `resolveWithinRoot` 冻结根分支是否在首次 I/O 前建立、且所有写入/恢复路径（`--save-json`、`-o` 下载与 sidecar、`make`、`mesh prepare-print`、`project`、任务动词与 `download` 的项目记账）都不再重新解析可变根；(2) `tests/codex-review-round6.test.ts` 是否按 acceptance 做了正向断言（task-json/API × 叶子/父目录；legacy/v1 × 5 动词 × 目录被换/别名重指向；exit 11、task/submission/operation_id、单 POST、精确 method/path、外部与原树整树摘要、无 snapshot/lock/temp、recovery null、无跨界命令；稳定别名与健康对照）；(3) `tests/codex-review-round5.test.ts` E03 20 组精确序列与 E02 按行候选（R6-T01）；(4) 前六轮 32 项 finding 是否保持通过（副本重跑 round1–6 探针、三个 verify 脚本、三个矩阵脚本、`round4-context-checks.mjs`、`stream-finalization-check.mjs`；旧 fs.watch C03 未触发时不得计为通过）。请勿修改 reviewer 证据目录；禁止付费调用、发布、Skill/MCP 迁移。真实账号、Windows/Linux、真实切片器、UV/Creative Lab/showcases 仍为 not_run；G1-release 与 S2 不在本轮范围。
