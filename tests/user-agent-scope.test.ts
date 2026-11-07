/**
 * The agent segment goes only to Meshy (D-092): requests to the API carry it;
 * the input URL preflight and asset downloads, which reach any host and follow
 * its redirects, carry the string without it.
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

const { ASSET_USER_AGENT, USER_AGENT } = await import("../src/internal/user-agent.js");
const { MeshyClient } = await import("../src/client/index.js");
const { fetchToTemp } = await import("../src/internal/download.js");
const { normalizeMediaPayload } = await import("../src/internal/file-input.js");

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

test("the API User-Agent names the agent; the asset one is the same string without it", () => {
  assert.match(USER_AGENT, /; agent test-agent\)/);
  assert.ok(!ASSET_USER_AGENT.includes("agent"));
  assert.equal(ASSET_USER_AGENT, USER_AGENT.replace("; agent test-agent", ""));
});

test("a request to the API carries the agent", async () => {
  const { fetchImpl, agents } = recordingFetch(
    () => new Response(JSON.stringify({ balance: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await new MeshyClient({
      apiKey: "msy_test_key",
      baseUrlV1: "https://api.example.com/v1",
      baseUrlV2: "https://api.example.com/v2",
      baseUrlCreativeLab: "https://api.example.com/openapi/creative-lab",
      publicWebBase: "https://api.example.com/web/public",
      connectTimeoutMs: 1000,
      readTimeoutMs: 5000,
      pollIntervalMs: 10,
      logLevel: "silent",
      credentialSource: "flag",
      credentialsFile: "/nonexistent/credentials.json",
      credentialKind: "api_key",
    }).balance.get();
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(agents, [USER_AGENT]);
});

test("the preflight of an input image URL does not carry the agent", async () => {
  const { fetchImpl, agents } = recordingFetch(() => new Response(null, { status: 200 }));
  await normalizeMediaPayload(
    { image_url: "https://images.example.com/ref.png" },
    [{ path: "image_url", kind: "image", many: false }],
    { fetchImpl },
  );
  assert.deepEqual(agents, [ASSET_USER_AGENT]);
});

test("an asset download does not carry the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-ua-scope-"));
  try {
    const { fetchImpl, agents } = recordingFetch(() => new Response("glTF", { status: 200 }));
    await fetchToTemp("https://assets.example.com/model.glb", join(dir, "model.glb"), { fetchImpl });
    assert.deepEqual(agents, [ASSET_USER_AGENT]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
