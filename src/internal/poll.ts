/**
 * Poll a task endpoint until it reaches a terminal status or the deadline hits.
 * Backoff grows 1.5× per iteration up to a 20s cap.
 */

import type { TaskEndpoint } from "../client/endpoints/base.js";
import { TERMINAL_STATUSES, type Task } from "../client/types.js";

export interface PollOptions {
  timeoutSeconds: number;
  intervalMs: number;
  onTick?: (task: Task) => void;
}

export interface PollResult {
  task: Task;
  timedOut: boolean;
}

export async function pollUntilTerminal(
  endpoint: TaskEndpoint,
  taskId: string,
  opts: PollOptions,
): Promise<PollResult> {
  const deadline = Date.now() + Math.max(0, opts.timeoutSeconds) * 1000;
  const baseInterval = Math.max(250, opts.intervalMs);
  let interval = baseInterval;
  const cap = Math.max(baseInterval, 20_000);

  while (true) {
    const task = await endpoint.retrieve(taskId);
    opts.onTick?.(task);
    if (TERMINAL_STATUSES.has(task.status)) {
      return { task, timedOut: false };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { task, timedOut: true };
    await sleep(Math.min(interval, Math.max(remaining, 100)));
    interval = Math.min(cap, Math.floor(interval * 1.5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
