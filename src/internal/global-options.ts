/**
 * Global flags that should be accepted at every command level so they work
 * regardless of position in argv (e.g. `meshy-cli balance --format pretty`
 * as well as `meshy-cli --format pretty balance`).
 *
 * Commander parses the root command's known options wherever they appear in
 * argv (positional options are disabled), so a flag declared here is consumed
 * by the root even when typed after the subcommand. The hidden mirrors on
 * every descendant keep `optsWithGlobals()` uniform and make the flag visible
 * to `<sub> --help` walkers.
 */

import { Command, Option } from "commander";

type OptionFactory = () => Option;

const FACTORIES: OptionFactory[] = [
  () => new Option("--api-key <key>", "Meshy API key (overrides MESHY_API_KEY)"),
  () => new Option("--base-url-v1 <url>", "override v1 base URL"),
  () => new Option("--base-url-v2 <url>", "override v2 base URL"),
  () =>
    new Option(
      "--base-url-creative-lab <url>",
      "override the Creative Lab base URL (default: <v1 origin>/openapi/creative-lab)",
    ),
  () => new Option("--format <fmt>", "output format").choices(["json", "pretty", "ndjson"]),
  () => new Option("--json", "output as JSON (alias for --format json)"),
  () =>
    new Option(
      "--output-schema <schema>",
      "stdout data model: legacy (0.2.0-compatible, default for existing commands) | v1 (stable envelope; default for new commands)",
    ).choices(["legacy", "v1"]),
  () =>
    new Option(
      "-o, --output <path>",
      "download artifacts + write meta.json; switches stdout to a status report",
    ),
  () =>
    new Option(
      "--api-key-file <path>",
      "read MESHY_API_KEY from this dotenv-style file (only that key is read; parsed, never executed; no .env auto-discovery)",
    ),
  // Node.js itself scans the whole argv for `--env-file` — even after the
  // script name — loads the entire file into process.env (NODE_OPTIONS
  // included) and exits 9 when it is missing. The flag therefore cannot be
  // offered safely; it is registered only so a habitual `--env-file` gets an
  // explanation instead of a silent, Node-side environment load.
  () => new Option("--env-file <path>", "(unsupported) use --api-key-file").hideHelp(),
  () =>
    new Option(
      "--workspace <dir>",
      "restrict every file written by local tools and downloads to this directory",
    ),
  () => new Option("--no-update-check", "never query npm for a newer version in this process"),
  () => new Option("-v, --verbose", "debug logging"),
  () =>
    new Option("--log-level <level>", "log level").choices([
      "debug",
      "info",
      "warn",
      "error",
      "silent",
    ]),
];

/** Register the visible, default-carrying versions on the root command. */
export function registerRootGlobalOptions(root: Command): void {
  for (const factory of FACTORIES) {
    const opt = factory();
    if (opt.long === "--format") opt.default("json");
    if (opt.long === "--verbose") opt.default(false);
    root.addOption(opt);
  }
}

/** Mirror the same flags onto every descendant, hidden from help. */
export function mirrorGlobalOptionsToDescendants(root: Command): void {
  walk(root, (cmd) => {
    if (cmd === root) return;
    for (const factory of FACTORIES) {
      const opt = factory().hideHelp();
      if (cmd.options.some((existing) => existing.long === opt.long)) continue;
      cmd.addOption(opt);
    }
  });
}

export function walkCommands(cmd: Command, visit: (c: Command) => void): void {
  walk(cmd, visit);
}

function walk(cmd: Command, visit: (c: Command) => void): void {
  visit(cmd);
  for (const sub of cmd.commands) walk(sub, visit);
}
