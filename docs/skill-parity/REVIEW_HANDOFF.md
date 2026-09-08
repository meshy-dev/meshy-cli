# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. 本文件为 **Round 5**（Codex review 第 4 轮修复后的复审交接）。历次 review：第 1 轮 `…/reviews/cli-s1-6273d9a/`，第 2 轮 `…/reviews/cli-s1-730132b/`，第 3 轮 `…/reviews/cli-s1-cf8905d/`，第 4 轮 `…/reviews/cli-s1-235d6de/`；四处 reviewer 证据目录均未被改动，所有复现/核对脚本逐字节复制到独立证据目录后运行（副本 sha256 与原件一致）。

## 0. 第 4 轮 review 结论与本轮修复

- 被 review 的 HEAD：`9e43a77ced4f84e1ab03c96ddc9a61ce349d44d4`（代码 `235d6de`）；结论 **changes_requested**：2 项 P2 代码缺陷（R4-F01、R4-F02）+ 1 项 P3 测试缺口（R4-T01）；reviewer 全量 542/542，R3 六项正向 6/6，前两轮 20 项正向 20/20，5 项上下文检查 5/5，未发现新的 P1。
- 修复 commit：`93e55bc`（`fix(review): address Codex review round 4 findings R4-F01, R4-F02 and test gap R4-T01`）；测试稳定性 commit：`68690f9`（`test(wait)`：round-1 R03 “expiry during the sleep” 子进程检查原本把 poll 数上限设为 2，而 D-044 已记录“提前唤醒可再发一次 deadline-bound GET”，该检查在本机约 1/6 次误报——改为断言真实时钟能证明的不变量：服务端看到的每次 GET 都在预算内开始、第二次等满间隔、第三次只能出现在 deadline 唤醒、计入的 polls 与服务端看到的 GET 一致（最多一个被 deadline 截断）；不放宽语义、不跳过）。`11 files changed, 1032 insertions(+), 121 deletions(-)`（相对 9e43a77，含 docs）。
- 复现脚本重跑（副本，`68690f9`）：`round4-probes.mjs` D01/D02 **不再呈现旧行为**（reproduced=false 不是验收依据，正向断言见 `tests/codex-review-round4.test.ts`），D03 正向中断探针 signal_sent=true / exit 130；`round3-probes.mjs` **0/6 复现**（原 fs.watch C03 本轮副本运行**触发成功**：signal_sent=true / exit 130、reproduced=false（上一轮 reviewer 运行中它曾未触发；触发与否取决于 fs.watch 时机，故中断证据仍以 D03、`round4-context-checks` 的 standalone-relink-interrupt 与仓库 C03/12 MB 轮询用例为主））；`round2-probes.mjs` **0/8**；`round1-probes.mjs` **0/12**（三者均 exit 1 = 并非全部复现）；reviewer 的 `verify-original-regressions.py` 对重跑结果 **20/20 通过**；`round4-context-checks.mjs` **5/5**；`stream-finalization-check.mjs` 通过。
- 正向回归：`tests/codex-review-round4.test.ts`（5 项：D01 两种顺序 + 仲裁单测 4 例；D02 三种记账失败 + 恢复命令回放；预检 4 例 + 健康项目；R4-T01 legacy/v1 × 503/SIGINT）；三轮旧回归全部保留并通过（C06 的 make 部分迁入 R4-T01 并按 reviewer 要求改为不同 step id）。
- 全量：`pnpm typecheck` 通过；`pnpm test` **547/547**（0 失败、0 跳过）；`git diff --check fd94490` 与工作树 exit 0；`poll.test.ts` 连续 12 次 12/12；`codex-review-round1.test.ts` 连续 8 次 8/8；round2+round3+round4 套件连续 3 次 3/3。

| ID | 优先级 | 问题 | 修复 | 决策 | 回归测试 | 复现脚本重跑 |
| --- | --- | --- | --- | --- | --- | --- |
| R4-F01 | P2 | 通道回退按“声明的通道”计竞争，实际回退落到同一贴图的两条不同引用被合并并报告 complete | `material-links.ts` 两遍解析：先按各自证据解析每个 distinct (key, reference)（`source_name`/`exact`/`source_stem` 为身份证据，通道与唯一贴图规则为启发式），再由 `arbitrate` 在**实际落到的贴图**上做全局竞争——任何其它 distinct 引用（命中或 ambiguous 候选）争用同一贴图时启发式命中一律否决；同一引用在不同 key 下落到不同贴图也不重写；身份命中永不否决。被否决的引用保持原文、`method: ambiguous`、`candidates: [贴图]`、组内共享一条 `note`；`status=incomplete`；warning 每个原因只说一次并列出材质组 | D-051 | D01（两种顺序：MTL 字节不变、两条引用 ambiguous、note 同时点名 channel_of_key 与 channel_in_name、rewritten 仅 OBJ、bytes/sha 与磁盘一致、贴图字节为源图、3 GET 0 POST）；仲裁单测：source_name 命中 + 启发式竞争者（身份保留、竞争者原文）、无法解析的竞争者（C05 生成名冲突）同样阻止、同一引用两 key 两贴图、单引用回退与不同通道回退仍解析；C05/N04/round-1 材质测试不变 | D01: exit 0, `status=incomplete`, MTL 未改写 |
| R4-F02 | P2 | `download --project` 的 realpath/indexRootFor/recordTask 阶段在下载异常包装之外，记账失败返回 `result=null` | 进入项目阶段前固化 `outcome`（source/selection/downloads 含磁盘摘要/unknown_urls/saved_json）；整段包进 `projectRecordFailure`：保留原分类（code/exit/http），`result` 完整 + `project: { action: "failed", stage, recorded_files: [], error, recovery }`，`error.recovery = { action: "record_project", command }`（同为 `hint`），command 为精确的 `meshy project record …`（task id、stage、resource、type、status、落在项目内的文件，`projectRecordCommand`）；不回滚、不重下、不重提；`index_dirty` 语义不变。能预检的先预检（`preflightProject`：metadata.json 存在、是常规文件、可解析；`--stage` 非空）→ “nothing was downloaded”、0 请求。任务动词的 `--project` 记账失败同样给出 `record_project` recovery/hint | D-052 | D02（GET 期间 metadata.json 换成指向工作区外有效 metadata 的符号链接：exit 11、完整 v1 形状、result.source/selection/downloads(written, sha=磁盘)/saved_json、project.action=failed + error + recovery、hint=命令、外部与备份 metadata 字节不变、符号链接未被替换、无临时文件、恰 1 次 GET；随后修复目录并**逐字回放恢复命令**：exit 0、metadata.tasks 恰好记录 model.glb、0 请求）；GET 期间 metadata 损坏为非 JSON（同上，损坏文件不被覆盖）；GET 期间项目目录变为不可写（锁文件无法创建的原生 errno → local_io + 完整 result）；预检：符号链接/损坏 metadata → exit 11 且 0 请求、无 id 任务 → exit 2、空 `--stage` → exit 2；健康项目照常记录 | D02: exit 11, result 含 downloads/project/recovery |
| R4-T01 | P3 | make 两步 mock 同一 task_id，只断言 operation_id 非空 | 新增 R4-T01：两步返回不同 id，对账 `result.task_id`、`submission.operation_id`、`executed[-1].operation_id`、legacy 顶层 `operation_id` = 最后一条 accepted journal，`executed[0].operation_id` = 第一步记录，`preview_task_id` = 第一步，请求序列 POST GET POST GET GET，恰 2 条 journal；legacy/v1 × 资产 503/SIGINT 四组；C06 保留 create/wait/get/sidecar/SIGINT | D-053 | R4-T01（4 组）；reviewer 的 `round4-context-checks.mjs` 副本 5/5 | context checks 5/5 |

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`68690f9273ff20bbf95e6ac586766e30d977b6b4`（= 修复 `93e55bcc717ceb9a368ee43aeeeac69a3fb52197` + 测试稳定性提交 `68690f9`）；本文件与 verification.json/capability-matrix.json 在其后的 **docs-only commit** 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`、`pnpm-lock.yaml`）
- 历次被 review 的 HEAD：round 1 `6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc`）；round 2 `730132bd99a471ed41d6bbf6b200219f13f569ba`（代码 `0388fe8`）；round 3 `566f3bdbcdd85d1139e48e3a87d4c6f5e844e43a`（代码 `cf8905d`）；round 4 `9e43a77ced4f84e1ab03c96ddc9a61ce349d44d4`（代码 `235d6de`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**第 4 轮 2 项代码 finding 已修复并有正向回归，1 项测试缺口已补；前三轮 23 项在新 HEAD 复核未回退（reviewer 正向脚本 20/20、R3 探针 0/6 复现且 D03/上下文检查通过）；自评 passed，等待 Codex 复审确认**（上一轮结论 not_accepted）
- G1-release / ready-for-S2：**not_run**（无复审结论、无真实账号/多 OS/切片器验证、未发布）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`；5 项带 `review_round_4`，10 项 `review_round_3`，13 项 `review_round_2`，21 项 `review_round_1`，`review_status` 均为 "re-review pending"）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **547 通过 / 0 失败 / 0 跳过**（547 项，含基线原有 363 项；覆盖 74 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权，在 68690f9 重跑：exit 0）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归，含真实 token 端点是否返回 user_id）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（四个 reviewer 目录未被改动；未调用付费接口；未发布）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
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
93e55bc fix(review): address Codex review round 4 findings R4-F01, R4-F02 and test gap R4-T01

 README.md                            |  18 +-
 docs/skill-parity/decisions.md       |  58 ++++
 docs/skill-parity/migration-notes.md |   9 +
 skills/meshy-cli/SKILL.md            |   7 +-
 src/cmd/download.ts                  | 140 ++++++--
 src/internal/material-links.ts       | 163 ++++++---
 src/internal/project-store.ts        |  23 ++
 src/internal/task-command.ts         |  36 +-
 tests/codex-review-round3.test.ts    |  28 +-
 tests/codex-review-round4.test.ts    | 648 +++++++++++++++++++++++++++++++++++
 10 files changed, 1013 insertions(+), 117 deletions(-)
```

测试稳定性 commit（仅测试与 decisions.md 的 D-044 备注）：

```
68690f9 test(wait): allow the deadline wake-up's one extra GET that D-044 permits

 docs/skill-parity/decisions.md    |  7 +++++++
 tests/codex-review-round1.test.ts | 16 ++++++++++++----
 2 files changed, 19 insertions(+), 4 deletions(-)
```

要点：

- `src/internal/material-links.ts`：`Resolution` 增加 `identity`；`resolveTextureReference` 不再接收 competing 集合；新增 `MapPair`/`pairId`/`arbitrate`（全局竞争）；MTL 处理改为“先解析全部 distinct 对，再仲裁，再重写”；ambiguous warning 按原因去重并列出材质组；模块注释描述身份/启发式两类规则。
- `src/cmd/download.ts`：`preflightProject`（lstat 常规文件、`readProject` 可解析、`--stage` 非空）；项目阶段前固化 `outcome`；`projectRecordFailure` 包装 realpath/indexRootFor/recordTask；成功输出形状不变（`project: { project_dir, action, stage, recorded_files }`）。
- `src/internal/project-store.ts`：`projectRecordCommand(projectDir, input, { root? })` + `shellArg`（仅在需要时加引号）。
- `src/internal/task-command.ts`：`attachToProject` 失败时附加 `recovery: { action: "record_project", command }`、`hint`、原 http/retryable/details。
- `tests/codex-review-round4.test.ts`（新，5 项）；`tests/codex-review-round3.test.ts` C06 移除 make 段（迁入 R4-T01）；`tests/codex-review-round1.test.ts` R03 “expiry during the sleep” 改为 D-044 不变量断言。
- 文档：`decisions.md` D-051–D-053 + D-044 备注；`migration-notes.md` §3.4；README 材质段与 `--project` 记账失败段；SKILL.md 新增 `project.action: "failed"` 处置与材质 note 说明。

## 4. 能力与接口证据

### 4.1 第 4 轮 finding 修复后的实际输出（`round4-probes.mjs` 副本重跑，`68690f9`，脱敏）

**D01**（`download --task-json <tmp>/channel-fallback.json --model-format obj --output-dir <tmp>/workspace/channel-fallback` → exit 0）。保存的 MTL 与服务端原文逐字节相同：

```text
newmtl body
map_Kd body_normal.png
newmtl eyes
map_Kd eyes_diffuse.png

```

`result.downloads.material_links`（贴图、mtllib、texture_maps、状态、warnings）：

```json
{
  "status": "incomplete",
  "textures": [
    {
      "key": "texture.0.base_color",
      "name": "texture_0_base_color.png",
      "source_name": "a.png",
      "set": 0,
      "channel": "basecolor"
    }
  ],
  "mtllib": [
    {
      "line": 1,
      "material": null,
      "reference": "original.mtl",
      "resolved_to": "model.mtl",
      "method": "downloaded_mtl"
    }
  ],
  "texture_maps": [
    {
      "line": 2,
      "material": "body",
      "reference": "body_normal.png",
      "resolved_to": null,
      "method": "ambiguous",
      "candidates": [
        "texture_0_base_color.png"
      ],
      "note": "'body_normal.png' (channel_of_key) and 'eyes_diffuse.png' (channel_in_name) compete for texture_0_base_color.png; different references cannot share one texture without evidence that they name the same image"
    },
    {
      "line": 4,
      "material": "eyes",
      "reference": "eyes_diffuse.png",
      "resolved_to": null,
      "method": "ambiguous",
      "candidates": [
        "texture_0_base_color.png"
      ],
      "note": "'body_normal.png' (channel_of_key) and 'eyes_diffuse.png' (channel_in_name) compete for texture_0_base_color.png; different references cannot share one texture without evidence that they name the same image"
    }
  ],
  "rewritten": [
    "<tmp>/workspace/channel-fallback/model.obj"
  ]
}
```

```json
[
  {
    "code": "material_reference_ambiguous",
    "message": "model.mtl: 'body_normal.png' (channel_of_key) and 'eyes_diffuse.png' (channel_in_name) compete for texture_0_base_color.png; different references cannot share one texture without evidence that they name the same image (body, eyes); the references stay as written — the CLI does not guess between material groups or sources"
  }
]
```

**D02**（`download --task-json <tmp>/project-failure-task.json --all --project <tmp>/workspace/projects/<stamp>_record-failure_958d --workspace <tmp>/workspace` → exit 11；model.glb 已落盘 = true，工作区外 metadata 字节未变 = true；请求：GET /model.glb）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "download",
  "ok": false,
  "result": {
    "source": {
      "kind": "task-json",
      "path": "<tmp>/project-failure-task.json",
      "shape": "api",
      "resource": "text-to-3d",
      "task_id": "round2-task"
    },
    "selection": {
      "selected": [
        "model.glb"
      ],
      "dependencies": []
    },
    "downloads": {
      "state": "completed",
      "files": [
        {
          "key": "model.glb",
          "path": "<tmp>/workspace/projects/<stamp>_record-failure_958d/model.glb",
          "relative_path": "projects/<stamp>_record-failure_958d/model.glb",
          "bytes": 49,
          "sha256": "1390b094bb61759b837fcb096cf53f499d6a5724524a0b55f9700bd22bb87651",
          "content_type": "model/gltf-binary",
          "format": "glb",
          "container_format": null,
          "extracted": null,
          "status": "written",
          "error": null,
          "publish_method": "link",
          "relinked": false
        }
      ],
      "metadata_path": null,
      "material_links": null
    },
    "unknown_urls": [],
    "saved_json": null,
    "project": {
      "project_dir": "<tmp>/workspace/projects/<stamp>_record-failure_958d",
      "action": "failed",
      "stage": "preview",
      "recorded_files": [],
      "error": {
        "code": "local_io",
        "message": "refusing to replace <tmp>/workspace/projects/<stamp>_record-failure_958d/metadata.json: it is not a regular file"
      },
      "recovery": {
        "action": "record_project",
        "automatic": false,
        "command": "meshy project record --project <tmp>/workspace/projects/<stamp>_record-failure_958d --task-id round2-task --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --file model.glb"
      }
    }
  },
  "error": {
    "code": "local_io",
    "message": "1 file(s) were downloaded to <tmp>/workspace/projects/<stamp>_record-failure_958d but recording task round2-task in project <tmp>/workspace/projects/<stamp>_record-failure_958d failed: refusing to replace <tmp>/workspace/projects/<stamp>_record-failure_958d/metadata.json: it is not a regular file",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "record_project",
      "automatic": false,
      "command": "meshy project record --project <tmp>/workspace/projects/<stamp>_record-failure_958d --task-id round2-task --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --file model.glb"
    },
    "hint": "meshy project record --project <tmp>/workspace/projects/<stamp>_record-failure_958d --task-id round2-task --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --file model.glb"
  },
  "warnings": []
}
```

**D03**（reviewer 的稳定中断探针，signal_sent=true，OBJ 完整 = true，磁盘文件 = ['model.mtl', 'model.obj']）→ exit 130，`error.code=interrupted`，`downloads.failed_step=relink`，manifest：

```json
{
  "state": "partial",
  "files": [
    {
      "key": "model_obj",
      "path": "<tmp>/workspace/relink-interrupt/model.obj",
      "bytes": 11600028,
      "sha256": "91bd24a25a223efabd173c0ab2a9bd6125a984d8a0bed601a09ca4c593c6acec",
      "content_type": "model/obj",
      "status": "written",
      "error": null,
      "relinked": false
    },
    {
      "key": "model_mtl",
      "path": "<tmp>/workspace/relink-interrupt/model.mtl",
      "bytes": 18,
      "sha256": "997fd7d9f6b03ab40a1e252c6319d76c351d6f5ea2a431859077faee004243d6",
      "content_type": "text/plain",
      "status": "written",
      "error": null,
      "relinked": false
    }
  ],
  "metadata_path": null,
  "failed_step": "relink"
}
```

### 4.2 `round4-context-checks.mjs` 副本（`68690f9`）：make 最后一步身份

legacy（exit 7，`task_id`/`operation_id` 顶层字段与 `result.submission`、`executed[-1]`、journal 一致）：

```json
{
  "name": "CliError",
  "code": "network",
  "status": 503,
  "task_id": "legacy-step-2",
  "operation_id": "e421a751-67a3-409c-b27e-8279e35693f8",
  "hint": "meshy download --resource text-to-3d --task-id legacy-step-2 --all --output-dir <dir>"
}
```

```json
{
  "route": "text",
  "task_id": "legacy-step-2",
  "submission": {
    "state": "accepted",
    "operation_id": "e421a751-67a3-409c-b27e-8279e35693f8",
    "task_id": "legacy-step-2"
  },
  "executed": [
    {
      "step": 1,
      "resource": "text-to-3d",
      "action": "preview",
      "task_id": "legacy-step-1",
      "status": "SUCCEEDED",
      "operation_id": "4e862c11-4ce8-438e-ad68-d3e2fe51cfb9"
    },
    {
      "step": 2,
      "resource": "text-to-3d",
      "action": "refine",
      "task_id": "legacy-step-2",
      "status": "SUCCEEDED",
      "operation_id": "e421a751-67a3-409c-b27e-8279e35693f8"
    }
  ],
  "next": {
    "get": "meshy text-to-3d get legacy-step-2 --output-schema v1",
    "wait": "meshy text-to-3d wait legacy-step-2 --output-schema v1",
    "stream": "meshy text-to-3d stream legacy-step-2 --format ndjson --output-schema v1"
  }
}
```

v1（exit 7）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "make",
  "ok": false,
  "error": {
    "code": "network",
    "message": "make finished (task v1-step-2) but downloading its assets failed: download failed for model_glb: download failed for http://127.0.0.1:<port>/asset.glb (HTTP 503 Service Unavailable)",
    "http_status": 503,
    "retryable": false,
    "recovery": {
      "action": "download",
      "automatic": false,
      "command": "meshy download --resource text-to-3d --task-id v1-step-2 --all --output-dir <dir>"
    },
    "details": {
      "expired_or_denied": false
    }
  },
  "result": {
    "route": "text",
    "task_id": "v1-step-2",
    "submission": {
      "state": "accepted",
      "operation_id": "d51c6fe0-f66b-4ee7-8c76-ae677e20f796",
      "task_id": "v1-step-2"
    },
    "executed": [
      {
        "step": 1,
        "resource": "text-to-3d",
        "action": "preview",
        "task_id": "v1-step-1",
        "status": "SUCCEEDED",
        "operation_id": "7fd4af5a-ac51-4dfc-b55c-e963e43282bf"
      },
      {
        "step": 2,
        "resource": "text-to-3d",
        "action": "refine",
        "task_id": "v1-step-2",
        "status": "SUCCEEDED",
        "operation_id": "d51c6fe0-f66b-4ee7-8c76-ae677e20f796"
      }
    ],
    "next": {
      "get": "meshy text-to-3d get v1-step-2 --output-schema v1",
      "wait": "meshy text-to-3d wait v1-step-2 --output-schema v1",
      "stream": "meshy text-to-3d stream v1-step-2 --format ndjson --output-schema v1"
    },
    "downloads": {
      "state": "failed",
      "files": [
        {
          "key": "model_glb",
          "path": "<tmp>/make-v1/model.glb",
          "bytes": 0,
          "sha256": "",
          "content_type": null,
          "status": "failed",
          "error": "download failed for http://127.0.0.1:<port>/asset.glb (HTTP 503 Service Unavailable)",
          "relinked": false
        }
      ],
      "metadata_path": null
    }
  }
}
```

### 4.3 tarball 安装 smoke（`68690f9`，`meshy-cli-0.3.0.tgz`；`<verify>` 为临时 npm prefix）

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

`<verify>/prefix/bin/meshy download --task-json task-rigging.synthetic.json --list --output-schema v1` → exit 0

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "download",
  "ok": true,
  "result": {
    "source": {
      "kind": "task-json",
      "path": "<verify>/work/task-rigging.synthetic.json",
      "shape": "api",
      "resource": null,
      "task_id": "fixture-rig-1"
    },
    "assets": [
      {
        "key": "result.rigged_character_glb_url",
        "kind": "rig",
        "format": "glb",
        "model_format": "glb",
        "container_format": null,
        "filename": "rigged_character.glb",
        "dependencies": [],
        "has_url": true
      },
      {
        "key": "result.basic_animations.walking_glb_url",
        "kind": "animation",
        "format": "glb",
        "model_format": "glb",
        "container_format": null,
        "filename": "walking_glb.glb",
        "dependencies": [],
        "has_url": true
      },
      {
        "key": "result.basic_animations.running_glb_url",
        "kind": "animation",
        "format": "glb",
        "model_format": "glb",
        "container_format": null,
        "filename": "running_glb.glb",
        "dependencies": [],
        "has_url": true
      }
    ],
    "unknown_urls": [],
    "product": null,
    "saved_json": null
  },
  "error": null,
  "warnings": []
}
```

`<verify>/prefix/bin/meshy make a red sports car --dry-run --output-schema v1` → exit 0

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "make",
  "ok": true,
  "result": {
    "command": "make",
    "route": "text",
    "steps": [
      {
        "step": 1,
        "resource": "text-to-3d",
        "action": "preview",
        "estimated_credits": 20
      },
      {
        "step": 2,
        "resource": "text-to-3d",
        "action": "refine",
        "estimated_credits": 10
      }
    ],
    "estimated_credits": 30,
    "note": "Estimates only — confirm prices at https://docs.meshy.ai/en/api/pricing and your balance with `meshy balance`.",
    "dry_run": true,
    "requests_made": 0
  },
  "error": null,
  "warnings": []
}
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
      "created_at": "2026-09-08T02:24:23.911Z",
      "updated_at": "2026-09-08T02:24:23.911Z"
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

全部绑定代码 HEAD `68690f9273ff20bbf95e6ac586766e30d977b6b4`（Node v24.20.0，pnpm 11.24.0）；机器记录见 `docs/skill-parity/verification.json`。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 | |
| `pnpm typecheck` | exit 0 | src + tests |
| `pnpm build` | exit 0 | |
| `pnpm test` | **547 pass / 0 fail / 0 skip**（547 项，41 s） | 含 5 项 round-4 新回归 |
| `dist/index.js --version` = package.json | exit 0 | |
| `git diff --check fd94490` / 工作树 | exit 0 / 0 | |
| `poll.test.ts` × 12 | 12/12 | |
| `codex-review-round1.test.ts` × 8 | 8/8 | R03 稳定性提交后；提交前在 `93e55bc` 上观察到 1/6 失败（polls=3） |
| round2+round3+round4 套件 × 3 | 3/3 | 含 SIGINT/竞争用例 |
| `round4-probes.mjs` 副本 | D01/D02 不再复现，D03 signal_sent=true exit 130 | 正向验收在仓库测试 |
| `round3-probes.mjs` 副本 | 0/6 复现（exit 1） | fs.watch C03 signal_sent=true, exit 130（本轮触发成功） |
| `round2-probes.mjs` 副本 | 0/8 复现（exit 1） | |
| `round1-probes.mjs` 副本 | 0/12 复现（exit 1） | |
| `verify-original-regressions.py` | **20/20** | reviewer 的正向核对脚本 |
| `round4-context-checks.mjs` 副本 | **5/5** | make legacy/v1、stream legacy/v1 sidecar、standalone relink SIGINT |
| `stream-finalization-check.mjs` 副本 | passed | 唯一 outcome、连续序号 |
| tarball smoke | **29/29** | `meshy-cli-0.3.0.tgz` sha256 `37c279550179ab1998278b92d828148858f1f2bf3dcc0247306813720e26f35c`，398 files，bins ['meshy', 'meshy-cli'] |

## 6. 真实环境验证

- 已执行：真实公开动画目录 GET（免费、无鉴权；`<verify>/prefix/bin/meshy animation-catalog list --category DailyActions --search wave --output-schema v1` → exit 0；public unauthenticated GET of the animation catalog; result keys: items,count,fetched,total,filters,search_scope,source,authenticated,saved_json; matched=8; total=157）；macOS arm64 tarball 安装 + 29 项本地命令 smoke。
- **not_run**（保持）：T-104 真实 API Key/OAuth 登录、重新登录、真实 token 端点 `user_id`；T-109 Windows x64 / Linux x64；T-110 鉴权 get / 已有任务资产下载；T-111 UV Unwrap / Creative Lab / showcases（付费或权限门控）；T-112 真实切片器 GUI；正式发布（未授权、未执行）。
- 不把离线通过写成 G1-release passed；不进入 S2。

## 7. 打包证据

- `npm pack` → `meshy-cli-0.3.0.tgz`，sha256 `37c279550179ab1998278b92d828148858f1f2bf3dcc0247306813720e26f35c`，398 个文件；必需文件（package.json、dist/index.js、README.md、LICENSE、.env.example、skills/meshy-cli/SKILL.md）齐全 = true；禁止内容（src/、tests/、docs/、node_modules/、.env、pnpm-lock.yaml）不存在 = true。
- `npm install -g --prefix <tmp>` → bins ['meshy', 'meshy-cli']；无 Python 依赖。
- 未 `npm publish`，未推送。

## 8. 需要 Codex 复审的事项

1. R4-F01 的仲裁语义：身份证据（source_name / 落盘名无来源冲突 / source_stem）永不被否决；启发式命中只要有其它 distinct 引用（命中或 ambiguous 候选）争用同一贴图即否决；同一引用在不同 key 下落到不同贴图不重写。请确认这与 §8.3 的意图一致，特别是“身份命中 + 启发式竞争者”时保留身份命中、竞争者原文的选择。
2. R4-F02 的 `project` 失败形状（`action: "failed"` + `error` + `recovery`，`error.recovery.action = "record_project"`）与预检范围；`index_dirty` 未被用于表达记账失败。
3. R4-T01 覆盖是否满足长期保护要求；C06 的 make 段迁出（而非并存）是否可接受。
4. 测试稳定性提交 `68690f9`（R03 “expiry during the sleep”）：把 poll 数上限 2 改为 D-044 不变量断言的理由与证据（提交前 1/6 失败，提交后 8/8）；产品逻辑未改。
5. 旧 `round3-probes.mjs` 的 fs.watch C03 依赖 fs.watch 时机：本轮副本运行 signal_sent=true / exit 130（触发成功，与 D03 结论一致）；稳定的中断证据为 D03、context 的 standalone-relink-interrupt 与仓库 C03（12 MB OBJ + 1 ms 轮询）。

## 9. 最短复现步骤

```bash
cd /Users/ark/Dev/meshy-cli && git checkout 68690f9
export FNM_DIR="$HOME/.local/share/fnm"; eval "$(fnm env --shell bash)"; fnm use 24
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test          # 547/547
node --import tsx --test tests/codex-review-round4.test.ts             # D01, arbitration, D02, preflight, R4-T01
mkdir -p /tmp/r4 && cp /Users/ark/Dev/meshy-agent-integrations-research/reviews/cli-s1-235d6de/{round4-probes.mjs,round4-context-checks.mjs} /tmp/r4/
node /tmp/r4/round4-probes.mjs /Users/ark/Dev/meshy-cli               # D01/D02 reproduced=false, D03 signal_sent=true exit 130
node /tmp/r4/round4-context-checks.mjs /Users/ark/Dev/meshy-cli       # 5/5
git diff --check fd94490
```

## 10. 交给 Codex 的复审提示词

> 请对 `/Users/ark/Dev/meshy-cli` 分支 `feat/skill-parity-s1` 做 Meshy CLI S1 第 5 轮 review。规范：2026-09-07 v1 实施包。代码 HEAD `68690f9273ff20bbf95e6ac586766e30d977b6b4`（= 修复 `93e55bcc717ceb9a368ee43aeeeac69a3fb52197` + 测试稳定性提交）；docs HEAD 为其后的 docs-only commit（`git log -1`）。上一轮（`…/reviews/cli-s1-235d6de/`）结论 changes_requested：R4-F01、R4-F02（P2）与 R4-T01（P3 测试缺口）。请核对：(1) `tests/codex-review-round4.test.ts` 是否按每项 acceptance 做了正向断言（D01 两种顺序、MTL 字节、method/note、bytes/hash、请求次数；D02 完整 v1 形状、exit 11、source/task_id、manifest 摘要、project 失败与 `record_project` 恢复、外部字节不变、恢复命令回放；预检 0 请求；R4-T01 与 journal 对账、POST GET POST GET GET）；(2) `src/internal/material-links.ts` 的两遍解析/仲裁是否覆盖 §8.3 的其它组合（身份 + 启发式、ambiguous 竞争者、同一引用多 key、顺序互换），且 C05/N04/round-1 材质用例未回退；(3) `src/cmd/download.ts` 的 `preflightProject`/`projectRecordFailure` 与 `task-command.ts` `attachToProject` 的恢复信息是否在所有入口一致，`index_dirty` 语义未被滥用；(4) 测试稳定性提交 `68690f9` 是否只改测试且理由成立（D-044）；(5) 前四轮 26 项 finding 是否保持通过（可从副本重跑 round1–4 探针、`verify-original-regressions.py`、`round4-context-checks.mjs`、`stream-finalization-check.mjs`；旧 fs.watch C03 未触发时不得计为通过）。请勿修改 reviewer 证据目录；禁止付费调用、发布、Skill/MCP 迁移。真实账号、Windows/Linux、真实切片器、UV/Creative Lab/showcases 仍为 not_run；G1-release 与 S2 不在本轮范围。
