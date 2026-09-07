/**
 * Codex review round 2 (reviews/cli-s1-730132b, R2-F01–R2-F07) as positive
 * regressions. Every scenario mirrors the reviewer's probe (N01–N08) with real
 * subprocesses, a loopback API/asset host that records every request, synthetic
 * credentials and isolated temp directories; each asserts the required
 * behaviour: exit code, envelope shape, task_id/submission, request counts,
 * bytes on disk, per-file manifests, one ndjson outcome with increasing sequence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { credentialBinding } from "../src/internal/operation-store.js";
import { jsonReply, parseNdjson, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

const V1 = ["--output-schema", "v1"];
const CREATE = ["text-to-3d", "create", "--mode", "preview", "--prompt", "round two", "--async", ...V1];

function taskBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "round2-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, ...fields };
}

function glb(payload = "x"): Buffer {
  const chunk = Buffer.from(`{"asset":{"version":"2.0"},"x":"${payload}"}   `);
  const head = Buffer.alloc(20);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + chunk.length, 8);
  head.writeUInt32LE(chunk.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, chunk]);
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Directory snapshot (names only) — used to prove nothing appeared outside a boundary. */
function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : ["<absent>"];
}

function localEnv(): Record<string, string | undefined> {
  return { PATH: process.env["PATH"], HOME: process.env["HOME"], MESHY_CLI_NO_UPDATE_NOTIFIER: "1", MESHY_CONFIG_DIR: tmpDir("cfg-") };
}

async function pngBytes(color: string): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
}

// ---------------------------------------------------------------------------
// R2-F01 / N01 — report-only tasks honour --workspace like every other write
// ---------------------------------------------------------------------------

test("N01/R2-F01 analyze-printability get/wait/stream -o: outside targets are refused before any directory exists; inside works", async () => {
  const report = taskBody({ type: "print-analyze", printability: { status: "healthy", issue_count: 0 } });
  const api = await startMockApi((req, res) => {
    if (req.path.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(report)}\n\n`);
      return;
    }
    return jsonReply(res, 200, report);
  });
  try {
    const dir = tmpDir();
    const workspace = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    const env = api.env();
    const outsideBefore = listing(outside);
    for (const verb of ["get", "wait", "stream"]) {
      // File form.
      const file = join(outside, `report-${verb}`, "report.json");
      const r = await runCli(["analyze-printability", verb, "round2-task", ...V1, "--workspace", workspace, "-o", file], { env, cwd: dir });
      assert.equal(r.code, 11, `${verb} file: ${r.stderr}\n${r.stdout}`);
      const out = (verb === "stream" ? parseSingleJson(r.stdout) : parseSingleJson(r.stdout)) as { error: { code: string }; result: { task_id: string; downloads: { state: string } } };
      assert.equal(out.error.code, "local_io");
      assert.equal(out.result.task_id, "round2-task");
      assert.equal(out.result.downloads.state, "failed");
      assert.ok(!existsSync(join(outside, `report-${verb}`)), `${verb}: the parent directory was not created`);
      // Directory form.
      const d = await runCli(["analyze-printability", verb, "round2-task", ...V1, "--workspace", workspace, "-o", join(outside, `dir-${verb}`)], { env, cwd: dir });
      assert.equal(d.code, 11, `${verb} dir: ${d.stderr}`);
      assert.ok(!existsSync(join(outside, `dir-${verb}`)));
    }
    assert.deepEqual(listing(outside), outsideBefore, "nothing outside the workspace changed");
    // Symlinked parent inside the workspace pointing outside.
    symlinkSync(outside, join(workspace, "link"));
    const viaLink = await runCli(["analyze-printability", "get", "round2-task", ...V1, "--workspace", workspace, "-o", join(workspace, "link", "report.json")], { env, cwd: dir });
    assert.equal(viaLink.code, 11, viaLink.stderr);
    assert.deepEqual(listing(outside), outsideBefore);
    // Legacy schema, same boundary.
    const legacy = await runCli(["analyze-printability", "get", "round2-task", "--workspace", workspace, "-o", join(outside, "legacy.json")], { env, cwd: dir });
    assert.equal(legacy.code, 11, legacy.stderr);
    assert.deepEqual(listing(outside), outsideBefore);
    // Inside the workspace: file and directory forms both write the report.
    const okFile = await runCli(["analyze-printability", "get", "round2-task", ...V1, "--workspace", workspace, "-o", join(workspace, "reports", "r.json")], { env, cwd: dir });
    assert.equal(okFile.code, 0, `${okFile.stderr}\n${okFile.stdout}`);
    const saved = JSON.parse(readFileSync(join(workspace, "reports", "r.json"), "utf8")) as { task: { printability: { status: string } } };
    assert.equal(saved.task.printability.status, "healthy");
    assert.equal((parseSingleJson(okFile.stdout) as { result: { downloads: { state: string; metadata_path: string } } }).result.downloads.state, "completed");
    const okDir = await runCli(["analyze-printability", "wait", "round2-task", ...V1, "--workspace", workspace, "-o", join(workspace, "report-dir")], { env, cwd: dir });
    assert.equal(okDir.code, 0, okDir.stderr);
    assert.ok(existsSync(join(workspace, "report-dir", "meta.json")));
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F01 / N02 — the implicit history root is confined too
// ---------------------------------------------------------------------------

test("N02/R2-F01 --workspace equal to the project dir: metadata is recorded, the parent's index/lock/temp files are never touched (record, task --project, download --project)", async () => {
  const api = await startMockApi((req, res) => {
    if (req.path === "/asset.glb") {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb());
    }
    return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/asset.glb` } }));
  });
  try {
    const dir = tmpDir();
    const root = join(dir, "project-root");
    const env = api.env();
    const init = await runCli(["project", "init", "--root", root, "--name", "review"], { env, cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    const projectDir = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    unlinkSync(join(root, "history.json"));
    const rootBefore = listing(root);

    const rec = await runCli(["project", "record", "--project", projectDir, "--workspace", projectDir, "--task-id", "round2-task", "--stage", "preview"], { env, cwd: dir });
    assert.equal(rec.code, 0, `${rec.stderr}\n${rec.stdout}`);
    const ro = parseSingleJson(rec.stdout) as { result: { index: { updated: boolean; error: string }; task_count: number }; warnings: Array<{ code: string }> };
    assert.equal(ro.result.index.updated, false);
    assert.match(ro.result.index.error, /outside --workspace/);
    assert.equal(ro.result.task_count, 1, "metadata inside the workspace was recorded");
    assert.ok(ro.warnings.some((w) => w.code === "index_dirty"));
    assert.deepEqual(listing(root), rootBefore, "no history.json, lock or temp file appeared in the parent");

    const get = await runCli(["text-to-3d", "get", "round2-task", ...V1, "--project", projectDir, "--workspace", projectDir], { env, cwd: dir });
    assert.equal(get.code, 0, `${get.stderr}\n${get.stdout}`);
    const go = parseSingleJson(get.stdout) as { result: { project: { index: { updated: boolean } } }; warnings: Array<{ code: string }> };
    assert.equal(go.result.project.index.updated, false);
    assert.ok(go.warnings.some((w) => w.code === "index_dirty"));
    assert.deepEqual(listing(root), rootBefore);

    const taskJson = join(projectDir, "t.json");
    writeFileSync(taskJson, JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/asset.glb` } })));
    const dl = await runCli(["download", "--task-json", taskJson, "--asset", "model.glb", "--project", projectDir, "--workspace", projectDir], { env, cwd: dir });
    assert.equal(dl.code, 0, `${dl.stderr}\n${dl.stdout}`);
    assert.ok((parseSingleJson(dl.stdout) as { warnings: Array<{ code: string }> }).warnings.some((w) => w.code === "index_dirty"));
    assert.ok(existsSync(join(projectDir, "model.glb")));
    assert.deepEqual(listing(root), rootBefore);

    // An explicit --root outside the workspace stays a refusal before any write.
    const outsideRoot = join(dir, "elsewhere");
    const explicit = await runCli(["project", "record", "--project", projectDir, "--workspace", projectDir, "--root", outsideRoot, "--task-id", "t2", "--stage", "preview"], { env, cwd: dir });
    assert.equal(explicit.code, 11, explicit.stderr);
    assert.ok(!existsSync(outsideRoot));
    // Workspace containing both project and root: the index is written normally.
    const normal = await runCli(["project", "record", "--project", projectDir, "--workspace", root, "--task-id", "t3", "--stage", "preview"], { env, cwd: dir });
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal((parseSingleJson(normal.stdout) as { result: { index: { updated: boolean } } }).result.index.updated, true);
    assert.ok(existsSync(join(root, "history.json")));
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F01 / N03 — a refused download creates no directory
// ---------------------------------------------------------------------------

test("N03/R2-F01 download: a target outside --workspace is refused before mkdir (directory and file forms), with zero requests", async () => {
  const host = await startMockApi((_req, res) => {
    res.writeHead(200, { "content-type": "model/gltf-binary" });
    res.end(glb());
  });
  try {
    const dir = tmpDir();
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const outside = join(dir, "standalone-outside");
    const env = host.env({ MESHY_API_KEY: undefined });
    const byDir = await runCli(["download", "--url", `${host.url}/model.glb`, "--workspace", workspace, "--output-dir", join(outside, "new-subdir")], { env, cwd: dir });
    assert.equal(byDir.code, 11, byDir.stderr);
    assert.equal((parseSingleJson(byDir.stdout) as { error: { code: string } }).error.code, "local_io");
    assert.ok(!existsSync(outside), "neither the target nor its parent was created");
    const byFile = await runCli(["download", "--url", `${host.url}/model.glb`, "--workspace", workspace, "--output", join(outside, "sub", "model.glb")], { env, cwd: dir });
    assert.equal(byFile.code, 11, byFile.stderr);
    assert.ok(!existsSync(outside));
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify(taskBody({ model_urls: { glb: `${host.url}/model.glb` } })));
    const byTask = await runCli(["download", "--task-json", taskJson, "--all", "--workspace", workspace, "--output-dir", join(outside, "x")], { env, cwd: dir });
    assert.equal(byTask.code, 11, byTask.stderr);
    assert.ok(!existsSync(outside));
    assert.equal(host.requests.length, 0, "nothing was fetched for a refused target");
    const inside = await runCli(["download", "--url", `${host.url}/model.glb`, "--workspace", workspace, "--output-dir", join(workspace, "new", "deep")], { env, cwd: dir });
    assert.equal(inside.code, 0, inside.stderr);
    assert.ok(existsSync(join(workspace, "new", "deep")));
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F02 / N04 — multi-material texture mapping
// ---------------------------------------------------------------------------

async function materialHost(files: Record<string, { body: Buffer | string; type: string }>): Promise<MockApi> {
  return startMockApi((req, res) => {
    const entry = files[req.path];
    if (!entry) return jsonReply(res, 404, {});
    res.writeHead(200, { "content-type": entry.type });
    res.end(entry.body);
  });
}

test("N04/R2-F02 two material groups keep distinct textures: source names decide, never the first candidate; case/dir/extension variants resolve", async () => {
  const red = await pngBytes("#ff0000");
  const green = await pngBytes("#00ff00");
  const obj = "mtllib character.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 1\nusemtl body\nf 1 2 3\nusemtl eyes\nf 3 2 1\n";
  const mtl = "newmtl body\nmap_Kd body.png\nmap_Bump -bm 0.5 textures/Body_N.PNG\nnewmtl eyes\nmap_Kd eyes.jpeg\nmap_Bump eyes_n.png\n";
  const host = await materialHost({
    "/character.obj": { body: obj, type: "model/obj" },
    "/character.mtl": { body: mtl, type: "text/plain" },
    "/assets/body.png": { body: red, type: "image/png" },
    "/assets/body_n.png": { body: red, type: "image/png" },
    "/assets/eyes.jpg": { body: green, type: "image/png" },
    "/assets/eyes_n.png": { body: green, type: "image/png" },
  });
  try {
    const dir = tmpDir();
    const fixture = join(dir, "multi.json");
    writeFileSync(
      fixture,
      JSON.stringify(
        taskBody({
          model_urls: { obj: `${host.url}/character.obj`, mtl: `${host.url}/character.mtl` },
          texture_urls: [
            { base_color: `${host.url}/assets/body.png?sig=1`, normal: `${host.url}/assets/body_n.png?sig=2` },
            { base_color: `${host.url}/assets/eyes.jpg?sig=3`, normal: `${host.url}/assets/eyes_n.png?sig=4` },
          ],
        }),
      ),
    );
    const out = join(dir, "materials");
    const r = await runCli(["download", "--task-json", fixture, "--model-format", "obj", "--output-dir", out], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    const savedMtl = readFileSync(join(out, "model.mtl"), "utf8");
    const lines = savedMtl.split("\n");
    const body = lines.indexOf("newmtl body");
    const eyes = lines.indexOf("newmtl eyes");
    assert.equal(lines[body + 1], "map_Kd texture_0_base_color.png", "body base color → set 0 (source name body.png)");
    assert.equal(lines[body + 2], "map_Bump -bm 0.5 texture_0_normal.png", "body normal → set 0 (source name, directory and case ignored)");
    assert.equal(lines[eyes + 1], "map_Kd texture_1_base_color.png", "eyes base color → set 1 (source stem eyes, .jpeg vs .jpg)");
    assert.equal(lines[eyes + 2], "map_Bump texture_1_normal.png", "eyes normal → set 1");
    for (const ref of ["texture_0_base_color.png", "texture_0_normal.png", "texture_1_base_color.png", "texture_1_normal.png"]) assert.ok(existsSync(join(out, ref)));
    assert.ok(readFileSync(join(out, "texture_1_base_color.png")).equals(green), "set 1 really is the second texture");
    const env = parseSingleJson(r.stdout) as { warnings: Array<{ code: string }>; result: { downloads: { material_links: { status: string; texture_maps: Array<{ material: string; reference: string; resolved_to: string; method: string }> } } } };
    assert.equal(env.result.downloads.material_links.status, "complete");
    assert.deepEqual(
      env.result.downloads.material_links.texture_maps.map((l) => [l.material, l.reference, l.resolved_to, l.method]),
      [
        ["body", "body.png", "texture_0_base_color.png", "source_name"],
        ["body", "textures/Body_N.PNG", "texture_0_normal.png", "source_name"],
        ["eyes", "eyes.jpeg", "texture_1_base_color.png", "source_stem"],
        ["eyes", "eyes_n.png", "texture_1_normal.png", "source_name"],
      ],
    );
    assert.ok(!env.warnings.some((w) => w.code.startsWith("material_reference")));

    // Legacy `-o` uses the same mapping.
    const api = await startMockApi((req, res) => {
      if (req.path.startsWith("/openapi/")) {
        return jsonReply(res, 200, taskBody({ model_urls: { obj: `${host.url}/character.obj`, mtl: `${host.url}/character.mtl` }, texture_urls: [{ base_color: `${host.url}/assets/body.png` }, { base_color: `${host.url}/assets/eyes.jpg` }] }));
      }
      return jsonReply(res, 404, {});
    });
    try {
      const legacyOut = join(dir, "legacy");
      const legacy = await runCli(["text-to-3d", "get", "round2-task", "-o", legacyOut], { env: api.env(), cwd: dir });
      assert.equal(legacy.code, 0, legacy.stderr);
      const lm = readFileSync(join(legacyOut, "model.mtl"), "utf8");
      assert.match(lm, /^map_Kd texture_0_base_color\.png$/m);
      assert.match(lm, /^map_Kd texture_1_base_color\.png$/m);
    } finally {
      await api.close();
    }
  } finally {
    await host.close();
  }
});

test("N04/R2-F02 ambiguous references stay as written and are reported: two base-color candidates, no source match → no guess", async () => {
  const red = await pngBytes("#ff0000");
  const green = await pngBytes("#00ff00");
  const mtl = "newmtl body\nmap_Kd skin.png\nnewmtl eyes\nmap_Kd face.png\n";
  const host = await materialHost({
    "/c.obj": { body: "mtllib c.mtl\nv 0 0 0\n", type: "model/obj" },
    "/c.mtl": { body: mtl, type: "text/plain" },
    "/a.png": { body: red, type: "image/png" },
    "/b.png": { body: green, type: "image/png" },
  });
  try {
    const dir = tmpDir();
    const fixture = join(dir, "ambiguous.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/c.obj`, mtl: `${host.url}/c.mtl` }, texture_urls: [{ base_color: `${host.url}/a.png` }, { base_color: `${host.url}/b.png` }] })));
    const out = join(dir, "amb");
    const r = await runCli(["download", "--task-json", fixture, "--model-format", "obj", "--output-dir", out], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    const savedMtl = readFileSync(join(out, "model.mtl"), "utf8");
    assert.match(savedMtl, /^map_Kd skin\.png$/m, "kept as written");
    assert.match(savedMtl, /^map_Kd face\.png$/m, "kept as written");
    assert.ok(!savedMtl.includes("texture_0_base_color.png"), "the first candidate was not picked");
    const env = parseSingleJson(r.stdout) as { warnings: Array<{ code: string; message: string }>; result: { downloads: { state: string; material_links: { status: string; texture_maps: Array<{ reference: string; resolved_to: string | null; method: string; candidates?: string[] }> } } } };
    assert.equal(env.result.downloads.state, "completed", "every file landed");
    assert.equal(env.result.downloads.material_links.status, "incomplete");
    assert.deepEqual(env.result.downloads.material_links.texture_maps.map((l) => [l.reference, l.resolved_to, l.method, l.candidates]), [
      ["skin.png", null, "ambiguous", ["texture_0_base_color.png", "texture_1_base_color.png"]],
      ["face.png", null, "ambiguous", ["texture_0_base_color.png", "texture_1_base_color.png"]],
    ]);
    const warn = env.warnings.find((w) => w.code === "material_reference_ambiguous");
    assert.ok(warn, "ambiguity is warned");
    assert.match(warn!.message, /skin\.png.*texture_0_base_color\.png or texture_1_base_color\.png/);
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F03 / N05 — every post-stream failure ends in one outcome event
// ---------------------------------------------------------------------------

test("N05/R2-F03 stream: save-json conflict, project failure and download failure each end in exactly one outcome with the next sequence", async () => {
  const api = await startMockApi((req, res) => {
    if (req.path.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/missing.glb` } }))}\n\n`);
      return;
    }
    return jsonReply(res, 404, { message: "gone" });
  });
  try {
    const dir = tmpDir();
    const occupied = join(dir, "occupied.json");
    writeFileSync(occupied, "do not overwrite");
    const cases: Array<[string, string[], number, string]> = [
      ["save-json conflict", ["--save-json", occupied], 11, "local_io"],
      ["project not initialised", ["--project", join(dir, "nope")], 11, "local_io"],
      ["asset 404", ["-o", join(dir, "asset.glb")], 5, "not_found"],
    ];
    for (const [label, extra, exitCode, code] of cases) {
      const nd = await runCli(["text-to-3d", "stream", "round2-task", ...V1, "--format", "ndjson", ...extra], { env: api.env(), cwd: dir });
      assert.equal(nd.code, exitCode, `${label}: ${nd.stderr}\n${nd.stdout}`);
      const lines = parseNdjson(nd.stdout) as Array<{ event?: string; sequence?: number; ok: boolean; error: { code: string } | null; result: { task_id: string; task: { status: string } } }>;
      assert.deepEqual(lines.map((l) => l.event), ["task", "outcome"], `${label}: one task event, one outcome`);
      assert.deepEqual(lines.map((l) => l.sequence), [1, 2], `${label}: sequence keeps counting`);
      assert.equal(lines[1]!.ok, false);
      assert.equal(lines[1]!.error!.code, code);
      assert.equal(lines[1]!.result.task_id, "round2-task");
      assert.equal(lines[1]!.result.task.status, "SUCCEEDED");
      // json/pretty: exactly one final document with the same classification.
      const js = await runCli(["text-to-3d", "stream", "round2-task", ...V1, ...extra], { env: api.env(), cwd: dir });
      assert.equal(js.code, exitCode, `${label} json: ${js.stderr}`);
      const env = parseSingleJson(js.stdout) as { ok: boolean; error: { code: string }; result: { task_id: string } };
      assert.equal(env.ok, false);
      assert.equal(env.error.code, code);
      assert.equal(env.result.task_id, "round2-task");
      const pretty = await runCli(["text-to-3d", "stream", "round2-task", ...V1, "--format", "pretty", ...extra], { env: api.env(), cwd: dir });
      assert.equal(pretty.code, exitCode, `${label} pretty: ${pretty.stderr}`);
      assert.equal((pretty.stdout.match(/^ok: false$/gm) ?? []).length, 1, `${label} pretty: one result`);
    }
    assert.equal(readFileSync(occupied, "utf8"), "do not overwrite");
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F04 / N06 — partial downloads keep their manifest and HTTP class
// ---------------------------------------------------------------------------

test("N06/R2-F04 task -o: first asset written, second asset 503/404/403 → the manifest lists both, the HTTP class and status survive, files stay on disk", async () => {
  let second: { status: number; body: unknown } = { status: 503, body: { message: "temporary asset host outage" } };
  const api = await startMockApi((req, res) => {
    if (req.path === "/first.glb") {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb("first"));
    }
    if (req.path === "/second.png") return jsonReply(res, second.status, second.body);
    if (req.method === "POST") return jsonReply(res, 200, { result: "round2-task" });
    return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/first.glb` }, thumbnail_url: `${api.url}/second.png` }));
  });
  try {
    const dir = tmpDir();
    const expectations: Array<[number, number, string]> = [
      [503, 7, "network"],
      [404, 5, "not_found"],
      [403, 4, "validation"],
    ];
    for (const [status, exitCode, code] of expectations) {
      second = { status, body: { message: `asset ${status}` } };
      for (const verb of ["get", "wait"]) {
        const out = join(dir, `${verb}-${status}`);
        const r = await runCli(["text-to-3d", verb, "round2-task", ...V1, "-o", out], { env: api.env(), cwd: dir });
        assert.equal(r.code, exitCode, `${verb} ${status}: ${r.stderr}\n${r.stdout}`);
        const env = parseSingleJson(r.stdout) as { error: { code: string; http_status: number }; result: { task_id: string; downloads: { state: string; files: Array<{ key: string; path: string; status: string; sha256: string; error: string | null }> } } };
        assert.equal(env.error.code, code);
        assert.equal(env.error.http_status, status);
        assert.equal(env.result.task_id, "round2-task");
        assert.equal(env.result.downloads.state, "partial");
        assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "written"], ["thumbnail", "failed"]]);
        const written = env.result.downloads.files[0]!;
        assert.equal(written.path, join(out, "model.glb"));
        assert.ok(existsSync(written.path), "the committed file is not rolled back");
        assert.equal(sha(written.path), written.sha256);
        assert.match(env.result.downloads.files[1]!.error ?? "", new RegExp(String(status)));
        assert.ok(!existsSync(join(out, "meta.json")), "no sidecar for an incomplete set");
        assert.deepEqual(readdirSync(out), ["model.glb"], "no temp files linger");
      }
    }
    // make: same rule on its final download.
    second = { status: 503, body: { message: "outage" } };
    const makeOut = join(dir, "make-out");
    const mk = await runCli(["make", "a cactus", ...V1, "-o", makeOut], { env: api.env(), cwd: dir });
    assert.equal(mk.code, 7, `${mk.stderr}\n${mk.stdout}`);
    const mo = parseSingleJson(mk.stdout) as { error: { code: string; http_status: number }; result: { task_id: string; executed: unknown[]; downloads: { state: string; files: Array<{ key: string; status: string }> } } };
    assert.equal(mo.error.code, "network");
    assert.equal(mo.error.http_status, 503);
    assert.equal(mo.result.task_id, "round2-task");
    assert.equal(mo.result.executed.length, 2);
    assert.equal(mo.result.downloads.state, "partial");
    assert.deepEqual(mo.result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "written"], ["thumbnail", "failed"]]);
    assert.ok(existsSync(join(makeOut, "model.glb")));
    // Legacy schema keeps the class in its payload too.
    const legacy = await runCli(["text-to-3d", "get", "round2-task", "-o", join(dir, "legacy-out")], { env: api.env(), cwd: dir });
    assert.equal(legacy.code, 7, legacy.stderr);
    const lp = parseSingleJson(legacy.stdout) as { code: string; status: number; result: { downloads: { state: string; files: unknown[] } } };
    assert.equal(lp.code, "network");
    assert.equal(lp.status, 503);
    assert.equal(lp.result.downloads.state, "partial");
    assert.equal(lp.result.downloads.files.length, 2);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F05 / N08 — SIGINT cancels the asset transfer
// ---------------------------------------------------------------------------

test("N08/R2-F05 SIGINT during the asset transfer (before headers, mid-body, on the second asset) exits 130 with the task kept, no extra requests, no leftovers", async () => {
  let child: ChildProcess | null = null;
  let mode: "headers" | "body" | "second" = "headers";
  const api = await startMockApi(async (req, res) => {
    if (req.method === "POST" || req.method === "DELETE") return jsonReply(res, 500, { message: "unexpected" });
    if (req.path === "/fast.glb") {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb("fast"));
    }
    if (req.path === "/slow.glb" || req.path === "/slow.png") {
      if (mode === "body") {
        res.writeHead(200, { "content-type": req.path.endsWith(".png") ? "image/png" : "model/gltf-binary" });
        res.write(glb("slow").subarray(0, 8));
      }
      child?.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 400));
      try {
        if (mode !== "body") res.writeHead(200, { "content-type": "model/gltf-binary" });
        res.end(mode === "body" ? glb("slow").subarray(8) : glb("slow"));
      } catch {
        /* client gone */
      }
      return;
    }
    if (mode === "second") return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/fast.glb` }, thumbnail_url: `${api.url}/slow.png` }));
    return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/slow.glb` } }));
  });
  try {
    const dir = tmpDir();
    for (const m of ["headers", "body"] as const) {
      mode = m;
      api.requests.length = 0;
      const target = join(dir, `${m}.glb`);
      const r = await runCli(["text-to-3d", "get", "round2-task", ...V1, "-o", target], { env: api.env(), cwd: dir, onSpawn: (c) => (child = c) });
      assert.equal(r.code, 130, `${m}: ${r.stderr}\n${r.stdout}`);
      const env = parseSingleJson(r.stdout) as { error: { code: string }; result: { task_id: string; submission: { state: string }; next: { get: string }; downloads: { state: string; files: Array<{ key: string; status: string; error: string | null }> } } };
      assert.equal(env.error.code, "interrupted");
      assert.equal(env.result.task_id, "round2-task");
      assert.equal(env.result.submission.state, "accepted");
      assert.match(env.result.next.get, /get round2-task/);
      assert.equal(env.result.downloads.state, "failed");
      assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "failed"]]);
      assert.ok(!existsSync(target), `${m}: no final file`);
      assert.ok(!existsSync(join(dir, `${m}_meta.json`)), `${m}: no sidecar`);
      assert.ok(!readdirSync(dir).some((f) => f.includes(".tmp-")), `${m}: temp file cleaned`);
      assert.deepEqual(api.requests.map((q) => q.method), ["GET", "GET"], `${m}: task GET + one asset GET, nothing else`);
    }
    // Second asset: the first stays committed in the manifest.
    mode = "second";
    api.requests.length = 0;
    const out = join(dir, "second");
    const r = await runCli(["text-to-3d", "wait", "round2-task", ...V1, "-o", out], { env: api.env(), cwd: dir, onSpawn: (c) => (child = c) });
    assert.equal(r.code, 130, `${r.stderr}\n${r.stdout}`);
    const env = parseSingleJson(r.stdout) as { error: { code: string }; result: { downloads: { state: string; files: Array<{ key: string; status: string; path: string }> } } };
    assert.equal(env.error.code, "interrupted");
    assert.equal(env.result.downloads.state, "partial");
    assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "written"], ["thumbnail", "failed"]]);
    assert.ok(existsSync(env.result.downloads.files[0]!.path));
    assert.deepEqual(readdirSync(out), ["model.glb"], "no temp file, no sidecar");
    assert.ok(!api.requests.some((q) => q.method === "DELETE" || q.method === "POST"));
    // Legacy schema and make share the behaviour.
    mode = "headers";
    api.requests.length = 0;
    const legacy = await runCli(["text-to-3d", "get", "round2-task", "-o", join(dir, "legacy.glb")], { env: api.env(), cwd: dir, onSpawn: (c) => (child = c) });
    assert.equal(legacy.code, 130, legacy.stderr);
    assert.ok(!existsSync(join(dir, "legacy.glb")));
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F06 / N07 — OAuth logins without a user id
// ---------------------------------------------------------------------------

test("N07/R2-F06 an OAuth profile without user_id or login_id cannot replay an existing operation; a login id binds the login and survives refresh", async () => {
  let tokens = 0;
  const api = await startMockApi((req, res) => {
    if (req.path === "/openapi/v1/oauth/token") {
      tokens += 1;
      return jsonReply(res, 200, { access_token: `refreshed-${tokens}`, token_type: "Bearer", expires_in: 3600, refresh_token: "fixture-refresh" });
    }
    if (req.method === "POST") return jsonReply(res, 200, { result: req.headers["authorization"] === "Bearer fixture-account-b-token" ? "oauth-account-b-task" : "oauth-account-a-task" });
    return jsonReply(res, 404, {});
  });
  try {
    const dir = tmpDir();
    const creds = join(dir, "oauth-credentials.json");
    const profile = (token: string, extra: Record<string, unknown> = {}, expiresAt = Date.now() + 3_600_000) =>
      JSON.stringify({ auth_version: 1, active_profile: "default", profiles: { default: { kind: "oauth", access_token: token, refresh_token: "fixture-refresh", expires_at: expiresAt, created_at: 1, ...extra } } });
    const env: Record<string, string | undefined> = { ...api.env(), MESHY_CREDENTIALS_PATH: creds };
    delete env["MESHY_API_KEY"];
    const args = [...CREATE, "--operation-id", "missing-subject-op"];

    // No identity at all: the first submission works, a second login under the same profile name is refused a replay.
    writeFileSync(creds, profile("fixture-account-a-token"));
    const a = await runCli(args, { env, cwd: dir });
    assert.equal(a.code, 0, a.stderr);
    writeFileSync(creds, profile("fixture-account-b-token"));
    const b = await runCli(args, { env, cwd: dir });
    assert.equal(b.code, 2, `${b.stderr}\n${b.stdout}`);
    const bo = parseSingleJson(b.stdout) as { error: { code: string; message: string; recovery: { command: string } }; result: { conflict: string[]; submission: { task_id: string } } };
    assert.equal(bo.error.code, "operation_conflict");
    assert.deepEqual(bo.result.conflict, ["credential_unverified"]);
    assert.match(bo.error.recovery.command, /meshy auth login/);
    assert.equal(bo.result.submission.task_id, "oauth-account-a-task", "the record is shown, never re-used");
    assert.equal(api.requests.filter((q) => q.method === "POST" && !q.path.endsWith("/oauth/token")).length, 1, "account B sent nothing");

    // A login id binds the login: rotated token → replay; a new login (new id) → conflict.
    const withLogin = [...CREATE, "--operation-id", "login-bound-op"];
    writeFileSync(creds, profile("tok-1", { login_id: "login-aaaa" }));
    const first = await runCli(withLogin, { env, cwd: dir });
    assert.equal(first.code, 0, first.stderr);
    writeFileSync(creds, profile("tok-2", { login_id: "login-aaaa" }));
    const rotated = await runCli(withLogin, { env, cwd: dir });
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.equal((parseSingleJson(rotated.stdout) as { warnings: Array<{ code: string }> }).warnings[0]?.code, "operation_replayed");
    writeFileSync(creds, profile("tok-3", { login_id: "login-bbbb" }));
    const relogin = await runCli(withLogin, { env, cwd: dir });
    assert.equal(relogin.code, 2, relogin.stderr);
    assert.deepEqual((parseSingleJson(relogin.stdout) as { result: { conflict: string[] } }).result.conflict, ["credential"]);
    assert.equal(api.requests.filter((q) => q.method === "POST" && !q.path.endsWith("/oauth/token")).length, 2);

    // A silent refresh keeps the login id (and therefore the identity): expired token → refresh → replay, no new POST.
    const refreshOp = [...CREATE, "--operation-id", "refresh-op"];
    writeFileSync(creds, profile("tok-old", { login_id: "login-cccc" }));
    const before = await runCli(refreshOp, { env, cwd: dir });
    assert.equal(before.code, 0, before.stderr);
    writeFileSync(creds, profile("tok-expired", { login_id: "login-cccc" }, Date.now() - 1000));
    const after = await runCli(refreshOp, { env, cwd: dir });
    assert.equal(after.code, 0, `${after.stderr}\n${after.stdout}`);
    assert.equal((parseSingleJson(after.stdout) as { warnings: Array<{ code: string }> }).warnings[0]?.code, "operation_replayed");
    const saved = JSON.parse(readFileSync(creds, "utf8")) as { profiles: { default: { access_token: string; login_id: string } } };
    assert.equal(saved.profiles.default.login_id, "login-cccc", "refresh preserved the login id");
    assert.match(saved.profiles.default.access_token, /^refreshed-/, "the token was rotated by the refresh");
    assert.equal(api.requests.filter((q) => q.method === "POST" && !q.path.endsWith("/oauth/token")).length, 3);
    // Journals hold neither tokens nor login ids in the clear.
    const ops = join(String(env["MESHY_CONFIG_DIR"]), "operations");
    for (const f of readdirSync(ops).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(join(ops, f), "utf8");
      assert.ok(!/fixture-account|tok-|refreshed-|login-[abc]{4}/.test(text), `${f}: no secret or raw login id`);
    }
  } finally {
    await api.close();
  }
});

test("R2-F06 credentialBinding: OAuth without subject or login id is unverified; subject or login id verifies; API keys bind to the key", () => {
  assert.deepEqual(credentialBinding({ source: "file", origin: "o", kind: "oauth" }), { binding: "unverified", verified: false });
  assert.equal(credentialBinding({ source: "file", origin: "o", kind: "oauth", subject: "u1" }).verified, true);
  assert.equal(credentialBinding({ source: "file", origin: "o", kind: "oauth", loginId: "l1" }).verified, true);
  assert.equal(credentialBinding({ source: "file", origin: "o", kind: "oauth", loginId: "l1" }).binding, "login:l1");
  assert.equal(credentialBinding({ source: "file", origin: "o", kind: "oauth", subject: "u1", loginId: "l1" }).binding, "subject:u1", "the account subject wins over the login id");
  assert.equal(credentialBinding({ source: "env", origin: "o", kind: "api_key", secret: "msy_x" }).verified, true);
  assert.ok(!credentialBinding({ source: "env", origin: "o", kind: "api_key", secret: "msy_x" }).binding.includes("msy_x"));
});
