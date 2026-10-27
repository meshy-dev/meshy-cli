/**
 * Texturing on image-to-3d and multi-image-to-3d, asserted on the wire: the
 * CLI textures by default like the API, `should_texture: false` (flag or
 * --data) is the untextured draft, and texture settings never reach an
 * untextured run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonReply, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

async function withApi(fn: (api: MockApi) => Promise<void>): Promise<void> {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "task-new" }) : jsonReply(res, 500, { message: "unexpected" })));
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

// A 1x1 PNG as local files: the create path inlines them (a data: URI cannot ride the --image-urls CSV).
const cwd = tmpDir("meshy-texturing-");
for (const view of ["front.png", "side.png"]) {
  writeFileSync(join(cwd, view), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));
}
const COMMANDS: Record<string, string[]> = {
  "image-to-3d": ["image-to-3d", "create", "--image-url", "front.png", "--async"],
  "multi-image-to-3d": ["multi-image-to-3d", "create", "--image-urls", "front.png,side.png", "--async"],
};

for (const [name, base] of Object.entries(COMMANDS)) {
  test(`${name}: textured by default with the game-ready settings; should_texture is left to the API`, async () => {
    await withApi(async (api) => {
      const r = await runCli(base, { env: api.env(), cwd });
      assert.equal(r.code, 0, r.stderr);
      const body = api.requests[0]!.json as Record<string, unknown>;
      assert.ok(!("should_texture" in body), "the API default (true) applies");
      assert.equal(body["enable_pbr"], true);
      assert.equal(body["texture_resolution"], "4k");
    });
  });

  test(`${name}: should_texture false — by flag or by --data — is a draft with no texture settings`, async () => {
    await withApi(async (api) => {
      for (const extra of [["--should-texture", "false"], ["--data", '{"should_texture":false}']]) {
        const r = await runCli([...base, ...extra], { env: api.env(), cwd });
        assert.equal(r.code, 0, `${extra.join(" ")}: ${r.stderr}`);
        const body = api.requests.at(-1)!.json as Record<string, unknown>;
        assert.equal(body["should_texture"], false, extra.join(" "));
        assert.ok(!("enable_pbr" in body) && !("texture_resolution" in body), `${extra.join(" ")}: no texture settings on an untextured run`);
      }
    });
  });

  test(`${name}: a texture setting with should_texture false is refused before the POST`, async () => {
    await withApi(async (api) => {
      for (const extra of [
        ["--should-texture", "false", "--texture-resolution", "2k"],
        ["--data", '{"should_texture":false}', "--enable-pbr", "true"],
        ["--should-texture", "false", "--data", '{"texture_prompt":"rusty"}'],
      ]) {
        const r = await runCli([...base, ...extra, "--format", "json"], { env: api.env(), cwd });
        assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stdout}`);
        assert.match(r.stdout, /cannot be used with --should-texture false/);
      }
      assert.equal(api.requests.length, 0);
    });
  });
}
