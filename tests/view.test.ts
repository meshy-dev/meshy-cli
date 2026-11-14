/**
 * view — the local model viewer (D-094). Drives the built CLI: argument
 * checks, the detached server and what it will and will not serve, and the
 * foreground server stopping on Ctrl-C. No network: the page is fetched, never
 * rendered.
 */

process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { viewerPage } from "../src/internal/viewer.js";
import { parseSingleJson, runCli, tmpDir } from "./helpers/cli.js";

const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);

interface Reply {
  status: number;
  type: string | undefined;
  body: Buffer;
}

function get(url: string, path: string, opts: { method?: string; host?: string } = {}): Promise<Reply> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function detach(file: string): Promise<{ url: string; pid: number; result: Record<string, unknown> }> {
  const run = await runCli(["view", file, "--detach", "--no-open", "--format", "json"]);
  assert.equal(run.code, 0, run.stderr);
  const result = (parseSingleJson(run.stdout) as { result: Record<string, unknown> }).result;
  return { url: String(result["url"]), pid: Number(result["pid"]), result };
}

test("view refuses a missing file, another format and a .glb that is not glTF", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "model.obj"), "v 0 0 0\n");
  writeFileSync(join(dir, "fake.glb"), "not a model");
  for (const [file, pattern] of [
    [join(dir, "missing.glb"), /model not found/],
    [join(dir, "model.obj"), /shows \.glb and \.gltf/],
    [join(dir, "fake.glb"), /not a binary glTF/],
  ] as const) {
    const run = await runCli(["view", file, "--no-open", "--format", "json"]);
    assert.equal(run.code, 2, `${file}: ${run.stderr}`);
    assert.match(run.stderr, pattern);
  }
});

test("view --detach serves the page, the model and the environment, and nothing else", async (t) => {
  const dir = tmpDir();
  const file = join(dir, "chest.glb");
  writeFileSync(file, GLB);
  writeFileSync(join(dir, "chest_meta.json"), '{"model_urls":{"glb":"https://signed.example/secret"}}');
  const { url, pid, result } = await detach(file);
  t.after(() => process.kill(pid));
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(result["file"], file);
  assert.equal(result["detached"], true);
  assert.equal(result["opened"], false);

  const page = await get(url, "/");
  assert.equal(page.status, 200);
  assert.match(String(page.type), /^text\/html/);
  assert.match(String(page.body), /"integrity":\{"https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\/build\/three\.module\.min\.js":"sha384-/);

  const model = await get(url, "/model.glb");
  assert.equal(model.status, 200);
  assert.equal(model.type, "model/gltf-binary");
  assert.deepEqual(model.body, GLB);
  const env = await get(url, "/env.hdr");
  assert.equal(env.status, 200);
  assert.match(String(env.body.subarray(0, 10)), /^#\?RADIANCE/);

  for (const path of ["/chest.glb", "/chest_meta.json", "/../chest_meta.json", "/%2e%2e/etc/passwd", "/model.gltf"]) {
    assert.equal((await get(url, path)).status, 404, path);
  }
  assert.equal((await get(url, "/model.glb", { method: "POST" })).status, 405);
  assert.equal((await get(url, "/model.glb", { host: "attacker.example" })).status, 403);
});

test("view serves a .gltf's buffers and textures beside it, never other files or links out", async (t) => {
  const dir = tmpDir();
  const outside = tmpDir();
  mkdirSync(join(dir, "tex"));
  writeFileSync(join(dir, "scene.gltf"), '{"asset":{"version":"2.0"}}');
  writeFileSync(join(dir, "scene.bin"), "buffer");
  writeFileSync(join(dir, "tex", "albedo.png"), "png");
  writeFileSync(join(dir, "notes.txt"), "text");
  writeFileSync(join(outside, "secret.png"), "outside");
  symlinkSync(join(outside, "secret.png"), join(dir, "link.png"));
  const { url, pid } = await detach(join(dir, "scene.gltf"));
  t.after(() => process.kill(pid));

  assert.equal((await get(url, "/model.gltf")).type, "model/gltf+json");
  assert.equal((await get(url, "/scene.bin")).status, 200);
  assert.equal((await get(url, "/tex/albedo.png")).status, 200);
  for (const path of ["/notes.txt", "/link.png", "/scene.gltf/../notes.txt"]) {
    assert.equal((await get(url, path)).status, 404, path);
  }
});

test("view in the foreground prints the URL, serves, and stops on Ctrl-C", async () => {
  const dir = tmpDir();
  const file = join(dir, "chest.glb");
  writeFileSync(file, GLB);
  let served: Reply | undefined;
  const run = await runCli(["view", file, "--no-open", "--format", "json"], {
    sigintAfterMs: 3_000,
    onSpawn: (child) => {
      child.stdout!.once("data", (chunk: Buffer) => {
        const url = String((JSON.parse(String(chunk)) as { result: { url: string } }).result.url);
        void get(url, "/model.glb").then((r) => (served = r));
      });
    },
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal((parseSingleJson(run.stdout) as { result: { detached: boolean } }).result.detached, false);
  assert.equal(served?.status, 200);
});

test("the page names the model safely in HTML and in script", () => {
  const html = viewerPage({ path: '/tmp/x<img src=y onerror=alert(1)>".glb', ext: ".glb", bytes: 1 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<title>x&#60;img src=y onerror=alert\(1\)&#62;&#34;\.glb<\/title>/);
  assert.ok(html.includes('note.textContent = "x\\u003cimg src=y onerror=alert(1)>\\".glb";'));
});
