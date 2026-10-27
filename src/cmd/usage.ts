/**
 * usage — GET /openapi/v1/usage/tasks: the team's finished API tasks with the
 * credits each consumed (Studio / Enterprise teams; 403 otherwise). Free. One
 * page per call; the window defaults to the last 30 days and spans at most a
 * year. Items are passed through as the API returns them.
 */

import { Command, Option } from "commander";
import { emitResult, listItems, openCommand, rejectOutputFlag, saveRawJson } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { UsageError } from "../internal/errors.js";
import { parseCsv, parseInt10 } from "../internal/flags.js";
import { buildRuntime } from "../internal/runtime.js";

export const USAGE_TASKS_PATH = "/usage/tasks";

function rfc3339(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new UsageError(`${flag} must be an RFC 3339 timestamp, e.g. 2026-08-01T00:00:00Z`);
  }
  return value;
}

const tasksCommand = new Command("tasks")
  .description("List finished API tasks with the credits each consumed (Studio/Enterprise teams; free)")
  .option("--page <n>", "page number (1-based)", parseInt10, 1)
  .option("--page-size <n>", "1-100", parseInt10, 10)
  .addOption(new Option("--sort-by <field>", "sort order").choices(["-created_at", "+created_at"]).default("-created_at"))
  .option("--start-time <rfc3339>", "start of the created_at window (default: 30 days before --end-time)")
  .option("--end-time <rfc3339>", "end of the created_at window (default: now); a window spans at most 1 year")
  .option("--endpoints <csv>", "endpoint names to include, e.g. image-to-3d,text-to-3d (text-to-3d covers preview and refine)", parseCsv)
  .addOption(new Option("--status <status>", "terminal status filter").choices(["SUCCEEDED", "FAILED"]))
  .option("--save-json <file>", "save the untouched response to this file (never overwrites)")
  .action(
    async (
      opts: { page: number; pageSize: number; sortBy: string; startTime?: string; endTime?: string; endpoints?: string[]; status?: string; saveJson?: string },
      thisCmd: Command,
    ) => {
      const opened = openCommand(thisCmd, "usage.tasks");
      rejectOutputFlag(opened, opts.saveJson);
      if (!Number.isInteger(opts.page) || opts.page < 1) throw new UsageError("--page must be a positive integer");
      if (!Number.isInteger(opts.pageSize) || opts.pageSize < 1 || opts.pageSize > 100) throw new UsageError("--page-size must be between 1 and 100");
      const page = { page_num: opts.page, page_size: opts.pageSize, sort_by: opts.sortBy };
      const filters = {
        start_time: rfc3339("--start-time", opts.startTime) ?? null,
        end_time: rfc3339("--end-time", opts.endTime) ?? null,
        endpoints: opts.endpoints?.join(",") ?? null,
        status: opts.status ?? null,
      };
      const runtime = await buildRuntime(opened.flags);
      const raw = await runtime.client.getV1(USAGE_TASKS_PATH, {
        ...page,
        start_time: filters.start_time ?? undefined,
        end_time: filters.end_time ?? undefined,
        endpoints: filters.endpoints ?? undefined,
        status: filters.status ?? undefined,
      }, { signal: abortSignal() });
      const items = listItems(raw, USAGE_TASKS_PATH);
      const saved = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspace }) : null;
      await emitResult(opened, { items, count: items.length, page, filters, saved_json: saved });
    },
  );

export const usageCommand = new Command("usage")
  .description("Account usage records (Studio/Enterprise teams)")
  .addCommand(tasksCommand);
