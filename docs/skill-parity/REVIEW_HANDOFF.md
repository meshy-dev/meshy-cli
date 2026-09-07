# Meshy CLI S1 Review Handoff

Filled from the 2026-09-07 / v1 implementation package. `not_run` means not verified.

## 1. 代码定位

- 仓库路径 / remote：`/Users/ark/Dev/meshy-cli`（fresh clone） / `https://github.com/meshy-dev/meshy-cli.git`
- 分支：`feat/skill-parity-s1`（本地分支，未推送）
- base SHA：`fd94490916376e691efcea51324ac4326b459e1f`（0.2.0，= 计划基线 = 开工时的 remote main）
- head SHA（代码）：`e7c26fc053cea4e1bf7dee08953e25a3ec858137`；本文件与 verification.json/capability-matrix.json 在其后的 docs-only commit 中（见 `git log`，不改变任何 `src/`、`tests/`、`package.json`）
- 工作区是否还有未提交修改：无（docs commit 之后 `git status` 干净）
- 实施包版本：2026-09-07 / v1
- 实际源码与计划基线的差异：无（remote main 与 Skills HEAD 均等于计划 SHA，见 `docs/skill-parity/baseline-delta.md`）
- PR URL：未创建（未获创建 PR / 推送授权）
- Node / pnpm / OS / arch：Node v24.20.0（fnm）/ pnpm 11.24.0（corepack，`packageManager`）/ macOS 26.6 (Darwin 25.6.0) / arm64

## 2. 完成状态

- G1-code / review-ready：**passed**（自评；等待 Codex review）
- G1-release / ready-for-S2：**not_run**（无 review 结论、无真实账号/多 OS/切片器验证、未发布）
- mandatory 能力实现数 / 总数：**35 / 35**（`docs/skill-parity/capability-matrix.json`，全部 `implementation_status: implemented`，`review_status: not_run`）
- mandatory 离线测试通过 / 失败 / 未执行数：`pnpm test` **502 通过 / 0 失败 / 0 跳过**（502 项，含基线原有 363 项；覆盖 73 个 T-id 的离线部分，见 verification.json `behavior_tests`）
- 真实 API / OS / GUI 验证通过 / 未执行项：通过 1 项部分（真实公开动画目录 GET，免费无鉴权）+ macOS arm64 tarball 安装 smoke 29 项；未执行：T-104（真实账号 OAuth/Key 回归）、T-109 Windows/Linux、T-110 鉴权 get/下载、T-111 UV/Creative Lab/showcases、T-112 真实切片器 open
- 是否修改独立 Skills、MCP 或内部服务仓库：**没有**（meshyd 仅只读核对 6 个文件，见 baseline.json）

## 3. 本次具体改动

`git log --oneline fd94490..HEAD`（最早在下）：

```
e7c26fc chore(release): 0.3.0 candidate — README, bundled skill, env example, origin-policy test
da7e1dc feat(local): B06-B08 inspect faces, OBJ prepare-print, slicers and doctor
96ee188 feat(project): B05 meshy_output project store, project command and --project bookkeeping
3935f35 feat(download): B04 asset enumeration, selective download and safe file placement
6784309 feat(tasks): B03 task lifecycle — v1 verbs, journaled single POST, SSE stream, make async, uv-unwrap, creative-lab
f05ff87 feat(client): B02 transport, resource registry, catalog and showcases
e7ea577 feat(cli): B01 v1 envelope, exit codes, local runtime, --api-key-file and unified error exit
c75588e docs(skill-parity): B00 baseline, endpoint contracts, decisions and fixtures
```

` 108 files changed, 14888 insertions(+), 881 deletions(-)`

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

## 4. 能力与接口证据

- 更新后的 capability-matrix 路径：`docs/skill-parity/capability-matrix.json`
- endpoint-contracts 与模型/媒体参数映射：`docs/skill-parity/endpoint-contracts.json`（与 `src/client/resource-registry.ts` 由 `tests/resource-registry.test.ts` 逐字段对账）
- v1 JSON schema / 错误码定义：`src/internal/result.ts`（六固定键）、`src/internal/errors.ts`（`CliErrorCode` → 退出码表）；`README.md` "Stable machine output"
- legacy compatibility / migration notes：`docs/skill-parity/migration-notes.md`（§3 兼容表：get 非终态 exit 0、`make --async` 单次 POST、Commander 错误 exit 2、`rigging list` 启用；其余 legacy 输出不变）
- intentional differences：`docs/skill-parity/migration-notes.md` §2（2.1–2.12），关键项：
  - `--api-key-file` 而非契约中的 `--env-file`：Node 22/24 会在整个 argv 预扫描 `--env-file` 并自行加载整个文件（含 NODE_OPTIONS）、缺失时 exit 9（决策 D-025，实验记录在 decisions.md）
  - `showcase_type` 服务端枚举为 `animate`，文档写 `animated`；CLI 两者都接受，发送 `animate` 并给 warning（D-007）
  - 公共任务 DTO 不含 `face_count`（meshyd `httpapi/dto.go` 只读核对）→ API 来源的 `inspect faces` 通常为 unknown/exit 13，绝不当 0（D-009）
  - `rigging list` 启用（官方文档 + 服务端路由均存在；0.2.0 标为不支持）
  - lamp prototype 已废弃 `text` 输入在提交前拒绝
- 限权 API / 未支持的 OS / deferred 新功能：UV/Creative Lab/showcases 真实调用 not_run；Windows/Linux 仅 fixture 覆盖；keycap/vinyl-figure/brick-figure/clover-fidget 等新 Creative Lab 产品记录为 deferred（矩阵 DF-001）

### 脱敏实际 CLI 输出（loopback mock 或本地；`<tmp>`/`<home>` 为替换后的路径）

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
      "operation_id": "2eb38a76-8e3f-48e1-9b0f-f8a3fff9d877",
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
      "operation_id": "b942c376-1d0d-430d-8419-d031041ae7a0",
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
      "command": "meshy text-to-3d list --output-schema v1   # then match operation b942c376-1d0d-430d-8419-d031041ae7a0 by time/prompt before creating again"
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
          "publish_method": "link"
        }
      ],
      "metadata_path": null
    },
    "unknown_urls": [],
    "saved_json": null,
    "project": null
  },
  "error": null,
  "warnings": []
}
```

`project record --project <dir> --task-id fixture-rig-1 --resource rigging --stage rigged --file rigged.glb`（tarball 安装 smoke，exit 0）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "project.record",
  "ok": true,
  "result": {
    "project_dir": "<tmp>/meshy_output/20260907_162908_smoke-demo_fixture-",
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
      "created_at": "2026-09-07T08:29:09.067Z",
      "updated_at": "2026-09-07T08:29:09.067Z"
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

`project show --project <dir>`（exit 0）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "project.show",
  "ok": true,
  "result": {
    "project_dir": "<tmp>/meshy_output/20260907_162908_smoke-demo_fixture-",
    "legacy_format": false,
    "metadata": {
      "schema_version": 2,
      "project_name": "smoke demo",
      "folder": "20260907_162908_smoke-demo_fixture-",
      "root_task_id": "fixture-rig-1",
      "created_at": "2026-09-07T08:29:08.930Z",
      "updated_at": "2026-09-07T08:29:09.067Z",
      "tasks": [
        {
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
          "created_at": "2026-09-07T08:29:09.067Z",
          "updated_at": "2026-09-07T08:29:09.067Z"
        }
      ]
    },
    "files": [
      {
        "task_id": "fixture-rig-1",
        "stage": "rigged",
        "file": "rigged.glb",
        "present": false
      }
    ]
  },
  "error": null,
  "warnings": []
}
```

`inspect faces --task-json - --max-faces 300000`，任务无 face_count（exit 13）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "inspect.faces",
  "ok": false,
  "result": {
    "face_count": null,
    "limit": 300000,
    "comparison": "lte",
    "verdict": "unknown",
    "reason": "face_count missing",
    "source": {
      "kind": "task-json",
      "path": "/dev/stdin",
      "shape": "api"
    },
    "task_id": "x",
    "status": "SUCCEEDED",
    "suggestion": null,
    "saved_json": null
  },
  "error": {
    "code": "check_unknown",
    "message": "face count unknown: face_count missing",
    "http_status": null,
    "retryable": false,
    "recovery": null
  },
  "warnings": []
}
```

`mesh prepare-print box-y-up.obj --height-mm 80`（exit 0；与 fixture oracle 一致：scale 20，bbox [-20,-60,0]..[20,60,80]）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "mesh.prepare-print",
  "ok": true,
  "result": {
    "input": "<tmp>/box-y-up.obj",
    "output": "<tmp>/box-y-up.print.obj",
    "height_mm": 80,
    "scale": 20,
    "rotation": "(x,y,z)->(x,-z,y)",
    "translation": [
      0,
      0,
      -40
    ],
    "before_bbox": {
      "min": [
        -1,
        2,
        -3
      ],
      "max": [
        1,
        6,
        3
      ]
    },
    "after_bbox": {
      "min": [
        -20,
        -60,
        0
      ],
      "max": [
        20,
        60,
        80
      ]
    },
    "counts": {
      "vertices": 8,
      "normals": 6,
      "uvs": 4,
      "faces": 6,
      "lines_total": 28
    },
    "material": {
      "mtllib": [
        "box.mtl"
      ],
      "copied": [],
      "missing": []
    },
    "in_place": false,
    "warnings": []
  },
  "error": null,
  "warnings": []
}
```

`slicer detect`（exit 0；本机未安装任何注册切片器，空列表即成功）：

```json
{
  "schema_version": "meshy.cli/v1",
  "command": "slicer.detect",
  "ok": true,
  "result": {
    "platform": "darwin",
    "slicers": [
      {
        "id": "bambu-studio",
        "name": "Bambu Studio",
        "path": "/Applications/BambuStudio.app",
        "multicolor": true,
        "platform": "darwin"
      }
    ],
    "unsupported": []
  },
  "error": null,
  "warnings": []
}
```

`doctor`（exit 0，无网络）：

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
        "detail": "sources present: --api-key=no, MESHY_API_KEY=no, --api-key-file=none, stored profile=absent (<config-dir>/credentials.json); values are never read by doctor. API commands need --api-key, MESHY_API_KEY, --api-key-file <file> or `meshy auth login`"
      },
      {
        "id": "workspace",
        "status": "skipped",
        "detail": "--workspace not given (files land next to their targets)"
      },
      {
        "id": "cwd_env_files",
        "status": "ok",
        "detail": "no .env or .env.local in <tmp> (none is ever read automatically)"
      },
      {
        "id": "api",
        "status": "skipped",
        "detail": "not requested (pass --check-api for one free GET /balance)"
      },
      {
        "id": "slicers",
        "status": "skipped",
        "detail": "not requested (pass --check-slicers)"
      }
    ],
    "credential_sources": {
      "flag": false,
      "env": false,
      "api_key_file": null,
      "stored_profile": {
        "path": "<config-dir>/credentials.json",
        "exists": false
      }
    },
    "base_urls": {
      "v1": "https://api.meshy.ai/openapi/v1",
      "v2": "https://api.meshy.ai/openapi/v2",
      "creative_lab": "https://api.meshy.ai/openapi/creative-lab",
      "public_web": "https://api.meshy.ai/web/public"
    },
    "workspace": {
      "path": null,
      "writable": null
    },
    "cwd_env_candidates": [],
    "slicers": null,
    "api": null,
    "saved_json": null
  },
  "error": null,
  "warnings": []
}
```

## 5. 实际验证记录

全部绑定代码 HEAD `e7c26fc053cea4e1bf7dee08953e25a3ec858137`，环境 macOS 26.6 arm64 / Node v24.20.0 / pnpm 11.24.0；日志见 `docs/skill-parity/verification.json`（`final_runs`、`package_smoke`）。

| 命令 / 测试 ID | 代码 SHA | 环境 | exit code | 结果 | 日志/fixture/报告 |
| --- | --- | --- | --- | --- | --- |
| `node --version` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm --version` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm install --frozen-lockfile` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm typecheck` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `pnpm test` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed (502 tests, 502 pass, 0 fail) | verification.json final_runs |
| `pnpm build` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `bash -c test "$(node dist/index.js --version)" = "$(node -p "require(\"./package.json\").version")"` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm pack --json --pack-destination /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| `npm install -g --prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify/prefix /private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify/meshy-cli-0.3.0.tgz` | e7c26fc053ce | macOS arm64, Node 24.20.0 | 0 | passed | verification.json final_runs |
| npm pack 文件清单 + 必需文件 + 禁止内容 | e7c26fc053ce | 同上 | 0 | passed（394 files；dist/skills/README/LICENSE/.env.example 存在；无 .env/credentials/tests/docs/src） | verification.json package_smoke |
| smoke:version | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:version_cli | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:help_cli | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_help | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:balance_nokey_json | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:balance_nokey_v1 | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:resources_v1 | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_slicers | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:doctor_check_api_nokey | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 3 (expected 3) | passed | verification.json package_smoke |
| smoke:slicer_detect | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_pass | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:inspect_fail | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 12 (expected 12) | passed | verification.json package_smoke |
| smoke:inspect_unknown | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 13 (expected 13) | passed | verification.json package_smoke |
| smoke:mesh_prepare | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:mesh_refuse_overwrite | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 11 (expected 11) | passed | verification.json package_smoke |
| smoke:project_init | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_record | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_show | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:project_list | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_list | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:download_no_selector | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:make_dry_run | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:usage_unknown_flag | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 2 (expected 2) | passed | verification.json package_smoke |
| smoke:uv_help | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:creative_lab_help | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:stream_help | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| smoke:catalog_live | e7c26fc053ce | tarball in temp prefix, macOS arm64, Node 24.20.0 | 0 (expected 0) | passed | verification.json package_smoke |
| 新增行为用例 T-001…T-108（离线部分） | e7c26fc053ce | node:test + tsx，loopback mock，临时目录 | 0 | passed（`pnpm test` 502/502） | tests/*.test.ts；verification.json behavior_tests |

基线（fd94490）上 `pnpm test` 363/363 通过，无基线失败；本次没有删除或跳过任何既有测试（`tests/surface.test.ts` 的模型/废弃参数约束原样保留并通过）。

## 6. 真实环境验证

| 环境/能力 | 身份/资源（脱敏） | 实际结果 | 未完成原因 | 补验方式 |
| --- | --- | --- | --- | --- |
| API Key 与 OAuth profile 回归 | 无 | not_run | 本会话无测试账户/Key | 用测试 Key：`meshy doctor --check-api`、`meshy balance --output-schema v1`、`meshy auth status`；OAuth：`meshy auth login` 后 `meshy text-to-3d list --output-schema v1` |
| UV / Creative Lab | 无 | not_run | 计费/账号 gate，未获预算授权 | `meshy uv-unwrap create --input-task-id <已有 SUCCEEDED 任务> --async --output-schema v1` → `wait`；`meshy creative-lab figure prototype create --image-url <png> --async` → `wait` → `build create --input-task-id`；记录 task id、请求次数、消耗额度 |
| Enterprise showcases（计费查询） | 无 | not_run | 每次请求计费且需 Enterprise | `meshy showcases list --page-size 1 --output-schema v1`（一次）；核对 `showcase_type=animated` 别名是否被服务端接受（D-007） |
| 公开动画目录（免费、无鉴权） | 无需身份 | passed（1 次 GET，157 条，8 条匹配 "wave"） | — | verification.json live_verification T-110 partial |
| macOS arm64 | 本机 | passed（tarball 安装 + 29 项 smoke） | — | verification.json package_smoke |
| Windows x64 | 无 | not_run | 无主机 | 安装 tarball，运行 `meshy doctor --check-slicers`、`meshy slicer detect`、`meshy mesh prepare-print`；检测规则已用 fixture 覆盖（T-088/T-089） |
| Linux x64 | 无 | not_run | 无主机 | 同上；CI（ubuntu, Node 24/26）会在推送后覆盖安装 smoke |
| 真实 slicer open | 无 | not_run | 本机未安装任何注册切片器 | 安装 OrcaSlicer 后 `meshy slicer open --slicer OrcaSlicer --file <obj>`，仅验证启动 |

## 7. 打包证据

- 候选版本：`0.3.0`（package.json，**未发布**；版本号可由 reviewer 调整）
- tarball 路径：`/private/tmp/claude-502/-Users-ark-Dev/005e8b84-02bd-4644-8c71-c3b60ab1d28e/scratchpad/verify/meshy-cli-0.3.0.tgz`（`npm pack --json --pack-destination`；复现见 §9）
- SHA256：`8e4e4d86faf18d5b5539264fdac5377059d033e07e4defc902e872f470e66367`
- npm pack 文件清单：394 个文件；必需项 dist/index.js、skills/meshy-cli/SKILL.md、skills/meshy-cli/animation-library.json、README.md、LICENSE、.env.example、package.json 均在；无 .env / credentials / tests / docs / src / node_modules
- 临时安装 prefix：`npm install -g --prefix <tmp> <tarball>` → `<tmp>/bin/meshy` 与 `<tmp>/bin/meshy-cli` 均指向 `dist/index.js`
- 两个 bin、sharp、本地无 Key/无 Python 验证：29 项 smoke 全部符合预期（含 `MESHY_API_KEY=""` 下 balance 的 stdout 为 JSON、exit 3；无 Key 的本地命令 exit 0；dist 中不含 python 引用）
- 是否发布：**未发布**

## 8. 需要 Codex 优先 review 的事项

1. 请求/路由/模型参数与旧 Skill 的等价性：`src/client/resource-registry.ts` vs `docs/skill-parity/endpoint-contracts.json`；Creative Lab 逐产品 Zod 范围（`src/cmd/creative-lab.ts`）取自官方页面与 meshyd 结构体，未做真实调用；uv-unwrap 双源互斥是 CLI 选择。
2. async、unknown submission、SIGINT/SSE 的恢复语义：`src/internal/task-command.ts`（`submitOnce`/`classifySubmissionFailure`：TransportError.phase connect/validate → not_submitted，其余 → unknown；4xx → rejected）；`src/internal/stream.ts`（idle/total deadline、terminal 后 close、error event 映射）；`src/internal/operation-store.ts`（重放/冲突仅限本地记录）。
3. JSON、stderr、exit 和 legacy 兼容：legacy 变化仅 get 非终态 exit 0、`make --async` 形状、Commander 错误 exit 2、`rigging list`；v1-only 命令拒绝 `--output-schema legacy`（D-002）。
4. credential origin / public fetch / api-key-file / 日志边界：`src/client/transport.ts`（拒绝 scheme-relative/userinfo/异源/`..`/redirect）；`src/internal/config.ts`（stored profile 不发往异源 creative-lab；v2 异源 override 的既有风险仅记录，见 D-013）；`--api-key-file` 命名原因 D-025；日志对 data URI 脱敏、签名 query 不入日志。
5. 嵌套资产、最终文件名、并发覆盖和本地路径：`src/internal/artifacts.ts`（keychain/fridge OBJ 为 ZIP 容器）、`src/internal/download.ts`（link 独占发布 + `copy-exclusive` 回退、MIME 改名后再次校验、私网/降级 redirect 拒绝；DNS 名指向私网不检测）。
6. metadata 与 history 的锁/部分提交/恢复：`src/internal/project-store.ts`（项目锁 → 提交 → 根锁 → 索引；index_dirty 语义；legacy 迁移备份）。
7. OBJ 数值/材质与 slicer OS 行为：`src/internal/obj-transform.ts`（旋转/缩放/平移公式、法线仅旋转、两遍流式、`formatObjNumber` 6 位小数）；`src/internal/slicers.ts`（win32 用检测到的绝对 exe、macOS `open -a <bundle>`、无默认应用）；Windows/Linux 仅 fixture 验证。
8. 声称通过但实际缺环境的事项：无 `passed` 依赖未运行的环境；§6 列出的全部 not_run/partial 项均在 verification.json 标注。

## 9. 最短复现步骤

```sh
git clone https://github.com/meshy-dev/meshy-cli.git && cd meshy-cli
git fetch <this-branch-remote> feat/skill-parity-s1 && git checkout e7c26fc053cea4e1bf7dee08953e25a3ec858137   # 或使用本地仓库 /Users/ark/Dev/meshy-cli
node --version        # v24.x
corepack enable && pnpm --version   # 11.24.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test             # 先 tsc 生成 dist，再运行 node:test（约 40 s；loopback mock，无外网、无凭据）
pnpm build
npm pack --json --pack-destination /tmp/meshy-pack
shasum -a 256 /tmp/meshy-pack/meshy-cli-0.3.0.tgz
npm install -g --prefix /tmp/meshy-prefix /tmp/meshy-pack/meshy-cli-0.3.0.tgz
export MESHY_CONFIG_DIR=$(mktemp -d)
/tmp/meshy-prefix/bin/meshy --version
/tmp/meshy-prefix/bin/meshy doctor --output-schema v1
cp tests/fixtures/skill-parity/box-y-up.obj tests/fixtures/skill-parity/box.mtl /tmp/ && /tmp/meshy-prefix/bin/meshy mesh prepare-print /tmp/box-y-up.obj --height-mm 80 --output-schema v1
/tmp/meshy-prefix/bin/meshy inspect faces --task-json tests/fixtures/skill-parity/task-rigging.synthetic.json --max-faces 300000 --output-schema v1
MESHY_API_KEY= /tmp/meshy-prefix/bin/meshy balance --output-schema v1 ; echo "exit=$?"   # 3, stdout 为 v1 envelope
```

不依赖作者机器上的凭据、Python 或全局包；`tests/helpers/cli.ts` 为每次子进程创建隔离的 `MESHY_CONFIG_DIR` 与 cwd，并显式指向 loopback mock。

## 10. 交给 Codex 的 Review 提示词

请 review Meshy CLI S1 实现。仓库和 base/head SHA 见本文件，规范是 2026-09-07 v1 实施包。先核实 diff 与 verification 绑定同一 HEAD（代码 HEAD `e7c26fc053cea4e1bf7dee08953e25a3ec858137`；本文件所在 docs commit 不改代码），再对照 capability matrix 和 COMMAND_CONTRACTS.md 检查功能、正确性、兼容、安全及测试缺口。

请优先找可复现的 bug、重复付费风险、凭据/路径问题、丢失资产/项目记录、OBJ 错误和伪造完成状态。必要时运行有意义的离线测试；不要做未授权付费调用、发布或 Skill/MCP 迁移。每项 finding 给出优先级、文件/行号、触发条件、影响与修复建议；区分代码缺陷、测试缺口与尚未完成的外部验证。最后分别判断 G1-code 是否可接受、G1-release 是否满足以及是否允许进入 S2。没有发现也要说明验证范围和剩余限制。
