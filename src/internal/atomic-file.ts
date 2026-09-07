/**
 * Exclusive and atomic file publication.
 *
 * Two contracts:
 *   - no-overwrite (default): the target must not exist when the file lands.
 *     `exists → rename` is a race (POSIX rename replaces a concurrent
 *     winner), so the temp file is published with `link()`, which fails
 *     atomically with EEXIST. Where hard links are unsupported the fallback
 *     opens the target with O_EXCL and copies — still exclusive, no longer
 *     atomic, and reported as such.
 *   - overwrite: `rename()` over a target that is a regular file (or absent).
 *     Directories and symlinks are never replaced.
 *
 * Temp files always live in the target directory (same filesystem) and are
 * removed on every failure path.
 */

import {
  closeSync,
  copyFileSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  readFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { CliError } from "./errors.js";

export type PublishMethod = "link" | "rename" | "copy-exclusive";

export interface PublishOptions {
  overwrite?: boolean;
}

export interface PublishResult {
  path: string;
  method: PublishMethod;
}

export function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export function refuseOverwriteError(target: string): CliError {
  return new CliError({
    code: "local_io",
    message: `refusing to overwrite existing file: ${target} (pass --overwrite, or choose another path)`,
    recovery: { action: "choose_path", automatic: false },
  });
}

/**
 * Move a fully written temp file onto `target`.
 * The temp file is consumed (removed) whether or not publication succeeds.
 */
export function publishTempFile(tmp: string, target: string, opts: PublishOptions = {}): PublishResult {
  try {
    if (opts.overwrite) {
      let existing: ReturnType<typeof lstatSync> | null = null;
      try {
        existing = lstatSync(target);
      } catch (err) {
        if (errno(err) !== "ENOENT") throw err;
      }
      if (existing && !existing.isFile()) {
        throw new CliError({
          code: "local_io",
          message: `refusing to replace ${target}: it is not a regular file`,
        });
      }
      renameSync(tmp, target);
      return { path: target, method: "rename" };
    }
    try {
      linkSync(tmp, target);
      unlinkSync(tmp);
      return { path: target, method: "link" };
    } catch (err) {
      const code = errno(err);
      if (code === "EEXIST") throw refuseOverwriteError(target);
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EOPNOTSUPP" && code !== "EACCES" && code !== "EMLINK") {
        throw err;
      }
      // Hard links unavailable on this filesystem: exclusive create + copy.
      let fd: number;
      try {
        fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      } catch (openErr) {
        if (errno(openErr) === "EEXIST") throw refuseOverwriteError(target);
        throw openErr;
      }
      try {
        const data = readFileSync(tmp);
        let offset = 0;
        while (offset < data.length) {
          offset += writeSync(fd, data, offset, data.length - offset);
        }
      } finally {
        closeSync(fd);
      }
      unlinkSync(tmp);
      return { path: target, method: "copy-exclusive" };
    }
  } catch (err) {
    removeQuietly(tmp);
    if (err instanceof CliError) throw err;
    throw new CliError({
      code: "local_io",
      message: `failed to write ${target}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
}

/** Serialise `value` as pretty JSON and publish it exclusively (or atomically replace with overwrite). */
export function writeJsonFile(
  target: string,
  value: unknown,
  opts: PublishOptions & { mode?: number } = {},
): PublishResult {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: opts.mode ?? 0o600 });
  } catch (err) {
    removeQuietly(tmp);
    throw new CliError({
      code: "local_io",
      message: `failed to write ${target}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
  return publishTempFile(tmp, target, opts);
}

/** Copy an existing file to `target` under the same publish rules. */
export function copyFilePublished(source: string, target: string, opts: PublishOptions = {}): PublishResult {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  try {
    copyFileSync(source, tmp);
  } catch (err) {
    removeQuietly(tmp);
    throw new CliError({
      code: "local_io",
      message: `failed to copy ${source} → ${target}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
  return publishTempFile(tmp, target, opts);
}
