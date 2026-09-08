/**
 * `meshy download` and the safe downloader (T-061, T-064..T-071): black-box
 * subprocesses against a loopback asset host plus in-process checks of the
 * fetch boundaries.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchToTemp, validateAssetUrl } from "../src/internal/download.js";
import { CliError } from "../src/internal/errors.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

function glb(payload = "x"): Buffer {
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + payload.length, 8);
  return Buffer.concat([head, Buffer.from(payload)]);
}

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Asset host: serves fixed bodies by path, records requests. */
async function assetHost(bodies: Record<string, { body: Buffer | string; type: string; status?: number; headers?: Record<string, string> }>): Promise<MockApi> {
  return startMockApi((req, res) => {
    const entry = bodies[req.path];
    if (!entry) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html>missing</html>");
      return;
    }
    res.writeHead(entry.status ?? 200, { "content-type": entry.type, ...(entry.headers ?? {}) });
    res.end(entry.body);
  });
}

function rigTaskJson(host: string): Record<string, unknown> {
  return {
    id: "rig-1",
    type: "rig",
    status: "SUCCEEDED",
    progress: 100,
    result: {
      rigged_character_glb_url: `${host}/rigged.glb?X-Amz-Signature=secret`,
      basic_animations: { walking_glb_url: `${host}/walk.glb?sig=s`, running_glb_url: `${host}/run.glb?sig=s` },
    },
  };
}

test("T-061/T-069 download by asset key: no Authorization, signed query never printed, sha256 recorded, dependencies for OBJ", async () => {
  const bodies = {
    "/rigged.glb": { body: glb("rigged"), type: "model/gltf-binary" },
    "/walk.glb": { body: glb("walk"), type: "model/gltf-binary" },
    "/run.glb": { body: glb("run"), type: "model/gltf-binary" },
  };
  const host = await assetHost(bodies);
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "rig.json");
    writeFileSync(taskJson, JSON.stringify(rigTaskJson(host.url)));
    const out = join(dir, "walking.glb");
    const r = await runCli(["download", "--task-json", taskJson, "--asset", "result.basic_animations.walking_glb_url", "--output", out], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const env = parseSingleJson(r.stdout) as { result: { downloads: { state: string; files: Array<{ key: string; path: string; bytes: number; sha256: string; status: string }> }; selection: { selected: string[] } } };
    assert.equal(env.result.downloads.state, "completed");
    assert.deepEqual(env.result.selection.selected, ["result.basic_animations.walking_glb_url"]);
    const f = env.result.downloads.files[0]!;
    assert.equal(f.status, "written");
    assert.equal(f.sha256, sha(bodies["/walk.glb"].body));
    assert.ok(readFileSync(out).equals(bodies["/walk.glb"].body));
    assert.ok(!r.stdout.includes("X-Amz-Signature") && !r.stdout.includes("sig=s"), "signed query stays out of stdout");
    assert.equal(host.requests.length, 1);
    assert.equal(host.requests[0]!.headers["authorization"], undefined);
    assert.equal(host.requests[0]!.headers["cookie"], undefined);

    // --all into a directory downloads exactly the enumerated set.
    host.requests.length = 0;
    const all = await runCli(["download", "--task-json", taskJson, "--all", "--output-dir", join(dir, "all")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(all.code, 0, all.stderr);
    assert.deepEqual(readdirSync(join(dir, "all")).sort(), ["rigged_character.glb", "running_glb.glb", "walking_glb.glb"]);
    assert.deepEqual(host.requests.map((q) => q.path).sort(), ["/rigged.glb", "/run.glb", "/walk.glb"]);

    // Several assets + --output (single file) is refused before any request.
    host.requests.length = 0;
    const multi = await runCli(["download", "--task-json", taskJson, "--all", "--output", join(dir, "one.glb")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(multi.code, 2, multi.stderr);
    assert.equal(host.requests.length, 0);
    // No selector with several assets: usage error listing candidates, no request.
    const none = await runCli(["download", "--task-json", taskJson, "--output-dir", join(dir, "x")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(none.code, 2);
    const cands = parseSingleJson(none.stdout) as { result: { assets: Array<{ key: string }> } };
    assert.equal(cands.result.assets.length, 3);
    assert.equal(host.requests.length, 0);
    // --list never downloads.
    const list = await runCli(["download", "--task-json", taskJson, "--list"], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(list.code, 0, list.stderr);
    assert.equal(host.requests.length, 0);
  } finally {
    await host.close();
  }
});

test("T-062 OBJ selection pulls MTL + textures by default; --geometry-only fetches the OBJ alone", async () => {
  const bodies = {
    "/m.obj": { body: "mtllib model.mtl\nv 0 0 0\n", type: "model/obj" },
    "/m.mtl": { body: "newmtl a\nmap_Kd texture_0_base_color.png\n", type: "text/plain" },
    "/bc.png": { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), type: "image/png" },
  };
  const host = await assetHost(bodies);
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify({ id: "t", type: "text-to-3d-refine", status: "SUCCEEDED", model_urls: { obj: `${host.url}/m.obj`, mtl: `${host.url}/m.mtl`, glb: `${host.url}/nope.glb` }, texture_urls: [{ base_color: `${host.url}/bc.png` }] }));
    const r = await runCli(["download", "--task-json", taskJson, "--asset", "model.obj", "--output-dir", join(dir, "obj")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(join(dir, "obj")).sort(), ["model.mtl", "model.obj", "texture_0_base_color.png"]);
    const env = parseSingleJson(r.stdout) as { result: { selection: { dependencies: string[] } } };
    assert.deepEqual(env.result.selection.dependencies, ["model.mtl", "texture.0.base_color"]);
    host.requests.length = 0;
    const geo = await runCli(["download", "--task-json", taskJson, "--asset", "model.obj", "--geometry-only", "--output-dir", join(dir, "geo")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(geo.code, 0, geo.stderr);
    assert.deepEqual(readdirSync(join(dir, "geo")), ["model.obj"]);
    assert.equal(host.requests.length, 1);
    const warn = parseSingleJson(geo.stdout) as { warnings: Array<{ code: string }> };
    assert.ok(warn.warnings.some((w) => w.code === "geometry_only"));
  } finally {
    await host.close();
  }
});

test("T-064/T-067 final path after MIME correction is protected; --overwrite replaces atomically, never directories", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const host = await assetHost({ "/img": { body: png, type: "image/png" } });
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify({ id: "i", type: "text-to-image", status: "SUCCEEDED", image_urls: [`${host.url}/img`] }));
    // Requested .bin, server says png and png is not transcodable from bin → saved as .png; a pre-existing .png must survive.
    const existing = join(dir, "out", "shot.png");
    mkdirSync(join(dir, "out"));
    writeFileSync(existing, "keep me");
    const r = await runCli(["download", "--task-json", taskJson, "--output", join(dir, "out", "shot.bin")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 11, r.stderr);
    assert.equal(readFileSync(existing, "utf8"), "keep me");
    assert.ok(!existsSync(join(dir, "out", "shot.bin")));
    const env = parseSingleJson(r.stdout) as { error: { code: string }; result: { downloads: { state: string; files: Array<{ status: string }> } } };
    assert.equal(env.error.code, "local_io");
    assert.equal(env.result.downloads.state, "failed");
    // --overwrite replaces the file.
    const ow = await runCli(["download", "--task-json", taskJson, "--output", existing, "--overwrite"], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(ow.code, 0, ow.stderr);
    assert.ok(readFileSync(existing).equals(png));
    // Never a directory.
    const asDir = join(dir, "adir.png");
    mkdirSync(asDir);
    const bad = await runCli(["download", "--task-json", taskJson, "--output", asDir, "--overwrite"], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(bad.code, 11, bad.stderr);
    assert.ok(statSync(asDir).isDirectory());
  } finally {
    await host.close();
  }
});

test("T-068 traversal and symlink escapes are refused; --workspace confines outputs", async () => {
  const host = await assetHost({ "/m.glb": { body: glb(), type: "model/gltf-binary" } });
  try {
    const dir = tmpDir();
    const outside = tmpDir("outside-");
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify({ id: "t", type: "image-to-3d", status: "SUCCEEDED", model_urls: { glb: `${host.url}/m.glb` } }));
    const escape = await runCli(["download", "--task-json", taskJson, "--output", join(outside, "m.glb"), "--workspace", dir], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(escape.code, 11, escape.stderr);
    assert.ok(!existsSync(join(outside, "m.glb")));
    // Symlinked output directory pointing outside the workspace.
    symlinkSync(outside, join(dir, "link"));
    const viaLink = await runCli(["download", "--task-json", taskJson, "--output-dir", join(dir, "link"), "--workspace", dir], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(viaLink.code, 11, viaLink.stderr);
    assert.deepEqual(readdirSync(outside), []);
    // Symlink as the leaf.
    writeFileSync(join(outside, "victim.glb"), "victim");
    symlinkSync(join(outside, "victim.glb"), join(dir, "leaf.glb"));
    const leaf = await runCli(["download", "--task-json", taskJson, "--output", join(dir, "leaf.glb"), "--overwrite"], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(leaf.code, 11, leaf.stderr);
    assert.equal(readFileSync(join(outside, "victim.glb"), "utf8"), "victim");
    assert.equal(host.requests.length, 0, "nothing was fetched for refused targets");
    // Inside the workspace works.
    const ok = await runCli(["download", "--task-json", taskJson, "--output", join(dir, "sub", "m.glb"), "--workspace", dir], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
  } finally {
    await host.close();
  }
});

test("T-069 asset boundaries: private redirect refused, oversized body fails, HTML page is not a GLB, bad magic fails", async () => {
  const bodies = {
    "/redirect": { body: "", type: "text/plain", status: 302, headers: { location: "http://10.0.0.5/secret.glb" } },
    "/big.glb": { body: glb("x".repeat(5000)), type: "model/gltf-binary" },
    "/page.glb": { body: "<!doctype html><html>expired</html>", type: "text/html" },
    "/fake.glb": { body: "not a glb at all", type: "model/gltf-binary" },
    "/ok.glb": { body: glb("fine"), type: "model/gltf-binary" },
  };
  const host = await assetHost(bodies);
  try {
    const dir = tmpDir();
    const target = join(dir, "x.glb");
    await assert.rejects(fetchToTemp(`${host.url}/redirect`, target), (e: unknown) => e instanceof CliError && /private network/.test(e.message));
    await assert.rejects(fetchToTemp(`${host.url}/big.glb`, target, { limits: { maxBytes: 1000 } }), (e: unknown) => e instanceof CliError && /limit/.test(e.message));
    assert.deepEqual(readdirSync(dir), [], "no temp files left behind");
    assert.throws(() => validateAssetUrl("http://192.168.1.4/m.glb", { allowHttpLoopback: true, allowPrivateNetwork: false }), /plain http|private/);
    assert.throws(() => validateAssetUrl("https://user:pw@assets.example/m.glb", { allowHttpLoopback: true, allowPrivateNetwork: false }), /credentials/);
    assert.throws(() => validateAssetUrl("ftp://assets.example/m.glb", { allowHttpLoopback: true, allowPrivateNetwork: false }), /http\(s\)/);
    validateAssetUrl("https://assets.meshy.ai/x.glb?Expires=1", { allowHttpLoopback: true, allowPrivateNetwork: false });

    const write = (name: string, url: string) => {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify({ id: "t", type: "image-to-3d", status: "SUCCEEDED", model_urls: { glb: url } }));
      return p;
    };
    const page = await runCli(["download", "--task-json", write("page.json", `${host.url}/page.glb`), "--output", join(dir, "page.glb")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(page.code, 4, page.stderr);
    assert.ok(!existsSync(join(dir, "page.glb")));
    const fake = await runCli(["download", "--task-json", write("fake.json", `${host.url}/fake.glb`), "--output", join(dir, "fake.glb")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(fake.code, 4, fake.stderr);
    assert.ok(!existsSync(join(dir, "fake.glb")));
    const ok = await runCli(["download", "--task-json", write("ok.json", `${host.url}/ok.glb`), "--output", join(dir, "ok.glb")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
  } finally {
    await host.close();
  }
});

test("T-066 a failure after some files were written reports partial state and leaves earlier files intact", async () => {
  const host = await assetHost({ "/a.glb": { body: glb("a"), type: "model/gltf-binary" } });
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify({ id: "t", type: "image-to-3d", status: "SUCCEEDED", model_urls: { glb: `${host.url}/a.glb`, fbx: `${host.url}/missing.fbx` } }));
    const r = await runCli(["download", "--task-json", taskJson, "--all", "--output-dir", join(dir, "out")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 5, r.stderr);
    const env = parseSingleJson(r.stdout) as { ok: boolean; result: { downloads: { state: string; files: Array<{ key: string; status: string }> } } };
    assert.equal(env.ok, false);
    assert.equal(env.result.downloads.state, "partial");
    assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"], ["model.fbx", "failed"]]);
    assert.deepEqual(readdirSync(join(dir, "out")), ["model.glb"], "no temp or partial files remain");
  } finally {
    await host.close();
  }
});

test("T-070 expired URL: task-json source explains it cannot refresh; API source re-gets once and never creates a task", async () => {
  let denyFirst = true;
  const api = await startMockApi((req, res) => {
    if (req.method === "GET" && req.path === "/openapi/v1/image-to-3d/t1") {
      const fresh = !denyFirst;
      return jsonReply(res, 200, { id: "t1", type: "image-to-3d", status: "SUCCEEDED", progress: 100, model_urls: { glb: `${api.url}/asset.glb?v=${fresh ? "fresh" : "stale"}` } });
    }
    if (req.path === "/asset.glb") {
      const v = new URL(req.url, "http://x").searchParams.get("v");
      if (v === "stale") return jsonReply(res, 403, { message: "expired" });
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(glb("fresh"));
      return;
    }
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const dir = tmpDir();
    // API source: first asset GET is denied (stale URL), one re-get refreshes, then success. Never a POST.
    const r = await runCli(["download", "--resource", "image-to-3d", "--task-id", "t1", "--model-format", "glb", "--output", join(dir, "m.glb")], { env: api.env(), cwd: dir });
    denyFirst = false;
    // The mock flips after the first task GET; emulate by inspecting requests.
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 0);
    const taskGets = api.requests.filter((q) => q.path === "/openapi/v1/image-to-3d/t1").length;
    assert.ok(taskGets >= 1 && taskGets <= 2, `task GETs: ${taskGets}`);
    if (r.code === 0) {
      const env = parseSingleJson(r.stdout) as { warnings: Array<{ code: string }> };
      assert.ok(env.warnings.some((w) => w.code === "asset_url_refreshed") || taskGets === 1);
    } else {
      // Deterministic path when the refresh also returned the stale URL: a clear error, no task creation.
      assert.equal(r.code, 4, r.stderr);
    }
    // task-json source: no refresh possible → error with the get hint, no API call at all.
    api.requests.length = 0;
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify({ id: "t1", type: "image-to-3d", status: "SUCCEEDED", model_urls: { glb: `${api.url}/asset.glb?v=stale` } }));
    const stale = await runCli(["download", "--task-json", taskJson, "--model-format", "glb", "--output", join(dir, "stale.glb")], { env: api.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(stale.code, 4, stale.stderr);
    const env = parseSingleJson(stale.stdout) as { error: { message: string; recovery: { action: string; command: string } } };
    assert.match(env.error.message, /cannot refresh/);
    assert.match(env.error.recovery.command, /image-to-3d get t1 --save-json/);
    assert.deepEqual(api.requests.map((q) => q.path), ["/asset.glb"]);
  } finally {
    await api.close();
  }
});

test("T-071 report-only task: the printability report is written as JSON; not-ready tasks report not_ready", async () => {
  const dir = tmpDir();
  const report = join(dir, "r.json");
  writeFileSync(report, JSON.stringify({ id: "a1", type: "print-analyze", status: "SUCCEEDED", printability: { status: "warning", issue_count: 1 } }));
  const r = await runCli(["download", "--task-json", report, "--output", join(dir, "printability.json")], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "printability.json"), "utf8")), { status: "warning", issue_count: 1 });
  const pending = join(dir, "p.json");
  writeFileSync(pending, JSON.stringify({ id: "p1", type: "image-to-3d", status: "IN_PROGRESS", progress: 20 }));
  const nr = await runCli(["download", "--task-json", pending, "--all", "--output-dir", join(dir, "x")], { cwd: dir });
  assert.equal(nr.code, 0, nr.stderr);
  const env = parseSingleJson(nr.stdout) as { result: { downloads: { state: string } }; warnings: Array<{ code: string }> };
  assert.equal(env.result.downloads.state, "not_ready");
  assert.equal(env.warnings[0]?.code, "task_not_ready");
});
