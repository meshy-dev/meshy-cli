/**
 * The agent segment goes only to Meshy (D-092): the API transport carries it
 * when its base origin is Meshy's; sign-in, the
 * input URL preflight and asset downloads follow redirects to any host and
 * carry the string without it, as they did before.
 *
 * The User-Agent is computed once when its module loads, so the agent is set
 * here first and every module that sends a request is imported after it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["MESHY_CLI_AGENT"] = "test-agent";

const { USER_AGENT, apiUserAgent, userAgent } = await import("../src/internal/user-agent.js");
const { MeshyClient } = await import("../src/client/index.js");
const { fetchToTemp } = await import("../src/internal/download.js");
const { normalizeMediaPayload } = await import("../src/internal/file-input.js");
const { exchangeCode } = await import("../src/internal/oauth.js");

const WITH_AGENT = userAgent(process.env);

type FetchInput = Parameters<typeof fetch>[0];

/** A fetch that records the User-Agent of every request and answers with `reply`. */
function recordingFetch(reply: () => Response): { fetchImpl: typeof fetch; agents: string[] } {
  const agents: string[] = [];
  const fetchImpl = (async (_input: FetchInput, init: RequestInit = {}) => {
    agents.push(new Headers(init.headers ?? {}).get("user-agent") ?? "");
    return reply();
  }) as typeof fetch;
  return { fetchImpl, agents };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function withGlobalFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function client(origin: string): InstanceType<typeof MeshyClient> {
  return new MeshyClient({
    apiKey: "msy_test_key",
    baseUrlV1: `${origin}/openapi/v1`,
    baseUrlV2: `${origin}/openapi/v2`,
    baseUrlCreativeLab: `${origin}/openapi/creative-lab`,
    publicWebBase: `${origin}/web/public`,
    connectTimeoutMs: 1000,
    readTimeoutMs: 5000,
    pollIntervalMs: 10,
    logLevel: "silent",
    credentialSource: "flag",
    credentialsFile: "/nonexistent/credentials.json",
    credentialKind: "api_key",
  });
}

test("USER_AGENT is the string without the agent segment", () => {
  assert.match(WITH_AGENT, /; agent test-agent\)/);
  assert.ok(!USER_AGENT.includes("agent"));
  assert.equal(USER_AGENT, WITH_AGENT.replace("; agent test-agent", ""));
});

test("apiUserAgent names the agent only for a Meshy origin, not even one on this machine", () => {
  for (const base of [
    "https://api.meshy.ai/openapi/v1",
    "https://api.staging.meshy.ai/openapi/v2",
    "https://api.meshy.cn/openapi/v1",
    "https://API.Meshy.AI./openapi/v1",
  ]) {
    assert.equal(apiUserAgent(base), WITH_AGENT, base);
  }
  for (const base of [
    "https://api.example.com/openapi/v1",
    "https://meshy.ai.example.com/openapi/v1",
    "https://notmeshy.ai/openapi/v1",
    "https://meshy.ai-proxy.example/openapi/v1",
    "http://10.0.0.5/openapi/v1",
    "http://localhost:8080/openapi/v1",
    "http://127.0.0.1:9/openapi/v1",
    "http://[::1]:9/openapi/v1",
    "not a url",
  ]) {
    assert.equal(apiUserAgent(base), USER_AGENT, base);
  }
});

test("an API request carries the agent to Meshy and not to another API origin", async () => {
  const meshy = recordingFetch(() => json({ balance: 1 }));
  await withGlobalFetch(meshy.fetchImpl, () => client("https://api.meshy.ai").balance.get());
  assert.deepEqual(meshy.agents, [WITH_AGENT]);

  const other = recordingFetch(() => json({ balance: 1 }));
  await withGlobalFetch(other.fetchImpl, () => client("https://api.example.com").balance.get());
  assert.deepEqual(other.agents, [USER_AGENT]);
});

test("a sign-in request does not carry the agent, even to Meshy", async () => {
  const { fetchImpl, agents } = recordingFetch(() =>
    json({ access_token: "tok", token_type: "Bearer", expires_in: 3600, refresh_token: "ref" }),
  );
  await withGlobalFetch(fetchImpl, () =>
    exchangeCode({
      baseUrlV1: "https://api.meshy.ai/openapi/v1",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost:8765/callback",
    }),
  );
  assert.deepEqual(agents, [USER_AGENT]);
});

test("the preflight of an input image URL does not carry the agent", async () => {
  const { fetchImpl, agents } = recordingFetch(() => new Response(null, { status: 200 }));
  await normalizeMediaPayload(
    { image_url: "https://images.example.com/ref.png" },
    [{ path: "image_url", kind: "image", many: false }],
    { fetchImpl },
  );
  assert.deepEqual(agents, [USER_AGENT]);
});

test("an asset download does not carry the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-ua-scope-"));
  try {
    const { fetchImpl, agents } = recordingFetch(() => new Response("glTF", { status: 200 }));
    await fetchToTemp("https://assets.meshy.ai/model.glb", join(dir, "model.glb"), { fetchImpl });
    assert.deepEqual(agents, [USER_AGENT]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
