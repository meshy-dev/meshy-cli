/**
 * Path containment and safe naming.
 *
 * Every file the CLI writes is checked against an authorised root: the
 * explicit --workspace when given, otherwise the root the command itself
 * authorised (a project directory, or the parent of an explicit output path).
 * Containment is decided on real paths — the deepest existing ancestor is
 * resolved with realpath so a symlinked directory cannot redirect a write —
 * never with a string prefix test.
 *
 * The root itself is *frozen* when the command starts (`freezeRoot`): its real
 * path and the identity (device, inode) of the physical directory behind it are
 * captured before the first request or write, and every later check
 * (`resolveWithinRoot` with an `AuthorisedRoot`) first proves that this very
 * directory is still there — not a symlink that appeared at its path, not a
 * different directory — and then proves the target's real path inside it. A
 * root that is re-resolved at check time would move with whatever now sits at
 * its path; a frozen root cannot. Stable aliases (macOS `/var` → `/private/var`,
 * a symlinked parent, a workspace given through a symlink that keeps pointing
 * at the same directory) resolve to the same physical directory and pass.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
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
 * A write boundary fixed at the start of a command. `real` is where writes may
 * land; `anchor` is the deepest part of it that existed when frozen (the whole
 * root when it exists) and `dev`/`ino` identify that directory. A later check
 * re-proves the identity, so replacing the directory at that path — a symlink
 * to somewhere else, a different directory swapped in — is refused rather than
 * silently becoming the new root.
 */
export interface AuthorisedRoot {
  /** The root as authorised, absolute (what the user named). */
  given: string;
  /** Real path of the root when frozen. */
  real: string;
  /** Real path of the deepest existing ancestor when frozen (equals `real` when the root existed). */
  anchor: string;
  dev: number;
  ino: number;
  /** Whether `anchor` was a directory when frozen (a file is refused at the first write, not earlier). */
  directory: boolean;
  /** Name used in messages: "--workspace", "--project", "output directory" … */
  label: string;
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Freeze a write boundary: resolve it once and remember which directory it is. */
export function freezeRoot(path: string, opts: { cwd?: string; label?: string } = {}): AuthorisedRoot {
  const given = resolvePath(opts.cwd ?? process.cwd(), path);
  const real = realpathLenient(given);
  let anchor = real;
  for (;;) {
    try {
      const st = statSync(anchor);
      return { given, real, anchor, dev: st.dev, ino: st.ino, directory: st.isDirectory(), label: opts.label ?? "root" };
    } catch (err) {
      if (errnoOf(err) !== "ENOENT" && errnoOf(err) !== "ENOTDIR") throw err;
      const parent = dirname(anchor);
      if (parent === anchor) throw err;
      anchor = parent;
    }
  }
}

/**
 * The directory a root was frozen on must still be the one at its path: a
 * directory (never a symlink), with the same device and inode. Anything else
 * means the authorised boundary was moved or replaced since the command started.
 */
export function assertRootIntact(root: AuthorisedRoot): void {
  if (!root.directory) {
    throw new CliError({ code: "local_io", message: `${root.label} ${root.given} is not a directory; refusing to write` });
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root.anchor);
  } catch (err) {
    throw new CliError({
      code: "local_io",
      message: `${root.label} ${root.given} changed since the command started: ${root.anchor} is gone (${errnoOf(err) ?? "stat failed"}); refusing to write outside the authorised boundary`,
      cause: err,
    });
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== root.dev || st.ino !== root.ino) {
    throw new CliError({
      code: "local_io",
      message: `${root.label} ${root.given} changed since the command started: ${root.anchor} is now ${st.isSymbolicLink() ? "a symbolic link" : st.isDirectory() ? "a different directory" : "not a directory"}; refusing to write outside the authorised boundary`,
    });
  }
}

/**
 * Resolve `target` (file or directory) against cwd and prove it lies inside
 * `root`. A symlink at the leaf is rejected for write targets: replacing or
 * following it could land the bytes outside the root.
 *
 * With an `AuthorisedRoot` the root is not resolved again: its frozen real path
 * is the boundary and its identity is re-proven first. A plain string root is
 * resolved here (for one-shot local checks with no request in between).
 */
export function resolveWithinRoot(
  target: string,
  root: string | AuthorisedRoot,
  opts: { cwd?: string; allowSymlinkLeaf?: boolean; label?: string } = {},
): ResolvedTarget {
  const cwd = opts.cwd ?? process.cwd();
  const label = opts.label ?? "path";
  let rootReal: string;
  if (typeof root === "string") {
    rootReal = realpathLenient(resolvePath(cwd, root));
  } else {
    assertRootIntact(root);
    rootReal = root.real;
  }
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
