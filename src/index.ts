#!/usr/bin/env node
/**
 * meshy-cli entry point.
 *
 * Responsibilities kept here on purpose:
 *   - decide whether the background update check may run before anything else;
 *   - turn SIGINT / SIGTERM / SIGHUP into a cooperative abort (exit 130) instead of a hard kill;
 *   - route every failure — including Commander parse errors — through one
 *     exit that renders the v1 error envelope in the format the command would have used;
 *   - flush stdout before exiting.
 */

import type { Command } from "commander";

import { buildRootCommand, LOCAL_COMMANDS } from "./root.js";
import { currentCommand, interruptedBy, markInterrupted, wasInterrupted } from "./internal/context.js";
import { isCommanderInformational, CliError } from "./internal/errors.js";
import { painterFor } from "./internal/color.js";
import { emitEnvelope, printWarnings, type OutputFormat } from "./internal/output.js";
import { humanHint } from "./internal/views.js";
import { stopActiveProgress } from "./internal/progress.js";
import { errorEnvelope } from "./internal/result.js";
import { resolveFormat } from "./internal/runtime.js";
import { refreshCache, shouldRunUpdateCheck } from "./internal/update-notifier.js";

async function main(): Promise<number> {
  const argv = process.argv;
  if (argv.includes("--no-update-check")) {
    // Children (none today, but any future spawn) inherit the opt-out.
    process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";
  }
  if (shouldRunUpdateCheck(argv, LOCAL_COMMANDS)) refreshCache(); // fire-and-forget; never throws

  installSignalHandlers();

  const program = buildRootCommand();
  try {
    await program.parseAsync(argv);
    const code = process.exitCode ?? 0;
    return typeof code === "number" ? code : 1;
  } catch (err) {
    if (isCommanderInformational(err)) return err.exitCode;
    return await reportFailure(program, argv, err);
  }
}

/** How long a SIGTERM / SIGHUP waits for the cooperative stop before the process exits anyway. */
export const TERMINATE_GRACE_MS = 3_000;

/**
 * SIGTERM and SIGHUP (a harness timing the command out, a closed terminal)
 * take the same cooperative path as SIGINT, so the operation journal records
 * what is known instead of being left at `started` by a hard kill. A command
 * that does not observe the abort (an `auth login` waiting for a person) still
 * exits after TERMINATE_GRACE_MS, as a terminate signal should.
 */
function installSignalHandlers(): void {
  let count = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      count += 1;
      if (count === 1) {
        markInterrupted(signal);
        stopActiveProgress();
        if (signal === "SIGINT") {
          process.stderr.write("\ninterrupted — finishing local bookkeeping; press Ctrl-C again to force exit\n");
          return;
        }
        process.stderr.write(`\ninterrupted by ${signal} — finishing local bookkeeping\n`);
        setTimeout(() => process.exit(130), TERMINATE_GRACE_MS).unref();
        return;
      }
      process.exit(130);
    });
  }
}

async function reportFailure(program: Command, argv: string[], err: unknown): Promise<number> {
  stopActiveProgress();
  const ctx = currentCommand();
  const format: OutputFormat = ctx?.format ?? resolveErrorFormat(program);
  // A SIGINT that surfaced as some other failure is still reported as
  // interrupted — but whatever the command already knew (task id, submission,
  // files written so far, recovery command) travels with it.
  const interruptedErr =
    wasInterrupted() && !(err instanceof CliError && err.code === "interrupted")
      ? new CliError({
          code: "interrupted",
          message: `interrupted by ${interruptedBy()}${err instanceof Error && err.message ? ` (${err.message})` : ""}`,
          result: err instanceof CliError ? err.result : null,
          warnings: err instanceof CliError ? err.warnings : [],
          recovery: err instanceof CliError ? err.recovery : null,
          hint: err instanceof CliError ? err.hint : undefined,
          cause: err,
        })
      : err;

  const command = ctx?.command ?? commandNameFromArgv(program, argv);
  const { envelope, exitCode } = errorEnvelope(command, interruptedErr);
  const paint = painterFor(process.stderr);
  process.stderr.write(`${paint("error:", "red")} ${envelope.error?.message ?? "unknown error"}\n`);
  const hint = format === "pretty" ? humanHint(envelope.error?.hint, envelope.error?.recovery?.command, envelope.result) : envelope.error?.hint;
  if (hint) process.stderr.write(`${paint("hint:", "yellow")} ${hint}\n`);
  // A person at a terminal has the message and the hint; the envelope is for
  // machines, which never get `pretty` unless they ask for it.
  if (format === "pretty") {
    printWarnings(envelope.warnings);
    return exitCode;
  }
  try {
    await emitEnvelope(envelope, format);
  } catch {
    /* stderr already carries the human message */
  }
  return exitCode;
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
function resolveErrorFormat(program: Command): OutputFormat {
  const anyJson = (cmd: Command): boolean =>
    Boolean(cmd.opts()["json"]) || cmd.commands.some(anyJson);
  if (anyJson(program)) return "json";
  const raw = program.opts()["format"];
  if (typeof raw === "string") {
    const v = raw.toLowerCase();
    return v === "pretty" || v === "ndjson" ? v : "json";
  }
  // Untyped: the same rule as the success path — a person at a terminal who
  // mistyped a flag reads a sentence, not a JSON object (D-063).
  return resolveFormat({});
}

function firstCommandToken(program: Command, argv: string[]): string | undefined {
  const names = new Set(program.commands.map((c) => c.name()));
  return argv.slice(2).find((a) => names.has(a));
}

function commandNameFromArgv(program: Command, argv: string[]): string {
  const first = firstCommandToken(program, argv);
  if (!first) return "meshy";
  const rest = argv.slice(argv.indexOf(first) + 1).filter((a) => !a.startsWith("-"));
  const sub = program.commands.find((c) => c.name() === first);
  const path = [first];
  let node = sub;
  for (const token of rest) {
    const next = node?.commands.find((c) => c.name() === token);
    if (!next) break;
    path.push(token);
    node = next;
  }
  return path.join(".");
}

main().then((code) => process.exit(code));
