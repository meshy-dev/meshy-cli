/**
 * Endpoints and parameters from the current public API docs, asserted on the
 * wire against a loopback API.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { jsonReply, parseSingleJson, runCli, startMockApi, type MockApi } from "./helpers/cli.js";

async function withApi(handler: Parameters<typeof startMockApi>[0], fn: (api: MockApi) => Promise<void>): Promise<void> {
  const api = await startMockApi(handler);
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

const accept: Parameters<typeof startMockApi>[0] = (req, res) =>
  req.method === "POST" ? jsonReply(res, 200, { result: "task-new" }) : jsonReply(res, 500, { message: "unexpected" });

const body = (api: MockApi, i = 0) => api.requests.filter((q) => q.method === "POST")[i]!.json as Record<string, unknown>;

// ---------------------------------------------------------------------------
// auto-split
// ---------------------------------------------------------------------------

test("auto-split create: flags reach POST /openapi/v1/print/split; v1 envelope by default", async () => {
  await withApi(accept, async (api) => {
    const r = await runCli([
      "auto-split", "create", "--input-task-id", "src-1", "--mode", "by_parts", "--prompt", "head, torso, legs",
      "--target-formats", "glb,3mf", "--layout", "on_plate", "--connectors", "true", "--connector-type", "cylinder",
      "--connector-size", "0.4", "--connector-height", "0.2", "--async",
    ], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(api.requests[0]!.path, "/openapi/v1/print/split");
    assert.deepEqual(body(api), {
      input_task_id: "src-1", mode: "by_parts", prompt: "head, torso, legs", target_formats: ["glb", "3mf"], layout: "on_plate",
      connectors: true, connector_type: "cylinder", connector_size: 0.4, connector_height: 0.2,
    });
    const out = parseSingleJson(r.stdout) as { command: string; result: { task_id: string } };
    assert.equal(out.command, "auto-split.create");
    assert.equal(out.result.task_id, "task-new");
  });
});

test("auto-split create: missing prompt for by_parts/by_color, out-of-range connectors and connector tuning without connectors are refused locally", async () => {
  await withApi(accept, async (api) => {
    for (const args of [
      ["--mode", "by_color"],
      ["--connectors", "true", "--connector-size", "0.9"],
      ["--connector-type", "cube"],
      ["--prompt", "x".repeat(601), "--mode", "by_parts"],
      [],
    ]) {
      const withTask = args.length === 0 ? [] : ["--input-task-id", "src-1"];
      const r = await runCli(["auto-split", "create", ...withTask, ...args, "--async"], { env: api.env() });
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
    }
    assert.equal(api.requests.length, 0);
  });
});

test("auto-split get/list/delete use /print/split", async () => {
  await withApi((req, res) => {
    if (req.method === "DELETE") return jsonReply(res, 200, {});
    if (req.path === "/openapi/v1/print/split") return jsonReply(res, 200, []);
    return jsonReply(res, 200, { id: "s-1", type: "print-split", status: "SUCCEEDED", progress: 100, part_count: 3, model_urls: { glb: "https://assets.example.invalid/s.glb" } });
  }, async (api) => {
    const get = await runCli(["auto-split", "get", "s-1"], { env: api.env() });
    assert.equal(get.code, 0, get.stderr);
    assert.equal((parseSingleJson(get.stdout) as { result: { task: { status: string } } }).result.task.status, "SUCCEEDED");
    assert.equal((await runCli(["auto-split", "list"], { env: api.env() })).code, 0);
    assert.equal((await runCli(["auto-split", "delete", "s-1"], { env: api.env() })).code, 0);
    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), [
      "GET /openapi/v1/print/split/s-1",
      "GET /openapi/v1/print/split",
      "DELETE /openapi/v1/print/split/s-1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

test("usage tasks: one GET with pagination, window, endpoint and status filters; records passed through", async () => {
  const records = [{ task_id: "t-1", endpoint: "image-to-3d", status: "SUCCEEDED", created_at: 1, finished_at: 2, consumed_credits: 20, api_key_name: "ci", api_key_suffix: "a1b2" }];
  await withApi((req, res) => (req.path === "/openapi/v1/usage/tasks" ? jsonReply(res, 200, records) : jsonReply(res, 404, {})), async (api) => {
    const r = await runCli([
      "usage", "tasks", "--page", "2", "--page-size", "50", "--sort-by", "+created_at", "--start-time", "2026-08-01T00:00:00Z",
      "--end-time", "2026-09-01T00:00:00Z", "--endpoints", "image-to-3d,text-to-3d", "--status", "SUCCEEDED",
    ], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    const q = Object.fromEntries(new URL(api.requests[0]!.url, "http://x").searchParams);
    assert.deepEqual(q, {
      page_num: "2", page_size: "50", sort_by: "+created_at", start_time: "2026-08-01T00:00:00Z", end_time: "2026-09-01T00:00:00Z",
      endpoints: "image-to-3d,text-to-3d", status: "SUCCEEDED",
    });
    const out = parseSingleJson(r.stdout) as { command: string; result: { items: unknown[]; count: number; page: { page_num: number } } };
    assert.equal(out.command, "usage.tasks");
    assert.deepEqual(out.result.items, records);
    assert.equal(out.result.page.page_num, 2);
  });
});

test("usage tasks: a bad window or page size is refused locally; a 403 (plan) is an auth-class error", async () => {
  await withApi((_req, res) => jsonReply(res, 403, { message: "Studio or Enterprise plan required" }), async (api) => {
    assert.equal((await runCli(["usage", "tasks", "--start-time", "yesterday"], { env: api.env() })).code, 2);
    assert.equal((await runCli(["usage", "tasks", "--page-size", "101"], { env: api.env() })).code, 2);
    assert.equal(api.requests.length, 0);
    const r = await runCli(["usage", "tasks"], { env: api.env() });
    assert.notEqual(r.code, 0);
    assert.equal((parseSingleJson(r.stdout) as { error: { http_status: number } }).error.http_status, 403);
  });
});

// ---------------------------------------------------------------------------
// animate / rigging
// ---------------------------------------------------------------------------

test("animate: --action-ids (one merged file) and --motion-task-id; exactly one source, ids unique and at most 10", async () => {
  await withApi(accept, async (api) => {
    const many = await runCli(["animate", "create", "--rig-task-id", "rig-1", "--action-ids", "10,25,92", "--async"], { env: api.env() });
    assert.equal(many.code, 0, many.stderr);
    assert.deepEqual(body(api, 0), { rig_task_id: "rig-1", action_ids: [10, 25, 92] });
    const motion = await runCli(["animate", "create", "--rig-task-id", "rig-1", "--motion-task-id", "mo-1", "--async"], { env: api.env() });
    assert.equal(motion.code, 0, motion.stderr);
    assert.deepEqual(body(api, 1), { rig_task_id: "rig-1", motion_task_id: "mo-1" });
    for (const extra of [
      ["--action-id", "1", "--action-ids", "2,3"],
      ["--action-ids", "1,1"],
      ["--action-ids", "1,2,3,4,5,6,7,8,9,10,11"],
      ["--action-ids", "wave"],
      [],
    ]) {
      const r = await runCli(["animate", "create", "--rig-task-id", "rig-1", ...extra, "--async"], { env: api.env() });
      assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stdout}`);
    }
    assert.equal(api.requests.length, 2);
  });
});

test("rigging list is enabled (GET /openapi/v1/rigging)", async () => {
  await withApi((_req, res) => jsonReply(res, 200, []), async (api) => {
    const r = await runCli(["rigging", "list", "--output-schema", "v1"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(api.requests[0]!.path, "/openapi/v1/rigging");
  });
});

// ---------------------------------------------------------------------------
// Creative Lab: vinyl-figure, brick-figure, keycap, fidget-pixel, fidget-collapsible, keychain engraving
// ---------------------------------------------------------------------------

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

test("Creative Lab: the new two-stage products post to their own prototype/build paths", async () => {
  await withApi(accept, async (api) => {
    for (const product of ["vinyl-figure", "brick-figure"]) {
      const proto = await runCli(["creative-lab", product, "prototype", "create", "--image-url", PHOTO, "--remove-background", "--async"], { env: api.env() });
      assert.equal(proto.code, 0, proto.stderr);
      const build = await runCli(["creative-lab", product, "build", "create", "--input-task-id", "p-1", "--async"], { env: api.env() });
      assert.equal(build.code, 0, build.stderr);
    }
    assert.deepEqual(api.requests.map((q) => q.path), [
      "/openapi/creative-lab/vinyl-figure/v1/prototype",
      "/openapi/creative-lab/vinyl-figure/v1/build",
      "/openapi/creative-lab/brick-figure/v1/prototype",
      "/openapi/creative-lab/brick-figure/v1/build",
    ]);
    assert.equal(body(api, 0)["remove_background"], true);
  });
});

test("Creative Lab keycap build: --candidate-id is required and the options are range-checked before the request", async () => {
  await withApi(accept, async (api) => {
    const ok = await runCli(["creative-lab", "keycap", "build", "create", "--input-task-id", "p-1", "--candidate-id", "c-0", "--options", '{"head_size_mm":30,"vertical_offset_mm":-2}', "--async"], { env: api.env() });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(body(api), { input_task_id: "p-1", candidate_id: "c-0", options: { head_size_mm: 30, vertical_offset_mm: -2 } });
    assert.equal(api.requests[0]!.path, "/openapi/creative-lab/keycap/v1/build");
    for (const extra of [[], ["--candidate-id", "c-0", "--options", '{"head_size_mm":50}'], ["--candidate-id", "c-0", "--options", '{"base_model":"sa-1u"}']]) {
      const r = await runCli(["creative-lab", "keycap", "build", "create", "--input-task-id", "p-1", ...extra, "--async"], { env: api.env() });
      assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stdout}`);
    }
    assert.equal(api.requests.length, 1);
  });
});

test("Creative Lab fidget-pixel: prototype needs --type and has no --remove-background; build options and 3mf output are checked", async () => {
  await withApi(accept, async (api) => {
    const proto = await runCli(["creative-lab", "fidget-pixel", "prototype", "create", "--image-url", PHOTO, "--type", "other", "--async"], { env: api.env() });
    assert.equal(proto.code, 0, proto.stderr);
    assert.equal(body(api, 0)["type"], "other");
    assert.equal((await runCli(["creative-lab", "fidget-pixel", "prototype", "create", "--image-url", PHOTO, "--async"], { env: api.env() })).code, 2);
    assert.equal((await runCli(["creative-lab", "fidget-pixel", "prototype", "create", "--image-url", PHOTO, "--type", "person", "--remove-background", "--async"], { env: api.env() })).code, 2);

    const build = await runCli(["creative-lab", "fidget-pixel", "build", "create", "--input-task-id", "p-1", "--options", '{"shape":"hex","grid_size":16,"piece_size_mm":8}', "--model-format", "3mf", "--async"], { env: api.env() });
    assert.equal(build.code, 0, build.stderr);
    assert.deepEqual(body(api, 1), { input_task_id: "p-1", options: { shape: "hex", grid_size: 16, piece_size_mm: 8 }, output: { format: "3mf" } });
    for (const options of ['{"shape":"hex","piece_size_mm":10}', '{"grid_size":24}', '{"color_count":9}']) {
      const r = await runCli(["creative-lab", "fidget-pixel", "build", "create", "--input-task-id", "p-1", "--options", options, "--async"], { env: api.env() });
      assert.equal(r.code, 2, `${options}: ${r.stdout}`);
    }
    assert.equal(api.requests.length, 2);
  });
});

test("Creative Lab fidget-collapsible: one stage on the product root, with the shared verbs", async () => {
  await withApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "fc-1" });
    return jsonReply(res, 200, { id: "fc-1", type: "creative-lab-fidget-collapsible", status: "SUCCEEDED", progress: 100, model_urls: { stl: "https://assets.example.invalid/model.stl" } });
  }, async (api) => {
    const r = await runCli(["creative-lab", "fidget-collapsible", "create", "--image-url", PHOTO, "--name", "demo", "--async"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((parseSingleJson(r.stdout) as { command: string }).command, "creative-lab.fidget-collapsible.create");
    const get = await runCli(["creative-lab", "fidget-collapsible", "get", "fc-1"], { env: api.env() });
    assert.equal(get.code, 0, get.stderr);
    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), [
      "POST /openapi/creative-lab/fidget-collapsible/v1",
      "GET /openapi/creative-lab/fidget-collapsible/v1/fc-1",
    ]);
    assert.deepEqual(body(api), { image_url: PHOTO, name: "demo" });
  });
});

test("Creative Lab keychain --name-text: up to 10 characters counted as characters, not bytes", async () => {
  await withApi(accept, async (api) => {
    const ok = await runCli(["creative-lab", "keychain", "prototype", "create", "--image-url", PHOTO, "--name-text", "小明的小狗小猫小鸟鱼", "--async"], { env: api.env() });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(body(api)["name_text"], "小明的小狗小猫小鸟鱼");
    const long = await runCli(["creative-lab", "keychain", "prototype", "create", "--image-url", PHOTO, "--name-text", "ABCDEFGHIJK", "--async"], { env: api.env() });
    assert.equal(long.code, 2, long.stdout);
    assert.equal(api.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

test("printability: --printer-type and one print size reach both endpoints; repair takes --alpha-thumbnail; two sizes or an out-of-range size are refused", async () => {
  await withApi(accept, async (api) => {
    const a = await runCli(["analyze-printability", "create", "--input-task-id", "t-1", "--printer-type", "sla", "--intended-print-height-mm", "120", "--async"], { env: api.env() });
    assert.equal(a.code, 0, a.stderr);
    assert.deepEqual(body(api, 0), { input_task_id: "t-1", printer_type: "sla", intended_print_height_mm: 120 });
    const r = await runCli(["repair-printability", "create", "--input-task-id", "t-1", "--intended-print-longest-side-mm", "80", "--alpha-thumbnail", "true", "--async"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(body(api, 1), { input_task_id: "t-1", alpha_thumbnail: true, intended_print_longest_side_mm: 80 });
    for (const extra of [["--intended-print-height-mm", "50", "--intended-print-longest-side-mm", "50"], ["--intended-print-height-mm", "0"], ["--printer-type", "resin"]]) {
      const bad = await runCli(["repair-printability", "create", "--input-task-id", "t-1", ...extra, "--async"], { env: api.env() });
      assert.equal(bad.code, 2, `${extra.join(" ")}: ${bad.stdout}`);
    }
    assert.equal(api.requests.length, 2);
  });
});

test("multi-color-print: --style and --printer-brand; --max-depth is realistic-only", async () => {
  await withApi(accept, async (api) => {
    const r = await runCli(["multi-color-print", "create", "--input-task-id", "t-1", "--style", "cartoon", "--printer-brand", "prusa", "--async"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(body(api), { input_task_id: "t-1", style: "cartoon", printer_brand: "prusa" });
    assert.equal((await runCli(["multi-color-print", "create", "--input-task-id", "t-1", "--style", "cartoon", "--max-depth", "5", "--async"], { env: api.env() })).code, 2);
    assert.equal((await runCli(["multi-color-print", "create", "--input-task-id", "t-1", "--printer-brand", "makerbot", "--async"], { env: api.env() })).code, 2);
    assert.equal(api.requests.length, 1);
  });
});

test("images: --remove-background on both; image-to-image takes --input-task-id instead of reference images", async () => {
  await withApi(accept, async (api) => {
    const t = await runCli(["text-to-image", "create", "--prompt", "a cat", "--remove-background", "true", "--async"], { env: api.env() });
    assert.equal(t.code, 0, t.stderr);
    assert.equal(body(api, 0)["remove_background"], true);
    const i = await runCli(["image-to-image", "create", "--prompt", "restyle as chibi", "--input-task-id", "img-1", "--remove-background", "true", "--async"], { env: api.env() });
    assert.equal(i.code, 0, i.stderr);
    const b = body(api, 1);
    assert.equal(b["input_task_id"], "img-1");
    assert.equal(b["remove_background"], true);
    assert.ok(!("reference_image_urls" in b));
    assert.equal((await runCli(["image-to-image", "create", "--prompt", "x", "--async"], { env: api.env() })).code, 2, "one source is still required");
  });
});

test("balance: monthly / permanent credits and the reset time are reported (v1 and legacy)", async () => {
  const reply = { balance: 1500, monthly_credits: 1000, permanent_credits: 500, monthly_resets_at: 1_793_404_800_000 };
  await withApi((_req, res) => jsonReply(res, 200, reply), async (api) => {
    const v1 = await runCli(["balance", "--output-schema", "v1"], { env: api.env() });
    assert.equal(v1.code, 0, v1.stderr);
    assert.deepEqual((parseSingleJson(v1.stdout) as { result: unknown }).result, { ...reply, saved_json: null });
    const legacy = await runCli(["balance"], { env: api.env() });
    assert.deepEqual(parseSingleJson(legacy.stdout), reply);
    const pretty = await runCli(["balance", "--format", "pretty"], { env: api.env() });
    assert.match(pretty.stdout, /1,000 monthly, resets 2026-10-31 · 500 permanent/);
  });
});

test("generation: --geometry-resolution on text-to-3d preview and image-to-3d; text-to-3d smart topology; --ultra-mode still works", async () => {
  await withApi(accept, async (api) => {
    const t = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "a robot", "--geometry-resolution", "4k", "--async"], { env: api.env() });
    assert.equal(t.code, 0, t.stderr);
    assert.equal(body(api, 0)["geometry_resolution"], "4k");
    const st = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "a robot", "--model-type", "smart-topology", "--target-polycount", "8000", "--async"], { env: api.env() });
    assert.equal(st.code, 0, st.stderr);
    assert.equal(body(api, 1)["model_type"], "smart-topology");
    assert.equal(body(api, 1)["target_polycount"], 8000);
    assert.equal(body(api, 1)["ai_model"], "meshy-t2.5");
    const i = await runCli(["image-to-3d", "create", "--image-url", "https://example.invalid/a.png", "--geometry-resolution", "2k", "--async", "--data", "{}"], { env: api.env() });
    assert.equal(i.code, 2, "the preflight of an unreachable URL fails before the POST");
    for (const args of [
      ["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--model-type", "smart-topology", "--geometry-resolution", "2k"],
      ["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--target-polycount", "500"],
      ["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--model-type", "smart-topology", "--target-polycount", "30001"],
      ["text-to-3d", "create", "--mode", "refine", "--preview-task-id", "p", "--geometry-resolution", "2k"],
      ["image-to-3d", "create", "--input-task-id", "img", "--ultra-mode", "true", "--geometry-resolution", "2k"],
      ["image-to-3d", "create", "--input-task-id", "img", "--model-type", "smart-topology", "--geometry-resolution", "4k"],
    ]) {
      const r = await runCli([...args, "--async"], { env: api.env() });
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
    }
    const legacyUltra = await runCli(["image-to-3d", "create", "--input-task-id", "img", "--ultra-mode", "true", "--async"], { env: api.env() });
    assert.equal(legacyUltra.code, 0, legacyUltra.stderr);
    assert.equal(body(api, 2)["ultra_mode"], true);
    const geo = await runCli(["image-to-3d", "create", "--input-task-id", "img", "--geometry-resolution", "2k", "--async"], { env: api.env() });
    assert.equal(geo.code, 0, geo.stderr);
    assert.equal(body(api, 3)["geometry_resolution"], "2k");
    // Smart topology defaults to T2.5 and leaves its 15k polycount to the API.
    const stDefault = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "a robot", "--model-type", "smart-topology", "--async"], { env: api.env() });
    assert.equal(stDefault.code, 0, stDefault.stderr);
    assert.equal(body(api, 4)["ai_model"], "meshy-t2.5");
    assert.ok(!("target_polycount" in body(api, 4)));
  });
});

test("smart topology meshy-t2.5: --ai-model on image-to-3d and text-to-3d preview, polycount up to 30000, the API's default polycount", async () => {
  await withApi(accept, async (api) => {
    const smart = ["--model-type", "smart-topology"];
    const img = ["image-to-3d", "create", "--input-task-id", "img", ...smart];
    const txt = ["text-to-3d", "create", "--mode", "preview", "--prompt", "a robot", ...smart];
    const ok = async (args: string[]) => {
      const r = await runCli([...args, "--async"], { env: api.env() });
      assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
      return api.requests[api.requests.length - 1]!;
    };

    let req = await ok([...img, "--ai-model", "meshy-t2.5", "--target-polycount", "30000"]);
    assert.equal(req.path, "/openapi/v1/image-to-3d");
    assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
    assert.equal((req.json as Record<string, unknown>)["model_type"], "smart-topology");
    assert.equal((req.json as Record<string, unknown>)["target_polycount"], 30_000);
    req = await ok([...txt, "--ai-model", "meshy-t2.5", "--target-polycount", "30000"]);
    assert.equal(req.path, "/openapi/v2/text-to-3d");
    assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
    assert.equal((req.json as Record<string, unknown>)["target_polycount"], 30_000);
    // Without --target-polycount meshy-t2.5 keeps the API's default (15000); meshy-t2 still gets 10000.
    for (const base of [img, txt]) {
      req = await ok([...base]);
      assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
      assert.ok(!("target_polycount" in (req.json as object)));
      req = await ok([...base, "--target-polycount", "30000"]);
      assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
      assert.equal((req.json as Record<string, unknown>)["target_polycount"], 30_000);
      req = await ok([...base, "--ai-model", "meshy-t2.5"]);
      assert.ok(!("target_polycount" in (req.json as object)), `${base[0]}: meshy-t2.5 polycount is left to the API`);
      req = await ok([...base, "--ai-model", "meshy-t2"]);
      assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2");
      assert.equal((req.json as Record<string, unknown>)["target_polycount"], 10_000);
      // Explicit JSON models and polycounts override the conditional defaults.
      req = await ok([...base, "--data", '{"ai_model":"meshy-t2"}']);
      assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2");
      assert.equal((req.json as Record<string, unknown>)["target_polycount"], 10_000);
      req = await ok([...base, "--data", '{"ai_model":"meshy-t2","target_polycount":8000}']);
      assert.equal((req.json as Record<string, unknown>)["target_polycount"], 8_000);
      req = await ok([...base, "--data", '{"ai_model":"meshy-t2"}', "--ai-model", "meshy-t2.5"]);
      assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
      assert.ok(!("target_polycount" in (req.json as object)));
    }
    // Raw JSON and flag-based model_type use the same defaults.
    for (const base of [img.slice(0, -2), txt.slice(0, -2)]) {
      req = await ok([...base, "--data", '{"model_type":"smart-topology"}']);
      assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
      assert.ok(!("target_polycount" in (req.json as object)));
      req = await ok([...base]);
      assert.ok(!("ai_model" in (req.json as object)), "standard mode keeps the server's model default");
      assert.ok(!("target_polycount" in (req.json as object)));
    }
    // A model_type sent through --data counts as smart-topology.
    req = await ok(["image-to-3d", "create", "--input-task-id", "img", "--data", '{"model_type":"smart-topology"}', "--ai-model", "meshy-t2.5"]);
    assert.equal((req.json as Record<string, unknown>)["ai_model"], "meshy-t2.5");
    const posts = api.requests.length;

    for (const args of [
      [...img, "--target-polycount", "30001"],
      [...img, "--ai-model", "meshy-t2", "--target-polycount", "30000"],
      [...txt, "--target-polycount", "30001"],
      [...img, "--data", '{"ai_model":"meshy-t2","target_polycount":30000}'],
      [...img, "--ai-model", "meshy-t2.5", "--target-polycount", "30001"],
      [...txt, "--ai-model", "meshy-t2.5", "--target-polycount", "99"],
      ["image-to-3d", "create", "--input-task-id", "img", "--ai-model", "meshy-t2.5"],
      ["image-to-3d", "create", "--input-task-id", "img", "--model-type", "standard", "--ai-model", "meshy-t2.5"],
      ["image-to-3d", "create", "--input-task-id", "img", "--data", '{"ai_model":"meshy-t2.5"}'],
      ["text-to-3d", "create", "--mode", "preview", "--prompt", "x", "--ai-model", "meshy-t2.5"],
      ["text-to-3d", "create", "--mode", "refine", "--preview-task-id", "p", "--ai-model", "meshy-t2.5"],
      [...img, "--ai-model", "meshy-t2.5", "--data", '{"topology":"quad"}'],
      [...txt, "--ai-model", "meshy-t2.5", "--data", '{"topology":"quad"}'],
      [...img, "--ai-model", "meshy-6"],
      ["multi-image-to-3d", "create", "--input-task-id", "img", "--ai-model", "meshy-t2.5"],
    ]) {
      const r = await runCli([...args, "--async"], { env: api.env() });
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
    }
    assert.equal(api.requests.length, posts, "every refusal happens before the request");
  });
});

test("multi-image-to-3d --texture-image-urls: local files are inlined, 1-4 views, needs a textured run, not with --texture-prompt", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpDir } = await import("./helpers/cli.js");
  const cwd = tmpDir("meshy-texviews-");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64");
  for (const f of ["a.png", "front.png", "side.png"]) writeFileSync(join(cwd, f), png);
  await withApi(accept, async (api) => {
    const r = await runCli(["multi-image-to-3d", "create", "--image-urls", "a.png", "--should-texture", "true", "--texture-image-urls", "front.png,side.png", "--async"], { env: api.env(), cwd });
    assert.equal(r.code, 0, r.stderr);
    const views = body(api)["texture_image_urls"] as string[];
    assert.equal(views.length, 2);
    for (const v of views) assert.match(v, /^data:image\/png;base64,/);
    for (const extra of [["--texture-image-urls", "front.png"], ["--should-texture", "true", "--texture-image-urls", "front.png", "--texture-prompt", "red"]]) {
      const bad = await runCli(["multi-image-to-3d", "create", "--image-urls", "a.png", ...extra, "--async"], { env: api.env(), cwd });
      assert.equal(bad.code, 2, `${extra.join(" ")}: ${bad.stdout}`);
    }
    assert.equal(api.requests.length, 1);
  });
});

test("retexture / remesh --alpha-thumbnail and rigging --texture-image-url reach the wire", async () => {
  await withApi(accept, async (api) => {
    assert.equal((await runCli(["retexture", "create", "--input-task-id", "t", "--text-style-prompt", "gold", "--alpha-thumbnail", "true", "--async"], { env: api.env() })).code, 0);
    assert.equal(body(api, 0)["alpha_thumbnail"], true);
    assert.equal((await runCli(["remesh", "create", "--input-task-id", "t", "--alpha-thumbnail", "true", "--async"], { env: api.env() })).code, 0);
    assert.equal(body(api, 1)["alpha_thumbnail"], true);
    const tex = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
    assert.equal((await runCli(["rigging", "create", "--input-task-id", "t", "--texture-image-url", tex, "--async"], { env: api.env() })).code, 0);
    assert.equal(body(api, 2)["texture_image_url"], tex);
  });
});
