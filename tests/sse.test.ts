/**
 * SSE parsing and stream semantics (T-049..T-053). The parser is exercised
 * with arbitrary byte splits, CRLF, UTF-8 boundaries, comments and multi-line
 * data; streamTask is exercised against a loopback server.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createSseParser, streamTask, type SseEvent } from "../src/internal/stream.js";
import { createTransport } from "../src/client/transport.js";
import { TaskEndpoint } from "../src/client/endpoints/base.js";
import { MeshyApiError } from "../src/client/errors.js";
import { CliError } from "../src/internal/errors.js";

function parseAll(text: string, chunkSize: number): SseEvent[] {
  const bytes = Buffer.from(text, "utf8");
  const parser = createSseParser();
  const out: SseEvent[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) out.push(...parser.feed(bytes.subarray(i, i + chunkSize)));
  out.push(...parser.end());
  return out;
}

const STREAM = [
  ": heartbeat comment",
  "",
  "event: message",
  'data: {"id":"t","status":"IN_PROGRESS",',
  'data: "progress":10,"name":"naïve ☃ 模型"}',
  "id: 7",
  "",
  ":keep-alive",
  "event: message",
  'data: {"id":"t","status":"SUCCEEDED","progress":100}',
  "",
].join("\n");

test("T-049 parser: identical events for every chunk size, LF/CR/CRLF, multi-line data, comments", () => {
  const reference = parseAll(STREAM, STREAM.length);
  assert.equal(reference.length, 2);
  assert.equal(reference[0]!.event, "message");
  assert.equal(JSON.parse(reference[0]!.data).name, "naïve ☃ 模型");
  assert.equal(reference[0]!.id, "7");
  assert.equal(JSON.parse(reference[1]!.data).status, "SUCCEEDED");
  for (const size of [1, 2, 3, 5, 7, 11, 64]) {
    assert.deepEqual(parseAll(STREAM, size), reference, `chunk size ${size}`);
  }
  assert.deepEqual(parseAll(STREAM.replace(/\n/g, "\r\n"), 3), reference, "CRLF");
  assert.deepEqual(parseAll(STREAM.replace(/\n/g, "\r"), 4), reference, "CR");
  // A final event without a trailing blank line is dispatched at end().
  const noTrailer = parseAll('data: {"a":1}', 2);
  assert.equal(noTrailer.length, 1);
  assert.equal(noTrailer[0]!.event, "message");
});

test("parser: the synthetic error fixture yields one error event with status_code 404", () => {
  const fixture = readFileSync(new URL("./fixtures/skill-parity/task-error.synthetic.sse", import.meta.url));
  for (const size of [1, 4, 16, fixture.length]) {
    const parser = createSseParser();
    const out: SseEvent[] = [];
    for (let i = 0; i < fixture.length; i += size) out.push(...parser.feed(fixture.subarray(i, i + size)));
    out.push(...parser.end());
    assert.equal(out.length, 1, `chunk ${size}`);
    assert.equal(out[0]!.event, "error");
    assert.deepEqual(JSON.parse(out[0]!.data), { message: "Synthetic task not found", status_code: 404 });
  }
});

test("parser: oversized events are a protocol error, not a truncation", () => {
  const parser = createSseParser({ maxEventBytes: 64 });
  assert.throws(() => parser.feed(Buffer.from(`data: ${"x".repeat(100)}\n\n`)), (e: unknown) => e instanceof CliError && e.code === "protocol");
});

// ---------------------------------------------------------------------------
// streamTask against a loopback server
// ---------------------------------------------------------------------------

interface Scenario {
  headers?: Record<string, string>;
  status?: number;
  /** Chunks written with the given delays (ms). A null chunk closes the response. */
  script: Array<{ delay: number; chunk: string | null }>;
  keepOpen?: boolean;
}

async function serve(scenario: Scenario): Promise<{ server: Server; endpoint: TaskEndpoint; url: string; opened: number }> {
  const state = { opened: 0 };
  const server = createServer((req, res) => {
    state.opened += 1;
    res.writeHead(scenario.status ?? 200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...(scenario.headers ?? {}) });
    res.flushHeaders();
    let t = 0;
    for (const step of scenario.script) {
      t += step.delay;
      setTimeout(() => {
        if (req.destroyed) return;
        if (step.chunk === null) res.end();
        else res.write(step.chunk);
      }, t);
    }
    req.on("close", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  const transport = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
  return { server, endpoint: new TaskEndpoint(transport, "/image-to-3d"), url, get opened() { return state.opened; } } as never;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

const msg = (obj: unknown) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;

test("T-050 terminal message closes the connection promptly and yields exactly one outcome", async () => {
  const s = await serve({
    script: [
      { delay: 10, chunk: msg({ id: "t", status: "IN_PROGRESS", progress: 30 }) },
      { delay: 30, chunk: msg({ id: "t", status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://assets.example.invalid/m.glb" } }) },
      // Server keeps the socket open afterwards (misbehaving server); client must not wait for it.
    ],
    keepOpen: true,
  });
  try {
    const seen: string[] = [];
    const started = Date.now();
    const out = await streamTask(s.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 2000, onTask: (task) => { seen.push(task.status); } });
    assert.equal(out.reason, "terminal");
    assert.equal(out.task?.status, "SUCCEEDED");
    assert.deepEqual(seen, ["IN_PROGRESS", "SUCCEEDED"]);
    assert.equal(out.events, 2);
    assert.ok(Date.now() - started < 1500, "did not wait for the idle timeout after the terminal event");
  } finally {
    await closeServer(s.server);
  }
});

test("T-051 error event after HTTP 200 maps to not_found; non-JSON and wrong content-type are protocol errors", async () => {
  const errFixture = readFileSync(new URL("./fixtures/skill-parity/task-error.synthetic.sse", import.meta.url), "utf8");
  const s1 = await serve({ script: [{ delay: 5, chunk: errFixture.slice(0, 40) }, { delay: 20, chunk: errFixture.slice(40) }] });
  try {
    const out = await streamTask(s1.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 2000 });
    assert.equal(out.reason, "error");
    assert.ok(out.error instanceof MeshyApiError);
    assert.equal((out.error as MeshyApiError).status, 404);
    assert.equal((out.error as MeshyApiError).code, "not_found");
    assert.equal(out.task, null);
  } finally {
    await closeServer(s1.server);
  }
  const s2 = await serve({ script: [{ delay: 5, chunk: msg({ id: "t", status: "IN_PROGRESS" }) }, { delay: 10, chunk: "event: message\ndata: {not json\n\n" }] });
  try {
    const out = await streamTask(s2.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 2000 });
    assert.equal(out.reason, "protocol");
    assert.equal(out.task?.status, "IN_PROGRESS", "last good task is kept");
  } finally {
    await closeServer(s2.server);
  }
  const s3 = await serve({ headers: { "content-type": "application/json" }, script: [{ delay: 5, chunk: '{"id":"t","status":"SUCCEEDED"}' }, { delay: 10, chunk: null }] });
  try {
    const out = await streamTask(s3.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 2000 });
    assert.equal(out.reason, "protocol");
    assert.equal(out.task, null, "an application/json body is never treated as a successful task");
  } finally {
    await closeServer(s3.server);
  }
  const s4 = await serve({ script: [{ delay: 5, chunk: ": hello\n\n" }, { delay: 10, chunk: null }] });
  try {
    const out = await streamTask(s4.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 2000 });
    assert.equal(out.reason, "protocol");
    assert.match(out.error?.message ?? "", /without any task event/);
  } finally {
    await closeServer(s4.server);
  }
});

test("T-051 disconnect before a terminal status keeps the last task and reports disconnected", async () => {
  const s = await serve({ script: [{ delay: 5, chunk: msg({ id: "t", status: "IN_PROGRESS", progress: 55 }) }, { delay: 15, chunk: null }] });
  try {
    const out = await streamTask(s.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 2000 });
    assert.equal(out.reason, "disconnected");
    assert.equal(out.task?.progress, 55);
  } finally {
    await closeServer(s.server);
  }
});

test("T-052 heartbeats reset the idle timer but not the total deadline; timers are cleaned up", async () => {
  const s = await serve({
    script: [
      { delay: 5, chunk: msg({ id: "t", status: "IN_PROGRESS", progress: 1 }) },
      ...Array.from({ length: 20 }, (_, i) => ({ delay: 60, chunk: i % 2 ? ": hb\n\n" : msg({ id: "t", status: "IN_PROGRESS", progress: 1 }) })),
    ],
    keepOpen: true,
  });
  try {
    const started = Date.now();
    const out = await streamTask(s.endpoint, "t", { timeoutMs: 400, idleTimeoutMs: 200 });
    assert.equal(out.reason, "timeout", "heartbeats every 60ms kept idle alive; the total deadline still fired");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 350 && elapsed < 2000, `elapsed ${elapsed}`);
    const idle = await serve({ script: [{ delay: 5, chunk: msg({ id: "t", status: "IN_PROGRESS" }) }], keepOpen: true });
    try {
      const out2 = await streamTask(idle.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 150 });
      assert.equal(out2.reason, "idle_timeout");
      assert.equal(out2.task?.status, "IN_PROGRESS");
    } finally {
      await closeServer(idle.server);
    }
  } finally {
    await closeServer(s.server);
  }
});

test("an external abort mid-stream is reported as interrupted and closes the connection", async () => {
  const s = await serve({ script: [{ delay: 5, chunk: msg({ id: "t", status: "IN_PROGRESS" }) }], keepOpen: true });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const out = await streamTask(s.endpoint, "t", { timeoutMs: 5000, idleTimeoutMs: 5000, signal: ac.signal });
    assert.equal(out.reason, "interrupted");
    assert.equal(out.task?.status, "IN_PROGRESS");
  } finally {
    await closeServer(s.server);
  }
});
