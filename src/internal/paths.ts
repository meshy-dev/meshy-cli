/**
 * Path containment and safe naming.
 *
 * Every file the CLI writes is checked against an authorised root: the
 * explicit --workspace when given, otherwise the root the command itself
 * authorised (a project directory, or the parent of an explicit output path).
 * Containment is decided on real paths — the deepest existing ancestor is
 * resolved with realpath so a symlinked directory cannot redirect a write —
 * never with a string prefix test.
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep, basename } from "node:path";
import { CliError } from "./errors.js";

export interface ResolvedTarget {
  /** Absolute, normalised path as given (symlink-free for the existing part). */
  path: string;
  /** The authorised root the path was checked against. */
  root: string;
  /** Path relative to root, POSIX separators. */
  relative: string;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Resolve the real path of the deepest existing ancestor and re-append the missing tail. */
export function realpathLenient(path: string): string {
  const abs = resolvePath(path);
  const missing: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cursor);
      return missing.length ? resolvePath(real, ...missing.reverse()) : real;
    } catch (err) {
      if (errno(err) !== "ENOENT" && errno(err) !== "ENOTDIR") throw err;
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `target` (file or directory) against cwd and prove it lies inside
 * `root`. A symlink at the leaf is rejected for write targets: replacing or
 * following it could land the bytes outside the root.
 */
export function resolveWithinRoot(
  target: string,
  root: string,
  opts: { cwd?: string; allowSymlinkLeaf?: boolean; label?: string } = {},
): ResolvedTarget {
  const cwd = opts.cwd ?? process.cwd();
  const label = opts.label ?? "path";
  const rootReal = realpathLenient(resolvePath(cwd, root));
  const absTarget = resolvePath(cwd, target);
  let leaf: ReturnType<typeof lstatSync> | null = null;
  try {
    leaf = lstatSync(absTarget);
  } catch (err) {
    if (errno(err) !== "ENOENT" && errno(err) !== "ENOTDIR") throw err;
  }
  if (leaf?.isSymbolicLink() && !opts.allowSymlinkLeaf) {
    throw new CliError({
      code: "local_io",
      message: `${label} ${target} is a symbolic link; refusing to write through it`,
    });
  }
  const real = realpathLenient(absTarget);
  if (!isInside(rootReal, real)) {
    throw new CliError({
      code: "local_io",
      message: `${label} ${target} resolves outside the authorised root ${rootReal}`,
    });
  }
  return { path: real, root: rootReal, relative: relative(rootReal, real).split(sep).join("/") };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turn an arbitrary string (asset key, task id, project name) into a single
 * safe path segment: lowercase-insensitive ASCII letters, digits, `.`, `_`,
 * `-`; everything else becomes `_`; no leading dots, no reserved names, no
 * empty result.
 */
export function safeSegment(input: string, fallback = "item"): string {
  let s = input.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").replace(/\.+$/, "");
  s = s.replace(/_{2,}/g, "_");
  if (!s) s = fallback;
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}

/** Lowercase file extension without the dot, or "" when the name has none or it is not a plain token. */
export function safeExtension(ext: string): string {
  const e = ext.replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(e) ? e : "";
}
