/**
 * Tests for pollUntilTerminal — the main polling loop behind `wait` + sync
 * `create`. We substitute a fake TaskEndpoint so tests stay offline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { TaskEndpoint } from "../src/client/endpoints/base.js";
import { pollUntilTerminal } from "../src/internal/poll.js";
import { TransportError } from "../src/client/transport.js";
import type { Task } from "../src/client/types.js";

function fakeEndpoint(statuses: string[]): TaskEndpoint {
  let i = 0;
  const retrieve = async (id: string): Promise<Task> => {
    const status = statuses[Math.min(i, statuses.length - 1)] ?? "PENDING";
    i += 1;
    return { id, status, type: "", progress: 0, preceding_tasks: 0, created_at: 0, started_at: 0, finished_at: 0, expires_at: 0 } as unknown as Task;
  };
  return {
    retrieve,
    async retrieveDetailed(id: string): Promise<{ task: Task; raw: unknown }> {
      const task = await retrieve(id);
      return { task, raw: task };
    },
  } as unknown as TaskEndpoint;
}

test("pollUntilTerminal — returns immediately when already SUCCEEDED", async () => {
  const ep = fakeEndpoint(["SUCCEEDED"]);
  const { task, timedOut } = await pollUntilTerminal(ep, "abc", {
    timeoutSeconds: 5,
    intervalMs: 250,
  });
  assert.equal(task?.status, "SUCCEEDED");
  assert.equal(timedOut, false);
});

test("pollUntilTerminal — iterates through PENDING → IN_PROGRESS → SUCCEEDED", async () => {
  const seen: string[] = [];
  const ep = fakeEndpoint(["PENDING", "IN_PROGRESS", "SUCCEEDED"]);
  const { task } = await pollUntilTerminal(ep, "abc", {
    timeoutSeconds: 5,
    intervalMs: 10,
    onTick: (t) => seen.push(t.status),
  });
  assert.equal(task?.status, "SUCCEEDED");
  assert.deepEqual(seen, ["PENDING", "IN_PROGRESS", "SUCCEEDED"]);
});

test("pollUntilTerminal — treats FAILED and CANCELED as terminal", async () => {
  const a = await pollUntilTerminal(fakeEndpoint(["FAILED"]), "x", {
    timeoutSeconds: 5,
    intervalMs: 10,
  });
  assert.equal(a.task?.status, "FAILED");
  assert.equal(a.timedOut, false);

  const b = await pollUntilTerminal(fakeEndpoint(["CANCELED"]), "x", {
    timeoutSeconds: 5,
    intervalMs: 10,
  });
  assert.equal(b.task?.status, "CANCELED");
  assert.equal(b.timedOut, false);
});

test("pollUntilTerminal — times out when a task never terminates", async () => {
  const ep = fakeEndpoint(["PENDING"]); // stays PENDING forever
  const started = Date.now();
  const { task, timedOut } = await pollUntilTerminal(ep, "abc", {
    timeoutSeconds: 0.3,
    intervalMs: 50,
  });
  const elapsed = Date.now() - started;
  assert.equal(timedOut, true);
  assert.equal(task?.status, "PENDING");
  assert.ok(elapsed >= 200, `elapsed=${elapsed}ms should be at least 200`);
  assert.ok(elapsed < 2000, `elapsed=${elapsed}ms should not blow past the deadline`);
});

/** Deterministic clock: `now` reads a counter, `sleep` advances it by the requested ms (optionally skewed). */
function fakeClock(skew: (requested: number) => number = (ms) => ms) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += skew(ms);
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function inProgress(id: string): Task {
  return { id, status: "IN_PROGRESS", type: "", progress: 0, preceding_tasks: 0, created_at: 0, started_at: 0, finished_at: 0, expires_at: 0 } as unknown as Task;
}

test("pollUntilTerminal — deterministic: the budget runs out during the sleep, no GET starts after the deadline", async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  const ep = {
    async retrieveDetailed(id: string, extras?: { timeoutMs?: number }): Promise<{ task: Task; raw: unknown }> {
      starts.push(clock.now());
      assert.ok((extras?.timeoutMs ?? Infinity) <= 250 - clock.now() || clock.now() === 0, "each GET is capped by the remaining budget");
      const task = inProgress(id);
      return { task, raw: task };
    },
  } as unknown as TaskEndpoint;
  const res = await pollUntilTerminal(ep, "abc", { timeoutSeconds: 0.25, intervalMs: 300, now: clock.now, sleep: clock.sleep });
  assert.equal(res.timedOut, true);
  assert.equal(res.task?.status, "IN_PROGRESS");
  assert.deepEqual(starts, [0], "one GET at t=0; the sleep consumed the whole budget (min(interval 300, remaining 250)) and no GET followed");
  assert.equal(res.polls, 1);
});

test("pollUntilTerminal — deterministic: a timer that wakes early may poll again, but never after the deadline", async () => {
  // The sleep wakes half a millisecond early (as real timers may); the second
  // GET starts inside the budget, is capped to the 1 ms left, and nothing starts
  // after 250 — the next sleep carries the clock to the deadline and the loop stops.
  const clock = fakeClock((ms) => ms - 0.5);
  const starts: number[] = [];
  const caps: Array<number | undefined> = [];
  const ep = {
    async retrieveDetailed(id: string, extras?: { timeoutMs?: number }): Promise<{ task: Task; raw: unknown }> {
      starts.push(clock.now());
      caps.push(extras?.timeoutMs);
      const task = inProgress(id);
      return { task, raw: task };
    },
  } as unknown as TaskEndpoint;
  const res = await pollUntilTerminal(ep, "abc", { timeoutSeconds: 0.25, intervalMs: 300, requestTimeoutMs: 5000, now: clock.now, sleep: clock.sleep });
  assert.equal(res.timedOut, true);
  assert.ok(starts.every((t) => t < 250), `every GET started before the deadline: ${JSON.stringify(starts)}`);
  assert.deepEqual(starts, [0, 249.5]);
  assert.deepEqual(caps, [250, 1], "the request cap is the remaining budget, rounded up to a whole millisecond");
  // The second sleep starts at 249.5 with 0.5 ms left → the loop finds the budget spent and stops.
  assert.equal(res.polls, 2);
});

test("pollUntilTerminal — deterministic: a timer that wakes late never polls again; a deadline-bound request timeout is the timeout", async () => {
  const late = fakeClock((ms) => ms + 20);
  const starts: number[] = [];
  const ep = {
    async retrieveDetailed(id: string): Promise<{ task: Task; raw: unknown }> {
      starts.push(late.now());
      const task = inProgress(id);
      return { task, raw: task };
    },
  } as unknown as TaskEndpoint;
  const res = await pollUntilTerminal(ep, "abc", { timeoutSeconds: 0.25, intervalMs: 300, now: late.now, sleep: late.sleep });
  assert.equal(res.timedOut, true);
  assert.deepEqual(starts, [0]);

  // The very first GET takes longer than the whole budget: the transport
  // aborts it (phase timeout) and the poll reports a timeout with no task.
  const slow = fakeClock();
  const slowEp = {
    async retrieveDetailed(_id: string, extras?: { timeoutMs?: number }): Promise<{ task: Task; raw: unknown }> {
      slow.advance(extras?.timeoutMs ?? 0);
      throw new TransportError({ message: "request timed out", phase: "timeout", path: "/x" });
    },
  } as unknown as TaskEndpoint;
  const out = await pollUntilTerminal(slowEp, "abc", { timeoutSeconds: 0.25, intervalMs: 300, now: slow.now, sleep: slow.sleep });
  assert.equal(out.timedOut, true);
  assert.equal(out.task, null);
  assert.equal(out.polls, 0);
  // A read-timeout-bound failure (budget still left) is a network error, not a timeout.
  const readCap = fakeClock();
  const readEp = {
    async retrieveDetailed(_id: string, extras?: { timeoutMs?: number }): Promise<{ task: Task; raw: unknown }> {
      readCap.advance(extras?.timeoutMs ?? 0);
      throw new TransportError({ message: "request timed out", phase: "timeout", path: "/x" });
    },
  } as unknown as TaskEndpoint;
  await assert.rejects(pollUntilTerminal(readEp, "abc", { timeoutSeconds: 10, intervalMs: 300, requestTimeoutMs: 50, now: readCap.now, sleep: readCap.sleep }), TransportError);
});

test("pollUntilTerminal — real timers (smoke): no GET starts after the deadline, whatever the timer jitter", async () => {
  // Real setTimeout may wake a fraction early or late; the only invariant a
  // real clock can prove is that no request *starts* past the deadline. The
  // decision is judged with the very clock reading the loop used (the last
  // value the injected `now` returned before the GET), not with a fresh
  // performance.now() taken microseconds later inside the endpoint — that
  // would turn call overhead into a false failure.
  let origin: number | null = null;
  let lastNow = 0;
  const now = () => {
    const t = performance.now();
    if (origin === null) origin = t;
    lastNow = t;
    return t;
  };
  const starts: number[] = [];
  const ep = {
    async retrieveDetailed(id: string): Promise<{ task: Task; raw: unknown }> {
      starts.push(lastNow);
      const task = inProgress(id);
      return { task, raw: task };
    },
  } as unknown as TaskEndpoint;
  const res = await pollUntilTerminal(ep, "abc", { timeoutSeconds: 0.12, intervalMs: 300, now });
  assert.equal(res.timedOut, true);
  assert.ok(starts.length >= 1);
  const deadline = (origin ?? 0) + 120;
  assert.ok(starts.every((t) => t < deadline), `GET decisions relative to the deadline: ${JSON.stringify(starts.map((t) => Number((t - deadline).toFixed(3))))}`);
});

test("pollUntilTerminal — --timeout 0 is a single query that is not bounded by the (zero) budget", async () => {
  const ep = {
    async retrieveDetailed(id: string, extras?: { timeoutMs?: number }): Promise<{ task: Task; raw: unknown }> {
      assert.equal(extras?.timeoutMs, 4321, "the transport read timeout applies, not a 0 ms budget");
      await new Promise((r) => setTimeout(r, 30));
      const task = { id, status: "IN_PROGRESS", type: "", progress: 0, preceding_tasks: 0, created_at: 0, started_at: 0, finished_at: 0, expires_at: 0 } as unknown as Task;
      return { task, raw: task };
    },
  } as unknown as TaskEndpoint;
  const res = await pollUntilTerminal(ep, "abc", { timeoutSeconds: 0, intervalMs: 300, requestTimeoutMs: 4321 });
  assert.equal(res.polls, 1);
  assert.equal(res.timedOut, true);
  assert.equal(res.task?.status, "IN_PROGRESS");
});
