/**
 * Factory that wires the uniform create/get/list/wait/stream/delete
 * subcommands for any registered task resource. Per-resource modules only
 * contribute their unique `create` flag shape and payload validation.
 *
 * Every verb prints one `meshy.cli/v1` envelope whose result carries the
 * TaskView, the submission record and the download manifest. `get` of a task
 * in any status is a successful query (exit 0); async create never polls.
 *
 * Money rules enforced here:
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
import type { Task } from "../client/types.js";
import { emitResult, openCommand, rejectOutputFlag, saveRawJson, type OpenedCommand, type SavedJson } from "./command-helpers.js";
import { abortSignal, wasInterrupted } from "./context.js";
import { downloadArtifacts, type SkippedArtifact } from "./download.js";
import { classifyError, CliError, UsageError, type Warning } from "./errors.js";
import { normalizeMediaPayload } from "./file-input.js";
import { allAssetsOption, outputOption } from "./global-options.js";
import { logger } from "./logger.js";
import type { MaterialLinkReport } from "./material-links.js";
import { mergeNestedObjects, mergePayload, parseJsonFlag } from "./payload.js";
import { emitEnvelope, emitStreamEvent } from "./output.js";
import { parseTimeoutSeconds, pollUntilTerminal, type PollResult } from "./poll.js";
import { createProgress, withSpinner, type Progress } from "./progress.js";
import { errorEnvelope, okEnvelope, warning, type StreamEventEnvelope } from "./result.js";
import { buildRuntime, type Runtime } from "./runtime.js";
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
import { freezeRoot, looksLikeFile, resolveWithinRoot, type AuthorisedRoot } from "./paths.js";
import { assertProjectMetadataPresent, indexRootFor, projectRecordCommand, recordTask, saveTaskSnapshot, stageFromTaskType, type RecordInput } from "./project-store.js";
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
  create: CreateSpec;
  /** Optional override; defaults to the registry endpoint for `name`. */
  endpointOf?(client: MeshyClient): TaskEndpoint;
}

const TASK_JSON_OPTIONS = (cmd: Command): Command =>
  cmd
    .addOption(outputOption())
    .addOption(allAssetsOption())
    .option("--save-json <file>", "save the full task JSON as received (never overwrites)")
    .option("--include-raw", "include the untouched task response under result.task.raw")
    .option("--project <dir>", "initialised meshy_output project: save task_<id>.json there and record the task in metadata.json")
    .option("--stage <name>", "stage label for the project record (default: derived from the task type, e.g. preview | refine | build)");

export interface DownloadOutcome {
  state: "not_requested" | "not_ready" | "completed" | "partial" | "failed";
  files: Array<{ key?: string; path: string; status: "written" | "failed"; bytes?: number; sha256?: string; error?: string | null }>;
  metadata_path: string | null;
  /** Artifacts `-o` left on the server (without --all-assets), with the reason; meta.json keeps their URLs. */
  skipped?: SkippedArtifact[];
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

function nextCommands(descriptor: TaskResourceDescriptor, taskId: string): { get: string; wait: string; stream: string } {
  const base = `meshy ${descriptor.commandPath.join(" ")}`;
  return {
    get: `${base} get ${taskId}`,
    wait: `${base} wait ${taskId}`,
    stream: `${base} stream ${taskId} --format ndjson`,
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
function resolveProjectDir(projectFlag: string, workspace: string | AuthorisedRoot | undefined, cwd = process.cwd()): string {
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
 * never read as "no task was created". The recovery context (task, journal
 * operation, stage, workspace) exists before the project is even looked at, so
 * every failure of this phase — the directory resolving outside the workspace,
 * a metadata.json that vanished or was damaged after the preflight, a lock, a
 * full disk — carries it. Two kinds of failure, two answers: a project that no
 * longer lies inside the write boundary gets no command that would cross it;
 * anything else gets the one `meshy project record …` invocation (with the
 * original `--workspace`) that redoes just the record once the project is
 * restored. Nothing is re-submitted.
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
  const projectDir = resolvePath(projectFlag);
  // The boundary was frozen before the first request (the workspace, or the
  // project directory itself when no workspace is given); it is never resolved
  // again from a path that may have been replaced since.
  const root: AuthorisedRoot = opened.flags.workspaceRoot ?? (opts.__projectRoot as AuthorisedRoot | undefined) ?? freezeRoot(projectDir, { label: "--project" });
  const workspace = opened.flags.workspaceRoot?.given;
  const stage = (opts.stage as string | undefined) ?? (typeof extra.payload?.["mode"] === "string" ? (extra.payload["mode"] as string) : descriptor.creativeLab?.stage ?? stageFromTaskType(task?.type, descriptor.id));
  const input: RecordInput = {
    taskId,
    stage,
    resource: descriptor.id,
    taskType: task?.type ?? null,
    endpoint: descriptor.endpoint,
    parentTaskId: parentTaskIdFromPayload(extra.payload ?? null),
    status: task?.status ?? null,
    taskJson: null,
    operationId: extra.operationId ?? null,
    files: extra.files ?? [],
  };
  // 1. The location. The frozen boundary must still be the directory it was,
  //    and the project must resolve inside it now — a workspace or project
  //    replaced by a symlink while the request was in flight, or a project that
  //    now resolves elsewhere, is a boundary problem: the task exists and is
  //    journaled, but no recovery command may be handed out that writes across
  //    that line. What passes is written through its real path.
  let located: string;
  try {
    located = resolveWithinRoot(projectDir, root, { label: "--project" }).path;
  } catch (err) {
    throw projectBoundaryFailure(err, taskId, projectFlag, input);
  }
  // 2. The record itself, including "is this (still) an initialised project".
  try {
    if (opts.__projectInitialised === false && !existsSync(join(located, "metadata.json"))) {
      throw new CliError({ code: "local_io", message: `--project ${projectFlag} is not an initialised project (no metadata.json); run \`meshy project init\` first` });
    }
    assertProjectMetadataPresent(located, projectFlag);
    const snapshot = task && raw ? saveTaskSnapshot(located, taskId, raw) : null;
    input.taskJson = snapshot?.relative ?? null;
    const indexRoot = indexRootFor(located, undefined, opened.flags.workspaceRoot);
    const rec = recordTask(located, input, { root: indexRoot.root, skipIndex: indexRoot.skipIndex });
    if (!rec.index.updated) warnings.push(warning("index_dirty", `metadata.json committed but history.json was not updated: ${rec.index.error}; run \`meshy project rebuild-index\``));
    return { project_dir: projectDir, snapshot: snapshot?.path ?? null, stage, action: rec.action, index: rec.index };
  } catch (err) {
    // The task exists and the journal is written; only the project entry is
    // missing. The recovery redoes that one step under the original boundary.
    const command = projectRecordCommand(projectDir, input, { workspace });
    throw new CliError({
      code: err instanceof CliError ? err.code : "local_io",
      message: `task ${taskId} exists${input.operationId ? ` (operation ${input.operationId})` : ""} but recording it in ${projectDir} failed: ${err instanceof Error ? err.message : String(err)}; restore the project, then run: ${command}`,
      httpStatus: err instanceof CliError ? err.httpStatus : null,
      retryable: err instanceof CliError ? err.retryable : false,
      recovery: { action: "record_project", automatic: false, command },
      hint: command,
      details: err instanceof CliError ? err.details : undefined,
      cause: err,
    });
  }
}

/**
 * The project directory no longer resolves inside the workspace (or is a
 * symlink). The task is known and journaled; the caller learns that, and that
 * nothing was recorded — but no `meshy project record` command is offered,
 * because the only one that would succeed is one without the boundary.
 */
function projectBoundaryFailure(err: unknown, taskId: string, projectFlag: string, input: RecordInput): CliError {
  const reason = err instanceof Error ? err.message : String(err);
  return new CliError({
    code: "local_io",
    message: `task ${taskId} exists${input.operationId ? ` (operation ${input.operationId})` : ""} but --project ${projectFlag} is no longer a target inside the authorised boundary: ${reason}; nothing was recorded (no project lock, snapshot or metadata was written). Restore the project inside the workspace, then record the task with \`meshy project record\` from that workspace`,
    details: { project: projectFlag, task_id: taskId, operation_id: input.operationId ?? null, stage: input.stage, recorded: false },
    cause: err,
  });
}

/** --save-json inside the task's context: a full disk or a vanished directory never hides the task id. */
function saveJsonInContext(opts: Record<string, unknown>, opened: OpenedCommand, raw: unknown, ctx: TaskContext): SavedJson | null {
  if (!opts.saveJson) return null;
  try {
    return saveRawJson(String(opts.saveJson), raw, { workspace: opened.flags.workspaceRoot });
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
export function preflightOutputPath(output: string, workspace: string | AuthorisedRoot | undefined, cwd = process.cwd()): void {
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
export function preflightSaveJsonPath(target: string, workspace: string | AuthorisedRoot | undefined, cwd = process.cwd()): void {
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

/**
 * Freeze the project's write boundary before the first request: with a
 * workspace it is the workspace (already frozen with the flags); without one it
 * is the project directory as it is right now. Whether the project was
 * initialised at this moment is remembered too, so a later "no metadata.json"
 * can say which it was. Nothing is refused here for get/wait/stream — a
 * bookkeeping problem stays a bookkeeping problem after the request (one
 * outcome); create's preflight refuses an uninitialised project before its POST.
 */
function beginProjectContext(opts: Record<string, unknown>, opened: OpenedCommand): void {
  const projectFlag = opts.project as string | undefined;
  if (!projectFlag || opts.__projectRoot) return;
  const projectDir = resolvePath(projectFlag);
  opts.__projectInitialised = existsSync(join(projectDir, "metadata.json"));
  opts.__projectRoot = opened.flags.workspaceRoot ?? freezeRoot(projectDir, { label: "--project" });
}

function preflightLocalTargets(opts: Record<string, unknown>, opened: OpenedCommand): void {
  if (opts.saveJson) preflightSaveJsonPath(String(opts.saveJson), opened.flags.workspaceRoot);
  if (opened.flags.output) preflightOutputPath(opened.flags.output, opened.flags.workspaceRoot);
  if (opts.project) {
    try {
      resolveProjectDir(String(opts.project), opened.flags.workspaceRoot);
      beginProjectContext(opts, opened);
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
    .addOption(new Option("--timeout <seconds>", "max seconds to poll in sync mode; the task keeps running after it (resume with `wait`; the API advises allowing up to 60 min)").default("600"))
    .addOption(
      new Option(
        "--operation-id <id>",
        "local journal id for this submission; repeating it returns the recorded outcome instead of submitting again (local record only, not a server idempotency key)",
      ),
    )
    .action(async (opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.create`);
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

      // 4. Sync: poll the id we just recorded.
      await waitAndReport(opened, runtime, descriptor, endpoint, taskId, timeoutSeconds, { ...opts, __payload: payload, __operationId: operationId }, submission, warnings);
    });
  cmd.addCommand(createCmd);

  // get
  TASK_JSON_OPTIONS(cmd.command("get <task-id>").description("Retrieve a single task by id (any status is a successful query)")).action(
    async (taskId: string, opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.get`);
    beginProjectContext(opts, opened);
      const runtime = await buildRuntime(opened.flags);
      const { task, raw } = await endpointOf(runtime.client).retrieveDetailed(taskId, { signal: abortSignal() });
      const submission: SubmissionInfo = { state: "accepted", operation_id: null };
      const includeRaw = Boolean(opts.includeRaw);
      const warnings: Warning[] = [];
      const ctx: TaskContext = { descriptor, taskId, task, raw, submission, includeRaw };
      const savedJson = saveJsonInContext(opts, opened, raw, ctx);
      const project = attachInContext(opts, opened, descriptor, taskId, task, raw, {}, warnings, { ...ctx, savedJson });
      const downloads = await maybeDownloadV1(opened, descriptor, task, raw, submission, warnings, { savedJson, includeRaw, project });
      await emitEnvelope(
        okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw, submission, downloads, savedJson, extra: project ? { project } : {} }), warnings),
        opened.format,
      );
      return;
    },
  );

  // wait
  TASK_JSON_OPTIONS(
    cmd
      .command("wait <task-id>")
      .description("Poll until the task reaches a terminal status")
      .option("--timeout <seconds>", "max seconds to wait (0 = a single query); the task keeps running after it — the API advises allowing up to 60 min", "600"),
  ).action(async (taskId: string, opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, `${prefix}.wait`);
    beginProjectContext(opts, opened);
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
    const opened = openCommand(thisCmd, `${prefix}.stream`);
    beginProjectContext(opts, opened);
    if (!descriptor.supports.stream) throw new UsageError(`${spec.name} does not support stream`);
    const timeoutSeconds = parseTimeoutSeconds(opts.timeout ?? "600");
    const idleSeconds = parseTimeoutSeconds(opts.idleTimeout ?? "60", "--idle-timeout");
    if (timeoutSeconds === 0) throw new UsageError("--timeout 0 is not meaningful for stream; use `get` for a single query");
    const runtime = await buildRuntime(opened.flags);
    const endpoint = endpointOf(runtime.client);
    await streamAndReport(opened, runtime, descriptor, endpoint, taskId, timeoutSeconds, idleSeconds, opts);
  });

  // delete — Creative Lab's DELETE cancels instead: the task stays, as CANCELED
  // (PENDING is refunded, IN_PROGRESS is not, a finished task is refused).
  const cancels = Boolean(descriptor.creativeLab);
  cmd
    .command("delete <task-id>")
    .description(
      cancels
        ? "Cancel a task: PENDING is refunded, IN_PROGRESS is not; a finished task cannot be canceled (the task is kept as CANCELED, not deleted)"
        : "Permanently delete a task (a PENDING task is refunded; an IN_PROGRESS one cannot be stopped and is refused with exit 14; a finished one is deleted without a refund)",
    )
    .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.delete`);
      rejectOutputFlag(opened, undefined);
      const runtime = await buildRuntime(opened.flags);
      let raw: unknown;
      try {
        raw = await endpointOf(runtime.client).delete(taskId, { signal: abortSignal() });
      } catch (err) {
        throw deleteFailure(err, taskId, nextCommands(descriptor, taskId).wait);
      }
      const outcome = cancels ? { deleted: false, canceled: true } : { deleted: true };
      await emitResult(opened, { resource: spec.name, endpoint: descriptor.endpoint, task_id: taskId, ...outcome, response: raw ?? null });
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
      .option("--include-raw", "include each raw task under items[].raw")
      .action(async (opts: Record<string, unknown>, thisCmd: Command) => {
        const opened = openCommand(thisCmd, `${prefix}.list`);
        rejectOutputFlag(opened, opts.saveJson as string | undefined);
        const runtime = await buildRuntime(opened.flags);
        const page = { page_num: Number(opts.page ?? 1), page_size: Number(opts.pageSize ?? 10), sort_by: String(opts.sortBy ?? "-created_at") };
        if (!Number.isInteger(page.page_num) || page.page_num < 1) throw new UsageError("--page must be a positive integer");
        if (!Number.isInteger(page.page_size) || page.page_size < 1) throw new UsageError("--page-size must be a positive integer");
        const { tasks, raw } = await endpointOf(runtime.client).listDetailed(page, { signal: abortSignal() });
        const savedJson = opts.saveJson ? saveRawJson(opts.saveJson as string, raw, { workspace: opened.flags.workspaceRoot }) : null;
        const rawItems = Array.isArray(raw) ? raw : [];
        await emitResult(
          opened,
          {
            items: tasks.map((t, i) => toTaskView(rawItems[i] ?? t, { descriptor, includeRaw: Boolean(opts.includeRaw) })),
            count: tasks.length,
            page,
            saved_json: savedJson,
          },
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

/**
 * A DELETE the server refused because the task is IN_PROGRESS (409): its own
 * class (`conflict`, exit 14). The task cannot be stopped and its credits are
 * spent, so the way forward is to wait for the result — not to delete it once
 * it finishes, which is permanent and refunds nothing. Without a resource
 * (top-level `delete`) there is no runnable wait command, so none is offered.
 */
export function deleteFailure(err: unknown, taskId: string, waitCommand?: string): unknown {
  if (!(err instanceof MeshyApiError) || err.code !== "conflict") return err;
  const wait = waitCommand ? `\`${waitCommand}\` gets the result` : "the `wait` verb of the command that created it gets the result";
  return new CliError({
    code: "conflict",
    message: `${err.message} (task ${taskId} was not deleted)`,
    httpStatus: err.status,
    recovery: waitCommand ? { action: "wait", automatic: false, command: waitCommand } : { action: "wait", automatic: false },
    hint: `The task is running: it cannot be stopped and its credits are spent; ${wait}. Delete it after it finishes only if the result should be gone — that is permanent, with no refund.`,
    details: { path: err.path, body: err.body },
    result: { task_id: taskId, deleted: false },
    cause: err,
  });
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
    endpoint: descriptor.endpoint,
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
        command: `meshy ${descriptor.commandPath.join(" ")} list   # then match operation ${operationId} by time/prompt before creating again`,
      },
      hint: resolveHint(operationId),
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
      hint: `The journal still says 'started'; record the task with \`meshy operations resolve ${operationId} --task-id ${created.taskId}\` once the journal is writable again.`,
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
      recovery: { action: "reconcile", automatic: false, command: `meshy ${descriptor.commandPath.join(" ")} list` },
      hint: resolveHint(operationId),
      result: { submission: { state: "unknown", operation_id: operationId, task_id: record.task_id }, task: null, ...extra },
    });
  }
  throw new CliError({
    code: "operation_conflict",
    message: `operation ${operationId} was already ${record.state} on ${record.updated_at} (${record.error ?? "no detail"}); use a new --operation-id to submit again, or release this one with \`meshy operations resolve ${operationId} --not-created\``,
    result: { submission: { state: record.state, operation_id: operationId, task_id: record.task_id }, task: null, ...extra },
  });
}

/** After `list`: bind the task it shows, or release the id when it shows none. */
function resolveHint(operationId: string): string {
  return `After checking list: \`meshy operations resolve ${operationId} --task-id <task-id>\` binds the task it shows; \`meshy operations resolve ${operationId} --not-created\` releases the id when it shows none.`;
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
 * `-o`: download a SUCCEEDED task's assets through the 0.2.0 file layout,
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
    const { files, metadataPath, materialLinks, skipped } = await withSpinner(opened.format, "Downloading assets", () =>
      downloadArtifacts(task, output, descriptor.id, { root: opened.flags.workspaceRoot, signal: abortSignal(), allAssets: opened.flags.allAssets }),
    );
    if (materialLinks) warnings.push(...materialLinks.warnings);
    return {
      state: "completed",
      files: files.map((f) => ({ key: f.key, path: f.path, status: f.status, bytes: f.bytes, sha256: f.sha256, error: f.error })),
      metadata_path: metadataPath,
      material_links: materialLinks,
      skipped,
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
  const progress = createProgress(opened.format);
  progress.start({ label: `${descriptor.id} ${taskId}`, resource: descriptor.id });
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
        progress.tick(task.status, task.progress);
      },
    });
  } catch (err) {
    progress.stop();
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
  const waitInfo = { timed_out: timedOut, elapsed_seconds: Number(elapsed.toFixed(2)), polls: poll.polls, ...retriedPolls(poll) };
  if (poll.lastError) warnings.push(retriedWarning(poll));
  endProgress(progress, task, timedOut, aborted);

  if (aborted) throw interruptedError(descriptor, taskId, task ? { task, raw } : seen.last, submission, opts, opened);

  if (task === null) {
    // The deadline passed before the first response arrived; the task id is all we know — and it is enough.
    throw new CliError({
      code: "timed_out",
      message: `task ${taskId} did not answer within ${timeoutSeconds}s (no status was received in time${poll.lastError ? `; ${poll.failedPolls} status request(s) failed, last: ${poll.lastError.message}` : ""}); the server keeps running it`,
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

/** `wait` keys for status requests that failed transiently and were retried (absent when none did). */
export function retriedPolls(poll: PollResult): Record<string, unknown> {
  if (!poll.lastError) return {};
  return { failed_polls: poll.failedPolls, last_poll_error: { message: poll.lastError.message, http_status: poll.lastError.status || null } };
}

export function retriedWarning(poll: PollResult): Warning {
  return warning("poll_retried", `${poll.failedPolls} status request(s) failed transiently and were retried at the next poll (last: ${poll.lastError?.message ?? "unknown"})`);
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
      saved = saveRawJson(opts.saveJson as string, last.raw, { workspace: opened.flags.workspaceRoot });
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
  const progress = createProgress(opened.format);
  progress.start({ label: `${descriptor.id} ${taskId}`, resource: descriptor.id });

  const outcome = await streamTask(endpoint, taskId, {
    timeoutMs: timeoutSeconds * 1000,
    idleTimeoutMs: idleSeconds * 1000,
    signal: abortSignal(),
    onUnknownEvent: (ev) => {
      warnings.push(warning("unknown_sse_event", `ignored SSE event '${ev.event}'`));
    },
    onTask: async (task, raw) => {
      progress.tick(task.status, task.progress);
      if (ndjson) {
        sequence += 1;
        const event: StreamEventEnvelope = {
          ...okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw, submission })),
          event: "task",
          sequence,
        };
        await emitStreamEvent(event);
      }
    },
  });
  endProgress(progress, outcome.task, outcome.reason === "timeout", outcome.reason !== "terminal" && outcome.reason !== "timeout");

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

/** Freeze the progress line with how the wait or stream ended. */
function endProgress(progress: Progress, task: Task | null, timedOut: boolean, abandoned: boolean): void {
  if (abandoned) progress.stop();
  else if (timedOut) progress.finish("timeout");
  else if (task?.status === "SUCCEEDED") progress.finish("ok");
  else progress.finish("failed", task?.status ?? "no status received");
}

export { taskResult as buildTaskResult, nextCommands as taskNextCommands };
export type { TaskView };
