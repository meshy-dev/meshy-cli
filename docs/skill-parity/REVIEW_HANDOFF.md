# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. 本文件为 **Round 3**（Codex review 第 2 轮修复后的复审交接）。第 1 轮 review 见 `meshy-agent-integrations-research/reviews/cli-s1-6273d9a/`，第 2 轮见 `…/reviews/cli-s1-730132b/`；两处 reviewer 证据目录均未被改动，复现脚本从副本运行。

## 0. 第 2 轮 review 结论与本轮修复

- 被 review 的 HEAD：`730132bd99a471ed41d6bbf6b200219f13f569ba`（代码 `0388fe8`）；结论 **changes_requested**：7 项 finding（1 P1、6 P2），8 个独立复现（N01–N08）；reviewer 全量测试 521/522（唯一失败为真实时钟的 poll 断言）；首轮 12 个场景已被 reviewer 正向核对通过。
- 修复 commit：`cf8905dd285bf16896df053aac253dbf8c672979`（`fix(review): address Codex review round 2 findings R2-F01–R2-F07`）；` 22 files changed, 1379 insertions(+), 189 deletions(-)`（相对 730132b）。
- 复现脚本重跑（副本，`cf8905d`）：`round2-probes.mjs` **0/8 复现**（exit 1 = 并非全部复现）；`round1-probes.mjs` **0/12 复现**（首轮修复未回退）。逐项结果与 exit code 见 verification.json `review_rounds[1].probe_rerun`。
- 正向回归：`tests/codex-review-round2.test.ts`（10 项，N01–N08 逐项按 acceptance 断言：退出码、envelope 形状、task_id/submission、请求次数、落盘内容与部分 manifest、ndjson 唯一 outcome 与递增 sequence、被拒目标连目录都不创建）；`tests/poll.test.ts` 改为确定性时钟（9 项，连续 8 次 8/8）；`tests/auth-headless.test.ts` 断言设备登录写入 `login_id`；round-1 `R10` 的期望随 HTTP 分类保留改为 not_found/exit 5。
- 全量：`pnpm typecheck` 通过；`pnpm test` **535/535**（上轮 522 + 本轮 13）；`git diff --check fd94490` exit 0。

| ID | 优先级 | 问题 | 修复 | 决策 | 回归测试 | 复现脚本重跑 |
| --- | --- | --- | --- | --- | --- | --- |
| R2-F01 | P1 | --workspace 仍未限制所有实际写入路径（报告任务 -o、隐式索引根、拒绝前 mkdir） | `saveReportOnly` 接收 workspace 并在 mkdir 前校验文件/`meta.json`；`downloadAssets` 先校验目录与每个计划叶子再创建目录；`indexRootFor` 判定历史索引根（显式 `--root`，否则项目父目录）：越界时 `project record`/任务 `--project`/`download --project` 只记录 metadata，索引以 `index.updated=false` + 原因跳过并给 `index_dirty`；显式 `--root` 越界仍在写入前拒绝 | D-038 | N01、N02、N03（codex-review-round2；报告任务 get/wait/stream 的文件/目录/符号链接父目录/工作区内正常路径；父目录清单前后一致；被拒目标目录不存在） | N01: exit 11, 不再复现 / N02: exit 0, 不再复现 / N03: exit 11, 不再复现 |
| R2-F02 | P2 | 多组材质的同通道贴图被错误地指向第一张 | 每张贴图携带服务端文件名（URL 末段）；解析顺序：已保存名 → 源文件名（忽略大小写）→ 源文件 stem（忽略扩展名/目录）→ 引用名中的通道词 → MTL key 通道 → 唯一贴图；每条规则只在**恰好一个**候选时命中，多候选为 ambiguous：引用原样保留、列出 candidates、`material_links.status=incomplete`、warning `material_reference_ambiguous`；记录 `newmtl` 组；legacy `-o` 同一解析器 | D-039 | N04 ×2（双材质各自正确；大小写/目录/扩展名变体；歧义保留并报警，且断言未指向第一张） | N04: exit 0, 不再复现 |
| R2-F03 | P2 | SSE 保存或项目记账失败时没有终结 outcome 事件 | stream 结束后的 save-json/project 记录在同一终结处理内执行：失败成为唯一的 `outcome`（ndjson，序号递增）或唯一 envelope（json/pretty），保留任务上下文；若流本身已失败，记账错误作为 `bookkeeping_failed` warning 附带 | D-040 | N05（save-json 冲突、project 未初始化、资产 404 × ndjson/json/pretty） | N05: exit 11, 不再复现 |
| R2-F04 | P2 | 任务 -o 下载失败仍丢失已落盘文件和 HTTP 分类 | `downloadArtifacts` 返回逐文件 manifest（key/path/bytes/sha256/status），失败抛出保留原 code/http_status/recovery 的 CliError 并携带 `result.downloads={state: partial|failed, files}`；`maybeDownloadV1`/make 合并而非覆盖；legacy 错误 payload 现含 `code`/`status`/`result.downloads` | D-041 | N06（503/404/403 × get/wait；make；legacy）；round-1 R10 期望改为 not_found/5 | N06: exit 7, 不再复现 |
| R2-F05 | P2 | 任务 -o 下载没有接入 SIGINT，取消后仍返回成功 | abort signal 从所有任务动词、make、legacy 报告器一路传入 `fetchToTemp`；中断即停止传输、删除临时文件、跳过重链接/sidecar，以 `interrupted`/130 返回 task_id/submission/next 与已提交文件；`index.ts` 顶层重包装保留 result/recovery | D-042 | N08（响应头前、body 中途、第二个资产；legacy；无 DELETE/POST；无临时文件） | N08: exit 130, 不再复现 |
| R2-F06 | P2 | OAuth 缺少 user_id 时仍会把不同登录视为同一账户 | `meshy auth login` 为每个 OAuth profile 生成 `login_id`（refresh 保留、重新登录更换）；journal 身份 = `subject:<user_id>`，否则 `login:<login_id>`；两者皆无的存量 profile 为 unverified：可发起新操作，但对已有记录的重放被拒绝（`operation_conflict`，`result.conflict=["credential_unverified"]`，recovery `meshy auth login`）；journal 不含 token 或 login_id 明文 | D-043（取代 D-029 的 profile 名限制） | N07（无 subject 换号被拒；login_id 轮换 token 重放；新 login_id 冲突；过期 token 静默 refresh 保留 login_id）；credentialBinding 单测；auth-headless 设备登录写入 login_id | N07: exit 2, 不再复现 |
| R2-F07 | P2 | 新增 deadline 测试依赖真实毫秒时序，导致测试套件间歇失败 | poll 测试改用 `pollUntilTerminal` 的 `now`/`sleep` 注入：精确到期、提前 0.5 ms 唤醒、迟到唤醒、deadline 约束的请求超时、读超时约束的网络错误均为确定性；唯一真实定时器 smoke 只断言“截止时间后不启动 GET”；慢 header/body 的子进程测试保留 | D-044 | tests/poll.test.ts 9 项；连续 8 次运行 8/8 通过；全量 535/535 | 全量 `pnpm test` 535/535；poll 重复 8/8 |

第 1 轮（F01–F10）修复保持不变，仅 R10 的断言随 R2-F04 的分类保留而更新（404 → `not_found`/exit 5，仍是一条 outcome）。

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`cf8905dd285bf16896df053aac253dbf8c672979`；本文件与 verification.json/capability-matrix.json 在其后的 docs-only commit 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`）
- 历次被 review 的 HEAD：round 1 `6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc053cea4e1bf7dee08953e25a3ec858137`）；round 2 `730132bd99a471ed41d6bbf6b200219f13f569ba`（代码 `0388fe804b456a931f871d2f227e2acf22359d77`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（remote main 与 Skills HEAD 均等于计划 SHA，见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**第 2 轮 7 项 finding 已全部修复并有正向回归，首轮 10 项在新 HEAD 复核未回退；自评 passed，等待 Codex 复审确认**（上一轮结论 not_accepted）
- G1-release / ready-for-S2：**not_run**（无复审结论、无真实账号/多 OS/切片器验证、未发布）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`；13 项带 `review_round_2: fixed`，21 项带 `review_round_1: fixed`，`review_status` 均为 "re-review pending"）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **535 通过 / 0 失败 / 0 跳过**（535 项，含基线原有 363 项；覆盖 74 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权，在 cf8905d 重跑）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归，含真实 token 端点是否返回 user_id、真实重新登录）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（meshyd 仅只读核对 6 个文件，见 baseline.json；两个 reviewer 目录未被改动）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
1d97ada docs(skill-parity): round-3 handoff after Codex review round 2 fixes
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

` 116 files changed, 20618 insertions(+), 930 deletions(-)`

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
| Review R2 | `fix(review)` `cf8905d` | §0 表中的 R2-F01–R2-F07：`download.ts` legacy 下载器逐文件 manifest/信号/报告分支 root/mkdir 顺序；`material-links.ts` 源文件名解析与歧义报告；`task-command.ts` stream 统一 outcome、部分 manifest、索引根、OAuth 身份校验；`project-store.ts` `indexRootFor`/`skipIndex`、快照相对路径 realpath 帧；`operation-store.ts` `credentialBinding`/unverified 拒绝；`credentials.ts`/`config.ts`/`auth.ts`/`runtime.ts` `login_id`；`index.ts` 中断重包装保留上下文；`make.ts`/`project.ts`/`cmd/download.ts` 相应接线；decisions D-038..D-044、migration-notes §3.2、README、SKILL.md | tests/codex-review-round2, poll（确定性）, auth-headless + 两个复现脚本重跑 |

## 4. 能力与接口证据

- 更新后的 capability-matrix 路径：`docs/skill-parity/capability-matrix.json`（`review_rounds`、各能力 `review_round_1`/`review_round_2`）
- endpoint-contracts 与模型/媒体参数映射：`docs/skill-parity/endpoint-contracts.json`（与 `src/client/resource-registry.ts` 由 `tests/resource-registry.test.ts` 逐字段对账；本轮未改）
- v1 JSON schema / 错误码定义：`src/internal/result.ts`（六固定键）、`src/internal/errors.ts`（`CliErrorCode` → 退出码表）；`README.md` "Stable machine output"。本轮新增/变化字段（均为附加或收窄）：任务 `-o` 的 `result.downloads.files[]` 现为逐文件 manifest（`key/path/bytes/sha256/status/error`），`downloads.state` 新增 `partial`；`material_links.status`（complete|incomplete）、`texture_maps[].material`/`candidates`、method 新值 `source_name`/`source_stem`/`ambiguous`；`result.conflict` 新值 `credential_unverified`；stream 的记账失败进入 `outcome`（流本身失败时附 `bookkeeping_failed` warning，D-040）；凭据文件 OAuth profile 新字段 `login_id`
- legacy compatibility / migration notes：`docs/skill-parity/migration-notes.md`（§3 兼容表、§3.1 首轮修正、§3.2 本轮修正：legacy `-o` 错误 payload 现含 `code`/`status`/`result.downloads`，其余 legacy 输出与文件布局不变）
- intentional differences：`docs/skill-parity/migration-notes.md` §2（2.1–2.12），关键项：`--api-key-file`（D-025）、`showcase_type=animate`（D-007）、公共 DTO 无 `face_count`（D-009）、`rigging list` 启用、lamp `text` 拒绝；本轮设计选择：材质重链接**拒绝在多候选间猜测**（D-039）；无账户身份的 OAuth 存量 profile **拒绝重放而非视为同一账户**（D-043，迁移路径为重新登录）
- 限权 API / 未支持的 OS / deferred 新功能：UV/Creative Lab/showcases 真实调用 not_run；Windows/Linux 仅 fixture 覆盖；新 Creative Lab 产品记录为 deferred（矩阵 DF-001）

### 脱敏实际 CLI 输出（tarball 安装的 `cf8905d`，loopback mock；`<tmp>`/`<home>` 为替换后的路径）

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
      "operation_id": "86ff89fe-8775-4654-a8f0-8ee924a23615",
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
      "operation_id": "f62a0362-51ce-45b4-a68d-f686a51062cf",
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
      "command": "meshy text-to-3d list --output-schema v1   # then match operation f62a0362-51ce-45b4-a68d-f686a51062cf by time/prompt before creating again"
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

### 第 2 轮 finding 修复后的实际输出（`round2-probes.mjs` 副本重跑，`cf8905d`，脱敏）

N01 · `analyze-printability get --workspace W -o OUTSIDE/report.json`（exit 11，`outside_file_created=false`）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "analyze-printability.get",
  "ok": false,
  "result": {
    "task": {
      "task_id": "round2-task",
      "resource": "analyze-printability",
      "endpoint": "/openapi/v1/print/analyze",
      "type": "analyze-printability",
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
      "model_urls": {},
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": null,
      "thumbnail_urls": null,
      "alpha_thumbnail_url": null,
      "result": null,
      "printability": {
        "score": 0.9,
        "issues": []
      },
      "task_error": null
    },
    "submission": {
      "state": "accepted",
      "operation_id": null
    },
    "downloads": {
      "state": "failed",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null,
    "task_id": "round2-task",
    "next": {
      "get": "meshy analyze-printability get round2-task --output-schema v1",
      "wait": "meshy analyze-printability wait round2-task --output-schema v1",
      "stream": "meshy analyze-printability stream round2-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "local_io",
    "message": "task round2-task is SUCCEEDED but downloading its assets failed: report path <tmp>/outside-report/report.json resolves outside the authorised root /private<tmp>/workspace",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "download",
      "automatic": false,
      "command": "meshy download --resource analyze-printability --task-id round2-task --all --output-dir <dir>"
    }
  },
  "warnings": []
}
```

N02 · `project record --project P --workspace P`（无 `--root`；exit 0，metadata 记录、`index.updated=false`、父目录无 history.json）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "project.record",
  "ok": true,
  "result": {
    "project_dir": "/private<tmp>/project-root/20260907_182132_review_48aa",
    "action": "added",
    "entry": {
      "task_id": "round2-task",
      "task_type": null,
      "resource": null,
      "endpoint": null,
      "stage": "preview",
      "parent_task_id": null,
      "status": null,
      "files": [],
      "task_json": null,
      "operation_id": null,
      "created_at": "2026-09-07T10:21:32.365Z",
      "updated_at": "2026-09-07T10:21:32.365Z"
    },
    "task_count": 1,
    "index": {
      "updated": false,
      "error": "history root /private<tmp>/project-root resolves outside --workspace <tmp>/project-root/20260907_182132_review_48aa; metadata.json was recorded but history.json was not touched (history root /private<tmp>/project-root resolves outside the authorised root /private<tmp>/project-root/20260907_182132_review_48aa) — run `meshy project rebuild-index --root /private<tmp>/project-root` from a workspace that contains it"
    },
    "migrated_from_legacy": false
  },
  "error": null,
  "warnings": [
    {
      "code": "index_dirty",
      "message": "metadata.json committed but history.json was not updated: history root /private<tmp>/project-root resolves outside --workspace <tmp>/project-root/20260907_182132_review_48aa; metadata.json was recorded but history.json was not touched (history root /private<tmp>/project-root resolves outside the authorised root /private<tmp>/project-root/20260907_182132_review_48aa) — run `meshy project rebuild-index --root /private<tmp>/project-root` from a workspace that contains it; run `meshy project rebuild-index`"
    }
  ]
}
```

N04 · 双材质 OBJ 下载后的 `model.mtl`（两组各自指向自己的贴图）：

```
newmtl body
map_Kd texture_0_base_color.png
newmtl eyes
map_Kd texture_1_base_color.png
```

N05 · `stream --format ndjson --save-json <已存在文件>`（exit 11；事件序列 task → outcome）：

```json
[
  {
    "schema_version": "meshy.cli/v1",
    "command": "text-to-3d.stream",
    "ok": true,
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
    "warnings": [],
    "event": "task",
    "sequence": 1
  },
  {
    "schema_version": "meshy.cli/v1",
    "command": "text-to-3d.stream",
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
      "task_id": "round2-task",
      "next": {
        "get": "meshy text-to-3d get round2-task --output-schema v1",
        "wait": "meshy text-to-3d wait round2-task --output-schema v1",
        "stream": "meshy text-to-3d stream round2-task --format ndjson --output-schema v1"
      },
      "stream": {
        "events": 1,
        "ended": "terminal",
        "elapsed_seconds": 0.01
      }
    },
    "error": {
      "code": "local_io",
      "message": "refusing to overwrite existing file: /private<tmp>/workspace/occupied.json (pass --overwrite, or choose another path)",
      "http_status": null,
      "retryable": false,
      "recovery": {
        "action": "choose_path",
        "automatic": false
      }
    },
    "warnings": [],
    "event": "outcome",
    "sequence": 2
  }
]
```

N06 · `get -o dir`，第一个资产成功、第二个 503（exit 7，`downloads.state=partial`，model.glb 在磁盘）：

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
        "glb": "http://127.0.0.1:<port>/first.glb"
      },
      "image_urls": [],
      "texture_urls": [],
      "thumbnail_url": "http://127.0.0.1:<port>/second.png",
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
          "path": "<tmp>/workspace/partial/model.glb",
          "bytes": 49,
          "sha256": "1390b094bb61759b837fcb096cf53f499d6a5724524a0b55f9700bd22bb87651",
          "content_type": "model/gltf-binary",
          "status": "written",
          "error": null,
          "relinked": false
        },
        {
          "key": "thumbnail",
          "path": "<tmp>/workspace/partial/thumbnail.png",
          "bytes": 0,
          "sha256": "",
          "content_type": null,
          "status": "failed",
          "error": "download failed for http://127.0.0.1:<port>/second.png (HTTP 503 Service Unavailable)",
          "relinked": false
        }
      ],
      "metadata_path": null
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
    "code": "network",
    "message": "task round2-task is SUCCEEDED but downloading its assets failed: download failed for thumbnail: download failed for http://127.0.0.1:<port>/second.png (HTTP 503 Service Unavailable)",
    "http_status": 503,
    "retryable": false,
    "recovery": {
      "action": "download",
      "automatic": false,
      "command": "meshy download --resource text-to-3d --task-id round2-task --all --output-dir <dir>"
    },
    "details": {
      "expired_or_denied": false
    }
  },
  "warnings": []
}
```

N07 · 无 user_id 的同名 OAuth profile 换 token 复用 `--operation-id`（exit 2，`credential_unverified`）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.create",
  "ok": false,
  "result": {
    "submission": {
      "state": "accepted",
      "operation_id": "missing-subject-op",
      "task_id": "oauth-account-a-task"
    },
    "conflict": [
      "credential_unverified"
    ]
  },
  "error": {
    "code": "operation_conflict",
    "message": "operation missing-subject-op already exists but the current OAuth login has no account identity (profile without user_id or login_id), so it cannot be confirmed as the same account; nothing was submitted — run `meshy auth login` to bind this login, or use a new --operation-id",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "login",
      "automatic": false,
      "command": "meshy auth login"
    }
  },
  "warnings": []
}
```

N08 · 资产传输中收到 SIGINT（exit 130，`file_created=false`）：

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
        "glb": "http://127.0.0.1:<port>/slow.glb"
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
      "state": "failed",
      "files": [
        {
          "key": "model_glb",
          "path": "<tmp>/workspace/interrupted.glb",
          "bytes": 0,
          "sha256": "",
          "content_type": null,
          "status": "failed",
          "error": "download of http://127.0.0.1:<port>/slow.glb interrupted",
          "relinked": false
        }
      ],
      "metadata_path": null
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
    "message": "task round2-task is SUCCEEDED but downloading its assets was interrupted: download failed for model_glb: download of http://127.0.0.1:<port>/slow.glb interrupted",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "download",
      "automatic": false,
      "command": "meshy download --resource text-to-3d --task-id round2-task --all --output-dir <dir>"
    }
  },
  "warnings": []
}
```

## 5. 实际验证记录

全部绑定代码 HEAD `cf8905dd285bf16896df053aac253dbf8c672979`，环境 macOS 26.6 arm64 / Node v24.20.0 / pnpm 11.24.0；日志见 `docs/skill-parity/verification.json`（`final_runs`、`package_smoke`、`review_rounds`）。

| 命令 / 测试 ID | 代码 SHA | 环境 | exit code | 结果 | 日志/fixture/报告 |
| --- | --- | --- | --- | --- | --- |
| `node --version` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm --version` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm install --frozen-lockfile` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm typecheck` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm test` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed (535 tests, 535 pass, 0 fail) | verification.json final_runs |
| `pnpm build` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `bash -c test "$(node dist/index.js --version)" = "$(node -p "require(\"./package.json\").version")"` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm pack --json --pack-destination /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r3` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm install -g --prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r3/prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r3/meshy-cli-0.3.0.tgz` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `git diff --check fd94490` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `for i in 1..8: node --import tsx --test tests/poll.test.ts` | cf8905dd285b | macOS arm64, Node 24.20.0 | 0 | passed — 8/8 runs, 9 tests each (deterministic clock tests + real-timer smoke asserting no GET starts after the deadline) | verification.json final_runs |
| npm pack 文件清单 + 必需文件 + 禁止内容 | cf8905dd285b | 同上 | 0 | passed（398 files；dist/skills/README/LICENSE/.env.example 存在；无 .env/credentials/tests/docs/src） | verification.json package_smoke |
| smoke:version | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:version_cli | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help_cli | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_help | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_nokey_json | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:balance_nokey_v1 | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:resources_v1 | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_slicers | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_api_nokey | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:slicer_detect | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_pass | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_fail | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 12 (expected 12) | passed | verification.json package_smoke |
| smoke:inspect_unknown | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 13 (expected 13) | passed | verification.json package_smoke |
| smoke:mesh_prepare | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:mesh_refuse_overwrite | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 11 (expected 11) | passed | verification.json package_smoke |
| smoke:project_init | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_record | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_show | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_list | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_list | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_no_selector | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:make_dry_run | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:usage_unknown_flag | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:uv_help | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:creative_lab_help | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:stream_help | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:catalog_live | cf8905dd285b | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| 第 2 轮复现脚本 `round2-probes.mjs`（8 场景） | cf8905dd285b | node v24.20.0，loopback，临时目录 | 1（= 并非全部复现） | 0/8 复现 | verification.json review_rounds[1].probe_rerun |
| 第 1 轮复现脚本 `round1-probes.mjs`（12 场景） | cf8905dd285b | 同上 | 1 | 0/12 复现（无回退） | verification.json review_rounds[0].reverified_on |
| 新增行为用例 T-001…T-108（离线部分）+ R01–R12 + N01–N08 | cf8905dd285b | node:test + tsx，loopback mock，临时目录 | 0 | passed（`pnpm test` 535/535） | tests/*.test.ts；verification.json behavior_tests |

基线（fd94490）上 `pnpm test` 363/363 通过，无基线失败；本次没有删除或跳过任何既有测试。被改写的既有断言：round-1 `R10` 的下载失败退出码随 HTTP 分类保留由 11 改为 5（仍要求唯一 outcome 与 task 上下文）；round-1 的真实时钟 poll 断言按 R2-F07 改为确定性时钟。

## 6. 真实环境验证

| 环境/能力 | 身份/资源（脱敏） | 实际结果 | 未完成原因 | 补验方式 |
| --- | --- | --- | --- | --- |
| API Key 与 OAuth profile 回归 | 无 | not_run | 本会话无测试账户/Key | 用测试 Key：`meshy doctor --check-api`、`meshy balance --output-schema v1`、`meshy auth status`；OAuth：`meshy auth login` 后 `meshy text-to-3d list --output-schema v1`；核对 D-043：真实 token 端点是否返回 `user_id`，登录后 profile 是否带 `login_id`，重新登录后 `--operation-id` 重放是否按预期冲突 |
| UV / Creative Lab | 无 | not_run | 计费/账号 gate，未获预算授权 | `meshy uv-unwrap create --input-task-id <已有 SUCCEEDED 任务> --async --output-schema v1` → `wait`；`meshy creative-lab figure prototype create --image-url <png> --async` → `wait` → `build create --input-task-id`；记录 task id、请求次数、消耗额度 |
| Enterprise showcases（计费查询） | 无 | not_run | 每次请求计费且需 Enterprise | `meshy showcases list --page-size 1 --output-schema v1`（一次）；核对 `showcase_type=animated` 别名是否被服务端接受（D-007） |
| 公开动画目录（免费、无鉴权） | 无需身份 | passed（1 次 GET，157 条，8 条匹配 "wave"，在 cf8905d 重跑） | — | verification.json live_verification T-110 partial |
| macOS arm64 | 本机 | passed（tarball 安装 + 29 项 smoke） | — | verification.json package_smoke |
| Windows x64 | 无 | not_run | 无主机 | 安装 tarball，运行 `meshy doctor --check-slicers`、`meshy slicer detect`、`meshy mesh prepare-print`；检测规则已用 fixture 覆盖（T-088/T-089） |
| Linux x64 | 无 | not_run | 无主机 | 同上；CI（ubuntu, Node 24/26）会在推送后覆盖安装 smoke |
| 真实 slicer open | 无 | not_run | 本机未安装任何注册切片器 | 安装 OrcaSlicer 后 `meshy slicer open --slicer OrcaSlicer --file <obj>`，仅验证启动 |
| 真实 Meshy 多材质 OBJ 的引用重链接（D-039） | 无 | not_run | 需要真实 refine 任务的 OBJ+MTL+多组贴图 | `meshy download --resource text-to-3d --task-id <id> --model-format obj --output-dir <dir>`，检查 `material_links.status` 与 `texture_maps[].method`（真实 MTL 是否引用 URL 末段文件名） |

## 7. 打包证据

- 候选版本：`0.3.0`（package.json，**未发布**；版本号可由 reviewer 调整）
- tarball 路径：`/private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r3/meshy-cli-0.3.0.tgz`（`npm pack --json --pack-destination`；复现见 §9）
- SHA256：`3077563a16fb9ad00b3be5c01d69724ba3122fe1c60d7abb69cc47e201835f2a`
- npm pack 文件清单：398 个文件；必需项 dist/index.js、skills/meshy-cli/SKILL.md、skills/meshy-cli/animation-library.json、README.md、LICENSE、.env.example、package.json 均在；无 .env / credentials / tests / docs / src / node_modules
- 临时安装 prefix：`npm install -g --prefix <tmp> <tarball>` → `<tmp>/bin/meshy` 与 `<tmp>/bin/meshy-cli` 均指向 `dist/index.js`
- 两个 bin、sharp、本地无 Key/无 Python 验证：29 项 smoke 全部符合预期（含 `MESHY_API_KEY=""` 下 balance 的 stdout 为 JSON、exit 3；无 Key 的本地命令 exit 0；dist 中不含 python 引用）
- 是否发布：**未发布**

## 8. 需要 Codex 复审的事项

1. **写入根覆盖面（R2-F01）**：`saveReportOnly`/`downloadAssets`/`downloadArtifacts` 的检查是否都在任何 mkdir/临时文件之前；`indexRootFor` 的“越界则跳过索引”是否可接受（reviewer 允许拒绝或跳过，本轮选择跳过并显式 `index_dirty`）；`project show/list` 仍为只读未限制。
2. **材质映射规则（R2-F02）**：源文件名/stem 匹配的大小写与扩展名策略；`only_texture` 规则仅在“唯一贴图且唯一引用”时生效；是否需要把 `material_links.status=incomplete` 提升为非零退出（当前所有文件都已落盘，命令 exit 0 + warning）。
3. **stream 收尾（R2-F03）**：`bookkeepingError` 与流本身失败并存时的取舍（流失败为 outcome，记账失败为 warning）。
4. **manifest 合并（R2-F04）**：`withTaskContext` 中 `err.result.downloads` 覆盖默认 `not_requested` 的顺序；legacy 错误 payload 从 `{name:"Error"}` 变为带 `code/status/result` 的 CliError payload 是否可接受（迁移说明 §3.2）。
5. **信号传递（R2-F05）**：`fetchToTemp` 对 body 中途 abort 的临时文件清理；`index.ts` 重包装保留 `result/recovery/hint` 但仍改写 `code=interrupted`。
6. **OAuth 身份（R2-F06）**：`login_id` 的生成点（`finishLogin`）是否覆盖所有登录路径（loopback/device/manual 均经 `finishLogin`）；refresh 保留；unverified 只拒绝重放而不阻止新操作的取舍；D-043 对存量 profile 的迁移说明。
7. **确定性测试（R2-F07）**：fake clock 的 early-wake 建模（-0.5 ms）是否足以代表真实定时器；真实时钟 smoke 只断言“截止后不启动 GET”。
8. 上两轮 §8 的其余事项仍然有效且本轮未改动相关代码（路由等价、transport 边界、锁顺序、slicer OS 行为、not_run 项）。

## 9. 最短复现步骤

```sh
git clone https://github.com/meshy-dev/meshy-cli.git && cd meshy-cli
git fetch <this-branch-remote> feat/skill-parity-s1 && git checkout cf8905dd285bf16896df053aac253dbf8c672979   # 或使用本地仓库 /Users/ark/Dev/meshy-cli
node --version        # v24.x
corepack enable && pnpm --version   # 11.24.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test             # 先 tsc 生成 dist，再运行 node:test（约 41 s；loopback mock，无外网、无凭据）
node --import tsx --test tests/codex-review-round2.test.ts tests/codex-review-round1.test.ts tests/poll.test.ts   # 两轮回归 + 确定性 deadline
for i in 1 2 3 4 5 6 7 8; do node --import tsx --test tests/poll.test.ts >/dev/null || echo "run $i failed"; done
pnpm build
mkdir -p /tmp/probes && cp /path/to/reviews/cli-s1-730132b/round2-probes.mjs /path/to/reviews/cli-s1-730132b/round1-probes.mjs /tmp/probes/
node /tmp/probes/round2-probes.mjs "$PWD"   # 期望 exit 1 且 8 个 reproduced=false
node /tmp/probes/round1-probes.mjs "$PWD"   # 期望 exit 1 且 12 个 reproduced=false
git diff --check fd94490
npm pack --json --pack-destination /tmp/meshy-pack && shasum -a 256 /tmp/meshy-pack/meshy-cli-0.3.0.tgz
npm install -g --prefix /tmp/meshy-prefix /tmp/meshy-pack/meshy-cli-0.3.0.tgz
export MESHY_CONFIG_DIR=$(mktemp -d)
/tmp/meshy-prefix/bin/meshy --version && /tmp/meshy-prefix/bin/meshy doctor --output-schema v1
MESHY_API_KEY= /tmp/meshy-prefix/bin/meshy balance --output-schema v1 ; echo "exit=$?"   # 3, stdout 为 v1 envelope
```

不依赖作者机器上的凭据、Python 或全局包；`tests/helpers/cli.ts` 为每次子进程创建隔离的 `MESHY_CONFIG_DIR` 与 cwd，并显式指向 loopback mock。复现脚本请从副本运行（它们在自身目录写结果文件）；脚本 exit 0 表示缺陷全部复现，exit 1 表示并非全部复现——正向验收以仓库内测试为准。

## 10. 交给 Codex 的复审提示词

请复审 Meshy CLI S1 第 2 轮 review（reviews/cli-s1-730132b，R2-F01–R2-F07）的修复，并确认第 1 轮（reviews/cli-s1-6273d9a，F01–F10）修复未回退。仓库、base/head SHA 见本文件；代码 HEAD `cf8905dd285bf16896df053aac253dbf8c672979`（本文件所在 docs commit 不改代码），规范仍是 2026-09-07 v1 实施包。先核实 diff `730132bd99a471ed41d6bbf6b200219f13f569ba..cf8905dd285bf16896df053aac253dbf8c672979` 与 verification.json/capability-matrix.json 绑定同一 HEAD，再逐项核对 §0 表：修复是否完整覆盖 finding 的触发条件与 acceptance、是否引入回归、正向回归测试是否真正断言了 expected（退出码、JSON 形状、task_id/submission、请求次数、落盘内容与 manifest、ndjson 唯一 outcome 与序号、被拒目标连目录都不创建），并重跑两个复现脚本副本、`pnpm test`、`git diff --check`。

请优先检查 §8 列出的 8 项风险，以及任何新的可复现 bug、重复付费风险、凭据/路径问题、丢失资产/项目记录、OBJ 错误和伪造完成状态。不要做未授权付费调用、发布或 Skill/MCP 迁移。每项 finding 给出优先级、文件/行号、触发条件、影响与修复建议；区分代码缺陷、测试缺口与尚未完成的外部验证。最后分别判断 G1-code 是否可接受、G1-release 是否满足以及是否允许进入 S2。没有发现也要说明验证范围和剩余限制。
