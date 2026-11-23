/**
 * Relief: photo → bas-relief model + 16-bit depth map on /openapi/v1/relief.
 * Registry entry, flag → payload mapping and local validation (nothing sent
 * when a rule is broken), the task verbs' routes, and what `-o` and
 * `meshy download` save for a relief task — models (OBJ with its MTL), the
 * color texture, the depth map, and the depth map alone for a depth-only task.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { requireTaskResource, resourceIndex } from "../src/client/resource-registry.js";
import { enumerateAssets, selectDefaultAssets } from "../src/internal/artifacts.js";
import { UsageError } from "../src/internal/errors.js";
import { okEnvelope } from "../src/internal/result.js";
import { toTaskView } from "../src/internal/task-view.js";
import { renderView } from "../src/internal/views.js";
import { plain } from "../src/internal/color.js";
import { reliefWarnings, validateReliefPayload } from "../src/cmd/relief.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

const IMAGE = "https://photos.example.com/cat.png";

function glb(payload = "relief"): Buffer {
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + payload.length, 8);
  return Buffer.concat([head, Buffer.from(payload)]);
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

/** A 16-bit grayscale PNG, the depth map's real shape. */
async function depthPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 128, g: 128, b: 128 } } }).toColourspace("grey16").png().toBuffer();
}

/** The colored relief task of the API reference, with OBJ + MTL and 3MF added, its URLs on `host`. */
function coloredTask(host: string): Record<string, unknown> {
  const out = (name: string) => `${host}/assets/relief-1/output/${name}?Expires=1&Signature=secret`;
  return {
    id: "relief-1",
    type: "relief",
    model_urls: { glb: out("model.glb"), stl: out("model.stl"), obj: out("model.obj"), mtl: out("model.mtl"), "3mf": out("model.3mf") },
    texture_urls: [{ base_color: out("texture_0.png") }],
    depth_map_url: out("depth.png"),
    thumbnail_url: out("preview.png"),
    progress: 100,
    status: "SUCCEEDED",
    created_at: 1_699_999_999_000,
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_060_000,
    expires_at: 1_700_259_260_000,
    task_error: null,
    consumed_credits: 20,
  };
}

/** A depth-map-only task: no models, an empty thumbnail. */
function depthOnlyTask(host: string): Record<string, unknown> {
  return {
    id: "depth-1",
    type: "relief",
    model_urls: {},
    depth_map_url: `${host}/assets/depth-1/output/depth.png?Expires=1&Signature=secret`,
    thumbnail_url: "",
    progress: 100,
    status: "SUCCEEDED",
    created_at: 1_699_999_999_000,
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_030_000,
    expires_at: 1_700_259_230_000,
    task_error: null,
    consumed_credits: 20,
  };
}

interface Bodies {
  glb: Buffer;
  png: Buffer;
  depth: Buffer;
}

async function bodies(): Promise<Bodies> {
  return { glb: glb(), png: await png(), depth: await depthPng() };
}

/** One loopback origin for the API and the asset host, as the tests elsewhere do. */
async function reliefApi(b: Bodies): Promise<MockApi> {
  const api: MockApi = await startMockApi((req, res) => {
    const asset = /^\/assets\/[a-z0-9-]+\/output\/(.+)$/.exec(req.path)?.[1];
    if (asset) {
      const files: Record<string, [string, Buffer | string]> = {
        "model.glb": ["model/gltf-binary", b.glb],
        "model.stl": ["model/stl", Buffer.from("solid relief\nendsolid relief\n")],
        "model.3mf": ["model/3mf", Buffer.from("3mf-bytes")],
        "model.obj": ["model/obj", "mtllib model.mtl\nusemtl relief\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"],
        "model.mtl": ["text/plain", "newmtl relief\nmap_Kd texture_0.png\n"],
        "texture_0.png": ["image/png", b.png],
        "preview.png": ["image/png", b.png],
        "depth.png": ["image/png", b.depth],
      };
      const f = files[asset];
      if (!f) return jsonReply(res, 404, { message: "no such asset" });
      res.writeHead(200, { "content-type": f[0] });
      return void res.end(f[1]);
    }
    if (req.path === "/photos/cat.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(req.method === "HEAD" ? undefined : b.png);
    }
    if (req.method === "POST" && req.path === "/openapi/v1/relief") return jsonReply(res, 202, { result: "relief-1" });
    if (req.method === "DELETE" && req.path === "/openapi/v1/relief/relief-1") return jsonReply(res, 200, {});
    if (req.method === "GET" && req.path === "/openapi/v1/relief") return jsonReply(res, 200, [coloredTask(api.url), depthOnlyTask(api.url)]);
    if (req.method === "GET" && req.path === "/openapi/v1/relief/relief-1") return jsonReply(res, 200, coloredTask(api.url));
    if (req.method === "GET" && req.path === "/openapi/v1/relief/depth-1") return jsonReply(res, 200, depthOnlyTask(api.url));
    if (req.method === "GET" && req.path === "/openapi/v1/relief/depth-1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ id: "depth-1", progress: 0, status: "PENDING" })}\n\n`);
      return void res.end(`event: message\ndata: ${JSON.stringify(depthOnlyTask(api.url))}\n\n`);
    }
    return jsonReply(res, 404, { message: "not found" });
  });
  return api;
}

const posts = (api: MockApi) => api.requests.filter((q) => q.method === "POST");

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("relief is a v1 task resource on /relief: photo input as JPG/PNG/WebP, task type relief, may charge, every verb", () => {
  const d = requireTaskResource("relief");
  assert.deepEqual([...d.commandPath], ["relief"]);
  assert.equal(d.base, "v1");
  assert.equal(d.relativePath, "/relief");
  assert.equal(d.endpoint, "/openapi/v1/relief");
  assert.deepEqual([...d.taskTypes], ["relief"]);
  assert.equal(d.billing.create, "may-charge");
  assert.equal(d.automaticRetry, false);
  assert.deepEqual(d.supports, { create: true, get: true, list: true, delete: true, stream: true });
  assert.deepEqual(d.mediaFields, [{ path: "image_url", kind: "image", many: false, formats: ["jpg", "jpeg", "png", "webp"] }]);
  const entry = resourceIndex().find((e) => e.name === "relief");
  assert.deepEqual(entry && { kind: entry.kind, command: entry.command, endpoint: entry.endpoint, verbs: entry.verbs }, {
    kind: "task",
    command: "meshy relief",
    endpoint: "/openapi/v1/relief",
    verbs: ["create", "get", "list", "wait", "stream", "delete"],
  });
});

test("meshy resources lists relief (local, no key)", async () => {
  const r = await runCli(["resources", "--format", "json"]);
  assert.equal(r.code, 0, r.stderr);
  const items = (parseSingleJson(r.stdout) as { result: { items: Array<{ name: string; kind: string; endpoint: string | null }> } }).result.items;
  const relief = items.find((i) => i.name === "relief");
  assert.deepEqual(relief && { kind: relief.kind, endpoint: relief.endpoint }, { kind: "task", endpoint: "/openapi/v1/relief" });
});

// ---------------------------------------------------------------------------
// create: flags → payload
// ---------------------------------------------------------------------------

test("relief create: flags reach POST /openapi/v1/relief; omitted flags stay out; a local photo goes inline", async () => {
  const api = await reliefApi(await bodies());
  try {
    const dir = tmpDir();
    const IMAGE = `${api.url}/photos/cat.png`;
    const photo = join(dir, "cat.png");
    writeFileSync(photo, await png());

    // Only the photo: the API's own defaults apply, nothing is pinned.
    const minimal = await runCli(["relief", "create", "--image-url", photo, "--async", "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(minimal.code, 0, minimal.stderr);
    assert.equal(posts(api)[0]!.path, "/openapi/v1/relief");
    const first = posts(api)[0]!.json as Record<string, unknown>;
    assert.deepEqual(Object.keys(first), ["image_url"]);
    assert.match(String(first.image_url), /^data:image\/png;base64,/);
    const env = parseSingleJson(minimal.stdout) as { command: string; result: { task_id: string; submission: { task_id: string } } };
    assert.equal(env.command, "relief.create");
    assert.equal(env.result.submission.task_id, "relief-1");

    // The API reference's advanced request.
    const advanced = await runCli([
      "relief", "create", "--image-url", IMAGE, "--variant", "high", "--size-mm", "120", "--carving-depth-mm", "10",
      "--base-thickness-mm", "3", "--bend-mode", "convex", "--bend-angle", "90", "--color-mapping", "true",
      "--target-formats", "glb,obj,stl", "--async", "--format", "json",
    ], { env: api.env(), cwd: dir });
    assert.equal(advanced.code, 0, advanced.stderr);
    assert.deepEqual(posts(api)[1]!.json, {
      image_url: IMAGE, variant: "high", size_mm: 120, carving_depth_mm: 10, base_thickness_mm: 3,
      bend_mode: "convex", bend_angle: 90, color_mapping: true, target_formats: ["glb", "obj", "stl"],
    });

    // Depth map only: should_generate_model false, and the variant still shapes the depth map.
    const depth = await runCli(["relief", "create", "--image-url", IMAGE, "--depth-only", "--variant", "high", "--async", "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(depth.code, 0, depth.stderr);
    assert.deepEqual(posts(api)[2]!.json, { image_url: IMAGE, variant: "high", should_generate_model: false });

    // No base plate, engraved, bent along the other axis, every other format; explicit false survives.
    const cut = await runCli([
      "relief", "create", "--image-url", IMAGE, "--remove-base", "true", "--removal-threshold", "0.2", "--base-thickness-mm", "0",
      "--carving-mode", "engrave", "--bend-mode", "concave", "--bend-axis", "yz", "--mesh-resolution", "2048",
      "--target-formats", "usdz,fbx,3mf", "--color-mapping", "false", "--async", "--format", "json",
    ], { env: api.env(), cwd: dir });
    assert.equal(cut.code, 0, cut.stderr);
    assert.deepEqual(posts(api)[3]!.json, {
      image_url: IMAGE, remove_base: true, removal_threshold: 0.2, base_thickness_mm: 0, carving_mode: "engrave",
      bend_mode: "concave", bend_axis: "yz", mesh_resolution: 2048, target_formats: ["usdz", "fbx", "3mf"], color_mapping: false,
    });

    // --data merges under the flags (flags win) and is validated like them.
    const data = await runCli(["relief", "create", "--data", JSON.stringify({ image_url: IMAGE, size_mm: 80, mesh_resolution: 512 }), "--size-mm", "100", "--async", "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(data.code, 0, data.stderr);
    assert.deepEqual(posts(api)[4]!.json, { image_url: IMAGE, size_mm: 100, mesh_resolution: 512 });

    // Color for formats that cannot show it is sent as asked, with a warning.
    const white = await runCli(["relief", "create", "--image-url", IMAGE, "--color-mapping", "true", "--target-formats", "stl", "--async", "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(white.code, 0, white.stderr);
    assert.deepEqual(posts(api)[5]!.json, { image_url: IMAGE, color_mapping: true, target_formats: ["stl"] });
    assert.deepEqual((parseSingleJson(white.stdout) as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code), ["color_not_in_formats"]);
  } finally {
    await api.close();
  }
});

test("relief create: a broken rule is refused before any request — by flag or by --data", async () => {
  const api = await reliefApi(await bodies());
  try {
    const dir = tmpDir();
    const gif = join(dir, "cat.gif");
    writeFileSync(gif, await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).gif().toBuffer());
    // The full rule set is covered in-process below; these prove the rules run before anything is sent.
    const cases: Array<[string[], RegExp]> = [
      [[], /provide --image-url/],
      [["--image-url", gif], /jpg\/jpeg\/png\/webp only/],
      [["--image-url", IMAGE, "--mesh-resolution", "1500.5"], /--mesh-resolution must be an integer from 512 to 2048/],
      [["--image-url", IMAGE, "--target-formats", "glb,glb"], /lists 'glb' twice/],
      [["--image-url", IMAGE, "--remove-base", "true", "--base-thickness-mm", "2"], /leave out --base-thickness-mm or pass 0/],
      [["--image-url", IMAGE, "--depth-only", "--target-formats", "stl"], /--depth-only returns the depth map alone, so --target-formats does not apply/],
      [["--image-url", IMAGE, "--data", '{"should_generate_model":false,"size_mm":80}'], /--size-mm does not apply/],
    ];
    for (const [args, message] of cases) {
      const r = await runCli(["relief", "create", ...args, "--async", "--format", "json"], { env: api.env(), cwd: dir });
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
      assert.match((parseSingleJson(r.stdout) as { error: { message: string } }).error.message, message, args.join(" "));
    }
    assert.equal(api.requests.length, 0, "nothing reaches the API");
  } finally {
    await api.close();
  }
});

test("validateReliefPayload: ranges, the base-thickness rule, and settings the API would not use", () => {
  const ok = (extra: Record<string, unknown>) => assert.doesNotThrow(() => validateReliefPayload({ image_url: IMAGE, ...extra }), JSON.stringify(extra));
  const refused = (extra: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => validateReliefPayload({ image_url: IMAGE, ...extra }), (err: unknown) => err instanceof UsageError && message.test(err.message), JSON.stringify(extra));

  // Range edges are inclusive.
  ok({ size_mm: 20, carving_depth_mm: 0, bend_mode: "convex", bend_angle: 0, mesh_resolution: 512, base_thickness_mm: 0.1 });
  ok({ size_mm: 250, carving_depth_mm: 60, bend_mode: "concave", bend_angle: 360, mesh_resolution: 2048, base_thickness_mm: 10 });
  ok({ remove_base: true, removal_threshold: 0.01 });
  ok({ remove_base: true, removal_threshold: 1, base_thickness_mm: 0 });
  ok({ variant: "" }); // the API reads "" as not sent
  ok({ should_generate_model: false, variant: "low" });
  ok({ should_generate_model: true, size_mm: 60 });
  ok({ bend_mode: "off" });
  ok({ remove_base: true, carving_depth_mm: 0 }); // documented: an empty model, still billed (a warning, not a refusal)
  for (const [extra, message] of [
    [{ size_mm: 250.5 }, /--size-mm must be a number from 20 to 250/],
    [{ size_mm: "60" }, /--size-mm must be a number/],
    [{ carving_depth_mm: -1 }, /--carving-depth-mm must be a number from 0 to 60/],
    [{ remove_base: true, removal_threshold: 0 }, /--removal-threshold must be a number from 0.01 to 1/],
    [{ bend_mode: "convex", bend_angle: 361 }, /--bend-angle must be a number from 0 to 360/],
    [{ mesh_resolution: 4096 }, /--mesh-resolution must be an integer from 512 to 2048/],
    [{ mesh_resolution: 1024.5 }, /an integer/],
    [{ base_thickness_mm: 0 }, /--base-thickness-mm must be a number from 0.1 to 10/],
    [{ base_thickness_mm: 11 }, /--base-thickness-mm must be a number from 0.1 to 10/],
    [{ remove_base: true, base_thickness_mm: 1 }, /--remove-base true builds no base plate/],
    [{ removal_threshold: 0.5 }, /--removal-threshold applies with --remove-base true only/],
    [{ remove_base: false, removal_threshold: 0.5 }, /--removal-threshold applies with --remove-base true only/],
    [{ bend_angle: 90 }, /--bend-angle applies with --bend-mode convex or concave only/],
    [{ bend_mode: "off", bend_axis: "yz", bend_angle: 90 }, /--bend-axis and --bend-angle apply with --bend-mode/],
    [{ target_formats: [] }, /--target-formats must list at least one/],
    [{ target_formats: "glb" }, /--target-formats must list at least one/],
    [{ target_formats: ["GLB"] }, /unknown format "GLB"/],
    [{ target_formats: ["obj", "mtl"] }, /unknown format "mtl".*OBJ comes with its MTL/],
    [{ target_formats: ["stl", "3mf", "stl"] }, /lists 'stl' twice/],
    [{ variant: "medium" }, /--variant must be one of low \| high/],
    [{ carving_mode: "deboss" }, /--carving-mode must be one of emboss \| engrave/],
    [{ bend_mode: "twist" }, /--bend-mode must be one of off \| convex \| concave/],
    [{ bend_mode: "convex", bend_axis: "xy" }, /--bend-axis must be one of xz \| yz/],
    [{ remove_base: "true" }, /--remove-base must be true or false/],
    [{ color_mapping: 1 }, /--color-mapping must be true or false/],
    [{ should_generate_model: "false" }, /should_generate_model \(--depth-only\) must be true or false/],
    [{ should_generate_model: false, color_mapping: true, mesh_resolution: 1024 }, /--mesh-resolution, --color-mapping do not apply/],
    [{ should_generate_model: false, remove_base: false }, /--remove-base does not apply/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    refused(extra, message);
  }
  assert.throws(() => validateReliefPayload({}), /provide --image-url/);
  assert.throws(() => validateReliefPayload({ image_url: "" }), /provide --image-url/);
});

test("relief create warns when the request likely misses what was meant", () => {
  assert.deepEqual(reliefWarnings({ remove_base: true, carving_depth_mm: 0 }).map((w) => w.code), ["empty_model"]);
  assert.deepEqual(reliefWarnings({ remove_base: false, carving_depth_mm: 0 }), [], "the base plate is still a model");
  assert.deepEqual(reliefWarnings({ color_mapping: true, target_formats: ["stl", "3mf"] }).map((w) => w.code), ["color_not_in_formats"]);
  assert.match(reliefWarnings({ color_mapping: true, target_formats: ["stl"] })[0]!.message, /stl carries no color/);
  assert.deepEqual(reliefWarnings({ color_mapping: true, target_formats: ["stl", "glb"] }), []);
  assert.deepEqual(reliefWarnings({ color_mapping: true }), [], "the default formats include GLB");
  assert.deepEqual(reliefWarnings({ color_mapping: false, target_formats: ["stl"] }), []);
});

// ---------------------------------------------------------------------------
// get / list / delete / stream
// ---------------------------------------------------------------------------

test("relief get/list/delete use /openapi/v1/relief; the task view carries the depth map, MTL and 3MF", async () => {
  const api = await reliefApi(await bodies());
  try {
    const get = await runCli(["relief", "get", "relief-1", "--format", "json"], { env: api.env() });
    assert.equal(get.code, 0, get.stderr);
    const task = (parseSingleJson(get.stdout) as { result: { task: Record<string, unknown> } }).result.task;
    assert.equal(task["resource"], "relief");
    assert.equal(task["type"], "relief");
    assert.equal(task["consumed_credits"], 20);
    assert.match(String(task["depth_map_url"]), /\/depth\.png\?/);
    assert.deepEqual(Object.keys(task["model_urls"] as object).sort(), ["3mf", "glb", "mtl", "obj", "stl"]);
    assert.deepEqual(Object.keys((task["texture_urls"] as object[])[0]!), ["base_color"]);

    const depth = await runCli(["relief", "get", "depth-1", "--format", "json"], { env: api.env() });
    const depthTask = (parseSingleJson(depth.stdout) as { result: { task: Record<string, unknown> } }).result.task;
    assert.deepEqual(depthTask["model_urls"], {});
    assert.equal(depthTask["thumbnail_url"], "");
    assert.match(String(depthTask["depth_map_url"]), /depth-1\/output\/depth\.png/);

    const list = await runCli(["relief", "list", "--page-size", "2", "--format", "json"], { env: api.env() });
    assert.equal(list.code, 0, list.stderr);
    assert.equal((parseSingleJson(list.stdout) as { result: { count: number } }).result.count, 2);

    const del = await runCli(["relief", "delete", "relief-1", "--format", "json"], { env: api.env() });
    assert.equal(del.code, 0, del.stderr);
    assert.equal((parseSingleJson(del.stdout) as { result: { deleted: boolean } }).result.deleted, true);

    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), [
      "GET /openapi/v1/relief/relief-1",
      "GET /openapi/v1/relief/depth-1",
      "GET /openapi/v1/relief",
      "DELETE /openapi/v1/relief/relief-1",
    ]);
    assert.match(api.requests[2]!.url, /page_size=2/);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// -o and meshy download
// ---------------------------------------------------------------------------

test("relief -o: models (OBJ with its MTL), the texture, the depth map and the preview; a depth-only task saves the depth map alone", async () => {
  const b = await bodies();
  const api = await reliefApi(b);
  try {
    const dir = tmpDir();
    const out = join(dir, "relief");
    const r = await runCli(["relief", "get", "relief-1", "-o", out, "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const env = parseSingleJson(r.stdout) as { result: { downloads: { state: string; files: Array<{ key: string; status: string }>; skipped: unknown[] } } };
    assert.equal(env.result.downloads.state, "completed");
    assert.deepEqual(env.result.downloads.files.map((f) => f.key), [
      "model.glb", "model.stl", "model.obj", "model.mtl", "model.3mf", "depth_map", "thumbnail.primary", "texture.0.base_color",
    ]);
    assert.ok(env.result.downloads.files.every((f) => f.status === "written"));
    assert.deepEqual(env.result.downloads.skipped, [], "an OBJ does not embed its texture, so the texture is saved");
    assert.deepEqual(readdirSync(out).sort(), [
      "depth_map.png", "meta.json", "model.3mf", "model.glb", "model.mtl", "model.obj", "model.stl", "texture_0_base_color.png", "thumbnail.png",
    ]);
    assert.ok(readFileSync(join(out, "depth_map.png")).equals(b.depth), "the 16-bit depth map is saved byte for byte");
    assert.match(readFileSync(join(out, "model.mtl"), "utf8"), /map_Kd texture_0_base_color\.png/, "the MTL points at the saved texture");

    // Depth map only, followed over SSE: one file plus the sidecar.
    const depthOut = join(dir, "depth");
    const s = await runCli(["relief", "stream", "depth-1", "-o", depthOut, "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(s.code, 0, s.stderr);
    const sEnv = parseSingleJson(s.stdout) as { result: { task: { status: string }; downloads: { files: Array<{ key: string }> } } };
    assert.equal(sEnv.result.task.status, "SUCCEEDED");
    assert.deepEqual(sEnv.result.downloads.files.map((f) => f.key), ["depth_map"]);
    assert.deepEqual(readdirSync(depthOut).sort(), ["depth_map.png", "meta.json"]);

    // A file path picks the file of that format; a model the depth-only task does not have is refused, naming what it has.
    const stl = join(dir, "plaque.stl");
    const one = await runCli(["relief", "get", "relief-1", "-o", stl, "--format", "json"], { env: api.env(), cwd: dir });
    assert.equal(one.code, 0, one.stderr);
    assert.equal(readFileSync(stl, "utf8"), "solid relief\nendsolid relief\n");
    const none = await runCli(["relief", "get", "depth-1", "-o", join(dir, "plaque.glb"), "--format", "json"], { env: api.env(), cwd: dir });
    // The task is fine and nothing was saved; the class is the existing one for an -o path that cannot be written (local_io, 11).
    assert.equal(none.code, 11, none.stdout);
    assert.match((parseSingleJson(none.stdout) as { error: { message: string } }).error.message, /does not name exactly one file of task depth-1 \(it has depth_map\.png\)/);
    assert.ok(!existsSync(join(dir, "plaque.glb")));
  } finally {
    await api.close();
  }
});

test("meshy download on a relief task: --asset depth_map, --kind depth_map, OBJ with MTL and texture; a missing format names the ones the task has", async () => {
  const b = await bodies();
  const api = await reliefApi(b);
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "relief.json");
    writeFileSync(taskJson, JSON.stringify(coloredTask(api.url)));
    const depthJson = join(dir, "depth.json");
    writeFileSync(depthJson, JSON.stringify(depthOnlyTask(api.url)));
    const run = (args: string[]) => runCli(["download", ...args, "--format", "json"], { env: api.env({ MESHY_API_KEY: undefined }), cwd: dir });

    const list = await run(["--task-json", taskJson, "--list"]);
    assert.equal(list.code, 0, list.stderr);
    const listed = parseSingleJson(list.stdout) as { result: { source: { resource: string }; assets: Array<{ key: string; kind: string; filename: string }> } };
    assert.equal(listed.result.source.resource, "relief", "the task type maps a saved task to its resource");
    const depthMap = listed.result.assets.find((a) => a.key === "depth_map");
    assert.deepEqual(depthMap && [depthMap.kind, depthMap.filename], ["depth_map", "depth_map.png"]);

    const byKey = await run(["--task-json", taskJson, "--asset", "depth_map", "--output", join(dir, "heightmap.png")]);
    assert.equal(byKey.code, 0, byKey.stderr);
    assert.ok(readFileSync(join(dir, "heightmap.png")).equals(b.depth));

    const byKind = await run(["--task-json", depthJson, "--kind", "depth_map", "--output-dir", join(dir, "by-kind")]);
    assert.equal(byKind.code, 0, byKind.stderr);
    assert.deepEqual(readdirSync(join(dir, "by-kind")), ["depth_map.png"]);

    // A depth map is never transcoded to 8 bits: asked for .jpg, it is kept as PNG under its own extension.
    const jpg = await run(["--task-json", depthJson, "--asset", "depth_map", "--output", join(dir, "depth.jpg")]);
    assert.equal(jpg.code, 0, jpg.stderr);
    assert.ok(readFileSync(join(dir, "depth.png")).equals(b.depth));
    assert.ok(!existsSync(join(dir, "depth.jpg")));
    assert.ok((parseSingleJson(jpg.stdout) as { warnings: Array<{ code: string }> }).warnings.some((w) => w.code === "extension_corrected"));

    const obj = await run(["--task-json", taskJson, "--model-format", "obj", "--output-dir", join(dir, "obj")]);
    assert.equal(obj.code, 0, obj.stderr);
    assert.deepEqual(readdirSync(join(dir, "obj")).sort(), ["model.mtl", "model.obj", "texture_0_base_color.png"]);

    const fbx = await run(["--task-json", taskJson, "--model-format", "fbx", "--output-dir", join(dir, "fbx")]);
    assert.equal(fbx.code, 2, fbx.stdout);
    assert.match((parseSingleJson(fbx.stdout) as { error: { message: string } }).error.message, /no model asset in format 'fbx' \(the task has glb, stl, obj, mtl, 3mf\)/);
    const depthGlb = await run(["--task-json", depthJson, "--model-format", "glb", "--output-dir", join(dir, "glb")]);
    assert.equal(depthGlb.code, 2, depthGlb.stdout);
    assert.match((parseSingleJson(depthGlb.stdout) as { error: { message: string } }).error.message, /the task has no model file/);
  } finally {
    await api.close();
  }
});

test("relief assets: stable keys and file names; -o keeps the depth map, and leaves a texture GLB/STL already carry", () => {
  const host = "https://assets.example.com";
  const relief = requireTaskResource("relief");
  const e = enumerateAssets(coloredTask(host), relief);
  assert.deepEqual(e.assets.map((a) => [a.key, a.kind, a.format, a.filename]), [
    ["model.glb", "model", "glb", "model.glb"],
    ["model.stl", "model", "stl", "model.stl"],
    ["model.obj", "model", "obj", "model.obj"],
    ["model.mtl", "model", "mtl", "model.mtl"],
    ["model.3mf", "model", "3mf", "model.3mf"],
    ["depth_map", "depth_map", "png", "depth_map.png"],
    ["thumbnail.primary", "thumbnail", "png", "thumbnail.png"],
    ["texture.0.base_color", "texture", "png", "texture_0_base_color.png"],
  ]);
  assert.deepEqual(e.assets.find((a) => a.key === "model.obj")!.dependencies, ["model.mtl", "texture.0.base_color"]);
  assert.deepEqual(e.unknown_urls, []);

  const depthOnly = enumerateAssets(depthOnlyTask(host), relief);
  assert.deepEqual(depthOnly.assets.map((a) => a.key), ["depth_map"], "an empty thumbnail_url is no asset");

  const glbStl = { ...coloredTask(host), model_urls: { glb: `${host}/m.glb`, stl: `${host}/m.stl` } };
  const sel = selectDefaultAssets(enumerateAssets(glbStl, relief).assets);
  assert.deepEqual(sel.selected.map((a) => a.key), ["model.glb", "model.stl", "depth_map", "thumbnail.primary"]);
  assert.deepEqual(sel.skipped.map((s) => [s.asset.key, s.reason]), [["texture.0.base_color", "embedded_textures"]]);
});

test("pretty view of a relief task names the depth map", () => {
  const card = (raw: Record<string, unknown>) =>
    renderView("relief.get", okEnvelope("relief.get", {
      task: toTaskView(raw, { descriptor: requireTaskResource("relief") }),
      submission: { state: "accepted", operation_id: null },
      downloads: { state: "not_requested", files: [], metadata_path: null },
      saved_json: null,
    }), plain);
  assert.match(card(coloredTask("https://assets.example.com")), /^Assets {3}glb, stl, obj, mtl, 3mf · depth map · textures: base_color · thumbnail$/m);
  assert.match(card(depthOnlyTask("https://assets.example.com")), /^Assets {3}depth map$/m);
});
