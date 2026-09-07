/**
 * Factory that wires the uniform create/get/list/wait/stream/delete
 * subcommands for any registered task resource. Per-resource modules only
 * contribute their unique `create` flag shape and payload validation.
 *
 * Two output schemas share one execution path:
 *   legacy — the 0.2.0 payloads and `-o` status report, with two documented
 *            fixes: `get` of a non-terminal task exits 0, and async create
 *            never polls.
 *   v1     — one `meshy.cli/v1` envelope whose result carries the TaskView,
 *            the submission record and the download manifest.
 *
 * Money rules enforced here, independent of schema:
 *   - every create is exactly one POST, journaled before it is sent;
 *   - a lost or malformed response is `submission_unknown` (exit 10), never a
 *     retry and never a "please run it again" hint;
 *   - local targets that would fail after the POST (an existing --save-json
 *     file, an -o path outside the workspace, a missing --project) are checked
 *     before it, so a detectable conflict costs zero requests;
 *   - once the server has accepted a task, every later failure — saving JSON,
 *     polling, downloading, recording, a signal — still reports that task id,
 *     the submission record and the `get`/`wait` commands that resume it;
 *   - SIGINT stops waiting/streaming (exit 130) and never deletes anything.
 */

import { Command, Option } from "commander";
import type { TaskEndpoint } from "../client/endpoints/base.js";
import { MeshyApiError } from "../client/errors.js";
import type { MeshyClient } from "../client/index.js";
import { requireTaskResource, type TaskResourceDescriptor } from "../client/resource-registry.js";
import { TransportError } from "../client/transport.js";
import { isTerminalStatus, summarizeTask, type Task } from "../client/types.js";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson, type OpenedCommand, type SavedJson } from "./command-helpers.js";
import { abortSignal, wasInterrupted } from "./context.js";
import { downloadArtifacts, looksLikeFile } from "./download.js";
import { classifyError, CliError, UsageError, type Warning } from "./errors.js";
import { normalizeMediaPayload } from "./file-input.js";
import { logger } from "./logger.js";
import type { MaterialLinkReport } from "./material-links.js";
import { mergeNestedObjects, mergePayload, parseJsonFlag } from "./payload.js";
import { emitEnvelope, emitStreamEvent, emit } from "./output.js";
import { parseTimeoutSeconds, pollUntilTerminal, type PollResult } from "./poll.js";
import { printReport } from "./report.js";
import { errorEnvelope, okEnvelope, warning, type StreamEventEnvelope } from "./result.js";
import { buildRuntime, type Runtime } from "./runtime.js";
import { getUpdateNotice } from "./update-notifier.js";
import { streamTask } from "./stream.js";
import { toTaskView, type TaskView } from "./task-view.js";
import {
  beginOperation,
  credentialBinding,
  credentialFingerprint,
  newOperationId,
  operationsRoot,
  payloadFingerprint,
  updateOperation,
  type OperationRecord,
} from "./operation-store.js";
import { originOf } from "./config.js";
import { resolveWithinRoot } from "./paths.js";
import { indexRootFor, recordTask, saveTaskSnapshot, stageFromTaskType } from "./project-store.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

export interface CreateSpec {
  description: string;
  /** Attach resource-specific flags; return a structured payload. */
  configure(cmd: Command): Command;
  /** Convert parsed command options into a JSON payload merged into --data. */
  toPayload(opts: Record<string, unknown>): Record<string, unknown>;
  /**
   * Pinned CLI defaults — the weakest payload layer, overridable by --data
   * and by explicit flags. Computed defaults may read other options but must
   * not throw (validation belongs in toPayload).
   */
  toDefaults?(opts: Record<string, unknown>): Record<string, unknown>;
  /**
   * Payload keys holding nested option objects that must merge field by field
   * across defaults < --data < flags (e.g. Creative Lab `options`, `output`).
   * Everything else merges shallowly: arrays and scalars replace wholesale.
   */
  nestedObjectKeys?: readonly string[];
  /**
   * Validate the merged payload (defaults < --data < flags) before media is
   * normalised and before anything is sent. Throw UsageError / CliError.
   */
  validatePayload?(payload: Record<string, unknown>, opts: Record<string, unknown>): void;
}

export interface ResourceCommandSpec {
  /** Registry id of the task resource this command drives. */
  name: string;
  /** Commander name when it differs from the id (Creative Lab stages). */
  commandName?: string;
  /** Dotted prefix for v1 `command` (defaults to the id). */
  commandPrefix?: string;
  description: string;
  supportsList?: boolean;
  /** Default output schema for this resource's verbs (`legacy` for 0.2.0 commands). */
  defaultSchema?: "legacy" | "v1";
  create: CreateSpec;
  /** Optional override; defaults to the registry endpoint for `name`. */
  endpointOf?(client: MeshyClient): TaskEndpoint;
}

const TASK_JSON_OPTIONS = (cmd: Command): Command =>
  cmd
    .option("--save-json <file>", "save the full task JSON as received (never overwrites)")
    .option("--include-raw", "v1: include the untouched task response under result.task.raw")
    .option("--project <dir>", "initialised meshy_output project: save task_<id>.json there and record the task in metadata.json")
    .option("--stage <name>", "stage label for the project record (default: derived from the task type, e.g. preview | refine | build)");

export interface DownloadOutcome {
  state: "not_requested" | "not_ready" | "completed" | "partial" | "failed";
  files: Array<{ key?: string; path: string; status: "written" | "failed"; bytes?: number; sha256?: string; error?: string | null }>;
  metadata_path: string | null;
  /** OBJ/MTL/texture reference report when the download contained a text OBJ. */
  material_links?: MaterialLinkReport | null;
  /** Set when the transfers landed but a later step (relink | digest | sidecar) failed or was interrupted. */
  failed_step?: string;
}

export interface SubmissionInfo {
  state: string;
  operation_id: string | null;
  task_id?: string | null;
  request_id?: string | null;
}

interface TaskResultOptions {
  task: Task | null;
  raw: unknown;
  descriptor: TaskResourceDescriptor;
  includeRaw: boolean;
  submission: SubmissionInfo;
  downloads?: DownloadOutcome;
  savedJson?: SavedJson | null;
  extra?: Record<string, unknown>;
}

const NOT_REQUESTED = (): DownloadOutcome => ({ state: "not_requested", files: [], metadata_path: null });

function taskResult(o: TaskResultOptions): Record<string, unknown> {
  return {
    task: o.task ? toTaskView(o.raw ?? o.task, { descriptor: o.descriptor, includeRaw: o.includeRaw }) : null,
    submission: o.submission,
    downloads: o.downloads ?? NOT_REQUESTED(),
    saved_json: o.savedJson ?? null,
    ...(o.extra ?? {}),
  };
}

function nextCommands(descriptor: TaskResourceDescriptor, taskId: string): Record<string, string> {
  const base = `meshy ${descriptor.commandPath.join(" ")}`;
  return {
    get: `${base} get ${taskId} --output-schema v1`,
    wait: `${base} wait ${taskId} --output-schema v1`,
    stream: `${base} stream ${taskId} --format ndjson --output-schema v1`,
  };
}

/**
 * What every failure after the server accepted a task must still say: which
 * task, what the submission record is, and how to pick it up again.
 */
interface TaskContext {
  descriptor: TaskResourceDescriptor;
  taskId: string;
  task?: Task | null;
  raw?: unknown;
  submission: SubmissionInfo;
  includeRaw?: boolean;
  savedJson?: SavedJson | null;
  extra?: Record<string, unknown>;
}

/**
 * Re-throw any error as a CliError whose `result` carries `result` — keeping
 * the original classification (code, HTTP status, hint, recovery, exit code).
 * A CliError's own partial result (files written so far, a failed download
 * manifest) is merged on top, so nothing already known is lost.
 */
export function wrapWithResult(err: unknown, result: Record<string, unknown>): CliError {
  if (err instanceof CliError) {
    return new CliError({
      code: err.code,
      message: err.message,
      exitCode: err.exitCode,
      httpStatus: err.httpStatus,
      retryable: err.retryable,
      recovery: err.recovery,
      hint: err.hint,
      details: err.details,
      warnings: err.warnings,
      result: { ...result, ...(err.result ?? {}) },
      cause: err,
    });
  }
  const c = classifyError(err);
  return new CliError({
    code: c.code,
    message: c.message,
    exitCode: c.exitCode,
    httpStatus: c.httpStatus,
    retryable: c.retryable,
    recovery: c.recovery,
    hint: c.hint,
    details: c.details,
    warnings: c.warnings,
    result: { ...result, ...(c.result ?? {}) },
    cause: err,
  });
}

/** `wrapWithResult` with the task result shape: the id, submission and next commands always survive. */
function withTaskContext(err: unknown, ctx: TaskContext): CliError {
  const next = nextCommands(ctx.descriptor, ctx.taskId);
  const base = taskResult({
    task: ctx.task ?? null,
    raw: ctx.raw ?? null,
    descriptor: ctx.descriptor,
    includeRaw: Boolean(ctx.includeRaw),
    submission: ctx.submission,
    savedJson: ctx.savedJson ?? null,
    extra: { task_id: ctx.taskId, next, ...(ctx.extra ?? {}) },
  });
  let own: Record<string, unknown> = {};
  if (err instanceof CliError && err.result) {
    own = { ...err.result };
    // A bookkeeping error's `task: null` must not erase a task we do know.
    if (own["task"] === null && ctx.task) delete own["task"];
  }
  const wrapped = wrapWithResult(err, base);
  return new CliError({
    code: wrapped.code,
    message: wrapped.message,
    exitCode: wrapped.exitCode,
    httpStatus: wrapped.httpStatus,
    retryable: wrapped.retryable,
    recovery: wrapped.recovery,
    hint: wrapped.hint ?? wrapped.recovery?.command ?? next.wait,
    details: wrapped.details,
    warnings: wrapped.warnings,
    result: { ...base, ...own, task_id: ctx.taskId, next },
    cause: err,
  });
}

interface ProjectAttachment {
  project_dir: string;
  snapshot: string | null;
  stage: string;
  action: "added" | "merged";
  index: { updated: boolean; error: string | null };
}

function parentTaskIdFromPayload(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const k of ["preview_task_id", "input_task_id", "rig_task_id"]) {
    if (typeof payload[k] === "string" && payload[k]) return payload[k] as string;
  }
  return null;
}

/** Resolve --project: an initialised project directory, inside the workspace when one is set. */
function resolveProjectDir(projectFlag: string, workspace: string | undefined, cwd = process.cwd()): string {
  const projectDir = resolvePath(cwd, projectFlag);
  if (!existsSync(join(projectDir, "metadata.json"))) {
    throw new CliError({
      code: "local_io",
      message: `--project ${projectFlag} is not an initialised project (no metadata.json); run \`meshy project init\` first`,
    });
  }
  if (workspace) resolveWithinRoot(projectDir, workspace, { cwd, label: "--project" });
  return projectDir;
}

/**
 * --project: snapshot the task (when a full task is known) and record it.
 * Failures keep the task id in the error result — a bookkeeping problem must
 * never read as "no task was created".
 */
function attachToProject(
  opts: Record<string, unknown>,
  opened: OpenedCommand,
  descriptor: TaskResourceDescriptor,
  taskId: string,
  task: Task | null,
  raw: unknown,
  extra: { operationId?: string | null; payload?: Record<string, unknown> | null; files?: string[] },
  warnings: Warning[],
): ProjectAttachment | null {
  const projectFlag = opts.project as string | undefined;
  if (!projectFlag) return null;
  const projectDir = resolveProjectDir(projectFlag, opened.flags.workspace);
  const stage = (opts.stage as string | undefined) ?? (typeof extra.payload?.["mode"] === "string" ? (extra.payload["mode"] as string) : descriptor.creativeLab?.stage ?? stageFromTaskType(task?.type, descriptor.id));
  try {
    const snapshot = task && raw ? saveTaskSnapshot(projectDir, taskId, raw) : null;
    const indexRoot = indexRootFor(projectDir, undefined, opened.flags.workspace);
    const rec = recordTask(projectDir, {
      taskId,
      stage,
      resource: descriptor.id,
      taskType: task?.type ?? null,
      endpoint: descriptor.legacyEndpoint,
      parentTaskId: parentTaskIdFromPayload(extra.payload ?? null),
      status: task?.status ?? null,
      taskJson: snapshot?.relative ?? null,
      operationId: extra.operationId ?? null,
      files: extra.files ?? [],
    }, { root: indexRoot.root, skipIndex: indexRoot.skipIndex });
    if (!rec.index.updated) warnings.push(warning("index_dirty", `metadata.json committed but history.json was not updated: ${rec.index.error}; run \`meshy project rebuild-index\``));
    if (rec.migrated_from_legacy) warnings.push(warning("metadata_migrated", "legacy metadata.json migrated to schema_version 2 (backup kept beside it)"));
    return { project_dir: projectDir, snapshot: snapshot?.path ?? null, stage, action: rec.action, index: rec.index };
  } catch (err) {
    throw new CliError({
      code: err instanceof CliError ? err.code : "local_io",
      message: `task ${taskId} exists but recording it in ${projectDir} failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
}

/** --save-json inside the task's context: a full disk or a vanished directory never hides the task id. */
function saveJsonInContext(opts: Record<string, unknown>, opened: OpenedCommand, raw: unknown, ctx: TaskContext): SavedJson | null {
  if (!opts.saveJson) return null;
  try {
    return saveRawJson(String(opts.saveJson), raw, { workspace: opened.flags.workspace });
  } catch (err) {
    throw withTaskContext(err, ctx);
  }
}

function attachInContext(
  opts: Record<string, unknown>,
  opened: OpenedCommand,
  descriptor: TaskResourceDescriptor,
  taskId: string,
  task: Task | null,
  raw: unknown,
  extra: { operationId?: string | null; payload?: Record<string, unknown> | null; files?: string[] },
  warnings: Warning[],
  ctx: TaskContext,
): ProjectAttachment | null {
  try {
    return attachToProject(opts, opened, descriptor, taskId, task, raw, extra, warnings);
  } catch (err) {
    throw withTaskContext(err, ctx);
  }
}

// ---------------------------------------------------------------------------
// Pre-submission checks: anything local that would fail *after* a billable POST
// and can be detected now is refused now, with "nothing was submitted".
// ---------------------------------------------------------------------------

/** `-o` target: inside the workspace (or its own directory), no symlink leaf, not an existing file. */
export function preflightOutputPath(output: string, workspace: string | undefined, cwd = process.cwd()): void {
  const abs = resolvePath(cwd, output);
  resolveWithinRoot(abs, workspace ?? dirname(abs), { cwd, label: "--output" });
  if (looksLikeFile(abs) && existsSync(abs)) {
    throw new CliError({
      code: "local_io",
      message: `--output ${output} already exists; choose another path (nothing was submitted)`,
      recovery: { action: "choose_path", automatic: false },
    });
  }
}

/** `--save-json` target: inside the workspace (or its own directory), no symlink leaf, not an existing file. */
export function preflightSaveJsonPath(target: string, workspace: string | undefined, cwd = process.cwd()): void {
  const abs = resolvePath(cwd, target);
  const resolved = resolveWithinRoot(abs, workspace ?? dirname(abs), { cwd, label: "--save-json target" });
  if (existsSync(resolved.path)) {
    throw new CliError({
      code: "local_io",
      message: `--save-json target ${target} already exists; choose another path (nothing was submitted)`,
      recovery: { action: "choose_path", automatic: false },
    });
  }
}

function preflightLocalTargets(opts: Record<string, unknown>, opened: OpenedCommand): void {
  if (opts.saveJson) preflightSaveJsonPath(String(opts.saveJson), opened.flags.workspace);
  if (opened.flags.output) preflightOutputPath(opened.flags.output, opened.flags.workspace);
  if (opts.project) {
    try {
      resolveProjectDir(String(opts.project), opened.flags.workspace);
    } catch (err) {
      if (err instanceof CliError) {
        throw new CliError({ code: err.code, message: `${err.message} (nothing was submitted)`, recovery: err.recovery, cause: err });
      }
      throw err;
    }
  }
}

export function buildResourceCommand(spec: ResourceCommandSpec): Command {
  const descriptor = requireTaskResource(spec.name);
  const endpointOf = spec.endpointOf ?? ((client: MeshyClient) => client.endpointFor(descriptor));
  const prefix = spec.commandPrefix ?? spec.name;
  const defaultSchema = spec.defaultSchema ?? "legacy";
  const cmd = new Command(spec.commandName ?? spec.name).description(spec.description);

  // create
  const createCmd = new Command("create").description(spec.create.description);
  spec.create.configure(createCmd);
  TASK_JSON_OPTIONS(createCmd)
    .addOption(new Option("--data <json>", "raw JSON payload (or @file.json); merges with flags (flags win)"))
    .addOption(
      new Option(
        "--async",
        "submit once and return the task id immediately (no polling); query later with `get`, `wait` or `stream`",
      ).default(false),
    )
    .addOption(new Option("--timeout <seconds>", "max seconds to poll in sync mode").default("600"))
    .addOption(
      new Option(
        "--operation-id <id>",
        "local journal id for this submission; repeating it returns the recorded outcome instead of submitting again (local record only, not a server idempotency key)",
      ),
    )
    .action(async (opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.create`, defaultSchema);
      const timeoutSeconds = parseTimeoutSeconds(opts.timeout ?? "600");
      const runAsync = Boolean(opts.async);
      const includeRaw = Boolean(opts.includeRaw);
      const runtime = await buildRuntime(opened.flags);
      const endpoint = endpointOf(runtime.client);

      // 1. Build and validate the payload — every local failure happens here, before the journal and the POST.
      const data = parseJsonFlag(opts.data as string | undefined, "--data");
      const flagPayload = spec.create.toPayload(opts);
      const defaults = spec.create.toDefaults?.(opts) ?? {};
      const layers = [defaults, data, flagPayload];
      let merged = mergePayload(...layers);
      if (spec.create.nestedObjectKeys && spec.create.nestedObjectKeys.length > 0) {
        merged = mergeNestedObjects(merged, layers, spec.create.nestedObjectKeys);
      }
      spec.create.validatePayload?.(merged, opts);
      const { payload } = await normalizeMediaPayload(merged, descriptor.mediaFields, { signal: abortSignal() });
      logger.debug("create payload", redactForLog(payload));

      // 2. Local targets that would fail after the POST are refused before it.
      preflightLocalTargets(opts, opened);

      // 3. Journal, then exactly one POST.
      const submitted = await submitCreate(runtime, descriptor, endpoint, payload, (opts.operationId as string | undefined) ?? null);
      const { taskId, raw: createRaw, operationId, warnings } = submitted;
      const submission: SubmissionInfo = { state: "accepted", operation_id: operationId, task_id: taskId, request_id: submitted.requestId };

      if (runAsync) {
        const ctx: TaskContext = { descriptor, taskId, task: null, raw: null, submission, includeRaw };
        const savedJson = saveJsonInContext(opts, opened, createRaw, ctx);
        const project = attachInContext(opts, opened, descriptor, taskId, null, null, { operationId, payload }, warnings, { ...ctx, savedJson });
        if (opened.schema === "v1") {
          await emitEnvelope(
            okEnvelope(
              opened.command,
              taskResult({
                task: null,
                raw: null,
                descriptor,
                includeRaw: false,
                submission,
                savedJson,
                extra: { task_id: taskId, next: nextCommands(descriptor, taskId), project },
              }),
              warnings,
            ),
            opened.format,
          );
          return;
        }
        emit(
          {
            resource: spec.name,
            task_id: taskId,
            status: "PENDING",
            hint: `meshy-cli ${descriptor.commandPath.join(" ")} wait ${taskId}`,
            operation_id: operationId,
            ...(project ? { project_dir: project.project_dir } : {}),
          },
          { format: opened.format, file: undefined },
        );
        return;
      }

      // 4. Sync: poll the id we just recorded.
      await waitAndReport(opened, runtime, descriptor, endpoint, taskId, timeoutSeconds, { ...opts, __payload: payload, __operationId: operationId }, submission, warnings);
    });
  cmd.addCommand(createCmd);

  // get
  TASK_JSON_OPTIONS(cmd.command("get <task-id>").description("Retrieve a single task by id (any status is a successful query)")).action(
    async (taskId: string, opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.get`, defaultSchema);
      const runtime = await buildRuntime(opened.flags);
      const { task, raw } = await endpointOf(runtime.client).retrieveDetailed(taskId, { signal: abortSignal() });
      const submission: SubmissionInfo = { state: "accepted", operation_id: null };
      const includeRaw = Boolean(opts.includeRaw);
      const warnings: Warning[] = [];
      const ctx: TaskContext = { descriptor, taskId, task, raw, submission, includeRaw };
      const savedJson = saveJsonInContext(opts, opened, raw, ctx);
      const project = attachInContext(opts, opened, descriptor, taskId, task, raw, {}, warnings, { ...ctx, savedJson });
      if (opened.schema === "v1") {
        const downloads = await maybeDownloadV1(opened, descriptor, task, raw, submission, warnings, { savedJson, includeRaw, project });
        await emitEnvelope(
          okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw, submission, downloads, savedJson, extra: project ? { project } : {} }), warnings),
          opened.format,
        );
        return;
      }
      // Legacy shape, same rule: a download failure still names the task.
      try {
        await emitLegacyOutcome(task, false, undefined, spec.name, runtime, { query: true });
      } catch (err) {
        throw withTaskContext(err, { ...ctx, savedJson, extra: project ? { project } : {} });
      }
    },
  );

  // wait
  TASK_JSON_OPTIONS(
    cmd
      .command("wait <task-id>")
      .description("Poll until the task reaches a terminal status")
      .option("--timeout <seconds>", "max seconds to wait (0 = a single query)", "600"),
  ).action(async (taskId: string, opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, `${prefix}.wait`, defaultSchema);
    const timeoutSeconds = parseTimeoutSeconds(opts.timeout ?? "600");
    const runtime = await buildRuntime(opened.flags);
    const endpoint = endpointOf(runtime.client);
    await waitAndReport(opened, runtime, descriptor, endpoint, taskId, timeoutSeconds, opts, { state: "accepted", operation_id: null }, []);
  });

  // stream
  TASK_JSON_OPTIONS(
    cmd
      .command("stream <task-id>")
      .description("Follow the task over Server-Sent Events until it is terminal")
      .option("--timeout <seconds>", "total deadline for the stream", "600")
      .option("--idle-timeout <seconds>", "abort when no bytes arrive for this long (keep-alives count)", "60"),
  ).action(async (taskId: string, opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, `${prefix}.stream`, defaultSchema);
    if (!descriptor.supports.stream) throw new UsageError(`${spec.name} does not support stream`);
    const timeoutSeconds = parseTimeoutSeconds(opts.timeout ?? "600");
    const idleSeconds = parseTimeoutSeconds(opts.idleTimeout ?? "60", "--idle-timeout");
    if (timeoutSeconds === 0) throw new UsageError("--timeout 0 is not meaningful for stream; use `get` for a single query");
    const runtime = await buildRuntime(opened.flags);
    const endpoint = endpointOf(runtime.client);
    await streamAndReport(opened, runtime, descriptor, endpoint, taskId, timeoutSeconds, idleSeconds, opts);
  });

  // delete
  cmd
    .command("delete <task-id>")
    .description("Delete a task")
    .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.delete`, defaultSchema);
      rejectOutputFlagForV1(opened, undefined);
      const runtime = await buildRuntime(opened.flags);
      const raw = await endpointOf(runtime.client).delete(taskId, { signal: abortSignal() });
      await emitResult(
        opened,
        { resource: spec.name, task_id: taskId, deleted: true },
        { resource: spec.name, endpoint: descriptor.legacyEndpoint, task_id: taskId, deleted: true, response: raw ?? null },
        { legacyFile: opened.flags.output },
      );
    });

  // list
  if (spec.supportsList !== false && descriptor.supports.list) {
    cmd
      .command("list")
      .description("List recent tasks")
      .option("--page <n>", "page number (1-based)", "1")
      .option("--page-size <n>", "page size", "10")
      .option("--sort-by <field>", "sort order (e.g. -created_at)", "-created_at")
      .option("--save-json <file>", "save the raw list response (never overwrites)")
      .option("--include-raw", "v1: include each raw task under items[].raw")
      .action(async (opts: Record<string, unknown>, thisCmd: Command) => {
        const opened = openCommand(thisCmd, `${prefix}.list`, defaultSchema);
        rejectOutputFlagForV1(opened, opts.saveJson as string | undefined);
        const runtime = await buildRuntime(opened.flags);
        const page = { page_num: Number(opts.page ?? 1), page_size: Number(opts.pageSize ?? 10), sort_by: String(opts.sortBy ?? "-created_at") };
        if (!Number.isInteger(page.page_num) || page.page_num < 1) throw new UsageError("--page must be a positive integer");
        if (!Number.isInteger(page.page_size) || page.page_size < 1) throw new UsageError("--page-size must be a positive integer");
        const { tasks, raw } = await endpointOf(runtime.client).listDetailed(page, { signal: abortSignal() });
        const savedJson = opts.saveJson ? saveRawJson(opts.saveJson as string, raw, { workspace: opened.flags.workspace }) : null;
        const rawItems = Array.isArray(raw) ? raw : [];
        await emitResult(
          opened,
          tasks.map((t) => summarizeTask(t)),
          {
            items: tasks.map((t, i) => toTaskView(rawItems[i] ?? t, { descriptor, includeRaw: Boolean(opts.includeRaw) })),
            count: tasks.length,
            page,
            saved_json: savedJson,
          },
          { legacyFile: opened.flags.output },
        );
      });
  } else {
    cmd
      .command("list")
      .description("(unsupported) Meshy does not expose a list endpoint for this resource")
      .action(() => {
        throw new UsageError(`${spec.name} does not support list`);
      });
  }

  return cmd;
}

/** Strip media payloads before logging. */
function redactForLog(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string" && v.startsWith("data:")) out[k] = `data:<${v.length} chars>`;
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" && x.startsWith("data:") ? `data:<${x.length} chars>` : x));
    else out[k] = v;
  }
  return out;
}

export interface Submitted {
  taskId: string;
  raw: unknown;
  requestId: string | null;
  operationId: string;
  warnings: Warning[];
}

export interface SubmitContext {
  /** Names the request in messages, e.g. "make: the text-to-3d preview (geometry) request". */
  label?: string;
  /** Extra keys carried in every failure result (e.g. `{ step: 1 }`). */
  extraResult?: Record<string, unknown>;
}

/**
 * The credential identity a submission is journaled under: bound to the key
 * digest, the OAuth subject or the OAuth login id. `verified` is false when
 * none of those exists (a pre-login-id OAuth profile): such a credential may
 * start operations but is refused a replay of an existing record.
 */
export function credentialIdentityFor(runtime: Runtime, apiOrigin: string): { fingerprint: string; verified: boolean } {
  const parts = {
    source: runtime.config.credentialSource,
    profile: runtime.config.credentialProfile ?? null,
    origin: apiOrigin,
    kind: runtime.config.credentialKind,
    secret: runtime.config.credentialKind === "api_key" ? runtime.config.apiKey : null,
    subject: runtime.config.credentialSubject ?? null,
    loginId: runtime.config.credentialLoginId ?? null,
  };
  return { fingerprint: credentialFingerprint(parts), verified: credentialBinding(parts).verified };
}

/**
 * Journal → single POST → journal update. Every failure path leaves a record
 * that says what is known; the unknown state is reported as exit 10 with the
 * operation id and never as a suggestion to submit again. Shared by the
 * resource commands and `make`, so there is exactly one submission state
 * machine.
 */
export async function submitCreate(
  runtime: Runtime,
  descriptor: TaskResourceDescriptor,
  endpoint: TaskEndpoint,
  payload: Record<string, unknown>,
  requestedOperationId: string | null,
  ctx: SubmitContext = {},
): Promise<Submitted> {
  const root = operationsRoot();
  const operationId = requestedOperationId ?? newOperationId();
  const apiOrigin = originOf(endpoint.transportBaseUrl) ?? endpoint.transportBaseUrl;
  const credential = credentialIdentityFor(runtime, apiOrigin);
  const identity = {
    resource: descriptor.id,
    endpoint: descriptor.legacyEndpoint,
    apiOrigin,
    credentialFingerprint: credential.fingerprint,
    credentialVerified: credential.verified,
    payloadFingerprint: payloadFingerprint(payload),
  };
  const label = ctx.label ?? "the create request";
  const extra = ctx.extraResult ?? {};
  const warnings: Warning[] = [];

  let begin: ReturnType<typeof beginOperation>;
  try {
    begin = beginOperation(root, operationId, identity);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError({ code: "local_io", message: `cannot write the operation journal under ${root}: ${err instanceof Error ? err.message : String(err)}; nothing was submitted`, cause: err });
  }

  if (begin.outcome === "existing") {
    return replayExisting(begin.record, descriptor, operationId, extra);
  }

  if (abortSignal().aborted) {
    updateOperation(root, operationId, { state: "not_submitted", error: "interrupted before the request was sent" });
    throw new CliError({ code: "interrupted", message: "interrupted before the request was sent; nothing was submitted", result: { submission: { state: "not_submitted", operation_id: operationId }, task: null, ...extra } });
  }

  let created: { taskId: string; raw: unknown; requestId: string | null };
  try {
    created = await endpoint.createDetailed(payload, { signal: abortSignal() });
  } catch (err) {
    const submission = classifySubmissionFailure(err);
    try {
      updateOperation(root, operationId, {
        state: submission.state,
        http_status: err instanceof MeshyApiError && err.status ? err.status : null,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (journalErr) {
      warnings.push(warning("journal_write_failed", `operation journal update failed: ${journalErr instanceof Error ? journalErr.message : String(journalErr)}`));
    }
    if (submission.state === "rejected" || submission.state === "not_submitted") {
      // Definite outcomes keep their own classification (validation/auth/network …).
      if (err instanceof CliError) throw err;
      const wrapped = err instanceof MeshyApiError ? err : err instanceof Error ? err : new Error(String(err));
      throw attachSubmission(wrapped, { state: submission.state, operation_id: operationId }, warnings);
    }
    const interrupted = wasInterrupted();
    throw new CliError({
      code: interrupted ? "interrupted" : "submission_unknown",
      message: interrupted
        ? `interrupted while ${label} was in flight; the server may or may not have created a task (operation ${operationId})`
        : `${label} was sent but its outcome is unknown (${err instanceof Error ? err.message : String(err)}); the server may or may not have created a task`,
      httpStatus: err instanceof MeshyApiError && err.status ? err.status : null,
      recovery: {
        action: "reconcile",
        automatic: false,
        command: `meshy ${descriptor.commandPath.join(" ")} list --output-schema v1   # then match operation ${operationId} by time/prompt before creating again`,
      },
      result: { submission: { state: "unknown", operation_id: operationId, task_id: null }, task: null, downloads: NOT_REQUESTED(), ...extra },
      warnings,
      cause: err,
    });
  }

  try {
    updateOperation(root, operationId, { state: "accepted", task_id: created.taskId, request_id: created.requestId, http_status: 200 });
  } catch (journalErr) {
    // The server has the task; the id must survive this failure — a local write
    // problem is local_io, never an unknown submission.
    throw new CliError({
      code: "local_io",
      message: `task ${created.taskId} was created but the operation journal could not be updated: ${journalErr instanceof Error ? journalErr.message : String(journalErr)}`,
      result: {
        submission: { state: "accepted", operation_id: operationId, task_id: created.taskId, request_id: created.requestId },
        task: null,
        task_id: created.taskId,
        next: nextCommands(descriptor, created.taskId),
        ...extra,
      },
      cause: journalErr,
    });
  }
  return { taskId: created.taskId, raw: created.raw, requestId: created.requestId, operationId, warnings };
}

function replayExisting(record: OperationRecord, descriptor: TaskResourceDescriptor, operationId: string, extra: Record<string, unknown>): Submitted {
  if (record.state === "accepted" && record.task_id) {
    return {
      taskId: record.task_id,
      raw: { result: record.task_id, replayed_from_journal: true },
      requestId: record.request_id,
      operationId,
      warnings: [warning("operation_replayed", `operation ${operationId} was already accepted as task ${record.task_id} on ${record.updated_at}; no new request was sent`)],
    };
  }
  if (record.state === "unknown" || record.state === "started") {
    throw new CliError({
      code: "submission_unknown",
      message: `operation ${operationId} is recorded as '${record.state}' since ${record.updated_at}; reconcile it before submitting again (nothing was sent now)`,
      recovery: { action: "reconcile", automatic: false, command: `meshy ${descriptor.commandPath.join(" ")} list --output-schema v1` },
      result: { submission: { state: "unknown", operation_id: operationId, task_id: record.task_id }, task: null, ...extra },
    });
  }
  throw new CliError({
    code: "operation_conflict",
    message: `operation ${operationId} was already ${record.state} on ${record.updated_at} (${record.error ?? "no detail"}); use a new --operation-id to submit again`,
    result: { submission: { state: record.state, operation_id: operationId, task_id: record.task_id }, task: null, ...extra },
  });
}

function classifySubmissionFailure(err: unknown): { state: "rejected" | "not_submitted" | "unknown" } {
  if (err instanceof TransportError) {
    return { state: err.neverSent ? "not_submitted" : "unknown" };
  }
  if (err instanceof MeshyApiError) {
    if (err.status >= 400 && err.status < 500) return { state: "rejected" };
    return { state: "unknown" }; // 5xx, malformed 2xx, unknown status
  }
  return { state: "unknown" };
}

function attachSubmission(err: Error, submission: { state: string; operation_id: string }, warnings: Warning[]): Error {
  (err as Error & { submission?: unknown; warnings?: Warning[] }).submission = submission;
  (err as Error & { submission?: unknown; warnings?: Warning[] }).warnings = warnings;
  return err;
}

/**
 * v1 `-o`: download a SUCCEEDED task's assets through the legacy layout,
 * confined to the workspace when one is set. A failure keeps the task in the
 * result — the assets are still on the server, the task still exists.
 */
async function maybeDownloadV1(
  opened: OpenedCommand,
  descriptor: TaskResourceDescriptor,
  task: Task,
  raw: unknown,
  submission: SubmissionInfo,
  warnings: Warning[],
  ctx: { savedJson?: SavedJson | null; includeRaw?: boolean; project?: ProjectAttachment | null },
): Promise<DownloadOutcome> {
  const output = opened.flags.output;
  if (!output) return NOT_REQUESTED();
  if (task.status !== "SUCCEEDED") return { state: "not_ready", files: [], metadata_path: null };
  try {
    const { files, metadataPath, materialLinks } = await downloadArtifacts(task, output, descriptor.id, { root: opened.flags.workspace, signal: abortSignal() });
    if (materialLinks) warnings.push(...materialLinks.warnings);
    return {
      state: "completed",
      files: files.map((f) => ({ key: f.key, path: f.path, status: f.status, bytes: f.bytes, sha256: f.sha256, error: f.error })),
      metadata_path: metadataPath,
      material_links: materialLinks,
    };
  } catch (err) {
    // Whatever the downloader already committed stays in the manifest, and the
    // failure keeps its own class: an HTTP 503 on the second asset is a network
    // failure with its status, a Ctrl-C is `interrupted` (130) — never a bare local_io.
    const partial: DownloadOutcome =
      err instanceof CliError && err.result && err.result["downloads"] && typeof err.result["downloads"] === "object"
        ? (err.result["downloads"] as DownloadOutcome)
        : { state: "failed", files: [], metadata_path: null };
    const interrupted = (err instanceof CliError && err.code === "interrupted") || wasInterrupted();
    const failure = new CliError({
      code: interrupted ? "interrupted" : err instanceof CliError ? err.code : "local_io",
      message: `task ${task.id} is SUCCEEDED but downloading its assets ${interrupted ? "was interrupted" : "failed"}: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: err instanceof CliError ? err.httpStatus : null,
      retryable: err instanceof CliError ? err.retryable : false,
      recovery: err instanceof CliError && err.recovery ? err.recovery : { action: "download", automatic: false, command: `meshy download --resource ${descriptor.id} --task-id ${task.id} --all --output-dir <dir>` },
      hint: err instanceof CliError ? err.hint : undefined,
      details: err instanceof CliError ? err.details : undefined,
      result: { downloads: partial },
      warnings: [...warnings, ...(err instanceof CliError ? err.warnings : [])],
      cause: err,
    });
    throw withTaskContext(failure, {
      descriptor,
      taskId: task.id,
      task,
      raw,
      submission,
      includeRaw: ctx.includeRaw,
      savedJson: ctx.savedJson,
      extra: ctx.project ? { project: ctx.project } : {},
    });
  }
}

async function waitAndReport(
  opened: OpenedCommand,
  runtime: Runtime,
  descriptor: TaskResourceDescriptor,
  endpoint: TaskEndpoint,
  taskId: string,
  timeoutSeconds: number,
  opts: Record<string, unknown>,
  submission: SubmissionInfo,
  warnings: Warning[],
): Promise<void> {
  const started = performance.now();
  const includeRaw = Boolean(opts.includeRaw);
  // A holder (not a bare `let`) so the callback's assignment is visible to the
  // catch block without TypeScript narrowing it away.
  const seen: { last: { task: Task; raw: unknown } | null; polls: number } = { last: null, polls: 0 };
  let poll: PollResult;
  try {
    poll = await pollUntilTerminal(endpoint, taskId, {
      timeoutSeconds,
      intervalMs: runtime.config.pollIntervalMs,
      requestTimeoutMs: runtime.config.readTimeoutMs,
      signal: abortSignal(),
      onTick: (task, raw) => {
        seen.last = { task, raw };
        seen.polls += 1;
        if (opened.schema === "v1" && opened.format !== "ndjson") {
          process.stderr.write(`[${descriptor.id}] ${task.status}${typeof task.progress === "number" ? ` ${task.progress}%` : ""}\n`);
        }
      },
    });
  } catch (err) {
    if (wasInterrupted() || abortSignal().aborted) {
      throw interruptedError(descriptor, taskId, seen.last, submission, opts, opened);
    }
    // A polling failure (5xx, network, malformed task) is not "no task": the
    // id, the submission and the last status seen travel with the error.
    const elapsed = (performance.now() - started) / 1000;
    throw withTaskContext(err, {
      descriptor,
      taskId,
      task: seen.last?.task ?? null,
      raw: seen.last?.raw ?? null,
      submission,
      includeRaw,
      extra: { wait: { timed_out: false, elapsed_seconds: Number(elapsed.toFixed(2)), polls: seen.polls } },
    });
  }
  const elapsed = (performance.now() - started) / 1000;
  const { task, raw, timedOut, aborted } = poll;
  const waitInfo = { timed_out: timedOut, elapsed_seconds: Number(elapsed.toFixed(2)), polls: poll.polls };

  if (aborted) throw interruptedError(descriptor, taskId, task ? { task, raw } : seen.last, submission, opts, opened);

  if (task === null) {
    // The deadline passed before the first response arrived; the task id is all we know — and it is enough.
    if (opened.schema !== "v1") {
      emitLegacyTimeoutWithoutTask(taskId, descriptor.id, runtime);
      return;
    }
    throw new CliError({
      code: "timed_out",
      message: `task ${taskId} did not answer within ${timeoutSeconds}s (no status was received in time); the server keeps running it`,
      recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait },
      result: taskResult({ task: null, raw: null, descriptor, includeRaw, submission, extra: { task_id: taskId, wait: waitInfo, next: nextCommands(descriptor, taskId) } }),
      warnings,
    });
  }

  const ctx: TaskContext = { descriptor, taskId, task, raw, submission, includeRaw, extra: { wait: waitInfo } };
  const savedJson = saveJsonInContext(opts, opened, raw, ctx);
  const project = attachInContext(
    opts,
    opened,
    descriptor,
    taskId,
    task,
    raw,
    { operationId: (opts.__operationId as string | undefined) ?? submission.operation_id ?? null, payload: (opts.__payload as Record<string, unknown> | undefined) ?? null },
    warnings,
    { ...ctx, savedJson },
  );
  const projectExtra = project ? { project } : {};

  if (opened.schema !== "v1") {
    // The legacy reporter downloads too; whatever fails there — an asset host
    // 503, a sidecar that cannot be published, Ctrl-C — the error still
    // carries the accepted task id, the real submission and the resume command.
    try {
      await emitLegacyOutcome(task, timedOut, elapsed, descriptor.id, runtime, { query: false });
    } catch (err) {
      throw withTaskContext(err, { ...ctx, savedJson, extra: { wait: waitInfo, ...projectExtra } });
    }
    return;
  }

  if (timedOut) {
    throw new CliError({
      code: "timed_out",
      message: `task ${taskId} did not reach a terminal status within ${timeoutSeconds}s (last status: ${task.status}); the server keeps running it`,
      recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait },
      result: taskResult({ task, raw, descriptor, includeRaw, submission, savedJson, extra: { task_id: taskId, wait: waitInfo, next: nextCommands(descriptor, taskId), ...projectExtra } }),
      warnings,
    });
  }
  if (task.status !== "SUCCEEDED") {
    throw new CliError({
      code: "task_failed",
      message: task.task_error?.message ? `task ${taskId} ${task.status}: ${task.task_error.message}` : `task ${taskId} ended as ${task.status}`,
      result: taskResult({ task, raw, descriptor, includeRaw, submission, savedJson, extra: { task_id: taskId, wait: waitInfo, ...projectExtra } }),
      warnings,
    });
  }
  const downloads = await maybeDownloadV1(opened, descriptor, task, raw, submission, warnings, { savedJson, includeRaw, project });
  await emitEnvelope(
    okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw, submission, downloads, savedJson, extra: { wait: waitInfo, ...projectExtra } }), warnings),
    opened.format,
  );
}

/** Legacy shape for a wait that timed out before any status arrived: still the task id, still exit 8. */
function emitLegacyTimeoutWithoutTask(taskId: string, resourceName: string, runtime: Runtime): void {
  if (runtime.flags.output) {
    const report: Parameters<typeof printReport>[0] = { status: "FAIL", taskId, type: resourceName, timedOut: true };
    const notice = getUpdateNotice();
    if (notice) report._notice = notice;
    printReport(report);
  } else {
    emit({ resource: resourceName, id: taskId, status: null, timed_out: true }, { format: runtime.flags.format });
  }
  process.exitCode = 8;
}

function interruptedError(
  descriptor: TaskResourceDescriptor,
  taskId: string,
  last: { task: Task; raw: unknown } | null,
  submission: SubmissionInfo,
  opts: Record<string, unknown>,
  opened: OpenedCommand,
  savedJson: SavedJson | null = null,
): CliError {
  let saved = savedJson;
  if (!saved && opts.saveJson && last) {
    try {
      saved = saveRawJson(opts.saveJson as string, last.raw, { workspace: opened.flags.workspace });
    } catch {
      saved = null;
    }
  }
  return new CliError({
    code: "interrupted",
    message: `interrupted while waiting for task ${taskId}; the server keeps running it — resume with \`${nextCommands(descriptor, taskId).wait}\``,
    recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait },
    result: taskResult({ task: last?.task ?? null, raw: last?.raw ?? null, descriptor, includeRaw: Boolean(opts.includeRaw), submission, savedJson: saved, extra: { task_id: taskId, next: nextCommands(descriptor, taskId) } }),
  });
}

async function streamAndReport(
  opened: OpenedCommand,
  runtime: Runtime,
  descriptor: TaskResourceDescriptor,
  endpoint: TaskEndpoint,
  taskId: string,
  timeoutSeconds: number,
  idleSeconds: number,
  opts: Record<string, unknown>,
): Promise<void> {
  const includeRaw = Boolean(opts.includeRaw);
  const ndjson = opened.format === "ndjson";
  let sequence = 0;
  const submission: SubmissionInfo = { state: "accepted", operation_id: null };
  const warnings: Warning[] = [];

  const outcome = await streamTask(endpoint, taskId, {
    timeoutMs: timeoutSeconds * 1000,
    idleTimeoutMs: idleSeconds * 1000,
    signal: abortSignal(),
    onUnknownEvent: (ev) => {
      warnings.push(warning("unknown_sse_event", `ignored SSE event '${ev.event}'`));
    },
    onTask: async (task, raw) => {
      if (opened.schema === "v1" && ndjson) {
        sequence += 1;
        const event: StreamEventEnvelope = {
          ...okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw, submission })),
          event: "task",
          sequence,
        };
        await emitStreamEvent(event);
      } else if (opened.schema === "v1") {
        process.stderr.write(`[${descriptor.id}] ${task.status}${typeof task.progress === "number" ? ` ${task.progress}%` : ""}\n`);
      }
    },
  });

  const streamInfo = { events: outcome.events, ended: outcome.reason, elapsed_seconds: Number((outcome.elapsedMs / 1000).toFixed(2)) };
  const ctx: TaskContext = { descriptor, taskId, task: outcome.task, raw: outcome.raw, submission, includeRaw, extra: { stream: streamInfo, task_id: taskId } };

  // Once the stream has started, every later step — saving JSON, recording the
  // project, downloading — is part of the same terminal outcome: one `outcome`
  // event (ndjson) or one envelope (json/pretty), never a bare error after it.
  let savedJson: SavedJson | null = null;
  let project: ProjectAttachment | null = null;
  let bookkeepingError: CliError | null = null;
  try {
    savedJson = opts.saveJson && outcome.raw ? saveJsonInContext(opts, opened, outcome.raw, ctx) : null;
    project = outcome.task ? attachInContext(opts, opened, descriptor, taskId, outcome.task, outcome.raw, {}, warnings, { ...ctx, savedJson }) : null;
  } catch (err) {
    bookkeepingError = err instanceof CliError ? err : withTaskContext(err, ctx);
  }
  const projectExtra = project ? { project } : {};

  let finalError: CliError | null = null;
  const resultWith = (downloads?: DownloadOutcome): Record<string, unknown> =>
    taskResult({ task: outcome.task, raw: outcome.raw, descriptor, includeRaw, submission, downloads, savedJson, extra: { stream: streamInfo, task_id: taskId, next: nextCommands(descriptor, taskId), ...projectExtra } });
  let result = resultWith();
  switch (outcome.reason) {
    case "terminal":
      if (outcome.task && outcome.task.status !== "SUCCEEDED") {
        finalError = new CliError({
          code: "task_failed",
          message: outcome.task.task_error?.message ? `task ${taskId} ${outcome.task.status}: ${outcome.task.task_error.message}` : `task ${taskId} ended as ${outcome.task.status}`,
          result,
          warnings,
        });
      }
      break;
    case "timeout":
      finalError = new CliError({ code: "timed_out", message: `stream deadline of ${timeoutSeconds}s reached (last status: ${outcome.task?.status ?? "none"}); the server keeps running the task`, recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait }, result, warnings });
      break;
    case "idle_timeout":
      finalError = new CliError({ code: "network", message: `no bytes received for ${idleSeconds}s on the stream (last status: ${outcome.task?.status ?? "none"})`, recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait }, result, warnings });
      break;
    case "disconnected":
      finalError = new CliError({ code: "network", message: outcome.error?.message ?? "stream disconnected before a terminal status", recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait }, result, warnings });
      break;
    case "interrupted":
      finalError = new CliError({ code: "interrupted", message: `interrupted while streaming task ${taskId}; the server keeps running it`, recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait }, result, warnings });
      break;
    case "error":
    case "protocol":
      finalError = wrapStreamError(outcome.error, result, warnings);
      break;
  }
  if (bookkeepingError) {
    if (finalError) {
      // The stream's own failure is the outcome; the bookkeeping failure rides along as a warning.
      finalError.warnings.push(warning("bookkeeping_failed", bookkeepingError.message));
    } else {
      finalError = bookkeepingError;
    }
  }

  if (opened.schema !== "v1") {
    // Legacy has no stream shape to preserve: reuse the terminal summary path (which honours -o itself).
    if (finalError) throw finalError;
    if (outcome.task) {
      try {
        await emitLegacyOutcome(outcome.task, false, outcome.elapsedMs / 1000, descriptor.id, runtime, { query: false });
      } catch (err) {
        throw withTaskContext(err, { ...ctx, savedJson, extra: { stream: streamInfo, ...projectExtra } });
      }
    }
    return;
  }

  // The terminal outcome includes the requested download whatever the output
  // format: `-o` means "put the assets on disk", not "only when printing JSON".
  if (!finalError && outcome.task && outcome.task.status === "SUCCEEDED") {
    try {
      const downloads = await maybeDownloadV1(opened, descriptor, outcome.task, outcome.raw, submission, warnings, { savedJson, includeRaw, project });
      result = resultWith(downloads);
    } catch (err) {
      finalError = err instanceof CliError ? err : withTaskContext(err, ctx);
    }
  }

  if (ndjson) {
    sequence += 1;
    const body = finalError ? errorEnvelope(opened.command, finalError).envelope : okEnvelope(opened.command, result, warnings);
    const event: StreamEventEnvelope = { ...body, event: "outcome", sequence };
    await emitStreamEvent(event);
    // The outcome line already carries the error; exit with its code without a second envelope.
    if (finalError) process.exitCode = finalError.exitCode;
    return;
  }
  if (finalError) throw finalError;
  await emitEnvelope(okEnvelope(opened.command, result, warnings), opened.format);
}

function wrapStreamError(err: MeshyApiError | CliError | null, result: Record<string, unknown>, warnings: Warning[]): CliError {
  if (err instanceof CliError) {
    return new CliError({ code: err.code, message: err.message, httpStatus: err.httpStatus, recovery: err.recovery, result, warnings: [...err.warnings, ...warnings], cause: err });
  }
  if (err instanceof MeshyApiError) {
    const code = err.code === "server" ? "server" : err.code;
    return new CliError({ code, message: err.message, httpStatus: err.status || null, result, warnings, cause: err });
  }
  return new CliError({ code: "protocol", message: "stream ended abnormally", result, warnings });
}

/**
 * Legacy reporter. `query: true` is `get`: a valid task is a successful query
 * whatever its status (0.2.0 exited 1 for PENDING/IN_PROGRESS — fixed); a
 * terminal FAILED/CANCELED still exits 1 for compatibility.
 */
async function emitLegacyOutcome(
  task: Task,
  timedOut: boolean,
  elapsedSeconds: number | undefined,
  resourceName: string,
  runtime: Runtime,
  mode: { query: boolean },
): Promise<void> {
  const output = runtime.flags.output;
  const succeeded = !timedOut && task.status === "SUCCEEDED";

  if (output) {
    if (succeeded) {
      const { savedFiles, metadataPath } = await downloadArtifacts(task, output, resourceName, { root: runtime.flags.workspace, signal: abortSignal() });
      const successReport: Parameters<typeof printReport>[0] = {
        status: "SUCCESS",
        taskId: task.id,
        type: task.type || resourceName,
        savedFiles,
        metadataPath,
      };
      const successNotice = getUpdateNotice();
      if (successNotice) successReport._notice = successNotice;
      printReport(successReport);
      return;
    }
    const report: Parameters<typeof printReport>[0] = {
      status: "FAIL",
      taskId: task.id,
      type: task.type || resourceName,
    };
    if (timedOut) report.timedOut = true;
    else if (task.task_error?.message) report.error = task.task_error.message;
    else if (task.status) report.error = `task status: ${task.status}`;
    const failNotice = getUpdateNotice();
    if (failNotice) report._notice = failNotice;
    printReport(report);
    if (timedOut) process.exitCode = 8;
    else if (mode.query && !isTerminalStatus(task.status)) process.exitCode = 0;
    else process.exitCode = 1;
    return;
  }

  emit(
    {
      resource: resourceName,
      ...summarizeTask(task, elapsedSeconds),
      ...(timedOut ? { timed_out: true } : {}),
    },
    { format: runtime.flags.format },
  );
  if (timedOut) process.exitCode = 8;
  else if (task.status === "SUCCEEDED") process.exitCode = 0;
  else if (!isTerminalStatus(task.status)) process.exitCode = mode.query ? 0 : 1;
  else process.exitCode = 1;
}

/** Kept for make.ts (legacy path). */
export async function emitTerminalOutcome(
  task: Task,
  timedOut: boolean,
  elapsedSeconds: number | undefined,
  resourceName: string,
  runtime: Runtime,
): Promise<void> {
  await emitLegacyOutcome(task, timedOut, elapsedSeconds, resourceName, runtime, { query: false });
}

export { taskResult as buildTaskResult, nextCommands as taskNextCommands };
export type { TaskView };
