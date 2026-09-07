# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. 本文件为 **Round 2**（Codex review 第 1 轮修复后的复审交接）；第 1 轮 review 记录在 `meshy-agent-integrations-research/reviews/cli-s1-6273d9a/`。

## 0. 第 1 轮 review 结论与本轮修复

- 被 review 的 HEAD：`6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc`）；结论 **changes_requested**：10 项 finding（4 P1、6 P2），12 个独立复现（R01–R12），G1-code not_accepted。
- 修复 commit：`0388fe804b456a931f871d2f227e2acf22359d77`（`fix(review): address Codex review round 1 findings F01–F10`）；` 25 files changed, 2266 insertions(+), 295 deletions(-)`（相对 6273d9a）。
- 复现脚本重跑：`reproduce.mjs` 复制到临时目录后对 `0388fe8` 运行（reviewer 的 evidence 文件未被改动）：**0/12 复现**，脚本 exit 1（其语义为"并非全部缺陷都复现"）。逐项结果见 verification.json `review_rounds[0].probe_rerun`。
- 正向回归：`tests/codex-review-round1.test.ts`（17 项，R01–R12 全部按 expected 断言 + 同 id 并发两进程仅 1 次 POST）、`tests/operation-store.test.ts`（媒体碰撞断言改为验证内容差异；T-046 改为 barrier 同步释放的真实并发）、`tests/poll.test.ts`（截止时间约束 sleep；`--timeout 0` 请求上限）。
- 其它 reviewer 备注：`tests/fixtures/skill-parity/task-error.synthetic.sse` 末尾多余空行已去掉，并以 `.gitattributes`（`*.sse -whitespace`）声明 SSE 终止空行为协议内容；`git diff --check fd94490..HEAD` 现为 exit 0。

| ID | 优先级 | 问题 | 修复 | 决策 | 回归测试 | 复现脚本重跑 |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | P1 | 资源命令在提交后的保存或轮询错误中丢失已知任务 ID | `withTaskContext`：受理后的每一步（save-json、轮询 5xx、下载、project 记录、SIGINT）都在任务上下文内抛错，保留原分类/退出码并附带 `result.task_id`/`submission`/`next`；`-o`/`--save-json`/`--project` 在 POST 前预检，可检测冲突 exit 11 且 0 请求 | D-032, D-034 | R05/F01、R06/F01、F01 make（codex-review-round1） | R05: exit 11, 不再复现, R06: exit 1, 不再复现 |
| F02 | P1 | make 把受理后的 journal 写入失败误报为 submission_unknown | make 改用与资源命令共享的 `submitCreate`：受理后 journal 写失败 → `local_io` exit 11，保留 task_id/next/step；单一提交状态机 | D-034 | R11/F02（文本与图片两条路径） | R11: exit 11, 不再复现 |
| F03 | P1 | project 和任务 -o 绕过用户显式指定的 workspace | `downloadArtifacts` 接受 root（=workspace），目录/每个文件/sidecar 在 mkdir 前校验；project init/record/rebuild-index、任务动词与 download 的 `--project`、`make -o` 全部受限；create/make 在 POST 前检查 `-o` | D-032 | R08/F03、R09/F03 | R08: exit 11, 不再复现, R09: exit 11, 不再复现 |
| F04 | P1 | OBJ 材质复制可通过目标父目录符号链接写出 workspace | 每个依赖复制目标按写入根（workspace，否则输出目录）做 `resolveWithinRoot`（真实路径、拒绝符号链接叶子），在 mkdir/复制前与发布前各一次；报告保留计划路径 | D-033 | R12/F04；obj-transform T-086 | R12: exit 11, 不再复现 |
| F05 | P2 | 账户指纹没有绑定实际 API Key，会跨账户重放旧任务 | 指纹加入 API Key 单向摘要（域前缀 sha256）或 OAuth 主体 `user_id`（token 轮换不改变身份）；冲突消息列出差异项 `result.conflict` | D-029 | R01/F05 ×2；operation-store F05；并发同 id 两进程仅 1 次 POST | R01: exit 2, 不再复现 |
| F06 | P2 | 媒体指纹只比较 MIME 和长度，不同图片被当成同一请求 | data URI 以解码字节 sha256 参与指纹（`data:<mime>;sha256=…`），等价编码相同、等长不同内容冲突；错误的碰撞断言测试已替换 | D-030 | R02/F06；operation-store F06 |  |
| F07 | P2 | wait 总截止时间没有约束在途 HTTP 请求 | 每次 GET 携带 `min(剩余预算, 读超时)`；deadline 约束的超时即 timed_out（exit 8）；sleep 不越界、预算耗尽后不再发 GET；`PollResult.task` 在首个响应前超时为 null，legacy 也输出 task id + timed_out；`--timeout 0` 单次查询不受 0 预算限制 | D-031 | R03/F07 ×2（慢 header、慢 body、sleep 到期、迟到 SUCCEEDED、--timeout 0）；poll.test.ts 新增 2 项 | R03: exit 8, 不再复现 |
| F08 | P2 | Creative Lab 的 --options 会整体覆盖 --data.options | `CreateSpec.nestedObjectKeys`（build: options/output）按字段合并 defaults < --data < flags，typed 优先，false/0 保留，校验看到合并后对象；其余字段仍为浅合并 | D-035 | R04/F08（三层真实 argv 检查 POST body） |  |
| F09 | P2 | OBJ 与 MTL 下载重命名后没有修复相对材质引用 | 新增 `material-links.ts`：落盘后重写 OBJ `mtllib` → 实际 MTL、MTL `map_*` → 实际贴图（精确名 → 引用名中的通道词 → MTL key 通道 → 唯一贴图），未解析项原样保留并 warning；manifest 条目 `relinked`+新 sha256，`result.downloads.material_links`；legacy `-o` 同样重链接；ZIP bundle/--geometry-only 不改写 | D-036 | R07/F09、F09 unresolved（读取最终 OBJ/MTL 验证引用存在） |  |
| F10 | P2 | stream 的 ndjson 模式成功退出却不执行 -o 下载 | 下载与 project 记录移到格式分支之前；ndjson 的 `outcome` 携带 downloads；下载失败只输出一条 ok:false outcome 并以其退出码退出 | D-037 | R10/F10（ndjson/json/pretty × 成功/失败） | R10: exit 0, 不再复现 |

未改动的范围：请求路由/registry、transport 凭据边界、SSE 解析、project 锁顺序、OBJ 数值公式、slicer 规则；所有 legacy 输出形状除 §3.1（migration-notes）列出的修正外不变。

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`0388fe804b456a931f871d2f227e2acf22359d77`；本文件与 verification.json/capability-matrix.json 在其后的 docs-only commit 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`）
- 上一轮被 review 的 HEAD：`6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc053cea4e1bf7dee08953e25a3ec858137`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（remote main 与 Skills HEAD 均等于计划 SHA，见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**第 1 轮 10 项 finding 已全部修复并有正向回归；自评 passed，等待 Codex 复审确认**（上一轮结论 not_accepted）
- G1-release / ready-for-S2：**not_run**（无复审结论、无真实账号/多 OS/切片器验证、未发布）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`，全部 `implementation_status: implemented`；21 项带 `review_round_1: fixed`，`review_status` = "round 1 findings fixed; re-review pending"，其余 `not_run`）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **522 通过 / 0 失败 / 0 跳过**（522 项 = 上轮 502 + 本轮 20；含基线原有 363 项；覆盖 73 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权，本轮在 0388fe8 重跑）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（meshyd 仅只读核对 6 个文件，见 baseline.json；reviewer 目录未被改动）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
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

` 113 files changed, 18587 insertions(+), 905 deletions(-)`

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
| Review R1 | `fix(review)` `0388fe8` | §0 表中的 F01–F10；新增 `src/internal/material-links.ts`；`task-command.ts` 任务上下文/预检/共享 `submitCreate`；`poll.ts` 截止时间语义；`operation-store.ts` 指纹；`payload.ts` 嵌套合并；`obj-transform.ts`/`download.ts`/`project.ts`/`mesh.ts`/`make.ts` 写入根；README/SKILL/decisions D-029..D-037/migration-notes §3.1 | tests/codex-review-round1, operation-store, poll + 复现脚本重跑 |

## 4. 能力与接口证据

- 更新后的 capability-matrix 路径：`docs/skill-parity/capability-matrix.json`（`review_rounds`、各能力 `review_round_1`）
- endpoint-contracts 与模型/媒体参数映射：`docs/skill-parity/endpoint-contracts.json`（与 `src/client/resource-registry.ts` 由 `tests/resource-registry.test.ts` 逐字段对账；本轮未改）
- v1 JSON schema / 错误码定义：`src/internal/result.ts`（六固定键）、`src/internal/errors.ts`（`CliErrorCode` → 退出码表）；`README.md` "Stable machine output"。本轮新增字段（均为附加）：`result.downloads.material_links`、manifest 条目 `relinked`、`result.conflict`（operation_conflict）、失败结果统一携带 `task_id`/`next`
- legacy compatibility / migration notes：`docs/skill-parity/migration-notes.md`（§3 兼容表 + §3.1 本轮修正：create/make 对已存在 `-o`/`--save-json` 的拒绝提前到 POST 前并改为 exit 11；受理后失败保留 task 上下文；wait 迟到响应为 exit 8；`--workspace` 全面生效；OBJ 引用重写；stream ndjson `-o` 下载）
- intentional differences：`docs/skill-parity/migration-notes.md` §2（2.1–2.12），关键项：
  - `--api-key-file` 而非契约中的 `--env-file`：Node 22/24 会在整个 argv 预扫描 `--env-file` 并自行加载整个文件（含 NODE_OPTIONS）、缺失时 exit 9（决策 D-025）
  - `showcase_type` 服务端枚举为 `animate`，文档写 `animated`；CLI 两者都接受，发送 `animate` 并给 warning（D-007）
  - 公共任务 DTO 不含 `face_count` → API 来源的 `inspect faces` 通常为 unknown/exit 13，绝不当 0（D-009）
  - `rigging list` 启用；lamp prototype 已废弃 `text` 输入在提交前拒绝
  - 本轮新增的设计选择：下载后**重写**引用而非保留服务端文件名（D-036）；OAuth 无 `user_id` 的 profile 只能绑定 profile 名（D-029 记录为限制）
- 限权 API / 未支持的 OS / deferred 新功能：UV/Creative Lab/showcases 真实调用 not_run；Windows/Linux 仅 fixture 覆盖；新 Creative Lab 产品记录为 deferred（矩阵 DF-001）

### 脱敏实际 CLI 输出（tarball 安装的 `0388fe8`，loopback mock；`<tmp>`/`<home>` 为替换后的路径）

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
      "operation_id": "2e6f3144-d714-4e27-bc1e-c99ca1c971bc",
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
      "operation_id": "74ddf9fc-7ab6-4327-acca-9f65a71b3f4f",
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
      "command": "meshy text-to-3d list --output-schema v1   # then match operation 74ddf9fc-7ab6-4327-acca-9f65a71b3f4f by time/prompt before creating again"
    }
  },
  "warnings": []
}
```

`download --resource rigging --task-id fixture-rig-1 --asset result.basic_animations.walking_glb_url --output walking.glb`（exit=0；manifest 新增 `relinked`/`material_links`）：

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

### 第 1 轮 finding 修复后的实际输出（复现脚本重跑，`0388fe8`，脱敏）

R01 · 换 API Key 复用同一 `--operation-id`（exit 2，0 次新 POST）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.create",
  "ok": false,
  "result": {
    "submission": {
      "state": "accepted",
      "operation_id": "same-credential-op",
      "task_id": "account-a-task"
    },
    "conflict": [
      "credential"
    ]
  },
  "error": {
    "code": "operation_conflict",
    "message": "operation same-credential-op already exists for a different request (credential differ); nothing was submitted — use a new --operation-id for a new request",
    "http_status": null,
    "retryable": false,
    "recovery": null
  },
  "warnings": []
}
```

R03 · `wait --timeout 0.05`，GET 400 ms 后才返回 SUCCEEDED（exit 8，task 为 null，保留 task_id/next）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.wait",
  "ok": false,
  "result": {
    "task": null,
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
    "task_id": "review-task",
    "wait": {
      "timed_out": true,
      "elapsed_seconds": 0.05,
      "polls": 0
    },
    "next": {
      "get": "meshy text-to-3d get review-task --output-schema v1",
      "wait": "meshy text-to-3d wait review-task --output-schema v1",
      "stream": "meshy text-to-3d stream review-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "timed_out",
    "message": "task review-task did not answer within 0.05s (no status was received in time); the server keeps running it",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "wait",
      "automatic": false,
      "command": "meshy text-to-3d wait review-task --output-schema v1"
    }
  },
  "warnings": []
}
```

R05 · `--save-json` 指向已存在文件（exit 11，**0 次 POST**）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.create",
  "ok": false,
  "result": null,
  "error": {
    "code": "local_io",
    "message": "--save-json target occupied.json already exists; choose another path (nothing was submitted)",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "choose_path",
      "automatic": false
    }
  },
  "warnings": []
}
```

R06 · 同步 create，POST 受理后 GET 503（exit 1，保留 task_id/submission/next）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.create",
  "ok": false,
  "result": {
    "task": null,
    "submission": {
      "state": "accepted",
      "operation_id": "<uuid>",
      "task_id": "accepted-before-get-error",
      "request_id": null
    },
    "downloads": {
      "state": "not_requested",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null,
    "task_id": "accepted-before-get-error",
    "next": {
      "get": "meshy text-to-3d get accepted-before-get-error --output-schema v1",
      "wait": "meshy text-to-3d wait accepted-before-get-error --output-schema v1",
      "stream": "meshy text-to-3d stream accepted-before-get-error --format ndjson --output-schema v1"
    },
    "wait": {
      "timed_out": false,
      "elapsed_seconds": 0,
      "polls": 0
    }
  },
  "error": {
    "code": "server",
    "message": "meshy api 503 on /text-to-3d/accepted-before-get-error: synthetic temporary outage",
    "http_status": 503,
    "retryable": false,
    "recovery": null,
    "details": {
      "path": "/text-to-3d/accepted-before-get-error",
      "body": {
        "message": "synthetic temporary outage"
      }
    }
  },
  "warnings": []
}
```

R09 · `get --workspace W -o OUTSIDE/model.glb`（exit 11，无资产请求、无文件）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "text-to-3d.get",
  "ok": false,
  "result": {
    "task": {
      "task_id": "review-task",
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
      "state": "failed",
      "files": [],
      "metadata_path": null
    },
    "saved_json": null,
    "task_id": "review-task",
    "next": {
      "get": "meshy text-to-3d get review-task --output-schema v1",
      "wait": "meshy text-to-3d wait review-task --output-schema v1",
      "stream": "meshy text-to-3d stream review-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "local_io",
    "message": "task review-task is SUCCEEDED but downloading its assets failed: output directory <tmp>/outside resolves outside the authorised root /private<tmp>/workspace",
    "http_status": null,
    "retryable": false,
    "recovery": null
  },
  "warnings": []
}
```

R10 · `stream --format ndjson -o stream.glb`（exit 0；outcome 行携带 downloads.completed）：

```json
[
  {
    "schema_version": "meshy.cli/v1",
    "command": "text-to-3d.stream",
    "ok": true,
    "result": {
      "task": {
        "task_id": "review-task",
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
    "ok": true,
    "result": {
      "task": {
        "task_id": "review-task",
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
        "state": "completed",
        "files": [
          {
            "path": "<tmp>/workspace/stream.glb",
            "status": "written"
          }
        ],
        "metadata_path": "<tmp>/workspace/stream_meta.json",
        "material_links": null
      },
      "saved_json": null,
      "stream": {
        "events": 1,
        "ended": "terminal",
        "elapsed_seconds": 0.01
      },
      "task_id": "review-task",
      "next": {
        "get": "meshy text-to-3d get review-task --output-schema v1",
        "wait": "meshy text-to-3d wait review-task --output-schema v1",
        "stream": "meshy text-to-3d stream review-task --format ndjson --output-schema v1"
      }
    },
    "error": null,
    "warnings": [],
    "event": "outcome",
    "sequence": 2
  }
]
```

R11 · `make --async`，受理后 journal 记录消失（exit 11，submission accepted，task_id 保留）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "make",
  "ok": false,
  "result": {
    "submission": {
      "state": "accepted",
      "operation_id": "<uuid>",
      "task_id": "make-known-accepted-id",
      "request_id": null
    },
    "task": null,
    "task_id": "make-known-accepted-id",
    "next": {
      "get": "meshy text-to-3d get make-known-accepted-id --output-schema v1",
      "wait": "meshy text-to-3d wait make-known-accepted-id --output-schema v1",
      "stream": "meshy text-to-3d stream make-known-accepted-id --format ndjson --output-schema v1"
    },
    "step": 1,
    "route": "text",
    "executed": []
  },
  "error": {
    "code": "local_io",
    "message": "task make-known-accepted-id was created but the operation journal could not be updated: operation record 3a428870-a191-4923-8dbf-ed8806e63eee disappeared before it could be updated",
    "http_status": null,
    "retryable": false,
    "recovery": null
  },
  "warnings": []
}
```

R12 · `mesh prepare-print`，目标 `materials/` 为指向 workspace 外的符号链接（exit 11，外部目录为空）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "mesh.prepare-print",
  "ok": false,
  "result": null,
  "error": {
    "code": "local_io",
    "message": "material dependency target for 'materials/a.mtl' /private<tmp>/workspace/target/materials/a.mtl resolves outside the authorised root /private<tmp>/workspace",
    "http_status": null,
    "retryable": false,
    "recovery": null
  },
  "warnings": []
}
```

## 5. 实际验证记录

全部绑定代码 HEAD `0388fe804b456a931f871d2f227e2acf22359d77`，环境 macOS 26.6 arm64 / Node v24.20.0 / pnpm 11.24.0；日志见 `docs/skill-parity/verification.json`（`final_runs`、`package_smoke`、`review_rounds`）。

| 命令 / 测试 ID | 代码 SHA | 环境 | exit code | 结果 | 日志/fixture/报告 |
| --- | --- | --- | --- | --- | --- |
| `node --version` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm --version` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm install --frozen-lockfile` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm typecheck` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm test` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed (522 tests, 522 pass, 0 fail) | verification.json final_runs |
| `pnpm build` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `bash -c test "$(node dist/index.js --version)" = "$(node -p "require(\"./package.json\").version")"` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm pack --json --pack-destination /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r2` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm install -g --prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r2/prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r2/meshy-cli-0.3.0.tgz` | 0388fe804b45 | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| npm pack 文件清单 + 必需文件 + 禁止内容 | 0388fe804b45 | 同上 | 0 | passed（398 files；dist/skills/README/LICENSE/.env.example 存在；无 .env/credentials/tests/docs/src） | verification.json package_smoke |
| smoke:version | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:version_cli | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help_cli | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_help | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_nokey_json | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:balance_nokey_v1 | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:resources_v1 | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_slicers | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_api_nokey | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:slicer_detect | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_pass | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_fail | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 12 (expected 12) | passed | verification.json package_smoke |
| smoke:inspect_unknown | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 13 (expected 13) | passed | verification.json package_smoke |
| smoke:mesh_prepare | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:mesh_refuse_overwrite | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 11 (expected 11) | passed | verification.json package_smoke |
| smoke:project_init | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_record | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_show | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_list | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_list | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_no_selector | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:make_dry_run | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:usage_unknown_flag | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:uv_help | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:creative_lab_help | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:stream_help | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:catalog_live | 0388fe804b45 | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| 第 1 轮复现脚本 `reproduce.mjs`（12 场景） | 0388fe804b45 | node v24.20.0，loopback，临时目录 | 1（= 并非全部复现） | 0/12 复现 | verification.json review_rounds[0].probe_rerun |
| 新增行为用例 T-001…T-108（离线部分）+ R01–R12 | 0388fe804b45 | node:test + tsx，loopback mock，临时目录 | 0 | passed（`pnpm test` 522/522） | tests/*.test.ts；verification.json behavior_tests |

基线（fd94490）上 `pnpm test` 363/363 通过，无基线失败；本次没有删除或跳过任何既有测试（`tests/surface.test.ts` 的模型/废弃参数约束原样保留并通过）。唯一被改写的既有断言是 reviewer 指出为错误的媒体指纹碰撞断言（tests/operation-store.test.ts）。

## 6. 真实环境验证

| 环境/能力 | 身份/资源（脱敏） | 实际结果 | 未完成原因 | 补验方式 |
| --- | --- | --- | --- | --- |
| API Key 与 OAuth profile 回归 | 无 | not_run | 本会话无测试账户/Key | 用测试 Key：`meshy doctor --check-api`、`meshy balance --output-schema v1`、`meshy auth status`；OAuth：`meshy auth login` 后 `meshy text-to-3d list --output-schema v1`；额外核对 D-029：`auth login` 写入的 profile 是否带 `user_id`（决定 journal 的账户绑定） |
| UV / Creative Lab | 无 | not_run | 计费/账号 gate，未获预算授权 | `meshy uv-unwrap create --input-task-id <已有 SUCCEEDED 任务> --async --output-schema v1` → `wait`；`meshy creative-lab figure prototype create --image-url <png> --async` → `wait` → `build create --input-task-id`；记录 task id、请求次数、消耗额度 |
| Enterprise showcases（计费查询） | 无 | not_run | 每次请求计费且需 Enterprise | `meshy showcases list --page-size 1 --output-schema v1`（一次）；核对 `showcase_type=animated` 别名是否被服务端接受（D-007） |
| 公开动画目录（免费、无鉴权） | 无需身份 | passed（1 次 GET，157 条，8 条匹配 "wave"，在 0388fe8 重跑） | — | verification.json live_verification T-110 partial |
| macOS arm64 | 本机 | passed（tarball 安装 + 29 项 smoke） | — | verification.json package_smoke |
| Windows x64 | 无 | not_run | 无主机 | 安装 tarball，运行 `meshy doctor --check-slicers`、`meshy slicer detect`、`meshy mesh prepare-print`；检测规则已用 fixture 覆盖（T-088/T-089） |
| Linux x64 | 无 | not_run | 无主机 | 同上；CI（ubuntu, Node 24/26）会在推送后覆盖安装 smoke |
| 真实 slicer open | 无 | not_run | 本机未安装任何注册切片器 | 安装 OrcaSlicer 后 `meshy slicer open --slicer OrcaSlicer --file <obj>`，仅验证启动 |
| 真实 Meshy OBJ/MTL 引用重写（D-036） | 无 | not_run | 需要一个真实 refine 任务的 OBJ+MTL+贴图 | `meshy download --resource text-to-3d --task-id <id> --model-format obj --output-dir <dir>`，检查 `result.downloads.material_links`（尤其 texture_maps 的 method/resolved_to）与目录中文件是否一致 |

## 7. 打包证据

- 候选版本：`0.3.0`（package.json，**未发布**；版本号可由 reviewer 调整）
- tarball 路径：`/private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify-r2/meshy-cli-0.3.0.tgz`（`npm pack --json --pack-destination`；复现见 §9）
- SHA256：`6a05293a3712a46be575f9359eeab20cc43e2de5260f42b3b2c224b989046806`
- npm pack 文件清单：398 个文件（上轮 394 + material-links.js 等 4 个）；必需项 dist/index.js、skills/meshy-cli/SKILL.md、skills/meshy-cli/animation-library.json、README.md、LICENSE、.env.example、package.json 均在；无 .env / credentials / tests / docs / src / node_modules
- 临时安装 prefix：`npm install -g --prefix <tmp> <tarball>` → `<tmp>/bin/meshy` 与 `<tmp>/bin/meshy-cli` 均指向 `dist/index.js`
- 两个 bin、sharp、本地无 Key/无 Python 验证：29 项 smoke 全部符合预期（含 `MESHY_API_KEY=""` 下 balance 的 stdout 为 JSON、exit 3；无 Key 的本地命令 exit 0；dist 中不含 python 引用）
- 是否发布：**未发布**

## 8. 需要 Codex 复审的事项

1. **任务上下文包装**：`src/internal/task-command.ts` `withTaskContext`/`wrapWithResult`——是否在所有受理后路径都保留了原始分类（code/http_status/hint/recovery/exit）且 `result.task`/`downloads` 合并顺序正确（bookkeeping 错误的 `task:null` 不覆盖已知任务）。
2. **共享提交原语**：`submitCreate` 被 make 复用后，`extraResult`（step/route/executed）与资源命令结果形状的兼容；`replayExisting` 对 make 不适用（make 不接受 `--operation-id`）。
3. **写入根覆盖面**：D-032 列出的入口是否穷尽（`emitLegacyOutcome`、`maybeDownloadV1`、`finalOutcome`、`project` 三个子命令、`attachToProject`、`download --project`、`mesh`）；`project show/list` 为只读未限制是否可接受。
4. **依赖复制的根检查**：`obj-transform.ts` 计划时与发布前两次 `resolveWithinRoot`；`copied` 报告计划路径而非 realpath 的选择。
5. **凭据指纹**：D-029 的 `sha256(domain|key)` 是否足够（键高熵）；OAuth 无 `user_id` 时退化为 profile 名的限制；`credentialSubject` 仅来自存储 profile。
6. **媒体摘要**：D-030 对非 base64 data URI 的处理（decodeURIComponent 失败回退原文）。
7. **截止时间语义**：`poll.ts` 用 `deadlineBound` 判定超时来源；`PollResult.task` 为 null 的 legacy 输出形状 `{resource,id,status:null,timed_out:true}` 是否可接受。
8. **嵌套合并范围**：仅 Creative Lab build 的 `options`/`output` 声明 `nestedObjectKeys`；其余 payload 保持浅合并（T-028 数组整体替换不变）。
9. **材质重链接**：D-036 的通道启发式（`channelInFileName`/`MAP_KEY_CHANNEL`）是否会产生错误匹配；对 ZIP bundle、二进制 OBJ、超大 MTL 的跳过条件；rewrite 后 manifest sha256 的一致性。
10. **stream outcome**：ndjson `outcome` 现在携带 `downloads`，失败时以 `errorEnvelope` 输出一条并设置退出码；确认没有第二个 envelope。
11. 上一轮 §8 的其余事项（路由等价、transport 边界、锁顺序、slicer OS 行为、not_run 项）仍然有效且本轮未改动相关代码。

## 9. 最短复现步骤

```sh
git clone https://github.com/meshy-dev/meshy-cli.git && cd meshy-cli
git fetch <this-branch-remote> feat/skill-parity-s1 && git checkout 0388fe804b456a931f871d2f227e2acf22359d77   # 或使用本地仓库 /Users/ark/Dev/meshy-cli
node --version        # v24.x
corepack enable && pnpm --version   # 11.24.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test             # 先 tsc 生成 dist，再运行 node:test（约 41 s；loopback mock，无外网、无凭据）
node --import tsx --test tests/codex-review-round1.test.ts   # 仅本轮 17 项回归
pnpm build
cp /path/to/reviews/cli-s1-6273d9a/reproduce.mjs /tmp/probe/ && node /tmp/probe/reproduce.mjs "$PWD"   # 期望 exit 1 且 12 个 reproduced=false
npm pack --json --pack-destination /tmp/meshy-pack
shasum -a 256 /tmp/meshy-pack/meshy-cli-0.3.0.tgz
npm install -g --prefix /tmp/meshy-prefix /tmp/meshy-pack/meshy-cli-0.3.0.tgz
export MESHY_CONFIG_DIR=$(mktemp -d)
/tmp/meshy-prefix/bin/meshy --version
/tmp/meshy-prefix/bin/meshy doctor --output-schema v1
MESHY_API_KEY= /tmp/meshy-prefix/bin/meshy balance --output-schema v1 ; echo "exit=$?"   # 3, stdout 为 v1 envelope
```

不依赖作者机器上的凭据、Python 或全局包；`tests/helpers/cli.ts` 为每次子进程创建隔离的 `MESHY_CONFIG_DIR` 与 cwd，并显式指向 loopback mock。复现脚本请从副本运行，它会在自身目录写 `reproduction-results.json`。

## 10. 交给 Codex 的复审提示词

请复审 Meshy CLI S1 第 1 轮 review（reviews/cli-s1-6273d9a，F01–F10）的修复。仓库、base/head SHA 见本文件；代码 HEAD `0388fe804b456a931f871d2f227e2acf22359d77`（本文件所在 docs commit 不改代码），规范仍是 2026-09-07 v1 实施包。先核实 diff `6273d9aa6ef396cf1cc26838e2c0d09ab176f595..0388fe804b456a931f871d2f227e2acf22359d77` 与 verification.json/capability-matrix.json 绑定同一 HEAD，再逐项核对 §0 表：修复是否完整覆盖 finding 的触发条件、是否引入回归、正向回归测试是否真正断言了 expected（而不是仅命令可运行），并重跑 reproduce.mjs 与 `pnpm test`。

请优先检查 §8 列出的 11 项风险，以及任何新的可复现 bug、重复付费风险、凭据/路径问题、丢失资产/项目记录、OBJ 错误和伪造完成状态。不要做未授权付费调用、发布或 Skill/MCP 迁移。每项 finding 给出优先级、文件/行号、触发条件、影响与修复建议；区分代码缺陷、测试缺口与尚未完成的外部验证。最后分别判断 G1-code 是否可接受、G1-release 是否满足以及是否允许进入 S2。没有发现也要说明验证范围和剩余限制。
