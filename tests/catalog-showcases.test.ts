/**
 * animation-catalog (T-026) and showcases (T-027) as black-box subprocesses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { jsonReply, parseSingleJson, runCli, startMockApi } from "./helpers/cli.js";

const CATALOG = {
  result: {
    total: 3,
    list: [
      { id: 290, key: "wave_one_hand", name: "Wave One Hand", category: "DailyActions", subCategory: "Interacting", previewUrl: "https://cdn.example.invalid/wave.gif", rigType: "biped", isDefault: false, isFree: true },
      { id: -1, key: "idle", name: "Idle", category: "DailyActions", subCategory: "Idle", previewUrl: "https://cdn.example.invalid/idle.gif", rigType: "biped", isDefault: true, isFree: true },
      { id: 12, key: "run", name: "Running", category: "WalkAndRun", subCategory: "Run", previewUrl: "https://cdn.example.invalid/run.gif", rigType: "biped", isDefault: false, isFree: false },
    ],
  },
};

test("T-026 catalog: public path, no Authorization/Cookie, no credential required, local search", async () => {
  const api = await startMockApi((req, res) => {
    if (req.path === "/web/public/animations/resources") {
      const q = new URL(req.url, "http://x").searchParams;
      const list = q.get("category") ? CATALOG.result.list.filter((e) => e.category === q.get("category")) : CATALOG.result.list;
      return jsonReply(res, 200, { result: { total: list.length, list } });
    }
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    // No MESHY_API_KEY, no profile: the command must still work.
    const env = api.env({ MESHY_API_KEY: undefined });
    const r = await runCli(["animation-catalog", "list", "--category", "DailyActions", "--search", "WAVE"], { env });
    assert.equal(r.code, 0, r.stderr);
    const out = parseSingleJson(r.stdout) as { command: string; result: { items: Array<{ action_id: number; name: string }>; search_scope: string; fetched: number; total: number; authenticated: boolean } };
    assert.equal(out.command, "animation-catalog.list");
    assert.deepEqual(out.result.items.map((i) => i.action_id), [290]);
    assert.equal(out.result.search_scope, "local");
    assert.equal(out.result.fetched, 2);
    assert.equal(out.result.authenticated, false);
    assert.equal(api.requests.length, 1);
    const req = api.requests[0]!;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/web/public/animations/resources?category=DailyActions");
    assert.equal(req.headers["authorization"], undefined);
    assert.equal(req.headers["cookie"], undefined);

    // Negative ids and an empty result are fine; nothing is fabricated.
    const empty = await runCli(["animation-catalog", "list", "--search", "does-not-exist"], { env });
    assert.equal(empty.code, 0);
    assert.deepEqual((parseSingleJson(empty.stdout) as { result: { items: unknown[] } }).result.items, []);
    const all = parseSingleJson((await runCli(["animation-catalog", "list"], { env })).stdout) as { result: { items: Array<{ action_id: number }> } };
    assert.ok(all.result.items.some((i) => i.action_id === -1));

    // Legacy schema is not available for a v1-only command.
    const legacy = await runCli(["animation-catalog", "list", "--output-schema", "legacy"], { env });
    assert.equal(legacy.code, 2);
  } finally {
    await api.close();
  }
});

test("T-027 showcases: exactly one billable GET with the given params; items pass through; alias warns", async () => {
  const items = [{ id: "s1", result_id: "t1", name: "Car", author: "a", community_url: "https://www.meshy.ai/x", model_url: "https://assets.example.invalid/m.glb", conversion_status: "", mode: "refine", extra: { kept: true } }];
  const api = await startMockApi((req, res) => {
    if (req.path === "/openapi/v1/showcases") return jsonReply(res, 200, { result: items });
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const r = await runCli(["showcases", "list", "--search", "car", "--page-size", "3", "--model-format", "glb", "--showcase-type", "animated", "--sort-by", "-downloads"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    const out = parseSingleJson(r.stdout) as { result: { items: unknown[]; requests_made: number; billing: string }; warnings: Array<{ code: string }> };
    assert.deepEqual(out.result.items, items);
    assert.equal(out.result.requests_made, 1);
    assert.equal(out.result.billing, "may-charge");
    assert.equal(out.warnings[0]?.code, "showcase_type_alias");
    assert.equal(api.requests.length, 1);
    const q = new URL(api.requests[0]!.url, "http://x").searchParams;
    assert.equal(q.get("search"), "car");
    assert.equal(q.get("page_size"), "3");
    assert.equal(q.get("format"), "glb");
    assert.equal(q.get("showcase_type"), "animate");
    assert.equal(q.get("sort_by"), "-downloads");
    assert.equal(api.requests[0]!.headers["authorization"], "Bearer msy_fixture_key_loopback_only");
  } finally {
    await api.close();
  }
});

test("T-027 showcases: non-Enterprise 403 and a network error are single attempts, never retried", async () => {
  let hits = 0;
  const api = await startMockApi((_req, res) => {
    hits += 1;
    jsonReply(res, 403, { message: "This endpoint is only available for enterprise users" });
  });
  try {
    const r = await runCli(["showcases", "list"], { env: api.env() });
    assert.equal(r.code, 1, r.stderr);
    const out = parseSingleJson(r.stdout) as { ok: boolean; error: { http_status: number; message: string } };
    assert.equal(out.ok, false);
    assert.equal(out.error.http_status, 403);
    assert.match(out.error.message, /enterprise/i);
    assert.equal(hits, 1);
    const bad = await runCli(["showcases", "list", "--page-size", "11"], { env: api.env() });
    assert.equal(bad.code, 2);
    assert.equal(hits, 1, "usage errors make no request");
  } finally {
    await api.close();
  }
  const dead = await startMockApi(() => undefined);
  await dead.close();
  const r = await runCli(["showcases", "list"], { env: dead.env() });
  assert.equal(r.code, 7, r.stderr);
});
