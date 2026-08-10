/**
 * Factory that wires the uniform get/list/delete/wait/create subcommands for
 * any async-task resource. Keeps the per-resource modules focused on their
 * unique create-flag shape.
 */

import { Command, Option } from "commander";
import type { TaskEndpoint } from "../client/endpoints/base.js";
import type { MeshyClient, ResourceName } from "../client/index.js";
import { downloadArtifacts } from "./download.js";
import { resolveImageFields, resolveModelFields } from "./file-input.js";
import { pollUntilTerminal } from "./poll.js";
import { emit } from "./output.js";
import { mergePayload, parseJsonFlag } from "./payload.js";
import { printReport } from "./report.js";
import { getUpdateNotice } from "./update-notifier.js";
import { buildRuntime, type Runtime, readGlobalFlags } from "./runtime.js";
import { summarizeTask, TERMINAL_STATUSES, type Task } from "../client/types.js";
import { UsageError } from "./errors.js";
import { logger } from "./logger.js";

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
}

export interface ResourceCommandSpec {
  name: ResourceName;
  description: string;
  supportsList?: boolean;
  create: CreateSpec;
  endpointOf(client: MeshyClient): TaskEndpoint;
}

export function buildResourceCommand(spec: ResourceCommandSpec): Command {
  const cmd = new Command(spec.name).description(spec.description);

  // create
  const createCmd = new Command("create").description(spec.create.description);
  spec.create.configure(createCmd);
  createCmd
    .addOption(new Option("--data <json>", "raw JSON payload (or @file.json); merges with flags"))
    .addOption(
      new Option(
        "--async",
        "return the task_id immediately without polling; query later with `<resource> wait <id>` or `get <id>`",
      ).default(false),
    )
    .addOption(new Option("--timeout <seconds>", "max seconds to poll in sync mode").default("600"))
    .action(async (opts: Record<string, unknown>, thisCmd: Command) => {
      const runtime = await buildRuntime(readGlobalFlags(thisCmd));
      const endpoint = spec.endpointOf(runtime.client);
      const data = parseJsonFlag(opts.data as string | undefined, "--data");
      // Resolve local file paths + preflight URLs for image and 3D-model
      // inputs before building the payload — fail fast on missing inputs.
      await resolveImageFields(opts);
      await resolveModelFields(opts);
      const flagPayload = spec.create.toPayload(opts);
      const defaults = spec.create.toDefaults?.(opts) ?? {};
      const payload = mergePayload(defaults, data, flagPayload);
      logger.debug("create payload", payload);
      const taskId = await endpoint.create(payload);
      const runAsync = Boolean(opts.async);
      const timeoutSeconds = Number(opts.timeout ?? 600);
      if (runAsync) {
        emit(
          {
            resource: spec.name,
            task_id: taskId,
            status: "PENDING",
            hint: `meshy-cli ${spec.name} wait ${taskId}`,
          },
          { format: runtime.flags.format, file: undefined },
        );
        return;
      }
      const started = Date.now();
      const { task, timedOut } = await pollUntilTerminal(endpoint, taskId, {
        timeoutSeconds,
        intervalMs: runtime.config.pollIntervalMs,
      });
      const elapsed = (Date.now() - started) / 1000;
      await emitTerminalOutcome(task, timedOut, elapsed, spec.name, runtime);
    });
  cmd.addCommand(createCmd);

  // get
  cmd
    .command("get <task-id>")
    .description("Retrieve a single task by id")
    .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
      const runtime = await buildRuntime(readGlobalFlags(thisCmd));
      const task = await spec.endpointOf(runtime.client).retrieve(taskId);
      await emitTerminalOutcome(task, false, undefined, spec.name, runtime);
    });

  // wait
  cmd
    .command("wait <task-id>")
    .description("Poll until the task reaches a terminal status")
    .option("--timeout <seconds>", "max seconds to wait", "600")
    .action(async (taskId: string, opts: { timeout?: string }, thisCmd: Command) => {
      const runtime = await buildRuntime(readGlobalFlags(thisCmd));
      const endpoint = spec.endpointOf(runtime.client);
      const timeoutSeconds = Number(opts.timeout ?? 600);
      const started = Date.now();
      const { task, timedOut } = await pollUntilTerminal(endpoint, taskId, {
        timeoutSeconds,
        intervalMs: runtime.config.pollIntervalMs,
      });
      const elapsed = (Date.now() - started) / 1000;
      await emitTerminalOutcome(task, timedOut, elapsed, spec.name, runtime);
    });

  // delete
  cmd
    .command("delete <task-id>")
    .description("Delete a task")
    .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
      const runtime = await buildRuntime(readGlobalFlags(thisCmd));
      await spec.endpointOf(runtime.client).delete(taskId);
      emit({ resource: spec.name, task_id: taskId, deleted: true }, {
        format: runtime.flags.format,
        file: runtime.flags.output,
      });
    });

  // list (optional — some endpoints don't support it)
  if (spec.supportsList !== false) {
    cmd
      .command("list")
      .description("List recent tasks")
      .option("--page <n>", "page number (1-based)", "1")
      .option("--page-size <n>", "page size", "10")
      .option("--sort-by <field>", "sort order (e.g. -created_at)", "-created_at")
      .action(async (opts: { page?: string; pageSize?: string; sortBy?: string }, thisCmd: Command) => {
        const runtime = await buildRuntime(readGlobalFlags(thisCmd));
        const tasks = await spec.endpointOf(runtime.client).list({
          page_num: Number(opts.page ?? 1),
          page_size: Number(opts.pageSize ?? 10),
          sort_by: opts.sortBy ?? "-created_at",
        });
        emit(tasks.map((t) => summarizeTask(t)), {
          format: runtime.flags.format,
          file: runtime.flags.output,
        });
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
 * Decide how to report a task whose status is (expected to be) terminal:
 *   - with `-o`: download artifacts to the filesystem and print the status
 *     report. Failed/timed-out tasks print the FAIL form without downloads.
 *   - without `-o`: emit the familiar JSON/pretty summary to stdout.
 */
export async function emitTerminalOutcome(
  task: Task,
  timedOut: boolean,
  elapsedSeconds: number | undefined,
  resourceName: string,
  runtime: Runtime,
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
    } else {
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
      process.exitCode = timedOut ? 8 : 1;
    }
    if (succeeded) return;
  } else {
    // No -o: keep the JSON/pretty summary for machine consumption.
    emit(
      {
        resource: resourceName,
        ...summarizeTask(task, elapsedSeconds),
        ...(timedOut ? { timed_out: true } : {}),
      },
      { format: runtime.flags.format },
    );
  }

  if (!output) {
    if (timedOut) process.exitCode = 8;
    else if (!TERMINAL_STATUSES.has(task.status) || task.status !== "SUCCEEDED") process.exitCode = 1;
  }
}
