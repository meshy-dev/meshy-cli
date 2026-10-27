/**
 * Small shared pieces every command action uses:
 *   - open the command context (name, format) so the error exit can render
 *     the failure the way the success path would have;
 *   - print a result as the meshy.cli/v1 envelope;
 *   - save the raw API JSON (--save-json) with exclusive publication.
 */

import { Command } from "commander";
import { MeshyApiError } from "../client/errors.js";
import { dirname, resolve as resolvePath } from "node:path";
import { beginCommand, type CommandContext } from "./context.js";
import { UsageError, type Warning } from "./errors.js";
import { emitEnvelope, type OutputFormat } from "./output.js";
import { okEnvelope } from "./result.js";
import { readGlobalFlags, type GlobalFlags } from "./runtime.js";
import { writeJsonFile } from "./atomic-file.js";
import { resolveWithinRoot, type AuthorisedRoot } from "./paths.js";

export interface OpenedCommand extends CommandContext {
  flags: GlobalFlags;
}

/** Read global flags and register the command context. */
export function openCommand(thisCmd: Command, command: string): OpenedCommand {
  const flags = readGlobalFlags(thisCmd);
  const ctx = beginCommand({ command, format: flags.format });
  return { ...ctx, flags };
}

/** Print a command result as one v1 envelope in the resolved rendering. */
export async function emitResult(
  opened: OpenedCommand,
  result: unknown,
  opts: { warnings?: Warning[]; format?: OutputFormat } = {},
): Promise<void> {
  await emitEnvelope(okEnvelope(opened.command, result, opts.warnings ?? []), opts.format ?? opened.format);
}

/** `-o` is reserved for task assets; a command that produces JSON points at --save-json. */
export function rejectOutputFlag(opened: OpenedCommand, saveJson: string | undefined): void {
  if (opened.flags.output && saveJson) {
    throw new UsageError("--output/-o and --save-json cannot be combined on this command; -o is for assets, --save-json for the raw JSON");
  }
  if (opened.flags.output) {
    throw new UsageError("this command produces JSON, not assets: use --save-json <file> instead of --output/-o");
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

/** A list endpoint's body as its object items; anything but a JSON array is an unexpected shape. */
export function listItems(raw: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    throw new MeshyApiError({ message: `unexpected response shape from GET ${path}: expected a JSON array`, status: 200, code: "server", path, body: raw });
  }
  return raw.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
}
