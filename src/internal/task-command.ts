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
 *   - SIGINT stops waiting/streaming (exit 130) and never deletes anything.
 */

import { Command, Option } from "commander";
import type { TaskEndpoint } from "../client/endpoints/base.js";
import { MeshyApiError } from "../client/errors.js";
import type { MeshyClient } from "../client/index.js";
import { requireTaskResource, type TaskResourceDescriptor } from "../client/resource-registry.js";
import { TransportError } from "../client/transport.js";
import { isTerminalStatus, summarizeTask, type Task } from "../client/types.js";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson, type OpenedCommand } from "./command-helpers.js";
import { abortSignal, wasInterrupted } from "./context.js";
import { downloadArtifacts } from "./download.js";
import { CliError, UsageError, type Warning } from "./errors.js";
import { normalizeMediaPayload } from "./file-input.js";
import { logger } from "./logger.js";
import { mergePayload, parseJsonFlag } from "./payload.js";
import { emitEnvelope, emitStreamEvent, emit } from "./output.js";
import { parseTimeoutSeconds, pollUntilTerminal } from "./poll.js";
import { printReport } from "./report.js";
import { errorEnvelope, okEnvelope, warning, type StreamEventEnvelope } from "./result.js";
import { buildRuntime, type Runtime } from "./runtime.js";
import { getUpdateNotice } from "./update-notifier.js";
import { streamTask } from "./stream.js";
import { toTaskView, type TaskView } from "./task-view.js";
import {
  beginOperation,
  credentialFingerprint,
  newOperationId,
  operationsRoot,
  payloadFingerprint,
  updateOperation,
  type OperationRecord,
} from "./operation-store.js";
import { originOf } from "./config.js";

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
    .option("--include-raw", "v1: include the untouched task response under result.task.raw");

interface DownloadOutcome {
  state: "not_requested" | "not_ready" | "completed" | "failed";
  files: Array<{ path: string; status: "written" }>;
  metadata_path: string | null;
}

interface TaskResultOptions {
  task: Task | null;
  raw: unknown;
  descriptor: TaskResourceDescriptor;
  includeRaw: boolean;
  submission: { state: string; operation_id: string | null; task_id?: string | null; request_id?: string | null };
  downloads?: DownloadOutcome;
  savedJson?: { path: string; bytes: number } | null;
  extra?: Record<string, unknown>;
}

function taskResult(o: TaskResultOptions): Record<string, unknown> {
  return {
    task: o.task ? toTaskView(o.raw ?? o.task, { descriptor: o.descriptor, includeRaw: o.includeRaw }) : null,
    submission: o.submission,
    downloads: o.downloads ?? { state: "not_requested", files: [], metadata_path: null },
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
      const runtime = await buildRuntime(opened.flags);
      const endpoint = endpointOf(runtime.client);

      // 1. Build and validate the payload — every local failure happens here, before the journal and the POST.
      const data = parseJsonFlag(opts.data as string | undefined, "--data");
      const flagPayload = spec.create.toPayload(opts);
      const defaults = spec.create.toDefaults?.(opts) ?? {};
      const merged = mergePayload(defaults, data, flagPayload);
      spec.create.validatePayload?.(merged, opts);
      const { payload } = await normalizeMediaPayload(merged, descriptor.mediaFields, { signal: abortSignal() });
      logger.debug("create payload", redactForLog(payload));

      // 2. Journal, then exactly one POST.
      const submitted = await submitOnce(runtime, descriptor, endpoint, payload, (opts.operationId as string | undefined) ?? null, opened);
      const { taskId, raw: createRaw, operationId, warnings } = submitted;

      if (runAsync) {
        const savedJson = opts.saveJson ? saveRawJson(opts.saveJson as string, createRaw, { workspace: opened.flags.workspace }) : null;
        if (opened.schema === "v1") {
          await emitEnvelope(
            okEnvelope(
              opened.command,
              taskResult({
                task: null,
                raw: null,
                descriptor,
                includeRaw: false,
                submission: { state: "accepted", operation_id: operationId, task_id: taskId, request_id: submitted.requestId },
                savedJson,
                extra: { task_id: taskId, next: nextCommands(descriptor, taskId) },
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
          },
          { format: opened.format, file: undefined },
        );
        return;
      }

      // 3. Sync: poll the id we just recorded.
      await waitAndReport(opened, runtime, descriptor, endpoint, taskId, timeoutSeconds, opts, {
        state: "accepted",
        operation_id: operationId,
        task_id: taskId,
        request_id: submitted.requestId,
      }, warnings);
    });
  cmd.addCommand(createCmd);

  // get
  TASK_JSON_OPTIONS(cmd.command("get <task-id>").description("Retrieve a single task by id (any status is a successful query)")).action(
    async (taskId: string, opts: Record<string, unknown>, thisCmd: Command) => {
      const opened = openCommand(thisCmd, `${prefix}.get`, defaultSchema);
      const runtime = await buildRuntime(opened.flags);
      const { task, raw } = await endpointOf(runtime.client).retrieveDetailed(taskId, { signal: abortSignal() });
      const savedJson = opts.saveJson ? saveRawJson(opts.saveJson as string, raw, { workspace: opened.flags.workspace }) : null;
      if (opened.schema === "v1") {
        const downloads = await maybeDownloadV1(opened, task, spec.name);
        await emitEnvelope(
          okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw: Boolean(opts.includeRaw), submission: { state: "accepted", operation_id: null }, downloads, savedJson })),
          opened.format,
        );
        return;
      }
      await emitLegacyOutcome(task, false, undefined, spec.name, runtime, { query: true });
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

interface Submitted {
  taskId: string;
  raw: unknown;
  requestId: string | null;
  operationId: string;
  warnings: Warning[];
}

/**
 * Journal → single POST → journal update. Every failure path leaves a record
 * that says what is known; the unknown state is reported as exit 10 with the
 * operation id and never as a suggestion to submit again.
 */
async function submitOnce(
  runtime: Runtime,
  descriptor: TaskResourceDescriptor,
  endpoint: TaskEndpoint,
  payload: Record<string, unknown>,
  requestedOperationId: string | null,
  opened: OpenedCommand,
): Promise<Submitted> {
  const root = operationsRoot();
  const operationId = requestedOperationId ?? newOperationId();
  const apiOrigin = originOf(endpoint.transportBaseUrl) ?? endpoint.transportBaseUrl;
  const identity = {
    resource: descriptor.id,
    endpoint: descriptor.legacyEndpoint,
    apiOrigin,
    credentialFingerprint: credentialFingerprint({
      source: runtime.config.credentialSource,
      profile: runtime.config.credentialProfile ?? null,
      origin: apiOrigin,
      kind: runtime.config.credentialKind,
    }),
    payloadFingerprint: payloadFingerprint(payload),
  };
  const warnings: Warning[] = [];

  let begin: ReturnType<typeof beginOperation>;
  try {
    begin = beginOperation(root, operationId, identity);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError({ code: "local_io", message: `cannot write the operation journal under ${root}: ${err instanceof Error ? err.message : String(err)}; nothing was submitted`, cause: err });
  }

  if (begin.outcome === "existing") {
    return replayExisting(begin.record, descriptor, operationId);
  }

  if (abortSignal().aborted) {
    updateOperation(root, operationId, { state: "not_submitted", error: "interrupted before the request was sent" });
    throw new CliError({ code: "interrupted", message: "interrupted before the request was sent; nothing was submitted", result: { submission: { state: "not_submitted", operation_id: operationId }, task: null } });
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
        ? `interrupted while the create request was in flight; the server may or may not have created a task (operation ${operationId})`
        : `the create request was sent but its outcome is unknown (${err instanceof Error ? err.message : String(err)}); the server may or may not have created a task`,
      httpStatus: err instanceof MeshyApiError && err.status ? err.status : null,
      recovery: {
        action: "reconcile",
        automatic: false,
        command: `meshy ${descriptor.commandPath.join(" ")} list --output-schema v1   # then match operation ${operationId} by time/prompt before creating again`,
      },
      result: { submission: { state: "unknown", operation_id: operationId, task_id: null }, task: null, downloads: { state: "not_requested", files: [], metadata_path: null } },
      warnings,
      cause: err,
    });
  }

  try {
    updateOperation(root, operationId, { state: "accepted", task_id: created.taskId, request_id: created.requestId, http_status: 200 });
  } catch (journalErr) {
    // The server has the task; the id must survive this failure.
    throw new CliError({
      code: "local_io",
      message: `task ${created.taskId} was created but the operation journal could not be updated: ${journalErr instanceof Error ? journalErr.message : String(journalErr)}`,
      result: { submission: { state: "accepted", operation_id: operationId, task_id: created.taskId }, task: null, task_id: created.taskId, next: nextCommands(descriptor, created.taskId) },
      cause: journalErr,
    });
  }
  void opened;
  return { taskId: created.taskId, raw: created.raw, requestId: created.requestId, operationId, warnings };
}

function replayExisting(record: OperationRecord, descriptor: TaskResourceDescriptor, operationId: string): Submitted {
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
      result: { submission: { state: "unknown", operation_id: operationId, task_id: record.task_id }, task: null },
    });
  }
  throw new CliError({
    code: "operation_conflict",
    message: `operation ${operationId} was already ${record.state} on ${record.updated_at} (${record.error ?? "no detail"}); use a new --operation-id to submit again`,
    result: { submission: { state: record.state, operation_id: operationId, task_id: record.task_id }, task: null },
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

async function maybeDownloadV1(opened: OpenedCommand, task: Task, resourceName: string): Promise<DownloadOutcome> {
  const output = opened.flags.output;
  if (!output) return { state: "not_requested", files: [], metadata_path: null };
  if (task.status !== "SUCCEEDED") return { state: "not_ready", files: [], metadata_path: null };
  try {
    const { savedFiles, metadataPath } = await downloadArtifacts(task, output, resourceName);
    return { state: "completed", files: savedFiles.map((p) => ({ path: p, status: "written" as const })), metadata_path: metadataPath };
  } catch (err) {
    throw new CliError({
      code: "local_io",
      message: `task ${task.id} is SUCCEEDED but downloading its assets failed: ${err instanceof Error ? err.message : String(err)}`,
      result: { task: toTaskView(task), downloads: { state: "failed", files: [], metadata_path: null } },
      cause: err,
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
  submission: { state: string; operation_id: string | null; task_id?: string | null; request_id?: string | null },
  warnings: Warning[],
): Promise<void> {
  const started = performance.now();
  let last: { task: Task; raw: unknown } | null = null;
  let polls = 0;
  let poll: Awaited<ReturnType<typeof pollUntilTerminal>>;
  try {
    poll = await pollUntilTerminal(endpoint, taskId, {
      timeoutSeconds,
      intervalMs: runtime.config.pollIntervalMs,
      signal: abortSignal(),
      onTick: (task, raw) => {
        last = { task, raw };
        polls += 1;
        if (opened.schema === "v1" && opened.format !== "ndjson") {
          process.stderr.write(`[${descriptor.id}] ${task.status}${typeof task.progress === "number" ? ` ${task.progress}%` : ""}\n`);
        }
      },
    });
  } catch (err) {
    if (wasInterrupted() || abortSignal().aborted) {
      throw interruptedError(descriptor, taskId, last, submission, opts, opened);
    }
    throw err;
  }
  const elapsed = (performance.now() - started) / 1000;
  const { task, raw, timedOut, aborted } = poll;
  const savedJson = opts.saveJson ? saveRawJson(opts.saveJson as string, raw, { workspace: opened.flags.workspace }) : null;

  if (aborted) throw interruptedError(descriptor, taskId, { task, raw }, submission, opts, opened, savedJson);

  if (opened.schema !== "v1") {
    await emitLegacyOutcome(task, timedOut, elapsed, descriptor.id, runtime, { query: false });
    return;
  }

  const includeRaw = Boolean(opts.includeRaw);
  const waitInfo = { timed_out: timedOut, elapsed_seconds: Number(elapsed.toFixed(2)), polls };
  if (timedOut) {
    throw new CliError({
      code: "timed_out",
      message: `task ${taskId} did not reach a terminal status within ${timeoutSeconds}s (last status: ${task.status}); the server keeps running it`,
      recovery: { action: "wait", automatic: false, command: nextCommands(descriptor, taskId).wait },
      result: taskResult({ task, raw, descriptor, includeRaw, submission, savedJson, extra: { wait: waitInfo, next: nextCommands(descriptor, taskId) } }),
      warnings,
    });
  }
  if (task.status !== "SUCCEEDED") {
    throw new CliError({
      code: "task_failed",
      message: task.task_error?.message ? `task ${taskId} ${task.status}: ${task.task_error.message}` : `task ${taskId} ended as ${task.status}`,
      result: taskResult({ task, raw, descriptor, includeRaw, submission, savedJson, extra: { wait: waitInfo } }),
      warnings,
    });
  }
  const downloads = await maybeDownloadV1(opened, task, descriptor.id);
  await emitEnvelope(
    okEnvelope(opened.command, taskResult({ task, raw, descriptor, includeRaw, submission, downloads, savedJson, extra: { wait: waitInfo } }), warnings),
    opened.format,
  );
}

function interruptedError(
  descriptor: TaskResourceDescriptor,
  taskId: string,
  last: { task: Task; raw: unknown } | null,
  submission: { state: string; operation_id: string | null; task_id?: string | null },
  opts: Record<string, unknown>,
  opened: OpenedCommand,
  savedJson: { path: string; bytes: number } | null = null,
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
  const submission = { state: "accepted", operation_id: null };
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

  const savedJson = opts.saveJson && outcome.raw ? saveRawJson(opts.saveJson as string, outcome.raw, { workspace: opened.flags.workspace }) : null;
  const streamInfo = { events: outcome.events, ended: outcome.reason, elapsed_seconds: Number((outcome.elapsedMs / 1000).toFixed(2)) };
  const result = taskResult({ task: outcome.task, raw: outcome.raw, descriptor, includeRaw, submission, savedJson, extra: { stream: streamInfo, task_id: taskId } });

  let finalError: CliError | null = null;
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
      finalError = wrapStreamError(outcome.error, result, warnings);
      break;
    case "protocol":
      finalError = wrapStreamError(outcome.error, result, warnings);
      break;
  }

  if (opened.schema !== "v1") {
    // Legacy has no stream shape to preserve: reuse the terminal summary path.
    if (finalError) throw finalError;
    if (outcome.task) await emitLegacyOutcome(outcome.task, false, outcome.elapsedMs / 1000, descriptor.id, runtime, { query: false });
    return;
  }

  if (ndjson) {
    sequence += 1;
    const body = finalError ? errorEnvelope(opened.command, finalError).envelope : okEnvelope(opened.command, result, warnings);
    const event: StreamEventEnvelope = { ...body, event: "outcome", sequence };
    await emitStreamEvent(event);
    if (finalError) {
      // The outcome line already carries the error; exit with its code without a second envelope.
      process.exitCode = finalError.exitCode;
      return;
    }
    return;
  }
  if (finalError) throw finalError;
  const downloads = outcome.task ? await maybeDownloadV1(opened, outcome.task, descriptor.id) : undefined;
  await emitEnvelope(okEnvelope(opened.command, { ...result, downloads: downloads ?? result["downloads"] }, warnings), opened.format);
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
      const { savedFiles, metadataPath } = await downloadArtifacts(task, output, resourceName);
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
export type { DownloadOutcome, TaskView };
