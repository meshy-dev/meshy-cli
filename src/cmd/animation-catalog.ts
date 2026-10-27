/**
 * animation-catalog — the Animation Library behind `animate --action-id(s)`.
 *
 * GET /openapi/v1/animations/library: free, authenticated, one complete list
 * (no pagination). Every filter is applied by the server: `--search` matches
 * name or key, `--category` / `--sub-category` match exactly, `--action-ids`
 * resolves specific ids. Items are passed through as the API returns them.
 */

import { Command, Option } from "commander";
import { emitResult, listItems, openCommand, rejectOutputFlag, saveRawJson } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { UsageError } from "../internal/errors.js";
import { parseCsv } from "../internal/flags.js";
import { buildRuntime } from "../internal/runtime.js";

export const ANIMATION_CATEGORIES = ["WalkAndRun", "BodyMovements", "DailyActions", "Fighting", "Dancing"] as const;
export const ANIMATION_LIBRARY_PATH = "/animations/library";
const MAX_LOOKUP_IDS = 200;

const listCommand = new Command("list")
  .description("List the animation library (action ids for `animate`); free, needs an API key")
  .addOption(new Option("--category <name>", "exact category").choices([...ANIMATION_CATEGORIES]))
  .option("--sub-category <name>", "exact sub-category (names repeat across categories)")
  .option("--search <text>", "case-insensitive substring match on name or key (server-side)")
  .option("--action-ids <csv>", `resolve specific action ids (at most ${MAX_LOOKUP_IDS}); unknown ids are simply absent`, parseCsv)
  .option("--include-raw", "include the untouched response under result.raw")
  .option("--save-json <file>", "save the untouched response to this file (never overwrites)")
  .action(
    async (
      opts: { category?: string; subCategory?: string; search?: string; actionIds?: string[]; includeRaw?: boolean; saveJson?: string },
      thisCmd: Command,
    ) => {
      const opened = openCommand(thisCmd, "animation-catalog.list");
      rejectOutputFlag(opened, opts.saveJson);
      if (opts.actionIds && (opts.actionIds.length > MAX_LOOKUP_IDS || opts.actionIds.some((id) => !/^-?\d+$/.test(id)))) {
        throw new UsageError(`--action-ids takes at most ${MAX_LOOKUP_IDS} integer ids`);
      }
      const filters = {
        category: opts.category ?? null,
        sub_category: opts.subCategory ?? null,
        search: opts.search ?? null,
        action_ids: opts.actionIds?.join(",") ?? null,
      };
      const runtime = await buildRuntime(opened.flags);
      const raw = await runtime.client.getV1(ANIMATION_LIBRARY_PATH, {
        category: opts.category,
        sub_category: opts.subCategory,
        search: opts.search,
        action_ids: filters.action_ids ?? undefined,
      }, { signal: abortSignal() });
      const items = listItems(raw, ANIMATION_LIBRARY_PATH);
      const saved = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspace }) : null;
      await emitResult(opened, {
        items,
        count: items.length,
        filters,
        search_scope: "server",
        source: `${runtime.config.baseUrlV1}${ANIMATION_LIBRARY_PATH}`,
        saved_json: saved,
        ...(opts.includeRaw ? { raw } : {}),
      });
    },
  );

export const animationCatalogCommand = new Command("animation-catalog")
  .description("Animation library lookups (action ids for `animate`)")
  .addCommand(listCommand);
