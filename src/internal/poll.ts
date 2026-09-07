/**
 * Poll a task endpoint until it reaches a terminal status or the deadline
 * hits. Backoff grows 1.5× per iteration up to a 20s cap.
 *
 * The deadline is monotonic and binds everything: every GET is issued with a
 * request timeout no larger than the remaining budget (headers *and* body),
 * the cancellable sleep never overshoots it, and no request is started once it
 * has passed. A response that arrives after the budget therefore cannot be
 * reported as an in-time success, and the loop never spends "one more GET"
 * after the caller's deadline. `--timeout 0` is the one exception by design:
 * exactly one query, bounded by the transport's own read timeout, returning
 * whatever status it saw.
 */

import type { TaskEndpoint } from "../client/endpoints/base.js";
import { TransportError } from "../client/transport.js";
import { isTerminalStatus, type Task } from "../client/types.js";
import { UsageError } from "./errors.js";

export interface PollOptions {
  timeoutSeconds: number;
  intervalMs: number;
  /** Transport read timeout; each request is capped at min(remaining budget, this). */
  requestTimeoutMs?: number;
  onTick?: (task: Task, raw: unknown) => void;
  signal?: AbortSignal;
  /** Test hook: injectable clock and sleep. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PollResult {
  /**
   * The last task seen. `null` only when the deadline or the abort signal hit
   * before the first response arrived — the caller still knows the task id.
   */
  task: Task | null;
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
  const single = opts.timeoutSeconds === 0;
  const deadline = now() + Math.max(0, opts.timeoutSeconds) * 1000;
  const baseInterval = Math.max(250, opts.intervalMs);
  let interval = baseInterval;
  const cap = Math.max(baseInterval, 20_000);
  let polls = 0;
  let last: { task: Task; raw: unknown } | null = null;

  const done = (timedOut: boolean, aborted: boolean): PollResult => ({
    task: last?.task ?? null,
    raw: last?.raw ?? null,
    timedOut,
    polls,
    aborted,
  });

  for (;;) {
    const remaining = deadline - now();
    if (!single && polls > 0 && remaining <= 0) return done(true, false);
    if (opts.signal?.aborted) return done(false, true);

    // Bound this request by what is left of the budget (and the transport's own
    // read timeout, whichever is smaller). A deadline-bound request that times
    // out *is* the deadline; a read-timeout-bound one is a network failure.
    const requestCap = opts.requestTimeoutMs;
    let timeoutMs: number | undefined;
    let deadlineBound = false;
    if (single) {
      timeoutMs = requestCap;
    } else if (requestCap === undefined || remaining <= requestCap) {
      timeoutMs = Math.max(1, Math.ceil(remaining));
      deadlineBound = true;
    } else {
      timeoutMs = requestCap;
    }

    let res: { task: Task; raw: unknown };
    try {
      res = await endpoint.retrieveDetailed(taskId, { signal: opts.signal, timeoutMs });
    } catch (err) {
      if (opts.signal?.aborted) return done(false, true);
      if (deadlineBound && err instanceof TransportError && (err.phase === "timeout" || err.phase === "aborted")) {
        return done(true, false);
      }
      throw err;
    }
    polls += 1;
    last = res;
    opts.onTick?.(res.task, res.raw);
    if (isTerminalStatus(res.task.status)) return done(false, false);
    if (opts.signal?.aborted) return done(false, true);
    if (single) return done(true, false);
    const left = deadline - now();
    if (left <= 0) return done(true, false);
    await sleep(Math.max(1, Math.min(interval, left)), opts.signal);
    if (opts.signal?.aborted) return done(false, true);
    interval = Math.min(cap, Math.floor(interval * 1.5));
  }
}
