#!/usr/bin/env node
/**
 * meshy-cli entry point.
 */

import type { Command } from "commander";

import { buildRootCommand } from "./root.js";
import { exitCodeFor, reportError } from "./internal/errors.js";
import { refreshCache } from "./internal/update-notifier.js";

async function main(): Promise<number> {
  refreshCache(); // fire-and-forget; internally guarded; never throws
  const program = buildRootCommand();
  try {
    await program.parseAsync(process.argv);
    const code = process.exitCode ?? 0;
    return typeof code === "number" ? code : 1;
  } catch (err) {
    const fmt = resolveErrorFormat(program);
    reportError(err, fmt);
    return exitCodeFor(err);
  }
}

/**
 * Resolve the output format for the error path.
 *
 * Mirrors the same --json override that readGlobalFlags applies on the success
 * path: --json (or --json combined with --format pretty) must still emit JSON
 * on stdout so machine consumers get a parseable error payload.
 *
 * The program tree is read directly here because the error may have been
 * thrown before any subcommand action ran (e.g. unknown flag), so
 * readGlobalFlags (which requires a fully-parsed Command) is not safe to
 * call. --json may be typed at ANY command level (global flags are mirrored
 * to descendants, and --json has no default, so a truthy value always means
 * the user passed it) — scanning only root opts would miss
 * `meshy --format pretty auth login --json`.
 */
function resolveErrorFormat(
  program: Command,
): "json" | "pretty" | "ndjson" {
  const anyJson = (cmd: Command): boolean =>
    Boolean(cmd.opts()["json"]) || cmd.commands.some(anyJson);
  if (anyJson(program)) return "json";
  const raw = program.opts()["format"];
  const v = (typeof raw === "string" ? raw : "json").toLowerCase();
  return v === "pretty" || v === "ndjson" ? v : "json";
}

main().then((code) => process.exit(code));
