/**
 * `meshy operations` and the journal after a lost process: a create killed
 * mid-POST used to leave a `started` record that every replay refused with
 * exit 10 and no way to record the reconciliation. `resolve --task-id` binds
 * the task `list` showed, `resolve --not-created` releases the id, and
 * SIGTERM now takes the cooperative path instead of a hard kill.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { beginOperation, credentialFingerprint, payloadFingerprint, readOperation, resolveOperation, updateOperation } from "../src/internal/operation-store.js";
import { CliError } from "../src/internal/errors.js";
import { DIST_ENTRY, isolatedEnv, jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const identity = {
  resource: "text-to-motion",
  endpoint: "/openapi/v1/text-to-motion",
  apiOrigin: "http://127.0.0.1:1",
  credentialFingerprint: credentialFingerprint({ source: "env", origin: "http://127.0.0.1:1", kind: "api_key", secret: "msy_fixture_ops_0000000000" }),
  payloadFingerprint: payloadFingerprint({ mode: "prime", prompt: "jet entry", duration: 3 }),
};

const dead = () => false;
const alive = () => true;

test("resolve --task-id binds the task: the record becomes accepted and a replay returns it", () => {
  const root = tmpDir("ops-resolve-");
  beginOperation(root, "op-a", identity);
  const res = resolveOperation(root, "op-a", { as: "created", taskId: "task-7" }, { isAlive: dead });
  assert.equal(res.previous_state, "started");
  assert.equal(res.record?.state, "accepted");
  assert.equal(res.record?.resolution?.as, "created");
  const replay = beginOperation(root, "op-a", identity);
  assert.equal(replay.outcome, "existing");
  assert.equal(replay.record.task_id, "task-7");
});

test("resolve --not-created releases the id (record archived under resolved/) so the same id starts fresh", () => {
  const root = tmpDir("ops-resolve-");
  beginOperation(root, "op-b", identity);
  updateOperation(root, "op-b", { state: "unknown", error: "socket hang up" });
  const res = resolveOperation(root, "op-b", { as: "not_created" });
  assert.equal(res.previous_state, "unknown");
  assert.equal(res.record, null);
  assert.ok(res.archived_to && existsSync(res.archived_to));
  assert.equal(readOperation(root, "op-b"), null);
  assert.equal(beginOperation(root, "op-b", identity).outcome, "created");
});

test("resolve refuses what it must not touch: a missing id, an accepted record, a task for a rejected one, a live started process", () => {
  const root = tmpDir("ops-resolve-");
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof CliError ? e.code : String(e);
    }
    return "no error";
  };
  assert.equal(code(() => resolveOperation(root, "nope", { as: "not_created" })), "not_found");

  beginOperation(root, "op-acc", identity);
  updateOperation(root, "op-acc", { state: "accepted", task_id: "task-1" });
  assert.equal(code(() => resolveOperation(root, "op-acc", { as: "not_created" })), "operation_conflict");
  assert.equal(readOperation(root, "op-acc")?.task_id, "task-1", "an accepted record is never released");

  beginOperation(root, "op-rej", identity);
  updateOperation(root, "op-rej", { state: "rejected", http_status: 400 });
  assert.equal(code(() => resolveOperation(root, "op-rej", { as: "created", taskId: "task-2" })), "operation_conflict");
  assert.equal(resolveOperation(root, "op-rej", { as: "not_created" }).resolution, "not_created");

  beginOperation(root, "op-live", identity);
  assert.equal(code(() => resolveOperation(root, "op-live", { as: "not_created" }, { isAlive: alive })), "operation_conflict");
  assert.equal(resolveOperation(root, "op-live", { as: "not_created" }, { isAlive: alive, force: true }).resolution, "not_created");
});

test("resolve matches the stored id, not the file name (ids that slug to the same file stay apart); binding the same task again is a no-op", () => {
  const root = tmpDir("ops-resolve-");
  beginOperation(root, "batch_7", identity);
  updateOperation(root, "batch_7", { state: "unknown" });
  assert.throws(() => resolveOperation(root, "batch/7", { as: "not_created" }), (e: unknown) => e instanceof CliError && e.code === "not_found");
  assert.equal(readOperation(root, "batch_7")?.state, "unknown");

  resolveOperation(root, "batch_7", { as: "created", taskId: "task-3" });
  assert.equal(resolveOperation(root, "batch_7", { as: "created", taskId: "task-3" }).record?.task_id, "task-3");
  assert.throws(() => resolveOperation(root, "batch_7", { as: "created", taskId: "task-4" }), (e: unknown) => e instanceof CliError && e.code === "operation_conflict");
});

test("a started record owned by this very pid (PID 1 in a fresh container) is not treated as in flight", () => {
  const root = tmpDir("ops-resolve-");
  beginOperation(root, "op-self", identity);
  assert.equal(readOperation(root, "op-self")?.pid, process.pid);
  assert.equal(resolveOperation(root, "op-self", { as: "not_created" }).resolution, "not_created");
});

test("one SIGTERM ends a command that does not observe the abort (auth login waiting for the browser) within the grace period", { timeout: 20_000 }, async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [DIST_ENTRY, "auth", "login", "--port", String(port)], {
    env: isolatedEnv({ MESHY_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:1/oauth/authorize", MESHY_CLI_FORCE_GUI: "1" }) as NodeJS.ProcessEnv,
  });
  let stderr = "";
  let sentAt = 0;
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
    if (!sentAt && stderr.includes("oauth/authorize")) {
      sentAt = Date.now();
      child.kill("SIGTERM");
    }
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  assert.ok(sentAt, `the login flow started: ${stderr}`);
  assert.equal(code, 130, stderr);
  assert.ok(Date.now() - sentAt < 8_000, `exited ${Date.now() - sentAt}ms after a single SIGTERM`);
});

const CREATE = ["text-to-motion", "create", "--prompt", "jet entry", "--mode", "prime", "--duration", "3", "--async", "--operation-id", "lf-jet_entry"];

test("SIGTERM mid-POST records `unknown` (not `started`); after reconciling, resolve --not-created lets the same --operation-id submit once", async () => {
  let hang = true;
  let child: ChildProcess | undefined;
  const api = await startMockApi((req, res) => {
    if (req.method !== "POST") return jsonReply(res, 404, { message: "nope" });
    if (hang) {
      child?.kill("SIGTERM"); // the harness gives up while the request is in flight
      return;
    }
    jsonReply(res, 202, { result: "task-new" });
  });
  try {
    const env = api.env();
    const killed = await runCli(CREATE, { env, onSpawn: (c) => (child = c) });
    assert.equal(killed.code, 130, killed.stderr);
    const ops = join(env["MESHY_CONFIG_DIR"]!, "operations");
    assert.equal(readOperation(ops, "lf-jet_entry")?.state, "unknown");

    const replay = await runCli(CREATE, { env });
    assert.equal(replay.code, 10, replay.stderr);
    const out = parseSingleJson(replay.stdout) as { error: { code: string; hint?: string } };
    assert.equal(out.error.code, "submission_unknown");
    assert.match(out.error.hint ?? "", /meshy operations resolve lf-jet_entry --not-created/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, "the replay sent nothing");

    const resolved = await runCli(["operations", "resolve", "lf-jet_entry", "--not-created"], { env });
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.equal((parseSingleJson(resolved.stdout) as { result: { previous_state: string } }).result.previous_state, "unknown");

    hang = false;
    const again = await runCli(CREATE, { env });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /task-new/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 2, "exactly one new POST");
    assert.equal(readOperation(ops, "lf-jet_entry")?.task_id, "task-new");
    assert.equal(readdirSync(join(ops, "resolved")).length, 1, "the released record is kept");
  } finally {
    await api.close();
  }
});

test("a record left `started` by a hard kill: operations list shows it, resolve --task-id makes the replay return that task with no POST", async () => {
  let child: ChildProcess | undefined;
  const api = await startMockApi((req) => {
    if (req.method === "POST") child?.kill("SIGKILL");
  });
  try {
    const env = api.env();
    const killed = await runCli(CREATE, { env, onSpawn: (c) => (child = c) });
    assert.equal(killed.signal, "SIGKILL");

    const listed = await runCli(["operations", "list", "--state", "started"], { env });
    assert.equal(listed.code, 0, listed.stderr);
    const ops = (parseSingleJson(listed.stdout) as { result: { operations: Array<{ operation_id: string; state: string }> } }).result.operations;
    assert.deepEqual(ops.map((o) => [o.operation_id, o.state]), [["lf-jet_entry", "started"]]);

    const resolved = await runCli(["operations", "resolve", "lf-jet_entry", "--task-id", "task-found"], { env });
    assert.equal(resolved.code, 0, resolved.stderr);

    const replay = await runCli(CREATE, { env });
    assert.equal(replay.code, 0, replay.stderr);
    assert.match(replay.stdout, /task-found/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, "the replay sent nothing");

    const usage = await runCli(["operations", "resolve", "lf-jet_entry"], { env });
    assert.equal(usage.code, 2, "exactly one of --task-id / --not-created");
    const empty = await runCli(["operations", "resolve", "lf-jet_entry", "--task-id", "", "--not-created"], { env });
    assert.equal(empty.code, 2, "an empty --task-id is not --not-created");
    assert.equal(readOperation(join(env["MESHY_CONFIG_DIR"]!, "operations"), "lf-jet_entry")?.task_id, "task-found");
  } finally {
    await api.close();
  }
});
