/**
 * Global flags that should be accepted at every command level so they work
 * regardless of position in argv (e.g. `meshy-cli balance --format pretty`
 * as well as `meshy-cli --format pretty balance`).
 *
 * We declare them once on the root with visible help + defaults, and mirror
 * them (hidden, no defaults) onto every descendant command. `optsWithGlobals`
 * then merges any set value — a flag on the innermost command wins, and
 * unset leaf options fall through to the parent's value or its default.
 */

import { Command, Option } from "commander";

type OptionFactory = () => Option;

const FACTORIES: OptionFactory[] = [
  () => new Option("--api-key <key>", "Meshy API key (overrides MESHY_API_KEY)"),
  () => new Option("--base-url-v1 <url>", "override v1 base URL"),
  () => new Option("--base-url-v2 <url>", "override v2 base URL"),
  () => new Option("--format <fmt>", "output format").choices(["json", "pretty", "ndjson"]),
  () => new Option("--json", "output as JSON (alias for --format json)"),
  () =>
    new Option(
      "-o, --output <path>",
      "download artifacts + write meta.json; switches stdout to a status report",
    ),
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

function walk(cmd: Command, visit: (c: Command) => void): void {
  visit(cmd);
  for (const sub of cmd.commands) walk(sub, visit);
}
