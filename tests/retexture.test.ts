/**
 * retexture's model choice, asserted on the wire: a loopback API records the
 * create POST (and answers the unauthenticated HEAD preflight of the image
 * URLs), so every test checks what the server would receive. No network.
 *
 * Meshy N1 (`ai_model: "meshy-n1"`) makes a 2K base color texture from
 * reference images only: one image, or 1-4 views with the front first. The
 * API answers 400 for N1 with a text prompt alone, `enable_pbr: true`, 4k/8k
 * (or `hd_texture: true`) and any `remove_lighting`, and only meshy-7 or
 * meshy-n1 take `multiview_image_urls`.
 *
 * Failure modes these tests guard:
 *   F1  N1 inherits the game-ready `enable_pbr: true` default → a 400 on every
 *       N1 request.
 *   F2  N1 inherits the `texture_resolution: "4k"` default → a 400 on every
 *       N1 request.
 *   F3  The multi-view meshy-7 pin overrides an N1 pick, so a meshy-7 task
 *       runs and bills instead of the N1 one that was asked for.
 *   F4  The CLI reorders, drops or dedupes the views, so the API reads the
 *       wrong image as the front view.
 *   F5  N1 picked through `--data` (the escape hatch) keeps the Meshy 7
 *       defaults and 400s — the defaults must follow the model wherever it
 *       was set.
 *   F6  An N1 request with a text prompt and no image is sent (a 400), or is
 *       refused with a message that does not say N1 needs a reference image.
 *   F7  An N1 prompt beside an image is sent through `--data`; the API drops
 *       the prompt silently, so the caller never learns it was ignored.
 *   F8  An explicit PBR / 4k / 8k / hd_texture / remove_lighting ask with N1
 *       — by flag or by `--data` — is sent (a 400) instead of refused before
 *       the POST, or is silently rewritten to what N1 can do.
 *   F9  The other models lose their defaults: no `--ai-model`, meshy-7 and
 *       meshy-6 must keep PBR on and 4k; multi-view without a model must
 *       keep the meshy-7 pin.
 *   F10 `--ai-model` accepts a value the endpoint refuses (the retired
 *       meshy-5, a typo) and spends a request on it.
 *   F11 `--ai-model latest|meshy-6` with `--multiview-image-urls` is sent;
 *       the API refuses multi-view on every model but meshy-7 and meshy-n1.
 *   F12 The flag stops winning over `--data`: `--ai-model` must beat a
 *       `--data` ai_model, and the defaults must follow the winner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { jsonReply, runCli, startMockApi, type MockApi, type RunResult } from "./helpers/cli.js";

async function withApi(fn: (api: MockApi) => Promise<void>): Promise<void> {
  const api = await startMockApi((req, res) => {
    // The unauthenticated preflight of an http(s) image URL.
    if (req.method === "HEAD" && req.path.startsWith("/views/")) return void res.writeHead(200, { "content-type": "image/png" }).end();
    if (req.method === "POST" && req.path === "/openapi/v1/retexture") return jsonReply(res, 200, { result: "task-new" });
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

const view = (api: MockApi, name: string) => `${api.origin}/views/${name}.png`;
const posts = (api: MockApi) => api.requests.filter((q) => q.method === "POST");
const lastBody = (api: MockApi) => posts(api).at(-1)!.json as Record<string, unknown>;

function retexture(api: MockApi, ...args: string[]): Promise<RunResult> {
  return runCli(["retexture", "create", "--input-task-id", "src-1", "--async", "--format", "json", ...args], { env: api.env() });
}

/** Refused before the POST (exit 2) with a message matching `message`. */
async function assertRefused(api: MockApi, args: string[], message: RegExp): Promise<void> {
  const before = posts(api).length;
  const r = await retexture(api, ...args);
  assert.equal(r.code, 2, `${args.join(" ")}: expected a usage error\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, message, args.join(" "));
  assert.equal(posts(api).length, before, `${args.join(" ")}: nothing may be sent`);
}

// ---------------------------------------------------------------------------
// Meshy N1: what reaches the wire
// ---------------------------------------------------------------------------

test("N1 with one image: ai_model meshy-n1, enable_pbr false, texture_resolution 2k (F1, F2)", async () => {
  await withApi(async (api) => {
    const r = await retexture(api, "--ai-model", "meshy-n1", "--image-style-url", view(api, "front"));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(lastBody(api), {
      input_task_id: "src-1",
      ai_model: "meshy-n1",
      image_style_url: view(api, "front"),
      enable_pbr: false,
      texture_resolution: "2k",
      target_formats: ["glb"],
    });
  });
});

test("N1 multi-view: 1, 2 and 4 views keep their order and stay on meshy-n1 (F3, F4)", async () => {
  await withApi(async (api) => {
    for (const names of [["front"], ["front", "back"], ["front", "left", "back", "right"]]) {
      const urls = names.map((n) => view(api, n));
      const r = await retexture(api, "--ai-model", "meshy-n1", "--multiview-image-urls", urls.join(","));
      assert.equal(r.code, 0, `${names.join(",")}: ${r.stderr}`);
      const body = lastBody(api);
      assert.equal(body["ai_model"], "meshy-n1", `${names.join(",")}: the meshy-7 pin must not replace N1`);
      assert.deepEqual(body["multiview_image_urls"], urls, `${names.join(",")}: the front view stays first, the rest as given`);
      assert.equal(body["enable_pbr"], false);
      assert.equal(body["texture_resolution"], "2k");
      assert.ok(!("image_style_url" in body) && !("text_style_prompt" in body));
    }
  });
});

test("N1 picked through --data gets the same defaults as the flag (F5)", async () => {
  await withApi(async (api) => {
    const single = await retexture(api, "--image-style-url", view(api, "front"), "--data", '{"ai_model":"meshy-n1"}');
    assert.equal(single.code, 0, single.stderr);
    assert.equal(lastBody(api)["ai_model"], "meshy-n1");
    assert.equal(lastBody(api)["enable_pbr"], false);
    assert.equal(lastBody(api)["texture_resolution"], "2k");

    const multi = await retexture(api, "--multiview-image-urls", `${view(api, "front")},${view(api, "back")}`, "--data", '{"ai_model":"meshy-n1"}');
    assert.equal(multi.code, 0, multi.stderr);
    assert.equal(lastBody(api)["ai_model"], "meshy-n1");
    assert.equal(lastBody(api)["enable_pbr"], false);
    assert.equal(lastBody(api)["texture_resolution"], "2k");

    // Everything in --data: the style input too.
    const allData = await retexture(api, "--data", JSON.stringify({ ai_model: "meshy-n1", image_style_url: view(api, "front") }));
    assert.equal(allData.code, 0, allData.stderr);
    assert.equal(lastBody(api)["enable_pbr"], false);
    assert.equal(lastBody(api)["texture_resolution"], "2k");
  });
});

test("N1 takes what it can make when asked explicitly: --enable-pbr false, --texture-resolution 2k", async () => {
  await withApi(async (api) => {
    const r = await retexture(api, "--ai-model", "meshy-n1", "--image-style-url", view(api, "front"), "--enable-pbr", "false", "--texture-resolution", "2k");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lastBody(api)["enable_pbr"], false);
    assert.equal(lastBody(api)["texture_resolution"], "2k");
  });
});

// ---------------------------------------------------------------------------
// Meshy N1: refused before the POST
// ---------------------------------------------------------------------------

test("N1 without a reference image is refused: it does not texture from a prompt (F6)", async () => {
  await withApi(async (api) => {
    const needsImage = /meshy-n1 needs a reference image/;
    await assertRefused(api, ["--ai-model", "meshy-n1", "--text-style-prompt", "rusty metal"], needsImage);
    await assertRefused(api, ["--ai-model", "meshy-n1"], needsImage);
    await assertRefused(api, ["--text-style-prompt", "rusty metal", "--data", '{"ai_model":"meshy-n1"}'], needsImage);
  });
});

test("N1 with a prompt beside an image is refused, not sent for the API to drop (F7)", async () => {
  await withApi(async (api) => {
    await assertRefused(
      api,
      ["--ai-model", "meshy-n1", "--image-style-url", view(api, "front"), "--data", '{"text_style_prompt":"rusty metal"}'],
      /meshy-n1.*--text-style-prompt/,
    );
  });
});

test("N1 with PBR, 4k, 8k, hd_texture or remove_lighting is refused — by flag or by --data (F8)", async () => {
  await withApi(async (api) => {
    const image = ["--ai-model", "meshy-n1", "--image-style-url", view(api, "front")];
    const views = ["--ai-model", "meshy-n1", "--multiview-image-urls", `${view(api, "front")},${view(api, "back")}`];
    const cases: Array<[string[], RegExp]> = [
      [[...image, "--enable-pbr", "true"], /meshy-n1.*--enable-pbr/],
      [[...image, "--texture-resolution", "4k"], /meshy-n1.*--texture-resolution 4k/],
      [[...image, "--texture-resolution", "8k"], /meshy-n1.*--texture-resolution 8k/],
      [[...views, "--texture-resolution", "4k"], /meshy-n1.*--texture-resolution 4k/],
      [[...image, "--remove-lighting", "true"], /meshy-n1.*--remove-lighting/],
      [[...image, "--remove-lighting", "false"], /meshy-n1.*--remove-lighting/],
      [[...image, "--data", '{"enable_pbr":true}'], /meshy-n1.*--enable-pbr/],
      [[...image, "--data", '{"texture_resolution":"8k"}'], /meshy-n1.*--texture-resolution 8k/],
      [[...image, "--data", '{"hd_texture":true}'], /meshy-n1.*hd_texture/],
      [["--image-style-url", view(api, "front"), "--data", '{"ai_model":"meshy-n1","enable_pbr":true}'], /meshy-n1.*--enable-pbr/],
    ];
    for (const [args, message] of cases) await assertRefused(api, args, message);
  });
});

// ---------------------------------------------------------------------------
// Every other model keeps its defaults
// ---------------------------------------------------------------------------

test("without --ai-model the defaults are unchanged: PBR on, 4k, no model; multi-view pins meshy-7 (F9)", async () => {
  await withApi(async (api) => {
    const prompt = await retexture(api, "--text-style-prompt", "rusty metal");
    assert.equal(prompt.code, 0, prompt.stderr);
    assert.deepEqual(lastBody(api), {
      input_task_id: "src-1",
      text_style_prompt: "rusty metal",
      enable_pbr: true,
      texture_resolution: "4k",
      target_formats: ["glb"],
    });

    const image = await retexture(api, "--image-style-url", view(api, "front"));
    assert.equal(image.code, 0, image.stderr);
    assert.ok(!("ai_model" in lastBody(api)), "a single style input leaves the model to the server");
    assert.equal(lastBody(api)["enable_pbr"], true);
    assert.equal(lastBody(api)["texture_resolution"], "4k");

    const urls = [view(api, "front"), view(api, "back")];
    const multi = await retexture(api, "--multiview-image-urls", urls.join(","));
    assert.equal(multi.code, 0, multi.stderr);
    assert.equal(lastBody(api)["ai_model"], "meshy-7");
    assert.deepEqual(lastBody(api)["multiview_image_urls"], urls);
    assert.equal(lastBody(api)["enable_pbr"], true);
    assert.equal(lastBody(api)["texture_resolution"], "4k");
  });
});

test("--ai-model meshy-7, meshy-6 and latest keep PBR on and 4k (F9)", async () => {
  await withApi(async (api) => {
    for (const model of ["meshy-7", "meshy-6", "latest"]) {
      const r = await retexture(api, "--ai-model", model, "--image-style-url", view(api, "front"));
      assert.equal(r.code, 0, `${model}: ${r.stderr}`);
      assert.equal(lastBody(api)["ai_model"], model);
      assert.equal(lastBody(api)["enable_pbr"], true, model);
      assert.equal(lastBody(api)["texture_resolution"], "4k", model);
    }
    const multi = await retexture(api, "--ai-model", "meshy-7", "--multiview-image-urls", view(api, "front"));
    assert.equal(multi.code, 0, multi.stderr);
    assert.equal(lastBody(api)["ai_model"], "meshy-7");
    assert.equal(lastBody(api)["enable_pbr"], true);
    assert.equal(lastBody(api)["texture_resolution"], "4k");
  });
});

// ---------------------------------------------------------------------------
// The flag itself
// ---------------------------------------------------------------------------

test("--ai-model refuses a model the endpoint does not run, before any request (F10)", async () => {
  await withApi(async (api) => {
    for (const model of ["meshy-5", "meshy-7.1", "meshy-n2"]) {
      await assertRefused(api, ["--ai-model", model, "--image-style-url", view(api, "front")], /--ai-model/);
    }
  });
});

test("--ai-model latest or meshy-6 with --multiview-image-urls is refused: multi-view needs meshy-7 or meshy-n1 (F11)", async () => {
  await withApi(async (api) => {
    for (const model of ["latest", "meshy-6"]) {
      await assertRefused(api, ["--ai-model", model, "--multiview-image-urls", view(api, "front")], /--multiview-image-urls.*meshy-7.*meshy-n1/);
    }
  });
});

test("--ai-model beats a --data ai_model, and the defaults follow the winner (F12)", async () => {
  await withApi(async (api) => {
    const toN1 = await retexture(api, "--ai-model", "meshy-n1", "--image-style-url", view(api, "front"), "--data", '{"ai_model":"meshy-7"}');
    assert.equal(toN1.code, 0, toN1.stderr);
    assert.equal(lastBody(api)["ai_model"], "meshy-n1");
    assert.equal(lastBody(api)["enable_pbr"], false);
    assert.equal(lastBody(api)["texture_resolution"], "2k");

    const fromN1 = await retexture(api, "--ai-model", "meshy-7", "--image-style-url", view(api, "front"), "--data", '{"ai_model":"meshy-n1"}');
    assert.equal(fromN1.code, 0, fromN1.stderr);
    assert.equal(lastBody(api)["ai_model"], "meshy-7");
    assert.equal(lastBody(api)["enable_pbr"], true);
    assert.equal(lastBody(api)["texture_resolution"], "4k");
  });
});
