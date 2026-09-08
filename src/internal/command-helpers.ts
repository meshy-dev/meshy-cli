/**
 * Small shared pieces every command action uses:
 *   - open the command context (name, schema, format) so the error exit can
 *     render in the right shape;
 *   - render a result in either schema;
 *   - save the raw API JSON (--save-json) with exclusive publication.
 */

import { Command } from "commander";
import { dirname, resolve as resolvePath } from "node:path";
import { beginCommand, type CommandContext } from "./context.js";
import { UsageError, type Warning } from "./errors.js";
import { emit, emitEnvelope, type OutputFormat } from "./output.js";
import { okEnvelope, type OutputSchema } from "./result.js";
import { readGlobalFlags, resolveSchema, type GlobalFlags } from "./runtime.js";
import { writeJsonFile } from "./atomic-file.js";
import { resolveWithinRoot, type AuthorisedRoot } from "./paths.js";

export interface OpenedCommand extends CommandContext {
  flags: GlobalFlags;
}

/** Read global flags, decide the schema and register the command context. */
export function openCommand(thisCmd: Command, command: string, defaultSchema: OutputSchema): OpenedCommand {
  const flags = readGlobalFlags(thisCmd);
  const schema = resolveSchema(flags, defaultSchema);
  const ctx = beginCommand({ command, schema, format: flags.format });
  return { ...ctx, flags };
}

/**
 * Print a command result. Legacy keeps the bare payload (and the historical
 * `-o <file>` meaning "write the JSON there" for non-task commands); v1 prints
 * the envelope and treats `-o` on a non-task command as a usage error that
 * points at --save-json.
 */
export async function emitResult(
  opened: OpenedCommand,
  legacyValue: unknown,
  v1Result: unknown,
  opts: { warnings?: Warning[]; legacyFile?: string | undefined; format?: OutputFormat } = {},
): Promise<void> {
  const format = opts.format ?? opened.format;
  if (opened.schema === "v1") {
    await emitEnvelope(okEnvelope(opened.command, v1Result, opts.warnings ?? []), format);
    return;
  }
  emit(legacyValue, { format, file: opts.legacyFile });
}

/** v1: `-o` is reserved for assets; JSON goes through --save-json. */
export function rejectOutputFlagForV1(opened: OpenedCommand, saveJson: string | undefined): void {
  if (opened.schema !== "v1") return;
  if (opened.flags.output && saveJson) {
    throw new UsageError("--output/-o and --save-json cannot be combined on this command; -o is for assets, --save-json for the raw JSON");
  }
  if (opened.flags.output) {
    throw new UsageError("this command produces JSON, not assets: use --save-json <file> instead of --output/-o under --output-schema v1");
  }
}

export interface SavedJson {
  path: string;
  bytes: number;
}

/**
 * Save the raw JSON the API returned (never the CLI envelope). The file is
 * published exclusively; an existing file is an error unless `overwrite`.
 */
export function saveRawJson(
  target: string,
  raw: unknown,
  opts: { workspace?: string | AuthorisedRoot | undefined; overwrite?: boolean; cwd?: string } = {},
): SavedJson {
  const cwd = opts.cwd ?? process.cwd();
  const abs = resolvePath(cwd, target);
  const root: string | AuthorisedRoot = opts.workspace ?? dirname(abs);
  const resolved = resolveWithinRoot(abs, root, { cwd, label: "--save-json target" });
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  writeJsonFile(resolved.path, raw, { overwrite: opts.overwrite ?? false });
  return { path: resolved.path, bytes: Buffer.byteLength(text, "utf8") };
}
