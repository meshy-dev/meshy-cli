/**
 * Tests for pollUntilTerminal — the main polling loop behind `wait` + sync
 * `create`. We substitute a fake TaskEndpoint so tests stay offline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { TaskEndpoint } from "../src/client/endpoints/base.js";
import { pollUntilTerminal } from "../src/internal/poll.js";
import type { Task } from "../src/client/types.js";

function fakeEndpoint(statuses: string[]): TaskEndpoint {
  let i = 0;
  return {
    async retrieve(id: string): Promise<Task> {
      const status = statuses[Math.min(i, statuses.length - 1)] ?? "PENDING";
      i += 1;
      return { id, status, type: "", progress: 0, preceding_tasks: 0, created_at: 0, started_at: 0, finished_at: 0, expires_at: 0 } as unknown as Task;
    },
  } as unknown as TaskEndpoint;
}

test("pollUntilTerminal — returns immediately when already SUCCEEDED", async () => {
  const ep = fakeEndpoint(["SUCCEEDED"]);
  const { task, timedOut } = await pollUntilTerminal(ep, "abc", {
    timeoutSeconds: 5,
    intervalMs: 250,
  });
  assert.equal(task.status, "SUCCEEDED");
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
  assert.equal(task.status, "SUCCEEDED");
  assert.deepEqual(seen, ["PENDING", "IN_PROGRESS", "SUCCEEDED"]);
});

test("pollUntilTerminal — treats FAILED and CANCELED as terminal", async () => {
  const a = await pollUntilTerminal(fakeEndpoint(["FAILED"]), "x", {
    timeoutSeconds: 5,
    intervalMs: 10,
  });
  assert.equal(a.task.status, "FAILED");
  assert.equal(a.timedOut, false);

  const b = await pollUntilTerminal(fakeEndpoint(["CANCELED"]), "x", {
    timeoutSeconds: 5,
    intervalMs: 10,
  });
  assert.equal(b.task.status, "CANCELED");
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
  assert.equal(task.status, "PENDING");
  assert.ok(elapsed >= 200, `elapsed=${elapsed}ms should be at least 200`);
  assert.ok(elapsed < 2000, `elapsed=${elapsed}ms should not blow past the deadline`);
});
