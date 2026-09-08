# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified. 本文件为 **Round 6**（Codex review 第 5 轮修复后的复审交接）。历次 review：第 1 轮 `…/reviews/cli-s1-6273d9a/`，第 2 轮 `…/reviews/cli-s1-730132b/`，第 3 轮 `…/reviews/cli-s1-cf8905d/`，第 4 轮 `…/reviews/cli-s1-235d6de/`，第 5 轮 `…/reviews/cli-s1-68690f9/`；五处 reviewer 证据目录均未被改动，所有复现/核对脚本逐字节复制到独立证据目录后运行（11 个副本 sha256 与原件一致）。

## 0. 第 5 轮 review 结论与本轮修复

- 被 review 的 HEAD：`e7c0bbc4c39b26e77d48ab0979328ae8fa4a5b59`（代码 `68690f9`）；结论 **changes_requested**：3 项 P2 代码缺陷（R5-F01–R5-F03），未发现新的 P1；reviewer 全量 547/547，前两轮 20/20、R3+R4 正向 8/8、上下文 5/5，材质矩阵 14/16，项目入口矩阵 缺失分支 0/10 有恢复。
- 修复 commit：`7b7c24c`（`fix(review): address Codex review round 5 findings R5-F01–R5-F03`）。本轮**没有**测试稳定性提交；68690f9 的 R03 改动按 reviewer 结论接受，未再改动。该 commit 顺带删去上一轮 `REVIEW_HANDOFF.md` 第 462 行样例中继承下来的一个尾随空格（`git diff --check fd94490` 在代码 HEAD 上因此为 exit 0；不改变任何 src/tests 语义）。`11 files changed, 757 insertions(+), 52 deletions(-)`（相对 e7c0bbc，含 docs）。
- 复现脚本重跑（副本，`7b7c24c`）：`round5-probes.mjs` E01 / E02×2 / E03 **均不再呈现旧行为**（reproduced=false 不是验收依据，正向断言见 `tests/codex-review-round5.test.ts`）；`material-matrix-check.mjs` **16/16**；`project-entry-matrix-check.mjs` **20/20 有 record_project 恢复**（全部 exit 11、task_id 保留）；`round4-probes.mjs` 0/3（D03 signal_sent=true / exit 130）；`round3-probes.mjs` 0/6（fs.watch C03 signal_sent=true / exit 130，本轮触发成功）；`round2-probes.mjs` 0/8；`round1-probes.mjs` 0/12；`verify-original-regressions.py` **20/20**；`verify-round3-4-regressions.py` **8/8**；`round4-context-checks.mjs` **5/5**；`stream-finalization-check.mjs` 通过。
- 正向回归：`tests/codex-review-round5.test.ts`（5 项：E01 逐字回放含带空格与引号的 workspace、无 workspace 语义不变；E02 两种顺序；8×2 仲裁矩阵；E03 20 组入口矩阵 + 逐字回放；项目越界边界用例）；`tests/codex-review-round4.test.ts` D02 改为逐字回放（不再补 `--workspace`），R4-T01 SIGINT 分支精确断言 `downloads.state=failed` 与 `[model_glb, failed]`；前四轮回归全部保留并通过。
- 全量：`pnpm typecheck` 通过；`pnpm test` **552/552**（0 失败、0 跳过）；`git diff --check fd94490` 与工作树 exit 0；`poll.test.ts` 连续 12 次 12/12；`codex-review-round1.test.ts` 连续 8 次 8/8；round2–5 套件连续 3 次 3/3。

| ID | 优先级 | 问题 | 修复 | 决策 | 回归测试 | 复现脚本重跑 |
| --- | --- | --- | --- | --- | --- | --- |
| R5-F01 | P2 | `record_project` 恢复命令不带原 `--workspace`，回放后更新了边界外的父目录 history.json 并在边界外建锁 | `projectRecordCommand(projectDir, input, { root?, workspace? })` 追加 `--workspace <解析后的绝对路径>`（与其它参数同样 shell 引用）；`download` 的 `projectRecordFailure` 与任务动词的 `attachToProject` 两处调用均传入；不通过省略约束让恢复成功；无显式 workspace 时不追加、父索引照常刷新 | D-054 | E01（workspace==project 且路径含空格与 `'`：命令被正确引用；修复后**逐字回放**——测试不补任何参数——exit 0、metadata 记录 model.glb、`index.updated=false` 且 `index_dirty`、父 history.json 字节不变、父目录列表不变（无锁/temp）、0 请求；无 workspace 对照：命令无 `--workspace`，父索引刷新）；D02 回放改为逐字并断言命令含原 workspace | E01: history_changed=false, index_dirty |
| R5-F02 | P2 | 同一引用在不同 key 下一处命中、另一处 ambiguous 时，只比较 hit，命中行被局部改写 | `arbitrate` 分两步：**先按 reference 汇总所有 key**——身份证据与 key 无关直接保留；否则每个 key 的通道规则给出候选集（命中=单元素、ambiguous=其候选、该通道无贴图=不提供证据），全部相同且为单一贴图才成立，否则该 reference 所有行保持原文、`method: ambiguous`、各自候选、共享一条跨 key note（"one reference names one file"）；**再**做 round-4 的跨引用竞争否决 | D-055 | E02（两种顺序：MTL 字节不变、两行 ambiguous、各行候选 `[base]` / `[n0, n1]`、note 点名两个 key 与各自结果、rewritten 仅 OBJ、bytes/sha 与磁盘一致、1 条 warning）；8×2 仲裁矩阵纳入仓库测试（身份+启发式、ambiguous 竞争者、同 ref 两命中 / 命中+ambiguous / 同身份 / 同回退、不同通道、身份+ambiguous 竞争者）；D01/C05/N04/round-1 不变 | E02×2: MTL 未改写；矩阵 16/16 |
| R5-F03 | P2 | `resolveProjectDir` 在 `attachToProject` 的 try 之外：metadata 在请求期间消失时 recovery=null、hint 退化为 wait（legacy/v1 × 5 入口共 10 组） | 先建立恢复上下文（task id、journal operation、stage、解析后的 workspace），再在阶段内做两类检查：项目不再位于 workspace 内（或变成符号链接）→ **边界失败**：说明任务与 operation、未记录任何东西、如何处理，但**不给出**会跨越边界的命令；其它（`assertProjectMetadataPresent`：metadata 消失或非常规文件、损坏、锁、磁盘满）→ `record_project` 命令含 `--operation-id` 与 `--workspace`（同为 hint，legacy payload 亦携带）；不重提、不建议 `project init`；`index_dirty` 语义不变；`download` 在记账前应用同一断言（消失 → local_io 而非 not_found） | D-056 | E03 矩阵（legacy/v1 × get/wait/stream/create --async/sync create × missing/damaged = 20 组：exit 11、task_id、create 恰 1 POST 且 journal 恰 1 条 accepted、`submission.operation_id` 与 legacy 顶层 `operation_id` = journal、命令含 `--operation-id`/`--workspace`/`--stage preview`、damaged 分支含快照 `--task-json`；修复后逐字回放：0 请求、正确记录、index_dirty、父 history 不变）；越界用例（项目在 POST 期间被换成指向外部目录的符号链接：exit 11、task 与 operation 被点名、recovery null、无 record 命令、外部目录未被写入） | E03: recovery 存在；入口矩阵 20/20 |

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`7b7c24c0357fb9a351438da2c1bc6a5cb1ebbae7`（= 修复 `7b7c24c0357fb9a351438da2c1bc6a5cb1ebbae7`）；本文件与 verification.json/capability-matrix.json 在其后的 **docs-only commit** 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`、`pnpm-lock.yaml`）
- 历次被 review 的 HEAD：round 1 `6273d9aa6ef396cf1cc26838e2c0d09ab176f595`（代码 `e7c26fc`）；round 2 `730132bd99a471ed41d6bbf6b200219f13f569ba`（代码 `0388fe8`）；round 3 `566f3bdbcdd85d1139e48e3a87d4c6f5e844e43a`（代码 `cf8905d`）；round 4 `9e43a77ced4f84e1ab03c96ddc9a61ce349d44d4`（代码 `235d6de`）；round 5 `e7c0bbc4c39b26e77d48ab0979328ae8fa4a5b59`（代码 `68690f9`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**第 5 轮 3 项 finding 已修复并有正向回归；前四轮 26 项在新 HEAD 复核未回退（reviewer 正向脚本 20/20 与 8/8、四轮探针 0 复现、上下文 5/5）；自评 passed，等待 Codex 复审确认**（上一轮结论 not_accepted）
- G1-release / ready-for-S2：**not_run**（无复审结论、无真实账号/多 OS/切片器验证、未发布；按用户要求不在本轮范围）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`；8 项带 `review_round_5`，5 项 `review_round_4`，10 项 `review_round_3`，13 项 `review_round_2`，21 项 `review_round_1`，`review_status` 均为 "re-review pending"）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **552 通过 / 0 失败 / 0 跳过**（552 项，含基线原有 363 项；覆盖 74 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权，在 7b7c24c 重跑：exit 0）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归，含真实 token 端点是否返回 user_id）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（五个 reviewer 目录未被改动；未调用付费接口；未发布）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
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
7b7c24c fix(review): address Codex review round 5 findings R5-F01–R5-F03

 README.md                            |   5 +-
 docs/skill-parity/REVIEW_HANDOFF.md  |   2 +-
 docs/skill-parity/decisions.md       |  60 ++++
 docs/skill-parity/migration-notes.md |   9 +
 skills/meshy-cli/SKILL.md            |   6 +-
 src/cmd/download.ts                  |  13 +-
 src/internal/material-links.ts       |  86 ++++--
 src/internal/project-store.ts        |  42 ++-
 src/internal/task-command.ts         |  51 +++-
 tests/codex-review-round4.test.ts    |  13 +-
 tests/codex-review-round5.test.ts    | 522 +++++++++++++++++++++++++++++++++++
 11 files changed, 757 insertions(+), 52 deletions(-)
```

要点：

- `src/internal/project-store.ts`：`projectRecordCommand` 增加 `workspace` 选项（`--workspace <resolvePath(workspace)>`，`shellArg` 引用）；新增 `assertProjectMetadataPresent`（metadata.json 消失 → `local_io` "has no metadata.json any more (it was an initialised project when this command started)"；非常规文件 → `local_io`）。
- `src/internal/task-command.ts`：`attachToProject` 先构造 `input`/`workspace`，再 (1) `resolveWithinRoot` 边界检查 → `projectBoundaryFailure`（无命令，details 含 task_id/operation_id/stage/recorded=false），(2) try 内 `assertProjectMetadataPresent` → 快照 → `indexRootFor` → `recordTask`，catch → `record_project` 命令（含 `--operation-id`、`--workspace`）与 hint；`resolveProjectDir` 仅保留给 POST 前的 `preflightLocalTargets`（"nothing was submitted" 语义不变）。
- `src/cmd/download.ts`：项目阶段先算落在项目内的文件列表，再 `assertProjectMetadataPresent`，再记账；`projectRecordFailure` 接收并传递 `workspace`。
- `src/internal/material-links.ts`：`arbitrate` 两步（按 reference 跨 key 汇总 → 跨引用竞争）；模块注释更新。
- 测试：`tests/codex-review-round5.test.ts`（新，5 项）；`tests/codex-review-round4.test.ts` D02 逐字回放、R4-T01 SIGINT 精确 manifest。
- 文档：`decisions.md` D-054–D-056；`migration-notes.md` §3.5；README `--project` 恢复段；SKILL.md 恢复命令处置。

## 4. 能力与接口证据

### 4.1 第 5 轮 finding 修复后的实际输出（`round5-probes.mjs` 副本重跑，`7b7c24c`，脱敏）

**E01**（`download --task-json <tmp>/scope-task.json --all --project <tmp>/projects/<stamp>_recovery-scope_4f87 --workspace <tmp>/projects/<stamp>_recovery-scope_4f87` → exit 11；模型 sha256 `1390b094bb61759b…`，外部 metadata 未变 = true）。返回的恢复命令（探针只替换启动器，**不补参数**）：

```text
meshy project record --project <tmp>/projects/<stamp>_recovery-scope_4f87 --task-id round2-task --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --file model.glb --workspace <tmp>/projects/<stamp>_recovery-scope_4f87
```

修复 metadata 后逐字回放 → exit 0，父目录 history.json 变化 = **false**：

```json
{
  "ok": true,
  "result": {
    "action": "added",
    "index": {
      "updated": false,
      "error": "history root <tmp>/projects resolves outside --workspace <tmp>/projects/<stamp>_recovery-scope_4f87; metadata.json was recorded but history.json was not touched (history root <tmp>/projects resolves outside the authorised root <tmp>/projects/<stamp>_recovery-scope_4f87) — run `meshy project rebuild-index --root <tmp>/projects` from a workspace that contains it"
    },
    "task_count": 1
  },
  "warnings": [
    {
      "code": "index_dirty",
      "message": "metadata.json committed but history.json was not updated: history root <tmp>/projects resolves outside --workspace <tmp>/projects/<stamp>_recovery-scope_4f87; metadata.json was recorded but history.json was not touched (history root <tmp>/projects resolves outside the authorised root <tmp>/projects/<stamp>_recovery-scope_4f87) — run `meshy project rebuild-index --root <tmp>/projects` from a workspace that contains it; run `meshy project rebuild-index`"
    }
  ]
}
```

**E02**（两种顺序，exit 0，保存的 MTL 与服务端原文逐字节相同）：

```text
newmtl a
map_Kd shared.png
map_Bump shared.png

```

```json
[
  {
    "line": 2,
    "reference": "shared.png",
    "resolved_to": null,
    "method": "ambiguous",
    "candidates": [
      "texture_0_base_color.png"
    ],
    "note": "'shared.png' is used by map_Kd and map_Bump but resolves differently per key: map_Kd would make it texture_0_base_color.png (channel_of_key) while map_Bump could only make it texture_0_normal.png or texture_1_normal.png; one reference names one file, so none of its lines is rewritten"
  },
  {
    "line": 3,
    "reference": "shared.png",
    "resolved_to": null,
    "method": "ambiguous",
    "candidates": [
      "texture_0_normal.png",
      "texture_1_normal.png"
    ],
    "note": "'shared.png' is used by map_Kd and map_Bump but resolves differently per key: map_Kd would make it texture_0_base_color.png (channel_of_key) while map_Bump could only make it texture_0_normal.png or texture_1_normal.png; one reference names one file, so none of its lines is rewritten"
  }
]
```
```text
newmtl a
map_Bump shared.png
map_Kd shared.png

```

```json
[
  {
    "line": 2,
    "reference": "shared.png",
    "resolved_to": null,
    "method": "ambiguous",
    "candidates": [
      "texture_0_normal.png",
      "texture_1_normal.png"
    ],
    "note": "'shared.png' is used by map_Bump and map_Kd but resolves differently per key: map_Bump could only make it texture_0_normal.png or texture_1_normal.png while map_Kd would make it texture_0_base_color.png (channel_of_key); one reference names one file, so none of its lines is rewritten"
  },
  {
    "line": 3,
    "reference": "shared.png",
    "resolved_to": null,
    "method": "ambiguous",
    "candidates": [
      "texture_0_base_color.png"
    ],
    "note": "'shared.png' is used by map_Bump and map_Kd but resolves differently per key: map_Bump could only make it texture_0_normal.png or texture_1_normal.png while map_Kd would make it texture_0_base_color.png (channel_of_key); one reference names one file, so none of its lines is rewritten"
  }
]
```

**E03**（`text-to-3d create --mode preview --prompt fixture --async --output-schema v1 --project <tmp>/task-projects/<stamp>_vanished-metadata_70a9 --workspace <tmp>/task-projects/<stamp>_vanished-metadata_70a9` → exit 11；请求：POST /openapi/v2/text-to-3d）：

```json
{
  "ok": false,
  "result": {
    "task_id": "accepted-project-recovery-task",
    "submission": {
      "state": "accepted",
      "operation_id": "c261d382-aee7-41dd-b6ff-6c93c5103dae",
      "task_id": "accepted-project-recovery-task",
      "request_id": null
    },
    "next": {
      "get": "meshy text-to-3d get accepted-project-recovery-task --output-schema v1",
      "wait": "meshy text-to-3d wait accepted-project-recovery-task --output-schema v1",
      "stream": "meshy text-to-3d stream accepted-project-recovery-task --format ndjson --output-schema v1"
    }
  },
  "error": {
    "code": "local_io",
    "message": "task accepted-project-recovery-task exists (operation c261d382-aee7-41dd-b6ff-6c93c5103dae) but recording it in <tmp>/task-projects/<stamp>_vanished-metadata_70a9 failed: --project <tmp>/task-projects/<stamp>_vanished-metadata_70a9 has no metadata.json any more (it was an initialised project when this command started); restore the project, then run: meshy project record --project <tmp>/task-projects/<stamp>_vanished-metadata_70a9 --task-id accepted-project-recovery-task --stage preview --resource text-to-3d --operation-id c261d382-aee7-41dd-b6ff-6c93c5103dae --workspace <tmp>/task-projects/<stamp>_vanished-metadata_70a9",
    "http_status": null,
    "retryable": false,
    "recovery": {
      "action": "record_project",
      "automatic": false,
      "command": "meshy project record --project <tmp>/task-projects/<stamp>_vanished-metadata_70a9 --task-id accepted-project-recovery-task --stage preview --resource text-to-3d --operation-id c261d382-aee7-41dd-b6ff-6c93c5103dae --workspace <tmp>/task-projects/<stamp>_vanished-metadata_70a9"
    },
    "hint": "meshy project record --project <tmp>/task-projects/<stamp>_vanished-metadata_70a9 --task-id accepted-project-recovery-task --stage preview --resource text-to-3d --operation-id c261d382-aee7-41dd-b6ff-6c93c5103dae --workspace <tmp>/task-projects/<stamp>_vanished-metadata_70a9"
  }
}
```

### 4.2 入口矩阵与材质矩阵（reviewer 脚本副本，`7b7c24c`）

`project-entry-matrix-check.mjs`：20/20 组有 `record_project` 恢复，全部 exit 11、task_id 保留。

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

legacy `get` / metadata 消失 的实际 payload（hint 即恢复命令，含 `--workspace`）：

```json
{
  "code": "local_io",
  "task_id": "legacy-get-missing",
  "hint": "meshy project record --project <tmp>/projects/<stamp>_legacy-get-missing_0eb7 --task-id legacy-get-missing --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --workspace <tmp>/projects/<stamp>_legacy-get-missing_0eb7",
  "message": "task legacy-get-missing exists but recording it in <tmp>/projects/<stamp>_legacy-get-missing_0eb7 failed: --project <tmp>/projects/<stamp>_legacy-get-missing_0eb7 has no metadata.json any more (it was an initialised project when this command started); restore the project, then run: meshy project record --project <tmp>/projects/<stamp>_legacy-get-missing_0eb7 --task-id legacy-get-missing --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --workspace <tmp>/projects/<stamp>_legacy-get-missing_0eb7"
}
```

v1 同步 `create` / metadata 消失 的 error（`--operation-id` 与 journal 一致）：

```json
{
  "code": "local_io",
  "message": "task v1-create-sync-missing exists (operation 176a6426-84f7-4885-9d69-35652b7b371d) but recording it in <tmp>/projects/<stamp>_v1-create-sync-missing_e63c failed: --project <tmp>/projects/<stamp>_v1-create-sync-missing_e63c has no metadata.json any more (it was an initialised project when this command started); restore the project, then run: meshy project record --project <tmp>/projects/<stamp>_v1-create-sync-missing_e63c --task-id v1-create-sync-missing --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --operation-id 176a6426-84f7-4885-9d69-35652b7b371d --workspace <tmp>/projects/<stamp>_v1-create-sync-missing_e63c",
  "http_status": null,
  "retryable": false,
  "recovery": {
    "action": "record_project",
    "automatic": false,
    "command": "meshy project record --project <tmp>/projects/<stamp>_v1-create-sync-missing_e63c --task-id v1-create-sync-missing --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --operation-id 176a6426-84f7-4885-9d69-35652b7b371d --workspace <tmp>/projects/<stamp>_v1-create-sync-missing_e63c"
  },
  "hint": "meshy project record --project <tmp>/projects/<stamp>_v1-create-sync-missing_e63c --task-id v1-create-sync-missing --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED --operation-id 176a6426-84f7-4885-9d69-35652b7b371d --workspace <tmp>/projects/<stamp>_v1-create-sync-missing_e63c"
}
```

`material-matrix-check.mjs`：16/16。

| 组合 | 顺序 | 结果 | 实际 [resolved_to, method] |
| --- | --- | --- | --- |
| identity-plus-heuristic | as listed | pass | [["texture_0_base_color.png", "source_name"], [null, "ambiguous"]] |
| identity-plus-heuristic | reversed | pass | [[null, "ambiguous"], ["texture_0_base_color.png", "source_name"]] |
| ambiguous-plus-heuristic | as listed | pass | [[null, "ambiguous"], [null, "ambiguous"]] |
| ambiguous-plus-heuristic | reversed | pass | [[null, "ambiguous"], [null, "ambiguous"]] |
| same-ref-two-hits | as listed | pass | [[null, "ambiguous"], [null, "ambiguous"]] |
| same-ref-two-hits | reversed | pass | [[null, "ambiguous"], [null, "ambiguous"]] |
| same-ref-hit-and-ambiguous | as listed | pass | [[null, "ambiguous"], [null, "ambiguous"]] |
| same-ref-hit-and-ambiguous | reversed | pass | [[null, "ambiguous"], [null, "ambiguous"]] |
| same-ref-same-identity | as listed | pass | [["texture_0_base_color.png", "source_name"], ["texture_0_base_color.png", "source_name"]] |
| same-ref-same-identity | reversed | pass | [["texture_0_base_color.png", "source_name"], ["texture_0_base_color.png", "source_name"]] |
| same-ref-same-fallback | as listed | pass | [["texture_0_normal.png", "channel_in_name"], ["texture_0_normal.png", "channel_in_name"]] |
| same-ref-same-fallback | reversed | pass | [["texture_0_normal.png", "channel_in_name"], ["texture_0_normal.png", "channel_in_name"]] |
| distinct-channel-fallbacks | as listed | pass | [["texture_0_base_color.png", "channel_of_key"], ["texture_0_normal.png", "channel_in_name"]] |
| distinct-channel-fallbacks | reversed | pass | [["texture_0_normal.png", "channel_in_name"], ["texture_0_base_color.png", "channel_of_key"]] |
| identity-with-ambiguous-source-rival | as listed | pass | [["texture_0_base_color.png", "source_name"], [null, "ambiguous"]] |
| identity-with-ambiguous-source-rival | reversed | pass | [[null, "ambiguous"], ["texture_0_base_color.png", "source_name"]] |

### 4.3 tarball 安装 smoke（`7b7c24c`，`meshy-cli-0.3.0.tgz`；`<verify>` 为临时 npm prefix）

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
      "created_at": "2026-09-08T03:09:36.915Z",
      "updated_at": "2026-09-08T03:09:36.915Z"
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

全部绑定代码 HEAD `7b7c24c0357fb9a351438da2c1bc6a5cb1ebbae7`（Node v24.20.0，pnpm 11.24.0）；机器记录见 `docs/skill-parity/verification.json`。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 | |
| `pnpm typecheck` | exit 0 | src + tests |
| `pnpm build` | exit 0 | |
| `pnpm test` | **552 pass / 0 fail / 0 skip**（552 项，42 s） | 含 5 项 round-5 新回归 |
| `dist/index.js --version` = package.json | exit 0 | |
| `git diff --check fd94490` / 工作树 | exit 0 / 0 | |
| `poll.test.ts` × 12 | 12/12 | |
| `codex-review-round1.test.ts` × 8 | 8/8 | R03 保持 68690f9 的 D-044 不变量断言 |
| round2–5 套件 × 3 | 3/3 | 含 SIGINT/竞争/20 组入口矩阵 |
| `round5-probes.mjs` 副本 | E01/E02×2/E03 不再复现 | 正向验收在仓库测试 |
| `material-matrix-check.mjs` 副本 | **16/16** | 两种顺序 |
| `project-entry-matrix-check.mjs` 副本 | **20/20** 有恢复，exit [11] | task_id 保留 20/20 |
| `round4-probes.mjs` 副本 | 0/3 复现；D03 signal_sent=true exit 130 | |
| `round3-probes.mjs` 副本 | 0/6 复现（exit 1） | fs.watch C03 signal_sent=true, exit 130（本轮触发成功） |
| `round2-probes.mjs` 副本 | 0/8 复现（exit 1） | |
| `round1-probes.mjs` 副本 | 0/12 复现（exit 1） | |
| `verify-original-regressions.py` | **20/20** | reviewer 的两轮正向核对 |
| `verify-round3-4-regressions.py` | **8/8** | reviewer 的 R3+R4 正向核对（C03 以 D03 补证） |
| `round4-context-checks.mjs` 副本 | **5/5** | make legacy/v1、stream legacy/v1 sidecar、standalone relink SIGINT |
| `stream-finalization-check.mjs` 副本 | passed | 唯一 outcome、连续序号 |
| tarball smoke | **29/29** | `meshy-cli-0.3.0.tgz` sha256 `f51d69236d36bec798c9b77004d4457cc69e0e47abe5a5dd31d4209d7a408c4d`，398 files，bins ['meshy', 'meshy-cli'] |

## 6. 真实环境验证

- 已执行：真实公开动画目录 GET（免费、无鉴权；`<verify>/prefix/bin/meshy animation-catalog list --category DailyActions --search wave --output-schema v1` → exit 0；public unauthenticated GET of the animation catalog; result keys: items,count,fetched,total,filters,search_scope,source,authenticated,saved_json; matched=8; total=157）；macOS arm64 tarball 安装 + 29 项本地命令 smoke。
- **not_run**（保持）：T-104 真实 API Key/OAuth 登录、重新登录、真实 token 端点 `user_id`；T-109 Windows x64 / Linux x64；T-110 鉴权 get / 已有任务资产下载；T-111 UV Unwrap / Creative Lab / showcases（付费或权限门控）；T-112 真实切片器 GUI；正式发布（未授权、未执行）。
- 不把离线通过写成 G1-release passed；不进入 S2。

## 7. 打包证据

- `npm pack` → `meshy-cli-0.3.0.tgz`，sha256 `f51d69236d36bec798c9b77004d4457cc69e0e47abe5a5dd31d4209d7a408c4d`，398 个文件；必需文件齐全 = true；禁止内容不存在 = true。
- `npm install -g --prefix <tmp>` → bins ['meshy', 'meshy-cli']；无 Python 依赖。
- 未 `npm publish`，未推送。

## 8. 需要 Codex 复审的事项

1. R5-F01：恢复命令追加解析后的绝对 `--workspace`（不是用户原始写法）；无显式 workspace 时不追加。请确认这与“原写入边界”一致。
2. R5-F02：跨 key 汇总中，某 key 的通道没有任何贴图（候选集为空）被视为“不提供证据”而不是“不一致”——例如 `map_Kd X` 命中 base color 而 `map_Ks X` 的 specular 通道无贴图时，map_Kd 仍改写、map_Ks 保持 unresolved。请确认该取舍（D-055）。
3. R5-F03：越界（项目在请求期间离开 workspace 或变成符号链接）时 `recovery: null` 且不给命令，hint 回落到 `wait`；缺失/损坏/锁失败给 `record_project`。请确认边界情形不给任何命令的做法可接受。
4. C06 的 make 段仍在 round-4 R4-T01（本轮按建议把 SIGINT 分支改为精确 `failed` manifest 断言）。
5. 旧 `round3-probes.mjs` 的 fs.watch C03 本轮副本 signal_sent=true（触发）；稳定中断证据为 D03、context 的 standalone-relink-interrupt 与仓库 C03。

## 9. 最短复现步骤

```bash
cd /Users/ark/Dev/meshy-cli && git checkout 7b7c24c
export FNM_DIR="$HOME/.local/share/fnm"; eval "$(fnm env --shell bash)"; fnm use 24
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test          # 552/552
node --import tsx --test tests/codex-review-round5.test.ts             # E01, E02, matrix, E03, boundary
mkdir -p /tmp/r5 && cp /Users/ark/Dev/meshy-agent-integrations-research/reviews/cli-s1-68690f9/{round5-probes.mjs,material-matrix-check.mjs,project-entry-matrix-check.mjs} /tmp/r5/
node /tmp/r5/round5-probes.mjs /Users/ark/Dev/meshy-cli               # E01/E02/E03 reproduced=false
node /tmp/r5/material-matrix-check.mjs                                 # 16/16
node /tmp/r5/project-entry-matrix-check.mjs /Users/ark/Dev/meshy-cli  # 20/20 record_recovery
git diff --check fd94490
```

## 10. 交给 Codex 的复审提示词

> 请对 `/Users/ark/Dev/meshy-cli` 分支 `feat/skill-parity-s1` 做 Meshy CLI S1 第 6 轮 review。规范：2026-09-07 v1 实施包。代码 HEAD `7b7c24c0357fb9a351438da2c1bc6a5cb1ebbae7`（= 修复 `7b7c24c0357fb9a351438da2c1bc6a5cb1ebbae7`）；docs HEAD 为其后的 docs-only commit（`git log -1`）。上一轮（`…/reviews/cli-s1-68690f9/`）结论 changes_requested：R5-F01–R5-F03（P2）。请核对：(1) `tests/codex-review-round5.test.ts` 是否按每项 acceptance 做了正向断言（E01 逐字回放不补参数、父 history 字节不变、index_dirty、边界外无锁/temp、含空格/引号 workspace；E02 两顺序 MTL 字节不变、各行候选与跨 key note、bytes/hash；8×2 矩阵；E03 20 组入口的 task_id/operation_id/请求次数对账与逐字回放；越界用例无命令）；(2) `src/internal/material-links.ts` 两步仲裁是否覆盖 §8.3 的其它组合且 D01/C05/N04/round-1 未回退；(3) `src/internal/task-command.ts` `attachToProject` 与 `src/cmd/download.ts` 的项目阶段是否在所有入口一致，边界失败不给跨界命令、`index_dirty` 语义未被滥用；(4) 前五轮 29 项 finding 是否保持通过（从副本重跑 round1–5 探针、两个 verify 脚本、两个矩阵脚本、`round4-context-checks.mjs`、`stream-finalization-check.mjs`；旧 fs.watch C03 未触发时不得计为通过）。请勿修改 reviewer 证据目录；禁止付费调用、发布、Skill/MCP 迁移。真实账号、Windows/Linux、真实切片器、UV/Creative Lab/showcases 仍为 not_run；G1-release 与 S2 不在本轮范围。
