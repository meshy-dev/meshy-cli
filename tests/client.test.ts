/**
 * Integration tests for MeshyClient with a mocked global fetch. Exercises the
 * create/retrieve/list/delete flow and the v1/v2 fetcher routing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MeshyClient } from "../src/client/index.js";
import { MeshyApiError } from "../src/client/errors.js";
import type { MeshyConfig } from "../src/internal/config.js";

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Headers;
}

function installFetch(
  handler: (req: Call) => Response | Promise<Response>,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  globalThis.fetch = (async (input: FetchInput, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : undefined;
    const headers = new Headers(init.headers ?? {});
    const call: Call = { url, method, headers };
    if (body !== undefined) call.body = body;
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function buildConfig(): MeshyConfig {
  return {
    apiKey: "msy_test_key",
    baseUrlV1: "https://api.example.com/v1",
    baseUrlV2: "https://api.example.com/v2",
    connectTimeoutMs: 1000,
    readTimeoutMs: 5000,
    pollIntervalMs: 10,
    logLevel: "silent",
    credentialSource: "flag",
    credentialsFile: "/nonexistent/credentials.json",
    credentialKind: "api_key",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("MeshyClient.balance.get — GETs /balance on v1 with bearer auth", async () => {
  const { calls, restore } = installFetch(() => jsonResponse({ balance: 42 }));
  try {
    const client = new MeshyClient(buildConfig());
    const balance = await client.balance.get();
    assert.deepEqual(balance, { balance: 42 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.com/v1/balance");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer msy_test_key");
    assert.match(calls[0]!.headers.get("user-agent") ?? "", /^meshy-cli\//);
  } finally {
    restore();
  }
});

test("MeshyClient.textTo3d.create — POSTs to v2 with JSON body, returns task_id", async () => {
  const { calls, restore } = installFetch(() => jsonResponse({ result: "task-123" }));
  try {
    const client = new MeshyClient(buildConfig());
    const id = await client.textTo3d.create({ mode: "preview", prompt: "a chair" });
    assert.equal(id, "task-123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.com/v2/text-to-3d");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0]!.body!), { mode: "preview", prompt: "a chair" });
  } finally {
    restore();
  }
});

test("MeshyClient.imageTo3d.create — POSTs to v1 with JSON body", async () => {
  const { calls, restore } = installFetch(() => jsonResponse({ result: "task-456" }));
  try {
    const client = new MeshyClient(buildConfig());
    await client.imageTo3d.create({ image_url: "https://example.com/cat.png" });
    assert.equal(calls[0]!.url, "https://api.example.com/v1/image-to-3d");
  } finally {
    restore();
  }
});

test("MeshyClient — retrieve percent-encodes task ids with unusual characters", async () => {
  const { calls, restore } = installFetch(() =>
    jsonResponse({ id: "abc/slash", status: "SUCCEEDED", type: "image-to-3d", progress: 100 }),
  );
  try {
    const client = new MeshyClient(buildConfig());
    await client.imageTo3d.retrieve("abc/slash");
    assert.equal(calls[0]!.url, "https://api.example.com/v1/image-to-3d/abc%2Fslash");
  } finally {
    restore();
  }
});

test("MeshyClient — list sends page_num/page_size/sort_by", async () => {
  const { calls, restore } = installFetch(() => jsonResponse([]));
  try {
    const client = new MeshyClient(buildConfig());
    await client.imageTo3d.list({ page_num: 2, page_size: 50, sort_by: "created_at" });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("page_num"), "2");
    assert.equal(url.searchParams.get("page_size"), "50");
    assert.equal(url.searchParams.get("sort_by"), "created_at");
  } finally {
    restore();
  }
});

test("MeshyClient — delete issues DELETE and swallows empty success bodies", async () => {
  const { calls, restore } = installFetch(
    () => new Response(null, { status: 200 }),
  );
  try {
    const client = new MeshyClient(buildConfig());
    await client.imageTo3d.delete("task-xyz");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, "https://api.example.com/v1/image-to-3d/task-xyz");
  } finally {
    restore();
  }
});

test("MeshyClient — wraps non-2xx responses in MeshyApiError with path", async () => {
  const { restore } = installFetch(() =>
    jsonResponse({ message: "Invalid prompt" }, 422),
  );
  try {
    const client = new MeshyClient(buildConfig());
    await assert.rejects(
      () => client.textTo3d.create({ mode: "preview", prompt: "" }),
      (err: unknown) => {
        assert.ok(err instanceof MeshyApiError);
        assert.equal((err as MeshyApiError).status, 422);
        assert.equal((err as MeshyApiError).code, "validation");
        assert.equal((err as MeshyApiError).path, "/text-to-3d");
        assert.match((err as MeshyApiError).message, /Invalid prompt/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("MeshyClient — raw passthrough routes v1 vs v2 correctly", async () => {
  const { calls, restore } = installFetch(() => jsonResponse({}));
  try {
    const client = new MeshyClient(buildConfig());
    await client.raw("v1", "GET", "/balance");
    await client.raw("v2", "GET", "/text-to-3d/task-x");
    assert.equal(calls[0]!.url, "https://api.example.com/v1/balance");
    assert.equal(calls[1]!.url, "https://api.example.com/v2/text-to-3d/task-x");
  } finally {
    restore();
  }
});
