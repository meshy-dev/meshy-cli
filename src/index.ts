#!/usr/bin/env node
/**
 * meshy-cli entry point.
 *
 * Responsibilities kept here on purpose:
 *   - decide whether the background update check may run before anything else;
 *   - turn SIGINT into a cooperative abort (exit 130) instead of a hard kill;
 *   - route every failure — including Commander parse errors — through one
 *     exit that renders the payload in the schema the command would have used;
 *   - flush stdout before exiting.
 */

import type { Command } from "commander";

import { buildRootCommand, V1_ONLY_COMMANDS, LOCAL_COMMANDS } from "./root.js";
import { currentCommand, markInterrupted, wasInterrupted } from "./internal/context.js";
import { exitCodeFor, isCommanderInformational, reportError, CliError } from "./internal/errors.js";
import { emitEnvelope, writeStdout, type OutputFormat } from "./internal/output.js";
import { errorEnvelope, type OutputSchema } from "./internal/result.js";
import { refreshCache, shouldSkip } from "./internal/update-notifier.js";

async function main(): Promise<number> {
  const argv = process.argv;
  if (argv.includes("--no-update-check")) {
    // Children (none today, but any future spawn) inherit the opt-out.
    process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";
  }
  if (shouldRunUpdateCheck(argv)) refreshCache(); // fire-and-forget; internally guarded; never throws

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

/**
 * The update check never runs for local work: no network, no detached child.
 * Local means the command touches neither the API nor the update state, or
 * the caller said so.
 */
export function shouldRunUpdateCheck(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (shouldSkip(env)) return false;
  if (argv.includes("--no-update-check")) return false;
  const rest = argv.slice(2);
  if (rest.length === 0) return false;
  if (rest.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V")) return false;
  const first = rest.find((a) => !a.startsWith("-"));
  if (!first) return false;
  if (LOCAL_COMMANDS.has(first)) return false;
  if (first === "make" && rest.includes("--dry-run")) return false;
  return true;
}

function installSignalHandlers(): void {
  let count = 0;
  process.on("SIGINT", () => {
    count += 1;
    if (count === 1) {
      markInterrupted();
      process.stderr.write("\ninterrupted — finishing local bookkeeping; press Ctrl-C again to force exit\n");
      return;
    }
    process.exit(130);
  });
}

async function reportFailure(program: Command, argv: string[], err: unknown): Promise<number> {
  const ctx = currentCommand();
  const schema: OutputSchema = ctx?.schema ?? resolveSchemaHeuristically(program, argv);
  const format: OutputFormat = ctx?.format ?? resolveErrorFormat(program);
  const interruptedErr =
    wasInterrupted() && !(err instanceof CliError && err.code === "interrupted")
      ? new CliError({ code: "interrupted", message: "interrupted by SIGINT", cause: err })
      : err;

  if (schema === "v1") {
    const command = ctx?.command ?? commandNameFromArgv(program, argv);
    const { envelope, exitCode } = errorEnvelope(command, interruptedErr);
    process.stderr.write(`error: ${envelope.error?.message ?? "unknown error"}\n`);
    if (envelope.error?.hint) process.stderr.write(`hint: ${envelope.error.hint}\n`);
    try {
      await emitEnvelope(envelope, format);
    } catch {
      /* stderr already carries the human message */
    }
    return exitCode;
  }

  reportError(interruptedErr, format);
  try {
    await writeStdout("");
  } catch {
    /* nothing to flush */
  }
  return exitCodeFor(interruptedErr);
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
  const v = (typeof raw === "string" ? raw : "json").toLowerCase();
  return v === "pretty" || v === "ndjson" ? v : "json";
}

/**
 * Before an action ran we only know argv. `--output-schema` is a root option,
 * so a parsed value is authoritative; otherwise the first command token decides
 * (new commands are v1-only, everything else is legacy).
 */
function resolveSchemaHeuristically(program: Command, argv: string[]): OutputSchema {
  const parsed = program.opts()["outputSchema"];
  if (parsed === "v1" || parsed === "legacy") return parsed;
  const idx = argv.indexOf("--output-schema");
  if (idx !== -1) {
    const v = argv[idx + 1];
    if (v === "v1" || v === "legacy") return v;
  }
  const first = firstCommandToken(program, argv);
  return first && V1_ONLY_COMMANDS.has(first) ? "v1" : "legacy";
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
