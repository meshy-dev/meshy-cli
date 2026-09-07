# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. 本文件为 **Round 4**（Codex review 第 3 轮修复后的复审交接）。历次 review：第 1 轮 `…/reviews/cli-s1-6273d9a/`，第 2 轮 `…/reviews/cli-s1-730132b/`，第 3 轮 `…/reviews/cli-s1-cf8905d/`；三处 reviewer 证据目录均未被改动，所有复现脚本从副本运行。

## 0. 第 3 轮 review 结论与本轮修复

- 被 review 的 HEAD：`566f3bdbcdd85d1139e48e3a87d4c6f5e844e43a`（代码 `cf8905d`）；结论 **changes_requested**：6 项 finding（2 P1、4 P2），6 个扩展复现（C01–C06）；reviewer 全量 535/535、首两轮 20 项正向核对通过。
- 修复 commit：`30536d8`（`fix(review): address Codex review round 3 findings R3-F01–R3-F06`）；测试稳定性 commit：`235d6de`（`test(poll)`：真实定时器 smoke 改用循环自身的时钟读数判定——在 30536d8 的一次全量运行中它以 +0.003 ms 误报失败一次，源于 endpoint 内重新取 `performance.now()` 的调用开销；不放宽容差、不跳过）。` 12 files changed, 846 insertions(+), 65 deletions(-)`（相对 566f3bd）。
- 复现脚本重跑（副本，`235d6de`）：`round3-probes.mjs` **0/6 复现**；`round2-probes.mjs` **0/8**；`round1-probes.mjs` **0/12**（均 exit 1 = 并非全部复现）；reviewer 自己的正向核对脚本 `verify-original-regressions.py` 对重跑结果 **20/20 通过**；`stream-finalization-check.mjs` 通过。
- 正向回归：`tests/codex-review-round3.test.ts`（7 项，C01–C06 逐条按 acceptance 断言 + relinkMaterials 已中止/中途中止单测 + v1 make SIGINT）；两轮旧回归全部保留并通过。
- 全量：`pnpm typecheck` 通过；`pnpm test` **542/542**；`git diff --check fd94490` exit 0；`poll.test.ts` 连续 12 次 12/12；round2+round3 套件连续 3 次 3/3。

| ID | 优先级 | 问题 | 修复 | 决策 | 回归测试 | 复现脚本重跑 |
| --- | --- | --- | --- | --- | --- | --- |
| R3-F01 | P1 | 下载 sidecar 仍可覆盖并发创建的文件或跟随新符号链接越界 | `writeMeta` 改为与资产相同的发布规则：发布时按 root 重新 `resolveWithinRoot`（拒绝符号链接叶子），用 `writeJsonFile` 独占原子发布（`link`），预检后出现的文件/符号链接/目录一律 `local_io` 拒绝且不截断；目录模式报告（`saveReportOnly`）同路径 | D-045 | C01+C02（预检后植入符号链接/普通文件/目录 × 目录模式、单文件 `<stem>_meta.json`、legacy；workspace 外文件字节前后一致；manifest 保留 model_glb written） | C01: exit 11, 不再复现 / C02: exit 11, 不再复现 |
| R3-F02 | P1 | 默认 legacy 同步 create 下载失败时仍丢失已受理任务的输出上下文 | get/wait(同步 create)/stream/make 的 legacy 收尾全部套入 `withTaskContext`/`wrapWithResult`；legacy 错误 payload 保持 `name/message/code/status/hint/result` 形状并附加 `task_id`、`operation_id`；`result` 含真实 `submission`、`next`、部分 manifest；`hint`（stderr）为恢复命令，带任务 id | D-046 | C06（默认 schema 同步 create 资产 503：exit 7、task_id、journal 中真实 operation_id、next、manifest、stderr 含 id、1 次 POST；legacy wait 503；legacy sidecar 失败；legacy SIGINT；legacy make 503；v1 make SIGINT） | C06: exit 7, 不再复现 |
| R3-F03 | P2 | 生成的落盘文件名抢先匹配，导致源贴图身份被错误替换 | 解析顺序改为：服务端源文件名 → 落盘名（仅当该文件来源未知或就是同名；若来源为其它文件则 ambiguous 并给出 `note`）→ 源 stem → 引用名通道词 → MTL key 通道 → 唯一贴图；通道规则在多个不同引用竞争同一唯一通道贴图时也判 ambiguous；无来源证据时保留保守回退 | D-047 | C05（源名与生成名交叉碰撞：按图像字节验证红/绿材质各指向正确文件；生成名引用而来源为 a.png → ambiguous + note + incomplete；无来源证据单测） | C05: exit 0, 不再复现 |
| R3-F04 | P2 | 资产全部落盘后的收尾失败仍丢失 manifest | relink / 摘要刷新 / sidecar 发布纳入同一 `finalisationFailure`：保留原分类，重新从磁盘取每个已提交文件的 bytes/sha256（重写过的标 `relinked`），`downloads.state=partial`、完整 `files`、`failed_step`；`meshy download` 的 relink 同样处理 | D-048 | C01+C02（sidecar 目录/文件/符号链接失败后 manifest 完整且 sha 与磁盘一致）、C03（relink 中断）、C06 legacy sidecar 失败 | C02: exit 11, 不再复现 |
| R3-F05 | P2 | SIGINT 在材质重写阶段仍被忽略，最终误报成功 | signal 传入 `relinkMaterials`/`rewriteLines`：首次读取前、每个 chunk 后、发布前检查，中断即删除临时文件并抛 `interrupted`；sidecar 前再检查；结果 exit 130，manifest 摘要重取，OBJ 为原文件或完整重写文件 | D-049 | C03（约 12 MB OBJ，观察到 `.model.obj.tmp-*` 后发送 SIGINT：exit 130、failed_step=relink、无 meta.json、无临时文件、manifest sha=磁盘 sha、OBJ 非部分文件）；relinkMaterials 已中止/中途中止单测 | C03: exit 130, 不再复现 |
| R3-F06 | P2 | 项目目录经过路径别名时，成功下载的资产未记入 metadata | `download --project` 先把项目目录与文件路径 `realpathLenient` 到同一坐标系再算包含关系与相对路径（同 saveTaskSnapshot）；用户可见路径不变；真正在项目外的文件仍不记录 | D-050 | C04（符号链接父目录 + macOS /var 别名：recorded_files 与 metadata.tasks[].files 含 model.glb、无 files_outside_project；显式 --output-dir 项目外仍不记录且有 warning） | C04: exit 0, 不再复现 |

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`235d6de34f4e78210cdf418a7273542fbd4ce906`（= 修复 `30536d8daa92dc9e8d39d99cbdf24d0d20799438` + 测试稳定性提交）；本文件与 verification.json/capability-matrix.json 在其后的 docs-only commit 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`）
- 历次被 review 的 HEAD：round 1 `6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc053cea4e1bf7dee08953e25a3ec858137`）；round 2 `730132bd99a471ed41d6bbf6b200219f13f569ba`（代码 `0388fe804b456a931f871d2f227e2acf22359d77`）；round 3 `566f3bdbcdd85d1139e48e3a87d4c6f5e844e43a`（代码 `cf8905dd285bf16896df053aac253dbf8c672979`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（remote main 与 Skills HEAD 均等于计划 SHA，见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**第 3 轮 6 项 finding 已全部修复并有正向回归，前两轮 17 项在新 HEAD 复核未回退（reviewer 正向脚本 20/20）；自评 passed，等待 Codex 复审确认**（上一轮结论 not_accepted）
- G1-release / ready-for-S2：**not_run**（无复审结论、无真实账号/多 OS/切片器验证、未发布）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`；10 项带 `review_round_3: fixed`，13 项 `review_round_2`，21 项 `review_round_1`，`review_status` 均为 "re-review pending"）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **542 通过 / 0 失败 / 0 跳过**（542 项，含基线原有 363 项；覆盖 74 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权，在 235d6de 重跑）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归，含真实 token 端点是否返回 user_id）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（meshyd 仅只读核对 6 个文件，见 baseline.json；三个 reviewer 目录未被改动）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
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

` 117 files changed, 21456 insertions(+), 935 deletions(-)`

| 批次 | commit | 改动与用户行为 | 关键验证 |
| --- | --- | --- | --- |
| B00 | `docs(skill-parity)` | baseline/endpoint-contracts/decisions/migration-notes/fixtures；无代码 | `validate` 由 tests/resource-registry.test.ts 绑定 |
| B01 | `feat(cli): B01` | v1 envelope、退出码 10–13/130、`CliError` 分类；全局 `--output-schema/--api-key-file/--workspace/--no-update-check/--base-url-creative-lab`；Commander 参数错误 → exit 2；本地 runtime；SIGINT→130；stdout flush；update-check 策略；balance/api/delete 的 v1 + `--save-json` | tests/cli-contract, env-file, result |
| B02 | `feat(client): B02` | transport（路径校验、拒绝 redirect、body 级超时、body 上限、connect/unknown phase）；resource registry（16 task + 8 Creative Lab stage + 3 query）；TaskView（缺失字段为 null）；媒体规范化移到合并后的 payload、支持 data URI；animation-catalog（无鉴权）、showcases（单次计费 GET）；registry 驱动的 `resources` | tests/transport, resource-registry, task-view, catalog-showcases, file-input |
| B03 | `feat(tasks): B03` | create/get/wait/stream/delete/list 双 schema；get 任意状态 exit 0；`--timeout 0` 单次查询；operation journal（POST 前落盘、5xx/畸形 2xx/断线 → exit 10、`--operation-id` 重放/冲突）；SSE 解析与 stream 语义（ndjson 事件 + outcome）；`make --async` 单次 POST + `--stop-after-first`；uv-unwrap；creative-lab 4×2 命令树与逐产品校验 | tests/task-lifecycle, sse, operation-store, uv-creative-lab |
| B04 | `feat(download): B04` | 资产枚举（lamp 部件 STL/ZIP、keychain/fridge OBJ=ZIP bundle、嵌套 basic_animations、多视角/alpha 缩略图、报告）；安全下载（无凭据、逐跳重定向校验、私网拒绝、大小上限、sha256、MIME 校正、magic 校验、link 独占发布、realpath 作用根）；`meshy download` | tests/artifacts, download-command, download(legacy) |
| B05 | `feat(project): B05` | metadata.json v2 + legacy 迁移备份、history 索引、(task_id,stage) 合并、锁顺序、index_dirty；`project init/record/show/list/rebuild-index`；任务动词与 download 的 `--project/--stage` | tests/project-store（含多进程） |
| B06–B08 | `feat(local): B06-B08` | `inspect faces`（unknown≠0，exit 12/13，仅描述 remesh）；`mesh prepare-print`（两遍流式、oracle 校验、材质依赖、`--in-place`）；`slicer detect/open`（七注册、三 OS 规则、无默认应用 fallback）；`doctor`（默认本地，`--check-api` 单次 balance） | tests/inspect, obj-transform, slicers, doctor |
| B09 | `chore(release)` + docs commit | 0.3.0 候选版本、README、随包 SKILL.md、.env.example、T-105；verification.json、REVIEW_HANDOFF | 本节 5、7 |
| Review R1 | `fix(review)` `0388fe8` | F01–F10（任务上下文/预检/共享 `submitCreate`、workspace 写入根、依赖复制根检查、凭据/媒体指纹、截止时间、嵌套合并、材质重链接、stream -o） | tests/codex-review-round1, operation-store, poll |
| Review R2 | `fix(review)` `cf8905d` | R2-F01–R2-F07（报告 -o/索引根/mkdir 顺序、多材质源名映射、stream 统一 outcome、部分 manifest、传输阶段 SIGINT、OAuth login_id、确定性 deadline 测试） | tests/codex-review-round2, poll, auth-headless |
| Review R3 | `fix(review)` `30536d8` + `test(poll)` `235d6de` | §0 表中的 R3-F01–R3-F06：`download.ts` sidecar 安全发布、统一收尾失败处理（`finalisationFailure`、`redigest`、`failed_step`）、relink 信号；`material-links.ts` 源身份优先与通道竞争歧义、`rewriteLines` 合作式中断；`task-command.ts`/`make.ts` legacy 收尾任务上下文；`errors.ts` legacy payload 附加 `task_id`/`operation_id`；`cmd/download.ts` realpath 坐标系记录项目文件；decisions D-045..D-050、migration-notes §3.3、README、SKILL.md；poll smoke 以循环时钟读数判定 | tests/codex-review-round3 + 三轮复现脚本重跑 + reviewer 正向脚本 20/20 |

## 4. 能力与接口证据

- 更新后的 capability-matrix 路径：`docs/skill-parity/capability-matrix.json`（`review_rounds[0..2]`、各能力 `review_round_1/2/3`）
- endpoint-contracts 与模型/媒体参数映射：`docs/skill-parity/endpoint-contracts.json`（与 `src/client/resource-registry.ts` 由 `tests/resource-registry.test.ts` 逐字段对账；本轮未改）
- v1 JSON schema / 错误码定义：`src/internal/result.ts`（六固定键）、`src/internal/errors.ts`（`CliErrorCode` → 退出码表）；`README.md` "Stable machine output"。本轮新增/变化字段（均为附加）：`result.downloads.failed_step`（relink | digest | sidecar）；`material_links.texture_maps[].note`；legacy 错误 payload 顶层 `task_id`、`operation_id`；legacy 错误 `hint` 为恢复命令
- legacy compatibility / migration notes：`docs/skill-parity/migration-notes.md`（§3 兼容表、§3.1–§3.3 三轮修正；legacy 输出与文件布局不变，错误 payload 只增字段）
- intentional differences：`docs/skill-parity/migration-notes.md` §2（2.1–2.12）；三轮设计选择：材质映射按来源身份、多候选与通道竞争拒绝猜测（D-039/D-047）；无账户身份 OAuth 存量 profile 拒绝重放（D-043）；sidecar 与资产同规则发布（D-045）；越界索引根跳过而非越界写入（D-038）
- 限权 API / 未支持的 OS / deferred 新功能：UV/Creative Lab/showcases 真实调用 not_run；Windows/Linux 仅 fixture 覆盖；新 Creative Lab 产品记录为 deferred（矩阵 DF-001）

### 脱敏实际 CLI 输出（tarball 安装的 `235d6de`，loopback mock；`<tmp>`/`<home>` 为替换后的路径）

`text-to-3d create --mode preview --prompt "a cactus" --async --output-schema v1`（exit=0）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.create",
  "ok": true,
  "result": {
    "task": null,
    "submission": {
      "state": "accepted",
      "operation_id": "f64531e3-a77a-4223-a4dd-de9de9d1fabb",
      "task_id": "fixture-task-a",
      "request_id": null
    },
    "downloads": {
      "state": "not_requested",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null,
    "task_id": "fixture-task-a",
    "next": {
      "get": "meshy text-to-3d get fixture-task-a --output-schema v1",
      "wait": "meshy text-to-3d wait fixture-task-a --output-schema v1",
      "stream": "meshy text-to-3d stream fixture-task-a --format ndjson --output-schema v1"
    },
    "project": null
  },
  "error": null,
  "warnings": []
}
```

`text-to-3d get fixture-task-a --output-schema v1`（exit=0，IN_PROGRESS）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.get",
  "ok": true,
  "result": {
    "task": {
      "task_id": "fixture-task-a",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "IN_PROGRESS",
      "progress": 52,
      "preceding_tasks": null,
      "created_at": 1757200000000,
      "started_at": 1757200010000,
      "finished_at": 0,
      "expires_at": 0,
      "face_count": null,
      "consumed_credits": null,
      "model_urls": {},
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "not_requested",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null
  },
  "error": null,
  "warnings": []
}
```

`text-to-3d get fixture-task-failed --output-schema v1`（exit=0，FAILED 仍是成功的查询）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.get",
  "ok": true,
  "result": {
    "task": {
      "task_id": "fixture-task-failed",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "FAILED",
      "progress": 0,
      "preceding_tasks": null,
      "created_at": 1757200000000,
      "started_at": 1757200010000,
      "finished_at": 1757200020000,
      "expires_at": 0,
      "face_count": null,
      "consumed_credits": 0,
      "model_urls": {},
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": {
        "message": "The server is busy. Please try again later."
      }
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "not_requested",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null
  },
  "error": null,
  "warnings": []
}
```

`text-to-3d wait fixture-task-a --timeout 0 --output-schema v1`（exit=8）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.wait",
  "ok": false,
  "result": {
    "task": {
      "task_id": "fixture-task-a",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "IN_PROGRESS",
      "progress": 52,
      "preceding_tasks": null,
      "created_at": 1757200000000,
      "started_at": 1757200010000,
      "finished_at": 0,
      "expires_at": 0,
      "face_count": null,
      "consumed_credits": null,
      "model_urls": {},
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "not_requested",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null,
    "task_id": "fixture-task-a",
    "wait": {
      "timed_out": true,
      "elapsed_seconds": 0.01,
      "polls": 1
    },
    "next": {
      "get": "meshy text-to-3d get fixture-task-a --output-schema v1",
      "wait": "meshy text-to-3d wait fixture-task-a --output-schema v1",
      "stream": "meshy text-to-3d stream fixture-task-a --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "timed_out",
    "message": "task fixture-task-a did not reach a terminal status within 0s (last status: IN_PROGRESS); the server keeps running it",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "wait",
      "automatic": false,
      "command": "meshy text-to-3d wait fixture-task-a --output-schema v1"
    }
  },
  "warnings": []
}
```

`text-to-3d create ... --async`，服务端返回 500（exit=10，仅一次 POST，日志记录 unknown）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.create",
  "ok": false,
  "result": {
    "submission": {
      "state": "unknown",
      "operation_id": "d7354b5e-d51d-439a-8e8d-e47cd1738dce",
      "task_id": null
    },
    "task": null,
    "downloads": {
      "state": "not_requested",
      "files": [],
      "metadata_path": null
    }
  },
  "error": {
    "code": "submission_unknown",
    "message": "the create request was sent but its outcome is unknown (meshy api 500 on /text-to-3d: internal error); the server may or may not have created a task",
    "http_status": 500,
    "retryable": false,
    "recovery": {
      "action": "reconcile",
      "automatic": false,
      "command": "meshy text-to-3d list --output-schema v1   # then match operation d7354b5e-d51d-439a-8e8d-e47cd1738dce by time/prompt before creating again"
    }
  },
  "warnings": []
}
```

`download --resource rigging --task-id fixture-rig-1 --asset result.basic_animations.walking_glb_url --output walking.glb`（exit=0）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "download",
  "ok": true,
  "result": {
    "source": {
      "kind": "api",
      "resource": "rigging",
      "task_id": "fixture-rig-1",
      "status": "SUCCEEDED"
    },
    "selection": {
      "selected": [
        "result.basic_animations.walking_glb_url"
      ],
      "dependencies": []
    },
    "downloads": {
      "state": "completed",
      "files": [
        {
          "key": "result.basic_animations.walking_glb_url",
          "path": "<tmp>/walking.glb",
          "relative_path": "walking.glb",
          "bytes": 28,
          "sha256": "617b6574607e137a4eeb3821a0e3ce60abd56e34d8c4d256e159f61764f156a8",
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
    "project": null
  },
  "error": null,
  "warnings": []
}
```

### 第 3 轮 finding 修复后的实际输出（`round3-probes.mjs` 副本重跑，`235d6de`，脱敏）

C01 · `get --workspace W -o W/out`，资产 GET 期间在 `W/out/meta.json` 植入指向 W 外文件的符号链接（exit 11，外部文件内容不变，manifest 保留 model_glb）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.get",
  "ok": false,
  "result": {
    "task": {
      "task_id": "round2-task",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "SUCCEEDED",
      "progress": null,
      "preceding_tasks": null,
      "created_at": null,
      "started_at": null,
      "finished_at": null,
      "expires_at": null,
      "face_count": null,
      "consumed_credits": null,
      "model_urls": {
        "glb": "http://127.0.0.1:<port>/asset.glb"
      },
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "partial",
      "files": [
        {
          "key": "model_glb",
          "path": "<tmp>/workspace/sidecar-race/model.glb",
          "bytes": 49,
          "sha256": "1390b094bb61759b837fcb096cf53f499d6a5724524a0b55f9700bd22bb87651",
          "content_type": "model/gltf-binary",
          "status": "written",
          "error": null,
          "relinked": false
        }
      ],
      "metadata_path": null,
      "failed_step": "sidecar"
    },
    "saved_json": null,
    "task_id": "round2-task",
    "next": {
      "get": "meshy text-to-3d get round2-task --output-schema v1",
      "wait": "meshy text-to-3d wait round2-task --output-schema v1",
      "stream": "meshy text-to-3d stream round2-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "local_io",
    "message": "task round2-task is SUCCEEDED but downloading its assets failed: 1 file(s) were written but the sidecar step failed: sidecar path <tmp>/workspace/sidecar-race/meta.json is a symbolic link; refusing to write through it",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "download",
      "automatic": false,
      "command": "meshy download --resource text-to-3d --task-id round2-task --all --output-dir <dir>"
    },
    "hint": "meshy download --resource text-to-3d --task-id round2-task --all --output-dir <dir>"
  },
  "warnings": []
}
```

C02 · 资产 GET 期间在 `meta.json` 位置出现同名目录（exit 11，`downloads.state=partial`、`failed_step=sidecar`、model.glb 在磁盘）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.get",
  "ok": false,
  "result": {
    "task": {
      "task_id": "round2-task",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "SUCCEEDED",
      "progress": null,
      "preceding_tasks": null,
      "created_at": null,
      "started_at": null,
      "finished_at": null,
      "expires_at": null,
      "face_count": null,
      "consumed_credits": null,
      "model_urls": {
        "glb": "http://127.0.0.1:<port>/asset.glb"
      },
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "partial",
      "files": [
        {
          "key": "model_glb",
          "path": "<tmp>/workspace/sidecar-failure/model.glb",
          "bytes": 49,
          "sha256": "1390b094bb61759b837fcb096cf53f499d6a5724524a0b55f9700bd22bb87651",
          "content_type": "model/gltf-binary",
          "status": "written",
          "error": null,
          "relinked": false
        }
      ],
      "metadata_path": null,
      "failed_step": "sidecar"
    },
    "saved_json": null,
    "task_id": "round2-task",
    "next": {
      "get": "meshy text-to-3d get round2-task --output-schema v1",
      "wait": "meshy text-to-3d wait round2-task --output-schema v1",
      "stream": "meshy text-to-3d stream round2-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "local_io",
    "message": "task round2-task is SUCCEEDED but downloading its assets failed: 1 file(s) were written but the sidecar step failed: refusing to overwrite existing file: /private<tmp>/workspace/sidecar-failure/meta.json (pass --overwrite, or choose another path)",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "choose_path",
      "automatic": false
    },
    "hint": "meshy text-to-3d wait round2-task --output-schema v1"
  },
  "warnings": []
}
```

C03 · OBJ 重写阶段发送 SIGINT（exit 130，`failed_step=relink`，无 meta.json）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.get",
  "ok": false,
  "result": {
    "task": {
      "task_id": "round2-task",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "SUCCEEDED",
      "progress": null,
      "preceding_tasks": null,
      "created_at": null,
      "started_at": null,
      "finished_at": null,
      "expires_at": null,
      "face_count": null,
      "consumed_credits": null,
      "model_urls": {
        "obj": "http://127.0.0.1:<port>/large.obj",
        "mtl": "http://127.0.0.1:<port>/original.mtl"
      },
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "partial",
      "files": [
        {
          "key": "model_obj",
          "path": "<tmp>/workspace/relink-interrupt/model.obj",
          "bytes": 4000028,
          "sha256": "f00b46cb6d822e2ce93c6a7cf61251e80b76eb6ef71d9ef30bb07129330ac34d",
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
    },
    "saved_json": null,
    "task_id": "round2-task",
    "next": {
      "get": "meshy text-to-3d get round2-task --output-schema v1",
      "wait": "meshy text-to-3d wait round2-task --output-schema v1",
      "stream": "meshy text-to-3d stream round2-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "interrupted",
    "message": "task round2-task is SUCCEEDED but downloading its assets was interrupted: 2 file(s) were written but the relink step was interrupted: interrupted while rewriting model.obj",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "download",
      "automatic": false,
      "command": "meshy download --resource text-to-3d --task-id round2-task --all --output-dir <dir>"
    },
    "hint": "meshy download --resource text-to-3d --task-id round2-task --all --output-dir <dir>"
  },
  "warnings": []
}
```

C04 · 通过符号链接父目录访问的项目（exit 0，`recorded_files=["model.glb"]`）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "download",
  "ok": true,
  "result": {
    "source": {
      "kind": "task-json",
      "path": "<tmp>/alias-projects/20260907_232307_alias-review_3a3b/task.json",
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
          "path": "/private<tmp>/real-projects/20260907_232307_alias-review_3a3b/model.glb",
          "relative_path": "model.glb",
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
      "project_dir": "<tmp>/alias-projects/20260907_232307_alias-review_3a3b",
      "action": "added",
      "stage": "preview",
      "recorded_files": [
        "model.glb"
      ]
    }
  },
  "error": null,
  "warnings": []
}
```

C05 · 源文件名与生成名交叉碰撞后的 `model.mtl`（红材质 → 红图 `texture_0_base_color.png`）：

```
newmtl red
map_Kd texture_0_base_color.png
newmtl green
map_Kd texture_1_base_color.png
```

C06 · 默认 legacy schema 同步 create，资产 503（exit 7；payload 含 `task_id`/`operation_id`/`result.submission`/`next`/manifest）：

```json
{
  "name": "CliError",
  "message": "download failed for model_glb: download failed for http://127.0.0.1:<port>/missing.glb (HTTP 503 Service Unavailable)",
  "code": "network",
  "status": 503,
  "hint": "meshy text-to-3d wait paid-legacy-created-id --output-schema v1",
  "task_id": "paid-legacy-created-id",
  "operation_id": "<uuid>",
  "result": {
    "task": {
      "task_id": "paid-legacy-created-id",
      "resource": "text-to-3d",
      "endpoint": "/openapi/v2/text-to-3d",
      "type": "text-to-3d-preview",
      "name": null,
      "status": "SUCCEEDED",
      "progress": null,
      "preceding_tasks": null,
      "created_at": null,
      "started_at": null,
      "finished_at": null,
      "expires_at": null,
      "face_count": null,
      "consumed_credits": null,
      "model_urls": {
        "glb": "http://127.0.0.1:<port>/missing.glb"
      },
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": null,
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": "<uuid>",
      "task_id": "paid-legacy-created-id",
      "request_id": null
    },
    "downloads": {
      "state": "failed",
      "files": [
        {
          "key": "model_glb",
          "path": "<tmp>/workspace/legacy-created/model.glb",
          "bytes": 0,
          "sha256": "",
          "content_type": null,
          "status": "failed",
          "error": "download failed for http://127.0.0.1:<port>/missing.glb (HTTP 503 Service Unavailable)",
          "relinked": false
        }
      ],
      "metadata_path": null
    },
    "saved_json": null,
    "task_id": "paid-legacy-created-id",
    "next": {
      "get": "meshy text-to-3d get paid-legacy-created-id --output-schema v1",
      "wait": "meshy text-to-3d wait paid-legacy-created-id --output-schema v1",
      "stream": "meshy text-to-3d stream paid-legacy-created-id --format ndjson --output-schema v1"
    },
    "wait": {
      "timed_out": false,
      "elapsed_seconds": 0,
      "polls": 1
    }
  }
}
```

## 5. 实际验证记录

全部绑定代码 HEAD `235d6de34f4e78210cdf418a7273542fbd4ce906`，环境 macOS 26.6 arm64 / Node v24.20.0 / pnpm 11.24.0；日志见 `docs/skill-parity/verification.json`（`final_runs`、`package_smoke`、`review_rounds`）。

| 命令 / 测试 ID | 代码 SHA | 环境 | exit code | 结果 | 日志/fixture/报告 |
| --- | --- | --- | --- | --- | --- |
| `node --version` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm --version` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm install --frozen-lockfile` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm typecheck` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm test` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed (542 tests, 542 pass, 0 fail) | verification.json final_runs |
| `pnpm build` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `bash -c test "$(node dist/index.js --version)" = "$(node -p "require(\"./package.json\").version")"` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm pack --json --pack-destination /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r5` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm install -g --prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r5/prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r5/meshy-cli-0.3.0.tgz` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `git diff --check fd94490` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `for i in 1..12: node --import tsx --test tests/poll.test.ts` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed — 12/12 runs; the real-timer smoke now judges with the loop's own clock reading (one +0.003 ms false failure was seen on 30536d8 before this change) | verification.json final_runs |
| `for i in 1..3: node --import tsx --test tests/codex-review-round3.test.ts tests/codex-review-round2.test.ts` | 235d6de34f4e | macOS arm64, Node 24.20.0 | 0 | passed — 3/3 runs (SIGINT-during-relink, sidecar race and other timing-sensitive cases) | verification.json final_runs |
| npm pack 文件清单 + 必需文件 + 禁止内容 | 235d6de34f4e | 同上 | 0 | passed（398 files；dist/skills/README/LICENSE/.env.example 存在；无 .env/credentials/tests/docs/src） | verification.json package_smoke |
| smoke:version | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:version_cli | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help_cli | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_help | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_nokey_json | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:balance_nokey_v1 | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:resources_v1 | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_slicers | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_api_nokey | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:slicer_detect | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_pass | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_fail | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 12 (expected 12) | passed | verification.json package_smoke |
| smoke:inspect_unknown | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 13 (expected 13) | passed | verification.json package_smoke |
| smoke:mesh_prepare | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:mesh_refuse_overwrite | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 11 (expected 11) | passed | verification.json package_smoke |
| smoke:project_init | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_record | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_show | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_list | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_list | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_no_selector | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:make_dry_run | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:usage_unknown_flag | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:uv_help | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:creative_lab_help | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:stream_help | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:catalog_live | 235d6de34f4e | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| 第 3 轮复现脚本 `round3-probes.mjs`（6 场景） | 235d6de34f4e | node v24.20.0，loopback，临时目录 | 1（= 并非全部复现） | 0/6 复现 | verification.json review_rounds[2].probe_rerun |
| 第 2 轮复现脚本 `round2-probes.mjs`（8 场景） | 235d6de34f4e | 同上 | 1 | 0/8 复现（无回退） | verification.json review_rounds[1].reverified_on |
| 第 1 轮复现脚本 `round1-probes.mjs`（12 场景） | 235d6de34f4e | 同上 | 1 | 0/12 复现（无回退） | verification.json review_rounds[0].reverified_on |
| reviewer 正向核对 `verify-original-regressions.py`（20 项） | 235d6de34f4e | 对上述重跑结果 | 0 | 20/20 passed | verification.json review_rounds[2].reviewer_positive_checker |
| reviewer 补测 `stream-finalization-check.mjs` | 235d6de34f4e | 同上 | 0 | passed | verification.json review_rounds[2].stream_finalization_check |
| 新增行为用例 T-001…T-108（离线部分）+ R01–R12 + N01–N08 + C01–C06 | 235d6de34f4e | node:test + tsx，loopback mock，临时目录 | 0 | passed（`pnpm test` 542/542） | tests/*.test.ts；verification.json behavior_tests |

基线（fd94490）上 `pnpm test` 363/363 通过，无基线失败；本次没有删除或跳过任何既有测试。唯一改写的既有断言：poll 真实定时器 smoke 的判定时钟（见 §0），预期不放宽。

## 6. 真实环境验证

| 环境/能力 | 身份/资源（脱敏） | 实际结果 | 未完成原因 | 补验方式 |
| --- | --- | --- | --- | --- |
| API Key 与 OAuth profile 回归 | 无 | not_run | 本会话无测试账户/Key | 用测试 Key：`meshy doctor --check-api`、`meshy balance --output-schema v1`、`meshy auth status`；OAuth：`meshy auth login` 后 `meshy text-to-3d list --output-schema v1`；核对 D-043：真实 token 端点是否返回 `user_id`，登录后 profile 是否带 `login_id` |
| UV / Creative Lab | 无 | not_run | 计费/账号 gate，未获预算授权 | `meshy uv-unwrap create --input-task-id <已有 SUCCEEDED 任务> --async --output-schema v1` → `wait`；`meshy creative-lab figure prototype create --image-url <png> --async` → `wait` → `build create --input-task-id`；记录 task id、请求次数、消耗额度 |
| Enterprise showcases（计费查询） | 无 | not_run | 每次请求计费且需 Enterprise | `meshy showcases list --page-size 1 --output-schema v1`（一次）；核对 `showcase_type=animated` 别名是否被服务端接受（D-007） |
| 公开动画目录（免费、无鉴权） | 无需身份 | passed（1 次 GET，157 条，8 条匹配 "wave"，在 235d6de 重跑） | — | verification.json live_verification T-110 partial |
| macOS arm64 | 本机 | passed（tarball 安装 + 29 项 smoke） | — | verification.json package_smoke |
| Windows x64 | 无 | not_run | 无主机 | 安装 tarball，运行 `meshy doctor --check-slicers`、`meshy slicer detect`、`meshy mesh prepare-print`；检测规则已用 fixture 覆盖（T-088/T-089） |
| Linux x64 | 无 | not_run | 无主机 | 同上；CI（ubuntu, Node 24/26）会在推送后覆盖安装 smoke |
| 真实 slicer open | 无 | not_run | 本机未安装任何注册切片器 | 安装 OrcaSlicer 后 `meshy slicer open --slicer OrcaSlicer --file <obj>`，仅验证启动 |
| 真实 Meshy 多材质 OBJ 的引用重链接（D-039/D-047） | 无 | not_run | 需要真实 refine 任务的 OBJ+MTL+多组贴图 | `meshy download --resource text-to-3d --task-id <id> --model-format obj --output-dir <dir>`，检查 `material_links.status` 与 `texture_maps[].method/note`（真实 MTL 是否引用 URL 末段文件名） |

## 7. 打包证据

- 候选版本：`0.3.0`（package.json，**未发布**；版本号可由 reviewer 调整）
- tarball 路径：`/private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r5/meshy-cli-0.3.0.tgz`（`npm pack --json --pack-destination`；复现见 §9）
- SHA256：`f29e8a168af1c66fe58c9ee53a4b392beca41350bccf55bf58c22eebf5e5f930`
- npm pack 文件清单：398 个文件；必需项 dist/index.js、skills/meshy-cli/SKILL.md、skills/meshy-cli/animation-library.json、README.md、LICENSE、.env.example、package.json 均在；无 .env / credentials / tests / docs / src / node_modules
- 临时安装 prefix：`npm install -g --prefix <tmp> <tarball>` → `<tmp>/bin/meshy` 与 `<tmp>/bin/meshy-cli` 均指向 `dist/index.js`
- 两个 bin、sharp、本地无 Key/无 Python 验证：29 项 smoke 全部符合预期（含 `MESHY_API_KEY=""` 下 balance 的 stdout 为 JSON、exit 3；无 Key 的本地命令 exit 0；dist 中不含 python 引用）
- 是否发布：**未发布**

## 8. 需要 Codex 复审的事项

1. **sidecar 发布（R3-F01）**：`writeMeta` 现在 `resolveWithinRoot`（拒绝符号链接叶子）+ `writeJsonFile` 独占发布；预检仍保留为早退。`saveReportOnly` 目录模式同路径；单文件模式的报告 JSON 已在写入前紧邻校验。legacy sidecar 文件权限从默认改为显式 0o644。
2. **legacy 任务上下文（R3-F02）**：`toErrorPayload` 为 CliError 附加顶层 `task_id`/`operation_id`（仅在 result 中存在时）；`hint` 回退为恢复命令 → stderr 出现任务 id；`make` legacy 的 `submission.operation_id` 取自最后一步 executed 记录。
3. **材质身份（R3-F03）**：来源名优先于落盘名；生成名引用而来源为其它文件 → ambiguous + `note`；通道规则在多个不同引用竞争同一唯一贴图时判 ambiguous（两个材质各引用一张不同图但只下载到一张同通道贴图时保持原样并报警，不把唯一贴图分给其中一个）；无来源证据的单测回退保留。
4. **收尾失败处理（R3-F04）**：`finalisationFailure` 从磁盘重取摘要并以摘要变化推断 `relinked`；`failed_step` 三值；`downloadAssets` 的 relink 同样包裹；digest 步骤本身失败（读文件失败）也走同一路径。
5. **relink 中断（R3-F05）**：`rewriteLines` 在每个 chunk 后检查 signal，发布前再检查并删除临时文件；OBJ 要么原样要么完整重写；C03 用轮询观察 `.model.obj.tmp-*` 触发 SIGINT（约 12 MB OBJ），并有 relinkMaterials 已中止 / 2 ms 后中止的进程内单测。
6. **别名路径（R3-F06）**：`download --project` 的 `relative(realpath(project), realpath(file))`；`attachToProject` 的 `extra.files` 目前无调用方传入路径，故未改。
7. **测试稳定性**：poll smoke 以循环的 `now()` 读数判定“截止前决策”（`starts.every(t < deadline)`），不再用 endpoint 内新取的时钟；确定性 fake-clock 用例不变；12/12 重复通过。
8. 前三轮 §8 的其余事项仍然有效且本轮未改动相关代码（路由等价、transport 边界、锁顺序、slicer OS 行为、not_run 项）。

## 9. 最短复现步骤

```sh
git clone https://github.com/meshy-dev/meshy-cli.git && cd meshy-cli
git fetch <this-branch-remote> feat/skill-parity-s1 && git checkout 235d6de34f4e78210cdf418a7273542fbd4ce906   # 或使用本地仓库 /Users/ark/Dev/meshy-cli
node --version        # v24.x
corepack enable && pnpm --version   # 11.24.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test             # 先 tsc 生成 dist，再运行 node:test（约 41 s；loopback mock，无外网、无凭据）
node --import tsx --test tests/codex-review-round3.test.ts tests/codex-review-round2.test.ts tests/codex-review-round1.test.ts tests/poll.test.ts
for i in $(seq 1 12); do node --import tsx --test tests/poll.test.ts >/dev/null || echo "run $i failed"; done
pnpm build
mkdir -p /tmp/probes && cp /path/to/reviews/cli-s1-cf8905d/round3-probes.mjs /path/to/reviews/cli-s1-cf8905d/round2-probes.mjs /path/to/reviews/cli-s1-cf8905d/round1-probes.mjs /path/to/reviews/cli-s1-cf8905d/stream-finalization-check.mjs /path/to/reviews/cli-s1-cf8905d/verify-original-regressions.py /tmp/probes/
node /tmp/probes/round3-probes.mjs "$PWD"   # 期望 exit 1 且 6 个 reproduced=false
node /tmp/probes/round2-probes.mjs "$PWD"   # 期望 exit 1 且 8 个 reproduced=false
node /tmp/probes/round1-probes.mjs "$PWD"   # 期望 exit 1 且 12 个 reproduced=false
python3 /tmp/probes/verify-original-regressions.py   # 期望 passed 20 / total 20
node /tmp/probes/stream-finalization-check.mjs "$PWD"
git diff --check fd94490
npm pack --json --pack-destination /tmp/meshy-pack && shasum -a 256 /tmp/meshy-pack/meshy-cli-0.3.0.tgz
npm install -g --prefix /tmp/meshy-prefix /tmp/meshy-pack/meshy-cli-0.3.0.tgz
export MESHY_CONFIG_DIR=$(mktemp -d)
/tmp/meshy-prefix/bin/meshy --version && /tmp/meshy-prefix/bin/meshy doctor --output-schema v1
MESHY_API_KEY= /tmp/meshy-prefix/bin/meshy balance --output-schema v1 ; echo "exit=$?"   # 3, stdout 为 v1 envelope
```

不依赖作者机器上的凭据、Python 或全局包；`tests/helpers/cli.ts` 为每次子进程创建隔离的 `MESHY_CONFIG_DIR` 与 cwd，并显式指向 loopback mock。复现脚本请从副本运行（它们在自身目录写结果文件）；脚本 exit 0 表示缺陷全部复现，exit 1 表示并非全部复现——正向验收以仓库内测试与 reviewer 的正向核对脚本为准。

## 10. 交给 Codex 的复审提示词

请复审 Meshy CLI S1 第 3 轮 review（reviews/cli-s1-cf8905d，R3-F01–R3-F06）的修复，并确认前两轮（reviews/cli-s1-6273d9a F01–F10、reviews/cli-s1-730132b R2-F01–R2-F07）修复未回退。仓库、base/head SHA 见本文件；代码 HEAD `235d6de34f4e78210cdf418a7273542fbd4ce906`（= 修复 `30536d8` + 测试稳定性提交；本文件所在 docs commit 不改代码），规范仍是 2026-09-07 v1 实施包。先核实 diff `566f3bdbcdd85d1139e48e3a87d4c6f5e844e43a..235d6de34f4e78210cdf418a7273542fbd4ce906` 与 verification.json/capability-matrix.json 绑定同一 HEAD，再逐项核对 §0 表：修复是否完整覆盖 finding 的触发条件与 acceptance（预检后目标变化、legacy 任务身份、下载完成后的失败与中断、材质来源身份、项目路径别名）、是否引入回归、正向回归测试是否真正断言了 expected（退出码、JSON 形状、task_id/submission/operation_id、请求次数、落盘内容与 manifest hash、ndjson 唯一 outcome 与序号、被拒目标连目录都不创建、外部文件字节不变），并重跑三个复现脚本副本、`verify-original-regressions.py`、`pnpm test`、`git diff --check`。

请优先检查 §8 列出的 8 项风险，以及任何新的可复现 bug、重复付费风险、凭据/路径问题、丢失资产/项目记录、OBJ 错误和伪造完成状态。不要做未授权付费调用、发布或 Skill/MCP 迁移。每项 finding 给出优先级、文件/行号、触发条件、影响与修复建议；区分代码缺陷、测试缺口与尚未完成的外部验证。最后分别判断 G1-code 是否可接受、G1-release 是否满足以及是否允许进入 S2。没有发现也要说明验证范围和剩余限制。
