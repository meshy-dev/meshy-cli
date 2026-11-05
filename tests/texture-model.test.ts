/**
 * --texture-model on image-to-3d and multi-image-to-3d (PRO-4335), asserted
 * on the wire: a loopback API records the create POST, so every test checks
 * what the server would receive. The loopback API answers every create with
 * 200: these tests prove the request body and the CLI's own refusals, not
 * what the backend does with them.
 *
 * texture_model picks the texture model apart from the geometry: meshy-7
 * (PBR, 2k/4k/8k), meshy-n1 (a 2k base color from the input images, no
 * prompt, no PBR) and meshy-6-lite (2k, PBR, single image only). Omitted,
 * nothing is sent and the geometry's own texture model runs. The API answers
 * 400 for meshy-n1 with a texture prompt, enable_pbr true, 4k/8k (or
 * hd_texture with no resolution), remove_lighting true or a quad remesh; for
 * meshy-6-lite with 4k/8k (or hd_texture) or remove_lighting true; and for
 * meshy-6 / meshy-6-lite on multi-image-to-3d.
 *
 * Failure modes these tests guard:
 *   F1  meshy-n1 inherits the game-ready enable_pbr true / 4k defaults, a 400
 *       on every N1 request.
 *   F2  meshy-6-lite inherits the 4k default, a 400 on every request.
 *   F3  meshy-7, or no --texture-model, loses PBR or 4k; or texture_model is
 *       sent when it was not asked for (the server default must stay).
 *   F4  A texture model set through --data keeps the Meshy 7 defaults.
 *   F5  --data ai_model meshy-6-lite with no texture model gets the 4k
 *       default: its own texture model, Meshy 6 Lite, makes 2k only.
 *   F6  The flag stops beating --data, or the defaults follow the loser.
 *   F7  An ask meshy-n1 cannot do, by flag or by --data, is sent (a 400) or is
 *       quietly rewritten.
 *   F8  An ask meshy-6-lite cannot do is sent; or one it can do (PBR, a
 *       prompt, remove_lighting false) is refused.
 *   F9  --texture-model accepts a value the endpoint refuses (meshy-6, a
 *       typo; meshy-6-lite on multi-image-to-3d) and spends a request.
 *   F10 An untextured run carries a texture model the API would ignore.
 *   F11 meshy-n1 on smart topology or with multi-image texture views is
 *       refused, though the API runs both.
 *   F12 The help loses the model guide, its Models link or the choices.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRootCommand } from "../src/root.js";
import { jsonReply, runCli, startMockApi, tmpDir, type MockApi, type RunResult } from "./helpers/cli.js";

async function withApi(fn: (api: MockApi) => Promise<void>): Promise<void> {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "task-new" }) : jsonReply(res, 500, { message: "unexpected" })));
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

// 1x1 PNGs as local files: the create path inlines them.
const cwd = tmpDir("meshy-texture-model-");
for (const name of ["front.png", "side.png"]) {
  writeFileSync(join(cwd, name), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));
}

type Endpoint = "image-to-3d" | "multi-image-to-3d";
const BASE: Record<Endpoint, string[]> = {
  "image-to-3d": ["image-to-3d", "create", "--image-url", "front.png"],
  "multi-image-to-3d": ["multi-image-to-3d", "create", "--image-urls", "front.png,side.png"],
};
const ENDPOINTS = Object.keys(BASE) as Endpoint[];

const posts = (api: MockApi) => api.requests.filter((q) => q.method === "POST");
const lastBody = (api: MockApi) => posts(api).at(-1)!.json as Record<string, unknown>;

function create(api: MockApi, endpoint: Endpoint, ...args: string[]): Promise<RunResult> {
  return runCli([...BASE[endpoint], "--async", "--format", "json", ...args], { env: api.env(), cwd });
}

/** Sent (exit 0); returns the POST body. */
async function sent(api: MockApi, endpoint: Endpoint, ...args: string[]): Promise<Record<string, unknown>> {
  const r = await create(api, endpoint, ...args);
  assert.equal(r.code, 0, `${endpoint} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return lastBody(api);
}

/** Refused before the POST (exit 2) with a message matching `message`. */
async function assertRefused(api: MockApi, endpoint: Endpoint, args: string[], message: RegExp): Promise<void> {
  const before = posts(api).length;
  const r = await create(api, endpoint, ...args);
  assert.equal(r.code, 2, `${endpoint} ${args.join(" ")}: expected a usage error\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, message, `${endpoint} ${args.join(" ")}`);
  assert.equal(posts(api).length, before, `${endpoint} ${args.join(" ")}: nothing may be sent`);
}

const textureOf = (body: Record<string, unknown>) => ({
  texture_model: body["texture_model"],
  enable_pbr: body["enable_pbr"],
  texture_resolution: body["texture_resolution"],
});

// ---------------------------------------------------------------------------
// Defaults follow the texture model
// ---------------------------------------------------------------------------

for (const endpoint of ENDPOINTS) {
  test(`${endpoint}: --texture-model meshy-n1 sends 2k with PBR off (F1)`, async () => {
    await withApi(async (api) => {
      const body = await sent(api, endpoint, "--texture-model", "meshy-n1");
      assert.deepEqual(textureOf(body), { texture_model: "meshy-n1", enable_pbr: false, texture_resolution: "2k" });
    });
  });

  test(`${endpoint}: meshy-7, or no --texture-model, keeps PBR on and 4k; omitted sends no texture_model (F3)`, async () => {
    await withApi(async (api) => {
      const picked = await sent(api, endpoint, "--texture-model", "meshy-7");
      assert.deepEqual(textureOf(picked), { texture_model: "meshy-7", enable_pbr: true, texture_resolution: "4k" });
      const omitted = await sent(api, endpoint);
      assert.ok(!("texture_model" in omitted), "the server's default texture model applies");
      assert.equal(omitted["enable_pbr"], true);
      assert.equal(omitted["texture_resolution"], "4k");
    });
  });

  test(`${endpoint}: meshy-n1 through --data gets its defaults too (F4)`, async () => {
    await withApi(async (api) => {
      const body = await sent(api, endpoint, "--data", '{"texture_model":"meshy-n1"}');
      assert.deepEqual(textureOf(body), { texture_model: "meshy-n1", enable_pbr: false, texture_resolution: "2k" });
    });
  });

  test(`${endpoint}: the flag beats a --data texture_model, and the defaults follow the winner (F6)`, async () => {
    await withApi(async (api) => {
      const n1Wins = await sent(api, endpoint, "--data", '{"texture_model":"meshy-7"}', "--texture-model", "meshy-n1");
      assert.deepEqual(textureOf(n1Wins), { texture_model: "meshy-n1", enable_pbr: false, texture_resolution: "2k" });
      const meshy7Wins = await sent(api, endpoint, "--data", '{"texture_model":"meshy-n1"}', "--texture-model", "meshy-7");
      assert.deepEqual(textureOf(meshy7Wins), { texture_model: "meshy-7", enable_pbr: true, texture_resolution: "4k" });
    });
  });

  test(`${endpoint}: --data ai_model meshy-6-lite with no texture model sends 2k, its texture model's only size (F5)`, async () => {
    await withApi(async (api) => {
      const lite = await sent(api, endpoint, "--data", '{"ai_model":"meshy-6-lite"}');
      assert.equal(lite["ai_model"], "meshy-6-lite");
      assert.ok(!("texture_model" in lite));
      assert.equal(lite["texture_resolution"], "2k");
      assert.equal(lite["enable_pbr"], true);
      // Meshy 6's own texture model is HD-capable; a picked meshy-7 runs instead of Lite.
      assert.equal((await sent(api, endpoint, "--data", '{"ai_model":"meshy-6"}'))["texture_resolution"], "4k");
      const meshy7 = await sent(api, endpoint, "--data", '{"ai_model":"meshy-6-lite"}', "--texture-model", "meshy-7");
      assert.deepEqual(textureOf(meshy7), { texture_model: "meshy-7", enable_pbr: true, texture_resolution: "4k" });
    });
  });

  test(`${endpoint}: explicit asks the texture model can do are sent as given`, async () => {
    await withApi(async (api) => {
      const meshy7 = await sent(api, endpoint, "--texture-model", "meshy-7", "--texture-resolution", "8k", "--texture-prompt", "rusty iron");
      assert.equal(meshy7["texture_resolution"], "8k");
      assert.equal(meshy7["texture_prompt"], "rusty iron");
      const n1 = await sent(api, endpoint, "--texture-model", "meshy-n1", "--texture-resolution", "2k", "--enable-pbr", "false", "--remove-lighting", "false");
      assert.deepEqual(textureOf(n1), { texture_model: "meshy-n1", enable_pbr: false, texture_resolution: "2k" });
      assert.equal(n1["remove_lighting"], false, "false asks for nothing N1 cannot do");
    });
  });

  // -------------------------------------------------------------------------
  // Refusals: meshy-n1 (F7)
  // -------------------------------------------------------------------------

  test(`${endpoint}: meshy-n1 refuses a prompt, PBR, 4k/8k, hd_texture, remove_lighting true and a quad remesh, by flag or --data (F7)`, async () => {
    await withApi(async (api) => {
      const cases: Array<[string[], RegExp]> = [
        [["--texture-prompt", "rusty iron"], /--texture-prompt/],
        [["--data", '{"texture_prompt":"rusty iron"}'], /--texture-prompt/],
        [["--enable-pbr", "true"], /--enable-pbr true/],
        [["--data", '{"enable_pbr":true}'], /--enable-pbr true/],
        [["--texture-resolution", "4k"], /--texture-resolution 4k/],
        [["--texture-resolution", "8k"], /--texture-resolution 8k/],
        [["--data", '{"texture_resolution":"8k"}'], /--texture-resolution 8k/],
        [["--data", '{"hd_texture":true}'], /hd_texture true/],
        [["--remove-lighting", "true"], /--remove-lighting true/],
        [["--data", '{"should_remesh":true,"topology":"quad"}'], /topology quad/],
      ];
      for (const [extra, message] of cases) {
        await assertRefused(api, endpoint, ["--texture-model", "meshy-n1", ...extra], message);
        await assertRefused(api, endpoint, ["--texture-model", "meshy-n1", ...extra], /--texture-model meshy-n1 cannot be used with/);
      }
      // meshy-n1 picked through --data meets the same rules.
      await assertRefused(api, endpoint, ["--data", '{"texture_model":"meshy-n1"}', "--enable-pbr", "true"], /--texture-model meshy-n1 cannot be used with --enable-pbr true/);
    });
  });

  // -------------------------------------------------------------------------
  // Untextured runs (F10)
  // -------------------------------------------------------------------------

  test(`${endpoint}: a texture model on an untextured run is refused, by flag or --data (F10)`, async () => {
    await withApi(async (api) => {
      for (const extra of [
        ["--should-texture", "false", "--texture-model", "meshy-7"],
        ["--should-texture", "false", "--data", '{"texture_model":"meshy-n1"}'],
        ["--data", '{"should_texture":false,"texture_model":"meshy-n1"}'],
      ]) {
        await assertRefused(api, endpoint, extra, /--texture-model cannot be used with --should-texture false/);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// image-to-3d only: meshy-6-lite, smart topology
// ---------------------------------------------------------------------------

test("image-to-3d: --texture-model meshy-6-lite sends 2k with PBR on (F2)", async () => {
  await withApi(async (api) => {
    const body = await sent(api, "image-to-3d", "--texture-model", "meshy-6-lite");
    assert.deepEqual(textureOf(body), { texture_model: "meshy-6-lite", enable_pbr: true, texture_resolution: "2k" });
  });
});

test("image-to-3d: meshy-6-lite refuses 4k/8k, hd_texture and remove_lighting true, and takes PBR, a prompt and remove_lighting false (F8)", async () => {
  await withApi(async (api) => {
    const cases: Array<[string[], RegExp]> = [
      [["--texture-resolution", "4k"], /--texture-resolution 4k/],
      [["--data", '{"texture_resolution":"8k"}'], /--texture-resolution 8k/],
      [["--data", '{"hd_texture":true}'], /hd_texture true/],
      [["--remove-lighting", "true"], /--remove-lighting true/],
    ];
    for (const [extra, message] of cases) {
      await assertRefused(api, "image-to-3d", ["--texture-model", "meshy-6-lite", ...extra], message);
    }
    const body = await sent(api, "image-to-3d", "--texture-model", "meshy-6-lite", "--enable-pbr", "true", "--texture-prompt", "rusty iron", "--remove-lighting", "false");
    assert.equal(body["enable_pbr"], true);
    assert.equal(body["texture_prompt"], "rusty iron");
    assert.equal(body["remove_lighting"], false);
    // A --data ai_model meshy-6-lite (its own texture model) meets the same 2k rule.
    await assertRefused(api, "image-to-3d", ["--data", '{"ai_model":"meshy-6-lite","texture_model":"meshy-6-lite"}', "--texture-resolution", "4k"], /--texture-resolution 4k/);
  });
});

test("image-to-3d: meshy-n1 on smart topology is sent, with the T2.5 pin and the N1 defaults (F11)", async () => {
  await withApi(async (api) => {
    const body = await sent(api, "image-to-3d", "--model-type", "smart-topology", "--target-polycount", "8000", "--texture-model", "meshy-n1");
    assert.equal(body["model_type"], "smart-topology");
    assert.equal(body["ai_model"], "meshy-t2.5");
    assert.equal(body["target_polycount"], 8000);
    assert.deepEqual(textureOf(body), { texture_model: "meshy-n1", enable_pbr: false, texture_resolution: "2k" });
  });
});

// ---------------------------------------------------------------------------
// multi-image-to-3d only: multi-view texture models
// ---------------------------------------------------------------------------

test("multi-image-to-3d: meshy-n1 takes --texture-image-urls as its views, in the order given (F11)", async () => {
  await withApi(async (api) => {
    const body = await sent(api, "multi-image-to-3d", "--texture-model", "meshy-n1", "--texture-image-urls", "side.png,front.png");
    const views = body["texture_image_urls"] as string[];
    assert.equal(views.length, 2);
    for (const v of views) assert.match(v, /^data:image\/png;base64,/);
    assert.deepEqual(textureOf(body), { texture_model: "meshy-n1", enable_pbr: false, texture_resolution: "2k" });
  });
});

test("multi-image-to-3d: a single-view texture model through --data is refused (F9)", async () => {
  await withApi(async (api) => {
    for (const model of ["meshy-6-lite", "meshy-6"]) {
      await assertRefused(api, "multi-image-to-3d", ["--data", `{"texture_model":"${model}"}`], /multi-view texture models only.*meshy-7 or meshy-n1/);
    }
  });
});

// ---------------------------------------------------------------------------
// The flag surface (F9, F12)
// ---------------------------------------------------------------------------

test("--texture-model refuses a value the endpoint does not take, before any request (F9)", async () => {
  await withApi(async (api) => {
    const refused: Array<[Endpoint, string]> = [
      ["image-to-3d", "meshy-6"],
      ["image-to-3d", "meshy-7.1"],
      ["image-to-3d", "meshy-n2"],
      ["multi-image-to-3d", "meshy-6-lite"],
      ["multi-image-to-3d", "meshy-6"],
    ];
    for (const [endpoint, model] of refused) {
      await assertRefused(api, endpoint, ["--texture-model", model], /--texture-model/);
    }
  });
});

test("create --help carries the model guide, the Models link and how the command reaches each row (F12)", async () => {
  for (const endpoint of ENDPOINTS) {
    const r = await runCli([...BASE[endpoint].slice(0, 2), "--help"]);
    assert.equal(r.code, 0, r.stderr);
    const help = r.stdout;
    assert.match(help, /--texture-model <model>/);
    assert.match(help, /Choose models by project \(geometry ai_model \+ texture_model\):/);
    for (const row of [
      /Detailed hero asset, product render, cinematic prop: +meshy-7\.1 \+ meshy-7 \(PBR, up to 8K\)/,
      /Game character to rig and animate: +meshy-t2\.5 \(smart topology, set target_polycount\) \+ meshy-n1/,
      /Many props for a game scene, or user-generated content: +meshy-t2 \(smart topology\) \+ meshy-n1/,
      /A real object from 2 to 4 photos: +meshy-7\.1 on Multi-Image to 3D \+ meshy-7/,
      /A model to 3D print: +meshy-7\.1 \+ none, or meshy-7 to print in color/,
      /Many drafts at a low cost: +meshy-6-lite \+ meshy-6-lite/,
    ]) {
      assert.match(help, row, endpoint);
    }
    assert.match(help, /More: https:\/\/docs\.meshy\.ai\/en\/api\/models\n/, endpoint);
    assert.match(help, /In this command:/, endpoint);
  }
});

test("--texture-model offers meshy-7, meshy-n1, meshy-6-lite on image-to-3d and the multi-view two on multi-image-to-3d (C1)", () => {
  const root = buildRootCommand();
  const choices = (resource: string) =>
    root.commands.find((c) => c.name() === resource)?.commands.find((c) => c.name() === "create")?.options.find((o) => o.long === "--texture-model")?.argChoices;
  assert.deepEqual(choices("image-to-3d"), ["meshy-7", "meshy-n1", "meshy-6-lite"]);
  assert.deepEqual(choices("multi-image-to-3d"), ["meshy-7", "meshy-n1"]);
});
