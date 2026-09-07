/**
 * UV Unwrap (T-021), Creative Lab routing/validation (T-022..T-025), payload
 * merge semantics (T-028) and make async/stop-after-first (T-041, T-042).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

function glbBytes(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write("glTF", 0, "ascii");
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(12, 8);
  return buf;
}

test("T-021 uv-unwrap: one source accepted, both/none/non-GLB refused before any request; exact v1 route", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST" && req.path === "/openapi/v1/uv-unwrap") return jsonReply(res, 200, { result: "uv-1" });
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const dir = tmpDir();
    const glb = join(dir, "m.glb");
    writeFileSync(glb, glbBytes());
    const obj = join(dir, "m.obj");
    writeFileSync(obj, "v 0 0 0\n");

    const byTask = await runCli(["uv-unwrap", "create", "--input-task-id", "src-1", "--async"], { env: api.env(), cwd: dir });
    assert.equal(byTask.code, 0, byTask.stderr);
    assert.deepEqual(api.requests.at(-1)!.json, { input_task_id: "src-1" });
    const out = parseSingleJson(byTask.stdout) as { command: string; result: { submission: { task_id: string } } };
    assert.equal(out.command, "uv-unwrap.create");
    assert.equal(out.result.submission.task_id, "uv-1");

    const byFile = await runCli(["uv-unwrap", "create", "--model-url", glb, "--async"], { env: api.env(), cwd: dir });
    assert.equal(byFile.code, 0, byFile.stderr);
    assert.match(String((api.requests.at(-1)!.json as { model_url: string }).model_url), /^data:model\/gltf-binary;base64,/);

    const before = api.requests.length;
    const both = await runCli(["uv-unwrap", "create", "--input-task-id", "src-1", "--model-url", glb, "--async"], { env: api.env(), cwd: dir });
    assert.equal(both.code, 2, both.stderr);
    const bothData = await runCli(["uv-unwrap", "create", "--input-task-id", "src-1", "--data", '{"model_url":"https://x.example/m.glb"}', "--async"], { env: api.env(), cwd: dir });
    assert.equal(bothData.code, 2, bothData.stderr);
    const none = await runCli(["uv-unwrap", "create", "--async"], { env: api.env(), cwd: dir });
    assert.equal(none.code, 2);
    const notGlb = await runCli(["uv-unwrap", "create", "--model-url", obj, "--async"], { env: api.env(), cwd: dir });
    assert.equal(notGlb.code, 2, notGlb.stderr);
    assert.match((parseSingleJson(notGlb.stdout) as { error: { message: string } }).error.message, /glb only/);
    assert.equal(api.requests.length, before, "invalid combinations never reach the API");

    // 404 is reported as not_found without guessing why.
    const gated = await startMockApi((_req, res) => jsonReply(res, 404, { message: "Not Found" }));
    try {
      const r = await runCli(["uv-unwrap", "create", "--input-task-id", "src-1", "--async"], { env: gated.env() });
      assert.equal(r.code, 5, r.stderr);
      const e = parseSingleJson(r.stdout) as { error: { code: string; message: string } };
      assert.equal(e.error.code, "not_found");
      assert.ok(!/rollout|unauthori|not enabled/i.test(e.error.message));
    } finally {
      await gated.close();
    }
    // list/get/stream/delete routes exist.
    const list = await runCli(["uv-unwrap", "list"], { env: api.env() });
    assert.equal(api.requests.at(-1)!.path, "/openapi/v1/uv-unwrap");
    assert.equal(list.code, 5); // mock answers 404 for GET list; the route is what matters here
  } finally {
    await api.close();
  }
});

test("T-022/T-025 Creative Lab: exact product/v1/stage paths and per-product payloads", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST" && /^\/openapi\/creative-lab\/(figure|lamp|keychain|fridge-magnet)\/v1\/(prototype|build)$/.test(req.path)) return jsonReply(res, 200, { result: "cl-1" });
    if (req.method === "GET" && /\/v1\/(prototype|build)\/cl-1$/.test(req.path)) return jsonReply(res, 200, { id: "cl-1", status: "SUCCEEDED", progress: 100, type: "creative-lab-x" });
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const dir = tmpDir();
    const png = join(dir, "p.png");
    writeFileSync(png, await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());

    for (const product of ["figure", "lamp", "keychain", "fridge-magnet"]) {
      const r = await runCli(["creative-lab", product, "prototype", "create", "--image-url", png, "--name", "demo", "--async"], { env: api.env(), cwd: dir });
      assert.equal(r.code, 0, `${product}: ${r.stderr}`);
      const req = api.requests.at(-1)!;
      assert.equal(req.path, `/openapi/creative-lab/${product}/v1/prototype`);
      const body = req.json as Record<string, unknown>;
      assert.match(String(body.image_url), /^data:image\/png;base64,/);
      assert.equal(body.name, "demo");
      assert.equal("remove_background" in body, false, "not sent unless asked");
      const out = parseSingleJson(r.stdout) as { command: string };
      assert.equal(out.command, `creative-lab.${product}.prototype.create`);

      const g = await runCli(["creative-lab", product, "build", "get", "cl-1"], { env: api.env() });
      assert.equal(g.code, 0, g.stderr);
      assert.equal(api.requests.at(-1)!.path, `/openapi/creative-lab/${product}/v1/build/cl-1`);
    }

    // lamp prototype: image_subject; deprecated text refused; remove-background flag sent as true.
    const lamp = await runCli(["creative-lab", "lamp", "prototype", "create", "--image-url", png, "--image-subject", "landscape", "--remove-background", "--async"], { env: api.env(), cwd: dir });
    assert.equal(lamp.code, 0, lamp.stderr);
    assert.equal((api.requests.at(-1)!.json as Record<string, unknown>).image_subject, "landscape");
    assert.equal((api.requests.at(-1)!.json as Record<string, unknown>).remove_background, true);
    const n = api.requests.length;
    const lampText = await runCli(["creative-lab", "lamp", "prototype", "create", "--data", '{"text":"a lamp"}', "--async"], { env: api.env(), cwd: dir });
    assert.equal(lampText.code, 2, lampText.stderr);
    assert.equal(api.requests.length, n);

    // lamp build: options + output.format; include_result_json needs zip.
    const lampBuild = await runCli(["creative-lab", "lamp", "build", "create", "--input-task-id", "cl-1", "--model-format", "zip", "--include-result-json", "--options", '{"diameter_mm":180,"light_source_preset":"none"}', "--async"], { env: api.env() });
    assert.equal(lampBuild.code, 0, lampBuild.stderr);
    assert.deepEqual(api.requests.at(-1)!.json, { input_task_id: "cl-1", options: { diameter_mm: 180, light_source_preset: "none", include_result_json: true }, output: { format: "zip" } });
    const lampBad = await runCli(["creative-lab", "lamp", "build", "create", "--input-task-id", "cl-1", "--include-result-json", "--async"], { env: api.env() });
    assert.equal(lampBad.code, 2, lampBad.stderr);
    const lampRange = await runCli(["creative-lab", "lamp", "build", "create", "--input-task-id", "cl-1", "--options", '{"diameter_mm":10}', "--async"], { env: api.env() });
    assert.equal(lampRange.code, 2, lampRange.stderr);
    assert.match((parseSingleJson(lampRange.stdout) as { error: { message: string } }).error.message, /diameter_mm/);

    // keychain build: relief options with explicit false preserved; obj format allowed; figure has no options.
    const kc = await runCli(["creative-lab", "keychain", "build", "create", "--input-task-id", "cl-1", "--model-format", "obj", "--data", '{"options":{"has_closed_back":false,"remove_background":false,"badge_shape":"star"}}', "--async"], { env: api.env() });
    assert.equal(kc.code, 0, kc.stderr);
    assert.deepEqual(api.requests.at(-1)!.json, { input_task_id: "cl-1", options: { has_closed_back: false, remove_background: false, badge_shape: "star" }, output: { format: "obj" } });
    const kcBad = await runCli(["creative-lab", "keychain", "build", "create", "--input-task-id", "cl-1", "--data", '{"options":{"badge_shape":"triangle"}}', "--async"], { env: api.env() });
    assert.equal(kcBad.code, 2, kcBad.stderr);
    const fig = await runCli(["creative-lab", "figure", "build", "create", "--input-task-id", "cl-1", "--data", '{"options":{"x":1}}', "--async"], { env: api.env() });
    assert.equal(fig.code, 2, fig.stderr);
    const figFmt = await runCli(["creative-lab", "figure", "build", "create", "--input-task-id", "cl-1", "--model-format", "glb", "--async"], { env: api.env() });
    assert.equal(figFmt.code, 2, "figure build has no --model-format");
    const noStage = await runCli(["creative-lab", "figure", "get", "cl-1"], { env: api.env() });
    assert.equal(noStage.code, 2, "there is no stage-less get");
    const longName = await runCli(["creative-lab", "figure", "prototype", "create", "--image-url", png, "--name", "x".repeat(101), "--async"], { env: api.env(), cwd: dir });
    assert.equal(longName.code, 2);
  } finally {
    await api.close();
  }
});

test("T-023 Creative Lab: injected product/stage tokens never build a path", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { result: "x" }));
  try {
    for (const args of [
      ["creative-lab", "../figure", "prototype", "create", "--image-url", "https://x.example/a.png", "--async"],
      ["creative-lab", "figure", "../build", "create", "--input-task-id", "a", "--async"],
      ["creative-lab", "keycap", "prototype", "create", "--image-url", "https://x.example/a.png", "--async"],
      ["creative-lab", "figure prototype", "create"],
    ]) {
      const r = await runCli(args, { env: api.env() });
      assert.equal(r.code, 2, args.join(" "));
    }
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("T-024 Creative Lab build: server rejections are preserved, no retry and no prototype re-creation", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST" && req.path === "/openapi/creative-lab/figure/v1/build") return jsonReply(res, 404, { message: "prototype task not found" });
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    const r = await runCli(["creative-lab", "figure", "build", "create", "--input-task-id", "webapp-proto", "--async"], { env: api.env() });
    assert.equal(r.code, 5, r.stderr);
    const out = parseSingleJson(r.stdout) as { error: { code: string; message: string } };
    assert.equal(out.error.code, "not_found");
    assert.match(out.error.message, /prototype task not found/);
    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), ["POST /openapi/creative-lab/figure/v1/build"]);
  } finally {
    await api.close();
  }
});

test("T-028 --data merge: flags beat JSON, JSON beats defaults, explicit false/0 survive, arrays replace, non-object refused", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "t" }) : jsonReply(res, 404, {})));
  try {
    const r = await runCli(
      ["text-to-3d", "create", "--mode", "refine", "--preview-task-id", "p1", "--texture-resolution", "2k", "--data", '{"enable_pbr":false,"texture_resolution":"8k","target_formats":["obj","fbx"],"seed":0}', "--async"],
      { env: api.env() },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.requests[0]!.json, {
      mode: "refine",
      preview_task_id: "p1",
      enable_pbr: false, // --data switches a default off
      texture_resolution: "2k", // typed flag wins over --data
      remove_lighting: true, // untouched default
      target_formats: ["obj", "fbx"], // array replaced wholesale
      seed: 0, // explicit 0 kept
    });
    const arr = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--data", "[1]", "--async"], { env: api.env() });
    assert.equal(arr.code, 2);
    const bad = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--data", "{oops", "--async"], { env: api.env() });
    assert.equal(bad.code, 2);
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});

test("T-041/T-042 make: --async is one POST and zero polls with pending_steps; --stop-after-first polls step 1 only; both flags refused", async () => {
  let gets = 0;
  const api = await startMockApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "prev-1" });
    gets += 1;
    return jsonReply(res, 200, { id: "prev-1", status: "SUCCEEDED", progress: 100, type: "text-to-3d-preview" });
  });
  try {
    const a = await runCli(["make", "a red sports car", "--async", "--output-schema", "v1"], { env: api.env() });
    assert.equal(a.code, 0, a.stderr);
    const out = parseSingleJson(a.stdout) as { result: { submitted: { task_id: string }; pending_steps: Array<{ step: number; action: string; command: string | null }>; task: unknown } };
    assert.equal(out.result.submitted.task_id, "prev-1");
    assert.equal(out.result.task, null);
    assert.equal(out.result.pending_steps.length, 1);
    assert.equal(out.result.pending_steps[0]!.action, "refine");
    assert.deepEqual(api.requests.map((q) => q.method), ["POST"]);
    assert.equal(gets, 0);

    api.requests.length = 0;
    const legacyAsync = await runCli(["make", "a red sports car", "--async"], { env: api.env() });
    assert.equal(legacyAsync.code, 0, legacyAsync.stderr);
    const lp = parseSingleJson(legacyAsync.stdout) as Record<string, unknown>;
    assert.equal(lp["task_id"], "prev-1");
    assert.equal(lp["submitted"], "preview");
    assert.deepEqual(api.requests.map((q) => q.method), ["POST"]);

    api.requests.length = 0;
    const stop = await runCli(["make", "a red sports car", "--stop-after-first", "--output-schema", "v1"], { env: api.env() });
    assert.equal(stop.code, 0, stop.stderr);
    const so = parseSingleJson(stop.stdout) as { result: { stopped_after: { action: string; status: string }; resume: string } };
    assert.equal(so.result.stopped_after.action, "preview");
    assert.equal(so.result.stopped_after.status, "SUCCEEDED");
    assert.match(so.result.resume, /--preview-task-id prev-1/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, "refine was not started");
    assert.ok(api.requests.some((q) => q.method === "GET"));

    const both = await runCli(["make", "a red sports car", "--async", "--stop-after-first"], { env: api.env() });
    assert.equal(both.code, 2);

    // Image route with a URL: async is one POST, no preflight of the mock is needed for data URIs.
    api.requests.length = 0;
    const dir = tmpDir();
    const png = join(dir, "cat.png");
    writeFileSync(png, await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());
    const img = await runCli(["make", png, "--async", "--output-schema", "v1"], { env: api.env(), cwd: dir });
    assert.equal(img.code, 0, img.stderr);
    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), ["POST /openapi/v1/image-to-3d"]);
    assert.equal((parseSingleJson(img.stdout) as { result: { pending_steps: unknown[] } }).result.pending_steps.length, 0);
  } finally {
    await api.close();
  }
});

test("T-105 a stored profile is never sent to a Creative Lab base on another origin; an explicit key may be", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "cl-x" }) : jsonReply(res, 404, {})));
  const other = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "cl-y" }) : jsonReply(res, 404, {})));
  try {
    const dir = tmpDir();
    const credFile = join(dir, "credentials.json");
    writeFileSync(credFile, JSON.stringify({ auth_version: 1, active_profile: "default", profiles: { default: { kind: "api_key", api_key: "msy_stored_profile_key", created_at: 1 } } }));
    const env = api.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: credFile, MESHY_BASE_URL_CREATIVE_LAB: `${other.url}/openapi/creative-lab` });
    const refused = await runCli(["creative-lab", "figure", "build", "create", "--input-task-id", "p1", "--async"], { env, cwd: dir });
    assert.equal(refused.code, 3, refused.stderr);
    const out = parseSingleJson(refused.stdout) as { error: { code: string; message: string } };
    assert.equal(out.error.code, "auth");
    assert.match(out.error.message, /different origin/);
    assert.equal(other.requests.length, 0, "the stored profile never left for the other origin");
    assert.equal(api.requests.length, 0);
    // Same-origin derived base with the stored profile works.
    const same = await runCli(["creative-lab", "figure", "build", "create", "--input-task-id", "p1", "--async"], { env: api.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: credFile }), cwd: dir });
    assert.equal(same.code, 0, same.stderr);
    assert.equal(api.requests[0]!.headers["authorization"], "Bearer msy_stored_profile_key");
    // An explicit key is the user's choice and may go to the explicit origin.
    const explicit = await runCli(["creative-lab", "figure", "build", "create", "--input-task-id", "p1", "--async", "--api-key", "msy_explicit"], { env, cwd: dir });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(other.requests.length, 1);
    assert.equal(other.requests[0]!.headers["authorization"], "Bearer msy_explicit");
    assert.equal(other.requests[0]!.path, "/openapi/creative-lab/figure/v1/build");
  } finally {
    await api.close();
    await other.close();
  }
});
