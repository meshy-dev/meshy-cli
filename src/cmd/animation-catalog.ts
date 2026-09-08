/**
 * animation-catalog — the public Animation Library behind `animate --action-id`.
 *
 * GET <v1 origin>/web/public/animations/resources[?category=…]. No credential
 * is loaded or sent; the command works without any Meshy account. `--search`
 * filters the fetched batch locally (name / key / subCategory, case-insensitive)
 * and says so in the result — it is not a server-side search.
 */

import { Command, Option } from "commander";
import { AnimationCatalogEndpoint, ANIMATION_CATEGORIES, type AnimationCatalogEntry } from "../client/endpoints/animation-catalog.js";
import { createPublicTransport } from "../client/transport.js";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson } from "../internal/command-helpers.js";
import { DEFAULT_BASE_URL_V1, derivePublicWebBase } from "../internal/config.js";
import { abortSignal } from "../internal/context.js";
import { buildLocalRuntime } from "../internal/runtime.js";
import { warning, type Warning } from "../internal/result.js";

export interface CatalogItem {
  action_id: number;
  name: string | null;
  key: string | null;
  category: string | null;
  sub_category: string | null;
  preview_url: string | null;
  rig_type: string | null;
  is_default: boolean | null;
  is_free: boolean | null;
}

export function toCatalogItem(e: AnimationCatalogEntry): CatalogItem {
  return {
    action_id: e.id,
    name: e.name ?? null,
    key: e.key ?? null,
    category: e.category ?? null,
    sub_category: e.subCategory ?? null,
    preview_url: e.previewUrl ?? null,
    rig_type: e.rigType ?? null,
    is_default: e.isDefault ?? null,
    is_free: e.isFree ?? null,
  };
}

/** Case-insensitive substring match over name, key and sub-category. */
export function matchesSearch(item: CatalogItem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.key, item.sub_category].some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
}

const listCommand = new Command("list")
  .description("Fetch the public animation catalog (no API key needed) and list action ids")
  .addOption(new Option("--category <name>", "server-side category filter").choices([...ANIMATION_CATEGORIES]))
  .option("--search <text>", "local, case-insensitive match on name / key / sub-category")
  .option("--include-raw", "include the untouched catalog response under result.raw")
  .option("--save-json <file>", "save the untouched catalog response to this file (never overwrites)")
  .action(async (opts: { category?: string; search?: string; includeRaw?: boolean; saveJson?: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "animation-catalog.list", "v1");
    rejectOutputFlagForV1(opened, opts.saveJson);
    buildLocalRuntime(opened.flags);
    const baseV1 = opened.flags.baseUrlV1 ?? process.env["MESHY_BASE_URL_V1"] ?? DEFAULT_BASE_URL_V1;
    const publicBase = derivePublicWebBase(baseV1);
    const transport = createPublicTransport({ baseUrl: publicBase, readTimeoutMs: readTimeout() });
    const endpoint = new AnimationCatalogEndpoint(transport);
    const { entries, total, raw } = await endpoint.list({ category: opts.category }, { signal: abortSignal() });
    const all = entries.map(toCatalogItem);
    const items = opts.search ? all.filter((i) => matchesSearch(i, opts.search!)) : all;
    const warnings: Warning[] = [];
    if (total !== null && total !== entries.length) {
      warnings.push(warning("catalog_total_mismatch", `server reported total=${total} but returned ${entries.length} entries; only the returned batch was searched`));
    }
    const saved = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspaceRoot }) : null;
    await emitResult(
      opened,
      items,
      {
        items,
        count: items.length,
        fetched: entries.length,
        total,
        filters: { category: opts.category ?? null, search: opts.search ?? null },
        search_scope: "local",
        source: `${publicBase}${AnimationCatalogEndpoint.PATH}`,
        authenticated: false,
        saved_json: saved,
        ...(opts.includeRaw ? { raw } : {}),
      },
      { warnings },
    );
  });

function readTimeout(): number {
  const raw = process.env["MESHY_READ_TIMEOUT_MS"];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export const animationCatalogCommand = new Command("animation-catalog")
  .description("Public animation library lookups (no API key required)")
  .addCommand(listCommand);
