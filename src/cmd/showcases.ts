/**
 * showcases — GET /openapi/v1/showcases (Enterprise tier).
 *
 * Every request may cost a credit, so this command performs exactly one GET
 * with the parameters given, never retries, never paginates, and is never
 * called by doctor or any smoke check. Items are passed through unchanged.
 */

import { Command, Option } from "commander";
import { SHOWCASE_FORMATS, SHOWCASE_SORT_BY, SHOWCASE_TYPES } from "../client/endpoints/showcases.js";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { UsageError } from "../internal/errors.js";
import { parseInt10 } from "../internal/flags.js";
import { warning, type Warning } from "../internal/result.js";
import { buildRuntime } from "../internal/runtime.js";

const listCommand = new Command("list")
  .description("Search community showcase models (Enterprise tier; every request is billed)")
  .option("--search <text>", "text search in model names (server-side)")
  .option("--page-size <n>", "1-10 (default: 3)", parseInt10)
  .addOption(new Option("--sort-by <field>", "sort order (default: -created_at)").choices([...SHOWCASE_SORT_BY]))
  .addOption(new Option("--model-format <fmt>", "model format to return (default: glb)").choices([...SHOWCASE_FORMATS]))
  .addOption(
    new Option("--showcase-type <type>", "all (default) | animate | static (the docs spell it 'animated'; both are accepted)").choices([
      ...SHOWCASE_TYPES,
      "animated",
    ]),
  )
  .option("--include-raw", "include the untouched response under result.raw")
  .option("--save-json <file>", "save the untouched response to this file (never overwrites)")
  .action(
    async (
      opts: { search?: string; pageSize?: number; sortBy?: string; modelFormat?: string; showcaseType?: string; includeRaw?: boolean; saveJson?: string },
      thisCmd: Command,
    ) => {
      const opened = openCommand(thisCmd, "showcases.list", "v1");
      rejectOutputFlagForV1(opened, opts.saveJson);
      if (opts.pageSize !== undefined && (opts.pageSize < 1 || opts.pageSize > 10)) {
        throw new UsageError("--page-size must be between 1 and 10");
      }
      const warnings: Warning[] = [];
      let showcaseType = opts.showcaseType;
      if (showcaseType === "animated") {
        showcaseType = "animate";
        warnings.push(
          warning(
            "showcase_type_alias",
            "the server enum spells this value 'animate' (the docs say 'animated'); sent as showcase_type=animate",
          ),
        );
      }
      const request = {
        page_size: opts.pageSize,
        sort_by: opts.sortBy,
        search: opts.search,
        format: opts.modelFormat,
        showcase_type: showcaseType,
      };
      const runtime = await buildRuntime(opened.flags);
      const { items, raw } = await runtime.client.showcases.list(request, { signal: abortSignal() });
      const saved = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspaceRoot }) : null;
      await emitResult(
        opened,
        items,
        {
          items,
          count: items.length,
          request,
          billing: "may-charge",
          requests_made: 1,
          saved_json: saved,
          ...(opts.includeRaw ? { raw } : {}),
        },
        { warnings },
      );
    },
  );

export const showcasesCommand = new Command("showcases")
  .description("Enterprise showcase search (every request is billed)")
  .addCommand(listCommand);
