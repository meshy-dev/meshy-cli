/**
 * inspect faces — the face-count gate.
 *
 * Two mutually exclusive task sources: a saved task JSON (no network, no
 * credential, no config directory) or exactly one GET of a task through the
 * resource registry. The command never downloads a model and never creates a
 * remesh task; a failing verdict only *describes* the remesh that would help.
 *
 * `--max-faces` is required on purpose: the rigging ceiling (300000) is one
 * consumer's rule and uv-unwrap's is 40000 — there is no limit that belongs
 * to every mesh, so none is assumed. Exit codes: pass 0, fail 12, unknown 13
 * (D-009). Nothing printed here claims more than the face count.
 */

import { Command } from "commander";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { findTaskResource, TASK_RESOURCES } from "../client/resource-registry.js";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson, type SavedJson } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { CliError, UsageError } from "../internal/errors.js";
import { judgeTask, remeshSuggestion, type RemeshSuggestion } from "../internal/inspect.js";
import { buildLocalRuntime, buildRuntime } from "../internal/runtime.js";
import { extractTaskObject } from "../internal/task-view.js";

/** Engineering limit for a local task JSON (D-018); enforced while reading, never by truncation. */
export const TASK_JSON_MAX_BYTES = 16 * 1024 * 1024;

export type TaskJsonShape = "api" | "meta.json" | "v1-envelope" | "v1-result";

export interface LoadedTaskJson {
  path: string;
  task: Record<string, unknown>;
  shape: TaskJsonShape;
}

interface FacesOptions {
  taskJson?: string;
  resource?: string;
  taskId?: string;
  maxFaces?: number;
  saveJson?: string;
}

type TaskSource = { kind: "task-json"; path: string } | { kind: "api"; resource: string; taskId: string };

function errnoMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ? code : err instanceof Error ? err.message : String(err);
}

/** `--max-faces` accepts a plain positive integer; "3.5", "0", "-1" and "abc" are usage errors. */
export function parseMaxFaces(raw: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new UsageError(`--max-faces must be a positive integer (got '${raw}')`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`--max-faces must be a positive integer (got '${raw}')`);
  return n;
}

function readBounded(fd: number, maxBytes: number, label: string): string {
  const chunks: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    total += n;
    if (total > maxBytes) {
      throw new UsageError(`--task-json: ${label} exceeds ${maxBytes} bytes (task JSON limit); refusing to read further`);
    }
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Read a task from a local JSON file in any shape the CLI writes or the API
 * returns (API task, download meta.json, v1 envelope / result). Every problem
 * with the file is a usage error: the caller named it, so a bad file is a
 * mistake to report, not a fact about the model.
 */
export function readTaskJsonFile(path: string, opts: { cwd?: string; maxBytes?: number } = {}): LoadedTaskJson {
  const cwd = opts.cwd ?? process.cwd();
  const maxBytes = opts.maxBytes ?? TASK_JSON_MAX_BYTES;
  const abs = resolvePath(cwd, path);
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch (err) {
    throw new UsageError(`--task-json: cannot open ${path} (${errnoMessage(err)})`);
  }
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) throw new UsageError(`--task-json: not a regular file: ${path}`);
    text = readBounded(fd, maxBytes, path);
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--task-json: ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const extracted = extractTaskObject(parsed);
  if (!extracted) {
    throw new UsageError(
      `--task-json: ${path} does not contain a task (expected an API task object with id+status, a download meta.json with "task", or a v1 envelope with result.task)`,
    );
  }
  return { path: abs, task: extracted.task, shape: extracted.source };
}

function resolveSource(opts: FacesOptions): TaskSource {
  const hasFile = opts.taskJson !== undefined;
  const hasApi = opts.resource !== undefined || opts.taskId !== undefined;
  if (hasFile && hasApi) {
    throw new UsageError("choose one task source: --task-json <file>, or --resource <id> with --task-id <id> — not both");
  }
  if (hasFile) return { kind: "task-json", path: opts.taskJson! };
  if (opts.resource === undefined || opts.taskId === undefined) {
    throw new UsageError("a task source is required: --task-json <file>, or --resource <id> together with --task-id <id>");
  }
  return { kind: "api", resource: opts.resource, taskId: opts.taskId };
}

function taskIdOf(task: Record<string, unknown>, fallback: string | null): string | null {
  if (typeof task["id"] === "string" && task["id"]) return task["id"] as string;
  if (typeof task["task_id"] === "string" && task["task_id"]) return task["task_id"] as string;
  return fallback;
}

export interface FacesResult {
  face_count: number | null;
  limit: number;
  comparison: "lte";
  verdict: "pass" | "fail" | "unknown";
  reason: string | null;
  source:
    | { kind: "task-json"; path: string; shape: TaskJsonShape }
    | { kind: "api"; resource: string; task_id: string; endpoint: string; requests_made: 1 };
  task_id: string | null;
  status: string | null;
  /** Only on `fail`: an unexecuted remesh the caller may run. */
  suggestion: RemeshSuggestion | null;
  saved_json: SavedJson | null;
}

/** Build a fresh `inspect` command tree (tests parse a new tree per run). */
export function buildInspectCommand(): Command {
  const faces = new Command("faces")
    .description(
      "Face-count gate: pass (exit 0) | fail (exit 12) | unknown (exit 13). Answers only whether face_count <= --max-faces; " +
        "a missing or malformed count is unknown, never 0. Never downloads a model or submits a remesh",
    )
    .option("--task-json <file>", "saved task JSON (API task, download meta.json or v1 envelope); no network, no credential")
    .option("--resource <id>", "task resource id (see `meshy resources`), fetched once with --task-id")
    .option("--task-id <id>", "task id to fetch once from the API (with --resource)")
    .option("--max-faces <n>", "maximum accepted face count (required; e.g. 300000 for rigging, 40000 for uv-unwrap — no default)", parseMaxFaces)
    .option("--save-json <file>", "API source only: save the task JSON as received (never overwrites)")
    .action(async (opts: FacesOptions, thisCmd: Command) => {
      const opened = openCommand(thisCmd, "inspect.faces", "v1");
      rejectOutputFlagForV1(opened, opts.saveJson);
      if (opts.maxFaces === undefined) {
        throw new UsageError(
          "--max-faces <n> is required: the limit belongs to the caller (rigging accepts up to 300000 faces, uv-unwrap up to 40000); no default is assumed",
        );
      }
      const limit = opts.maxFaces;
      const source = resolveSource(opts);

      let task: Record<string, unknown>;
      let sourceInfo: FacesResult["source"];
      let savedJson: SavedJson | null = null;
      if (source.kind === "task-json") {
        if (opts.saveJson) {
          throw new UsageError("--save-json only applies to the API source (--resource/--task-id); the task JSON is already a file");
        }
        buildLocalRuntime(opened.flags);
        const loaded = readTaskJsonFile(source.path);
        task = loaded.task;
        sourceInfo = { kind: "task-json", path: loaded.path, shape: loaded.shape };
      } else {
        const descriptor = findTaskResource(source.resource);
        if (!descriptor) {
          throw new UsageError(`unknown --resource '${source.resource}'. Valid ids: ${TASK_RESOURCES.map((d) => d.id).join(", ")}`);
        }
        const runtime = await buildRuntime(opened.flags);
        // Exactly one GET; the verdict is read from the raw JSON, not the Zod-defaulted object.
        const { raw } = await runtime.client.endpointFor(descriptor).retrieveDetailed(source.taskId, { signal: abortSignal() });
        const extracted = extractTaskObject(raw);
        task = extracted?.task ?? (raw as Record<string, unknown>);
        savedJson = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspaceRoot }) : null;
        sourceInfo = { kind: "api", resource: descriptor.id, task_id: source.taskId, endpoint: descriptor.legacyEndpoint, requests_made: 1 };
      }

      const verdict = judgeTask(task, limit);
      const taskId = taskIdOf(task, source.kind === "api" ? source.taskId : null);
      const result: FacesResult = {
        ...verdict,
        source: sourceInfo,
        task_id: taskId,
        status: typeof task["status"] === "string" ? (task["status"] as string) : null,
        suggestion: verdict.verdict === "fail" ? remeshSuggestion(taskId, limit) : null,
        saved_json: savedJson,
      };
      if (verdict.verdict === "fail") {
        throw new CliError({ code: "check_failed", message: `face count check failed: ${verdict.reason}`, result: { ...result } });
      }
      if (verdict.verdict === "unknown") {
        throw new CliError({ code: "check_unknown", message: `face count unknown: ${verdict.reason}`, result: { ...result } });
      }
      await emitResult(opened, result, result);
    });

  return new Command("inspect").description("Local checks on task results (face-count gate)").addCommand(faces);
}

export const inspectCommand = buildInspectCommand();
