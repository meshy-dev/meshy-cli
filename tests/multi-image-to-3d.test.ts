/**
 * multi-image-to-3d's geometry pass, asserted on the wire: a loopback API
 * records the create POST, so the test checks what the server receives.
 *
 * Unless Ultra is on (geometry_resolution "2k", or the legacy ultra_mode
 * boolean when the enum is absent), the endpoint runs a two-stage multi-view
 * model even for "latest" or "meshy-7.1"; with Ultra on, ai_model picks the
 * Ultra model. "4k" is refused server-side for this endpoint (single-image
 * only). The CLI exposes the enum; ai_model and ultra_mode ride --data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonReply, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

// 1x1 white PNG, written as local view files: the create path inlines them.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
  "base64",
);
const VIEWS = ["front.png", "side.png", "back.png"];

async function withApi(fn: (api: MockApi) => Promise<void>): Promise<void> {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST" && req.path === "/openapi/v1/multi-image-to-3d") return jsonReply(res, 200, { result: "task-new" });
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

function create(api: MockApi, ...extra: string[]) {
  const cwd = tmpDir("meshy-views-");
  for (const view of VIEWS) writeFileSync(join(cwd, view), PNG);
  return runCli(["multi-image-to-3d", "create", "--image-urls", VIEWS.join(","), "--async", "--output-schema", "v1", ...extra], {
    env: api.env(),
    cwd,
  });
}

test("multi-image-to-3d --geometry-resolution 2k reaches the server as geometry_resolution", async () => {
  await withApi(async (api) => {
    const r = await create(api, "--geometry-resolution", "2k");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(api.requests.length, 1);
    const body = api.requests[0]!.json as Record<string, unknown>;
    assert.equal(body["geometry_resolution"], "2k");
    const urls = body["image_urls"] as string[];
    assert.equal(urls.length, 3);
    for (const url of urls) assert.match(url, /^data:image\/png;base64,/);
    assert.equal(body["should_texture"], false);
    assert.ok(!("ultra_mode" in body), "geometry_resolution is the only Ultra knob sent");
  });
});

test("multi-image-to-3d sends no geometry_resolution unless asked: Ultra bills extra", async () => {
  await withApi(async (api) => {
    const r = await create(api);
    assert.equal(r.code, 0, r.stderr);
    const body = api.requests[0]!.json as Record<string, unknown>;
    assert.ok(!("geometry_resolution" in body), "the server's standard pass is the default");
  });
});

test("multi-image-to-3d refuses --geometry-resolution 4k before the wire", async () => {
  await withApi(async (api) => {
    const r = await create(api, "--geometry-resolution", "4k");
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr + r.stdout, /standard.*2k/);
    assert.equal(api.requests.length, 0, "no POST for a value the server refuses");
  });
});

test("multi-image-to-3d leaves the Ultra model and the legacy ultra_mode to --data, untouched", async () => {
  await withApi(async (api) => {
    // Pinning the Ultra model: ai_model rides --data next to the flag.
    const pinned = await create(api, "--geometry-resolution", "2k", "--data", '{"ai_model":"meshy-7.1"}');
    assert.equal(pinned.code, 0, pinned.stderr);
    const pinnedBody = api.requests[0]!.json as Record<string, unknown>;
    assert.equal(pinnedBody["ai_model"], "meshy-7.1");
    assert.equal(pinnedBody["geometry_resolution"], "2k");

    // A legacy ultra_mode is passed through as sent: the CLI never adds a
    // geometry_resolution that would override it.
    const legacy = await create(api, "--data", '{"ultra_mode":true}');
    assert.equal(legacy.code, 0, legacy.stderr);
    const legacyBody = api.requests[1]!.json as Record<string, unknown>;
    assert.equal(legacyBody["ultra_mode"], true);
    assert.ok(!("geometry_resolution" in legacyBody));
  });
});

test("multi-image-to-3d sends 2k together with a textured run", async () => {
  await withApi(async (api) => {
    const r = await create(api, "--should-texture", "true", "--geometry-resolution", "2k");
    assert.equal(r.code, 0, r.stderr);
    const body = api.requests[0]!.json as Record<string, unknown>;
    assert.equal(body["should_texture"], true);
    assert.equal(body["geometry_resolution"], "2k");
    assert.equal(body["texture_resolution"], "4k", "texturing defaults still apply");
  });
});

test("multi-image-to-3d keeps --data geometry_resolution, and the flag wins over it", async () => {
  await withApi(async (api) => {
    const viaData = await create(api, "--data", '{"geometry_resolution":"2k"}');
    assert.equal(viaData.code, 0, viaData.stderr);
    assert.equal((api.requests[0]!.json as Record<string, unknown>)["geometry_resolution"], "2k");

    const flagWins = await create(api, "--data", '{"geometry_resolution":"2k"}', "--geometry-resolution", "standard");
    assert.equal(flagWins.code, 0, flagWins.stderr);
    assert.equal((api.requests[1]!.json as Record<string, unknown>)["geometry_resolution"], "standard");
  });
});
