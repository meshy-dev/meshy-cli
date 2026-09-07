/**
 * Poll a task endpoint until it reaches a terminal status or the deadline
 * hits. Backoff grows 1.5× per iteration up to a 20s cap.
 *
 * The deadline is monotonic, the sleep is cancellable, and one slow response
 * consumes the same budget as any other second — a `--timeout 0` performs
 * exactly one query and returns whatever status it saw.
 */

import type { TaskEndpoint } from "../client/endpoints/base.js";
import { isTerminalStatus, type Task } from "../client/types.js";
import { UsageError } from "./errors.js";

export interface PollOptions {
  timeoutSeconds: number;
  intervalMs: number;
  onTick?: (task: Task, raw: unknown) => void;
  signal?: AbortSignal;
  /** Test hook: injectable clock and sleep. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PollResult {
  task: Task;
  raw: unknown;
  timedOut: boolean;
  polls: number;
  /** True when the external signal fired before a terminal status. */
  aborted: boolean;
}

/** Accept only finite, non-negative seconds. NaN/Infinity/negative are usage errors, never "wait forever". */
export function parseTimeoutSeconds(raw: unknown, flag = "--timeout"): number {
  const text = String(raw ?? "").trim();
  const n = typeof raw === "number" ? raw : Number(text);
  if (text === "" || !Number.isFinite(n) || n < 0) {
    throw new UsageError(`${flag} must be a finite number of seconds >= 0 (got '${String(raw)}')`);
  }
  return n;
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollUntilTerminal(
  endpoint: TaskEndpoint,
  taskId: string,
  opts: PollOptions,
): Promise<PollResult> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? sleepWithSignal;
  const deadline = now() + Math.max(0, opts.timeoutSeconds) * 1000;
  const baseInterval = Math.max(250, opts.intervalMs);
  let interval = baseInterval;
  const cap = Math.max(baseInterval, 20_000);
  let polls = 0;

  for (;;) {
    const { task, raw } = await endpoint.retrieveDetailed(taskId, { signal: opts.signal });
    polls += 1;
    opts.onTick?.(task, raw);
    if (isTerminalStatus(task.status)) {
      return { task, raw, timedOut: false, polls, aborted: false };
    }
    if (opts.signal?.aborted) return { task, raw, timedOut: false, polls, aborted: true };
    const remaining = deadline - now();
    if (remaining <= 0) return { task, raw, timedOut: true, polls, aborted: false };
    await sleep(Math.min(interval, Math.max(remaining, 100)), opts.signal);
    if (opts.signal?.aborted) return { task, raw, timedOut: false, polls, aborted: true };
    interval = Math.min(cap, Math.floor(interval * 1.5));
  }
}
