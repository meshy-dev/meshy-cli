/**
 * operations — the local journal of billable creates (`<config dir>/operations`).
 *
 *   list     every record, oldest first (--state to filter)
 *   show     one record
 *   resolve  close out a `started` / `unknown` record after reconciling it with
 *            `<resource> list`: --task-id binds the task that list showed (a
 *            replay returns it), --not-created releases the id so the same
 *            --operation-id submits again
 *
 * Local only: no API key, no network. A resolution is the caller's finding;
 * the CLI cannot see whether the server created a task.
 */

import { Command, Option } from "commander";
import { emitResult, openCommand } from "../internal/command-helpers.js";
import { CliError, UsageError } from "../internal/errors.js";
import { listOperations, operationsRoot, readOperation, resolveOperation, type OperationState } from "../internal/operation-store.js";
import { buildLocalRuntime } from "../internal/runtime.js";

const STATES: OperationState[] = ["started", "accepted", "rejected", "unknown", "not_submitted"];

const listCommand = new Command("list")
  .description("List the journaled create operations, oldest first")
  .addOption(new Option("--state <state>", "only records in this state").choices(STATES))
  .action(async (opts: { state?: OperationState }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "operations.list");
    buildLocalRuntime(opened.flags);
    const root = operationsRoot();
    const operations = listOperations(root).filter((r) => !opts.state || r.state === opts.state);
    await emitResult(opened, { root, operations });
  });

const showCommand = new Command("show")
  .description("Show one journaled operation")
  .argument("<operation-id>")
  .action(async (operationId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "operations.show");
    buildLocalRuntime(opened.flags);
    const root = operationsRoot();
    const record = readOperation(root, operationId);
    if (!record || record.operation_id !== operationId) {
      throw new CliError({ code: "not_found", message: `no operation ${operationId} in ${root}`, recovery: { action: "none", automatic: false, command: "meshy operations list" } });
    }
    await emitResult(opened, { root, operation: record });
  });

const resolveCommand = new Command("resolve")
  .description(
    "Close out a 'started' or 'unknown' operation after checking `<resource> list`: --task-id <id> when the task is there, --not-created when it is not (the same --operation-id then submits again)",
  )
  .argument("<operation-id>")
  .option("--task-id <id>", "the server created this task for the operation; a replay returns it without a new POST")
  .option("--not-created", "the server created no task; release the id so the same --operation-id submits again")
  .option("--force", "resolve a 'started' operation even though the process that started it still appears to run")
  .action(async (operationId: string, opts: { taskId?: string; notCreated?: boolean; force?: boolean }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "operations.resolve");
    buildLocalRuntime(opened.flags);
    if ((opts.taskId !== undefined) === Boolean(opts.notCreated)) {
      throw new UsageError("pass exactly one of --task-id <id> or --not-created");
    }
    const taskId = opts.taskId?.trim();
    if (opts.taskId !== undefined && !taskId) throw new UsageError("--task-id needs a task id");
    const res = resolveOperation(operationsRoot(), operationId, taskId ? { as: "created", taskId } : { as: "not_created" }, { force: opts.force });
    await emitResult(opened, res);
  });

export const operationsCommand = new Command("operations")
  .description("Local journal of create requests: list | show | resolve (no API key needed)")
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(resolveCommand);
