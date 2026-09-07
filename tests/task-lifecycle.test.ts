/**
 * Task verbs end to end (T-006, T-007, T-009, T-040, T-043..T-045, T-047,
 * T-048, T-053): real subprocesses against a loopback API that records every
 * request, so "exactly one POST" is asserted, not assumed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jsonReply, parseNdjson, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

const SIX = ["schema_version", "command", "ok", "result", "error", "warnings"];

function taskBody(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "task-1", type: "text-to-3d-preview", status, progress: status === "SUCCEEDED" ? 100 : 40, created_at: 1, started_at: 2, finished_at: 0, expires_at: 0, task_error: null, ...extra };
}

function envOf(api: MockApi, extra: Record<string, string | undefined> = {}) {
  return api.env(extra);
}

test("T-006 get: every valid status is a successful query (exit 0) in v1 and legacy; FAILED stays exit 1 in legacy only", async () => {
  const statuses = ["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELED", "SOMETHING_NEW"];
  let current = "PENDING";
  const api = await startMockApi((req, res) => {
    if (req.method === "GET" && req.path === "/openapi/v2/text-to-3d/task-1") return jsonReply(res, 200, taskBody(current, { face_count: 0, consumed_credits: 0, novel: { x: 1 } }));
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    for (const status of statuses) {
      current = status;
      const v1 = await runCli(["text-to-3d", "get", "task-1", "--output-schema", "v1", "--include-raw"], { env: envOf(api) });
      assert.equal(v1.code, 0, `${status}: ${v1.stderr}`);
      const env = parseSingleJson(v1.stdout) as { ok: boolean; command: string; result: { task: Record<string, unknown>; submission: unknown; downloads: { state: string } } };
      assert.deepEqual(Object.keys(env), SIX);
      assert.equal(env.ok, true);
      assert.equal(env.command, "text-to-3d.get");
      assert.equal(env.result.task["status"], status, "status is preserved verbatim");
      assert.equal(env.result.task["face_count"], 0, "0 stays 0");
      assert.equal(env.result.task["consumed_credits"], 0);
      assert.deepEqual((env.result.task["raw"] as Record<string, unknown>)["novel"], { x: 1 });
      assert.equal(env.result.downloads.state, "not_requested");

      const legacy = await runCli(["text-to-3d", "get", "task-1"], { env: envOf(api) });
      const expected = status === "FAILED" || status === "CANCELED" ? 1 : 0;
      assert.equal(legacy.code, expected, `legacy ${status}: ${legacy.stderr}`);
      const payload = parseSingleJson(legacy.stdout) as Record<string, unknown>;
      assert.equal(payload["status"], status);
      assert.equal(payload["resource"], "text-to-3d");
    }
    // Missing face_count is null, never 0.
    current = "SUCCEEDED";
    const api2 = await startMockApi((_req, res) => jsonReply(res, 200, taskBody("SUCCEEDED")));
    try {
      const r = await runCli(["text-to-3d", "get", "task-1", "--output-schema", "v1"], { env: envOf(api2) });
      const env = parseSingleJson(r.stdout) as { result: { task: Record<string, unknown> } };
      assert.equal(env.result.task["face_count"], null);
      assert.equal(env.result.task["consumed_credits"], null);
    } finally {
      await api2.close();
    }
  } finally {
    await api.close();
  }
});

test("T-040 create --async: exactly one POST, zero GETs, accepted + id + operation id, journal written", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST" && req.path === "/openapi/v2/text-to-3d") return jsonReply(res, 200, { result: "task-new" });
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    const env = envOf(api);
    const r = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "a cactus", "--async", "--output-schema", "v1"], { env });
    assert.equal(r.code, 0, r.stderr);
    const out = parseSingleJson(r.stdout) as { ok: boolean; result: { task: unknown; submission: { state: string; operation_id: string; task_id: string }; task_id: string; next: Record<string, string> } };
    assert.equal(out.ok, true);
    assert.equal(out.result.task, null, "accepted but not queried: no fabricated PENDING task");
    assert.equal(out.result.submission.state, "accepted");
    assert.equal(out.result.submission.task_id, "task-new");
    assert.match(out.result.submission.operation_id, /^[0-9a-f-]{36}$/);
    assert.match(out.result.next.wait, /text-to-3d wait task-new/);
    assert.deepEqual(api.requests.map((q) => q.method), ["POST"]);
    assert.deepEqual(api.requests[0]!.json, { mode: "preview", prompt: "a cactus", target_formats: ["glb"] });
    const ops = readdirSync(join(String(env["MESHY_CONFIG_DIR"]), "operations")).filter((f) => f.endsWith(".json"));
    assert.equal(ops.length, 1);
    const rec = JSON.parse(readFileSync(join(String(env["MESHY_CONFIG_DIR"]), "operations", ops[0]!), "utf8")) as { state: string; task_id: string };
    assert.equal(rec.state, "accepted");
    assert.equal(rec.task_id, "task-new");

    // Legacy async keeps the 0.2.0 shape (plus operation_id) and also makes exactly one request.
    const legacy = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "a cactus", "--async"], { env: envOf(api) });
    assert.equal(legacy.code, 0, legacy.stderr);
    const lp = parseSingleJson(legacy.stdout) as Record<string, unknown>;
    assert.equal(lp["task_id"], "task-new");
    assert.equal(lp["status"], "PENDING");
    assert.match(String(lp["hint"]), /text-to-3d wait task-new/);
    assert.deepEqual(api.requests.map((q) => q.method), ["POST", "POST"]);
  } finally {
    await api.close();
  }
});

test("T-043/T-044 create: 5xx and malformed 2xx are submission_unknown (exit 10) after exactly one POST; 4xx is a definite rejection", async () => {
  let mode: "500" | "malformed" | "400" | "hang" = "500";
  const api = await startMockApi((req, res) => {
    if (req.method !== "POST") return jsonReply(res, 404, { message: "nope" });
    if (mode === "500") return jsonReply(res, 500, { message: "boom" });
    if (mode === "malformed") return jsonReply(res, 200, { unexpected: true });
    if (mode === "400") return jsonReply(res, 400, { message: "prompt too long" });
    // hang: accept the request, never answer → client read timeout
  });
  try {
    for (const m of ["500", "malformed", "hang"] as const) {
      mode = m;
      api.requests.length = 0;
      const r = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--async", "--output-schema", "v1"], { env: envOf(api, { MESHY_READ_TIMEOUT_MS: "500" }), timeoutMs: 15000 });
      assert.equal(r.code, 10, `${m}: ${r.stderr}\n${r.stdout}`);
      const out = parseSingleJson(r.stdout) as { ok: boolean; error: { code: string; recovery: { action: string; automatic: boolean; command: string } }; result: { submission: { state: string; operation_id: string } } };
      assert.equal(out.ok, false);
      assert.equal(out.error.code, "submission_unknown");
      assert.equal(out.error.recovery.action, "reconcile");
      assert.equal(out.error.recovery.automatic, false);
      assert.ok(!/create again|re-run|retry the create/i.test(r.stdout + r.stderr), "no advice to resubmit");
      assert.equal(out.result.submission.state, "unknown");
      assert.ok(out.result.submission.operation_id);
      assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, `${m}: exactly one POST`);
    }
    mode = "400";
    api.requests.length = 0;
    const rejected = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--async", "--output-schema", "v1"], { env: envOf(api) });
    assert.equal(rejected.code, 4, rejected.stderr);
    const out = parseSingleJson(rejected.stdout) as { error: { code: string; http_status: number } };
    assert.equal(out.error.code, "validation");
    assert.equal(out.error.http_status, 400);
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});

test("T-046 --operation-id: the second run with the same request replays the journal and sends nothing", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "task-once" });
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const env = envOf(api);
    const args = ["text-to-3d", "create", "--mode", "preview", "--prompt", "same", "--async", "--operation-id", "op-fixed", "--output-schema", "v1"];
    const first = await runCli(args, { env });
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(args, { env });
    assert.equal(second.code, 0, second.stderr);
    const out = parseSingleJson(second.stdout) as { result: { submission: { task_id: string } }; warnings: Array<{ code: string }> };
    assert.equal(out.result.submission.task_id, "task-once");
    assert.equal(out.warnings[0]?.code, "operation_replayed");
    assert.equal(api.requests.length, 1, "no second POST");
    // Same id, different payload → conflict, still no POST.
    const conflict = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "different", "--async", "--operation-id", "op-fixed", "--output-schema", "v1"], { env });
    assert.equal(conflict.code, 2, conflict.stderr);
    assert.equal((parseSingleJson(conflict.stdout) as { error: { code: string } }).error.code, "operation_conflict");
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});

test("T-007 wait: FAILED with null task_error exits 1 with the task preserved; SUCCEEDED exits 0", async () => {
  let n = 0;
  const api = await startMockApi((req, res) => {
    if (req.method !== "GET") return jsonReply(res, 404, { message: "nope" });
    n += 1;
    return jsonReply(res, 200, taskBody(n < 3 ? "IN_PROGRESS" : "FAILED", { task_error: null }));
  });
  try {
    const r = await runCli(["text-to-3d", "wait", "task-1", "--output-schema", "v1"], { env: envOf(api) });
    assert.equal(r.code, 1, r.stderr);
    const out = parseSingleJson(r.stdout) as { ok: boolean; error: { code: string }; result: { task: { task_id: string; status: string }; wait: { polls: number } } };
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "task_failed");
    assert.equal(out.result.task.task_id, "task-1");
    assert.equal(out.result.task.status, "FAILED");
    assert.equal(out.result.wait.polls, 3);
  } finally {
    await api.close();
  }
});

test("T-047 wait --timeout: 0 = one query then exit 8; negative/NaN/Infinity make no request", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, taskBody("IN_PROGRESS")));
  try {
    const zero = await runCli(["text-to-3d", "wait", "task-1", "--timeout", "0", "--output-schema", "v1"], { env: envOf(api) });
    assert.equal(zero.code, 8, zero.stderr);
    const out = parseSingleJson(zero.stdout) as { error: { code: string; recovery: { command: string } }; result: { task: { status: string }; wait: { timed_out: boolean; polls: number } } };
    assert.equal(out.error.code, "timed_out");
    assert.equal(out.result.task.status, "IN_PROGRESS");
    assert.equal(out.result.wait.timed_out, true);
    assert.equal(out.result.wait.polls, 1);
    assert.match(out.error.recovery.command, /wait task-1/);
    assert.equal(api.requests.length, 1);
    for (const bad of ["-1", "NaN", "Infinity", "abc", ""]) {
      const r = await runCli(["text-to-3d", "wait", "task-1", "--timeout", bad, "--output-schema", "v1"], { env: envOf(api) });
      assert.equal(r.code, 2, `${bad}: ${r.stderr}`);
    }
    assert.equal(api.requests.length, 1, "invalid timeouts never reach the API");
  } finally {
    await api.close();
  }
});

test("T-009 get -o: non-terminal → downloads.not_ready, exit 0, no asset request; --save-json stores the raw task", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, taskBody("IN_PROGRESS", { model_urls: { glb: "http://127.0.0.1:9/never.glb" } })));
  try {
    const dir = tmpDir();
    const r = await runCli(["text-to-3d", "get", "task-1", "-o", join(dir, "out"), "--save-json", join(dir, "task.json"), "--output-schema", "v1"], { env: envOf(api), cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const out = parseSingleJson(r.stdout) as { result: { downloads: { state: string }; saved_json: { path: string } } };
    assert.equal(out.result.downloads.state, "not_ready");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).id, "task-1");
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});

test("T-048 SIGINT during wait exits 130, sends no DELETE and no second POST, keeps the task id", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "task-slow" });
    return jsonReply(res, 200, { ...taskBody("IN_PROGRESS"), id: "task-slow" });
  });
  try {
    const r = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "slow", "--output-schema", "v1"], { env: envOf(api, { MESHY_POLL_INTERVAL_MS: "300" }), sigintAfterMs: 1200, timeoutMs: 15000 });
    assert.equal(r.code, 130, `${r.stderr}\n${r.stdout}`);
    const out = parseSingleJson(r.stdout) as { error: { code: string; recovery: { command: string } }; result: { task_id: string; submission: { state: string; task_id: string } } };
    assert.equal(out.error.code, "interrupted");
    assert.equal(out.result.task_id, "task-slow");
    assert.equal(out.result.submission.state, "accepted");
    assert.match(out.error.recovery.command, /wait task-slow/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
    assert.equal(api.requests.filter((q) => q.method === "DELETE").length, 0);
  } finally {
    await api.close();
  }
});

test("T-053 stream: ndjson emits task events + one outcome; json emits one envelope; error event → exit 5", async () => {
  const sse = (obj: unknown) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
  const api = await startMockApi((req, res, raw) => {
    if (req.path === "/openapi/v2/text-to-3d/task-1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hello\n\n");
      setTimeout(() => res.write(sse(taskBody("IN_PROGRESS"))), 20);
      setTimeout(() => res.write(sse(taskBody("SUCCEEDED", { model_urls: { glb: "https://assets.example.invalid/m.glb" } }))), 60);
      raw.on("close", () => res.end());
      return;
    }
    if (req.path === "/openapi/v2/text-to-3d/missing/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(readFileSync(new URL("./fixtures/skill-parity/task-error.synthetic.sse", import.meta.url)));
      return;
    }
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const nd = await runCli(["text-to-3d", "stream", "task-1", "--format", "ndjson", "--output-schema", "v1"], { env: envOf(api) });
    assert.equal(nd.code, 0, nd.stderr);
    const lines = parseNdjson(nd.stdout) as Array<{ event: string; sequence: number; ok: boolean; result: { task: { status: string } } }>;
    assert.deepEqual(lines.map((l) => l.event), ["task", "task", "outcome"]);
    assert.deepEqual(lines.map((l) => l.sequence), [1, 2, 3]);
    assert.equal(lines[2]!.ok, true);
    assert.equal(lines[2]!.result.task.status, "SUCCEEDED");
    for (const l of lines) assert.deepEqual(Object.keys(l).slice(0, 6), SIX);
    assert.equal(nd.stderr.trim(), "", "ndjson keeps stderr quiet");

    const js = await runCli(["text-to-3d", "stream", "task-1", "--output-schema", "v1"], { env: envOf(api) });
    assert.equal(js.code, 0, js.stderr);
    const env = parseSingleJson(js.stdout) as { result: { stream: { events: number; ended: string } } };
    assert.equal(env.result.stream.events, 2);
    assert.equal(env.result.stream.ended, "terminal");
    assert.match(js.stderr, /IN_PROGRESS/, "progress goes to stderr in json mode");

    const missing = await runCli(["text-to-3d", "stream", "missing", "--output-schema", "v1"], { env: envOf(api) });
    assert.equal(missing.code, 5, missing.stderr);
    const errEnv = parseSingleJson(missing.stdout) as { ok: boolean; error: { code: string; http_status: number } };
    assert.equal(errEnv.ok, false);
    assert.equal(errEnv.error.code, "not_found");
    assert.equal(errEnv.error.http_status, 404);
  } finally {
    await api.close();
  }
});
