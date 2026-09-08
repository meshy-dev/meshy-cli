/**
 * Transport boundaries (T-031, T-032): credential scope, redirect refusal,
 * body-inclusive deadlines, body caps, and the not-sent vs unknown phase.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createTransport, resolveApiUrl, TransportError } from "../src/client/transport.js";
import { MeshyApiError } from "../src/client/errors.js";

const BASE = "https://api.example.com/openapi/v1";

test("resolveApiUrl — relative paths stay inside the base; escapes are refused before any request", () => {
  assert.equal(resolveApiUrl(BASE, "/balance").href, "https://api.example.com/openapi/v1/balance");
  assert.equal(resolveApiUrl(BASE, "text-to-3d/abc%2Fslash").href, "https://api.example.com/openapi/v1/text-to-3d/abc%2Fslash");
  assert.equal(resolveApiUrl(BASE, "https://api.example.com/openapi/v1/rigging/x").href, "https://api.example.com/openapi/v1/rigging/x");
  for (const bad of [
    "//evil.example/openapi/v1/balance",
    "https://evil.example/openapi/v1/balance",
    "https://api.example.com/openapi/v2/text-to-3d",
    "https://user:pw@api.example.com/openapi/v1/balance",
    "ftp://api.example.com/openapi/v1/balance",
    "/../v2/text-to-3d",
    "/text-to-3d/../../admin",
  ]) {
    assert.throws(() => resolveApiUrl(BASE, bad), (e: unknown) => e instanceof TransportError && e.phase === "validate", bad);
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no addr");
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

test("authenticated transport sends the bearer, public transport never does", async () => {
  const seen: Array<string | undefined> = [];
  const { server, url } = await listen((req, res) => {
    seen.push(req.headers["authorization"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const auth = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
    const pub = createTransport({ baseUrl: `${url}/web/public`, readTimeoutMs: 5000 });
    await auth.requestJson("GET", "/balance");
    await pub.requestJson("GET", "/animations/resources", { headers: { Authorization: "Bearer leaked", Cookie: "a=b" } });
    assert.deepEqual(seen, ["Bearer msy_k", undefined]);
  } finally {
    await close(server);
  }
});

test("redirects are refused rather than followed with a credential", async () => {
  const hits: string[] = [];
  const { server, url } = await listen((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(302, { location: "https://evil.example/steal" });
    res.end();
  });
  try {
    const t = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
    await assert.rejects(t.requestJson("GET", "/balance"), (e: unknown) => e instanceof TransportError && e.phase === "response" && /redirect/.test(e.message));
    assert.deepEqual(hits, ["/openapi/v1/balance"]);
  } finally {
    await close(server);
  }
});

test("the deadline covers the body: headers then a stalled body time out and report phase timeout", async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"partial":');
    // never end
  });
  try {
    const t = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 300 });
    const started = Date.now();
    await assert.rejects(t.requestJson("GET", "/slow"), (e: unknown) => e instanceof TransportError && e.phase === "timeout");
    assert.ok(Date.now() - started < 5000);
  } finally {
    await close(server);
  }
});

test("oversized bodies fail explicitly instead of being truncated", async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ blob: "x".repeat(5000) }));
  });
  try {
    const t = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
    await assert.rejects(t.requestJson("GET", "/big", { maxBodyBytes: 1000 }), (e: unknown) => e instanceof MeshyApiError && /exceeds 1000 bytes/.test(e.message));
    const ok = await t.requestJson("GET", "/big");
    assert.equal((ok.json as { blob: string }).blob.length, 5000);
  } finally {
    await close(server);
  }
});

test("connection refused is classified as never sent; an abort mid-flight is 'aborted'", async () => {
  const { server, url } = await listen(() => undefined);
  await close(server); // port is now closed
  const t = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 2000 });
  await assert.rejects(t.requestJson("POST", "/text-to-3d", { body: {} }), (e: unknown) => e instanceof TransportError && e.phase === "connect" && e.neverSent);

  const stalled = await listen(() => undefined);
  try {
    const t2 = createTransport({ baseUrl: `${stalled.url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
    const ac = new AbortController();
    const p = t2.requestJson("POST", "/text-to-3d", { body: {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e: unknown) => e instanceof TransportError && e.phase === "aborted" && !e.neverSent);
  } finally {
    await close(stalled.server);
  }
});

test("non-2xx bodies map to MeshyApiError with the status and message", async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Task not found" }));
  });
  try {
    const t = createTransport({ baseUrl: `${url}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
    await assert.rejects(t.requestJson("GET", "/uv-unwrap/x"), (e: unknown) => e instanceof MeshyApiError && e.status === 404 && e.code === "not_found" && /Task not found/.test(e.message));
  } finally {
    await close(server);
  }
});
