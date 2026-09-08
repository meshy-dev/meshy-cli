/**
 * Cross-process exclusive lock on a directory-scoped lock file.
 *
 * O_EXCL creation is the atomic primitive (Node exposes no flock). A lock
 * older than `staleMs` is treated as abandoned by a crashed process and
 * broken. Waiting is a blocking sleep because every store that uses this is
 * synchronous by design; the wait is bounded and a timeout is a structured
 * error rather than a hang.
 */

import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "./errors.js";

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** Test hook to observe contention. */
  onWait?: () => void;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_STALE_MS = 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Holder released between open and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError({
          code: "local_io",
          message: `timed out after ${timeoutMs}ms waiting for the lock ${lockPath}. If no other meshy process is running, delete that file.`,
          recovery: { action: "retry", automatic: false },
        });
      }
      opts.onWait?.();
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}
