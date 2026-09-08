/**
 * Codex review round 3 (reviews/cli-s1-cf8905d, R3-F01–R3-F06) as positive
 * regressions. Each scenario mirrors the reviewer's probe (C01–C06) with real
 * subprocesses, a loopback API/asset host that records every request, synthetic
 * credentials and isolated temp directories, and asserts the required outcome:
 * the sidecar is published like an asset (no overwrite, no new symlink, root
 * re-proven at publication), every failure after the transfers keeps the
 * per-file manifest with the bytes actually on disk, Ctrl-C during the material
 * rewrite is an interrupt, legacy-schema errors still name the accepted task,
 * texture identity follows the server-side name even when it collides with a
 * generated one, and an aliased project path still records its files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { CliError } from "../src/internal/errors.js";
import { relinkMaterials } from "../src/internal/material-links.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const V1 = ["--output-schema", "v1"];

function taskBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "round3-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, ...fields };
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

function tmpFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".tmp-")) : [];
}

function journalOperationIds(configDir: string): string[] {
  const ops = join(configDir, "operations");
  return readdirSync(ops)
    .filter((f) => f.endsWith(".json"))
    .map((f) => (JSON.parse(readFileSync(join(ops, f), "utf8")) as { operation_id: string; state: string; task_id: string | null }).operation_id);
}

interface LegacyErrorPayload {
  code: string;
  status?: number;
  hint?: string;
  task_id?: string;
  operation_id?: string;
  result?: { task_id?: string; submission?: { state: string; operation_id: string | null; task_id?: string }; next?: { wait: string; get: string }; downloads?: { state: string; files: Array<{ key: string; status: string }>; failed_step?: string } };
}

// ---------------------------------------------------------------------------
// R3-F01 / C01 + R3-F04 / C02 — the sidecar is published like an asset
// ---------------------------------------------------------------------------

test("C01+C02/R3-F01,R3-F04 sidecar targets planted after the preflight (symlink, file, directory) are refused; outside bytes untouched; the model manifest survives", async () => {
  let plant: (() => void) | null = null;
  const api = await startMockApi((req, res) => {
    if (req.path === "/asset.glb") {
      // Another process changes the sidecar target between preflight and publication.
      plant?.();
      plant = null;
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb());
    }
    return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/asset.glb` } }));
  });
  try {
    const dir = tmpDir();
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const outside = join(dir, "outside-user-file.json");
    writeFileSync(outside, "original-user-data");
    const env = api.env();

    const cases: Array<[string, (out: string) => void, RegExp]> = [
      ["symlink", (out) => symlinkSync(outside, join(out, "meta.json")), /symbolic link/],
      ["file", (out) => writeFileSync(join(out, "meta.json"), "keep me"), /refusing to overwrite/],
      ["directory", (out) => mkdirSync(join(out, "meta.json")), /refusing to overwrite|EEXIST|EISDIR/],
    ];
    for (const [label, planter, re] of cases) {
      const out = join(workspace, `race-${label}`);
      plant = () => {
        mkdirSync(out, { recursive: true });
        planter(out);
      };
      const r = await runCli(["text-to-3d", "get", "round3-task", ...V1, "--workspace", workspace, "-o", out], { env, cwd: dir });
      assert.equal(r.code, 11, `${label}: ${r.stderr}\n${r.stdout}`);
      const env1 = parseSingleJson(r.stdout) as { error: { code: string; message: string }; result: { task_id: string; downloads: { state: string; failed_step: string; files: Array<{ key: string; path: string; status: string; sha256: string }> } } };
      assert.equal(env1.error.code, "local_io");
      assert.match(env1.error.message, re, `${label}: the refusal names its cause`);
      assert.equal(env1.result.task_id, "round3-task");
      assert.equal(env1.result.downloads.state, "partial");
      assert.equal(env1.result.downloads.failed_step, "sidecar");
      assert.deepEqual(env1.result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "written"]]);
      const model = env1.result.downloads.files[0]!;
      assert.ok(existsSync(model.path), `${label}: the committed model is not rolled back`);
      assert.equal(sha(model.path), model.sha256);
      assert.equal(readFileSync(outside, "utf8"), "original-user-data", `${label}: nothing outside the workspace changed`);
      if (label === "file") assert.equal(readFileSync(join(out, "meta.json"), "utf8"), "keep me", "the planted file keeps its content");
      assert.deepEqual(tmpFiles(out), [], `${label}: no temp file left behind`);
    }
    assert.equal(api.requests.filter((q) => q.method !== "GET").length, 0);

    // Single-file mode: the per-file sidecar (`<stem>_meta.json`) follows the same rule.
    const single = join(workspace, "single.glb");
    plant = () => symlinkSync(outside, join(workspace, "single_meta.json"));
    const s = await runCli(["text-to-3d", "get", "round3-task", ...V1, "--workspace", workspace, "-o", single], { env, cwd: dir });
    assert.equal(s.code, 11, `${s.stderr}\n${s.stdout}`);
    assert.equal(readFileSync(outside, "utf8"), "original-user-data");
    assert.ok(existsSync(single), "the model itself was published");
    // Legacy schema: same refusal, the task stays discoverable.
    const legacyOut = join(workspace, "race-legacy");
    plant = () => {
      mkdirSync(legacyOut, { recursive: true });
      symlinkSync(outside, join(legacyOut, "meta.json"));
    };
    const legacy = await runCli(["text-to-3d", "get", "round3-task", "--workspace", workspace, "-o", legacyOut], { env, cwd: dir });
    assert.equal(legacy.code, 11, legacy.stderr);
    const lp = parseSingleJson(legacy.stdout) as LegacyErrorPayload;
    assert.equal(lp.code, "local_io");
    assert.equal(lp.task_id, "round3-task");
    assert.equal(lp.result?.downloads?.failed_step, "sidecar");
    assert.deepEqual(lp.result?.downloads?.files.map((f) => [f.key, f.status]), [["model_glb", "written"]]);
    assert.equal(readFileSync(outside, "utf8"), "original-user-data");
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R3-F05 / C03 — SIGINT during the material rewrite
// ---------------------------------------------------------------------------

const BIG_OBJ = `mtllib original.mtl\n${"v 0.123456 0.654321 0.111111\n".repeat(400_000)}f 1 2 3\n`;

test("C03/R3-F05 SIGINT while the OBJ is being relinked exits 130, keeps the committed files and their real digests, publishes no sidecar, leaves no temp file", async () => {
  let child: ChildProcess | null = null;
  const api = await startMockApi((req, res) => {
    if (req.path === "/large.obj") {
      res.writeHead(200, { "content-type": "model/obj" });
      return void res.end(BIG_OBJ);
    }
    if (req.path === "/original.mtl") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("newmtl a\nKd 1 0 0\n");
    }
    if (req.method !== "GET") return jsonReply(res, 500, { message: "unexpected" });
    return jsonReply(res, 200, taskBody({ model_urls: { obj: `${api.url}/large.obj`, mtl: `${api.url}/original.mtl` } }));
  });
  try {
    const dir = tmpDir();
    const out = join(dir, "relink-interrupt");
    mkdirSync(out);
    let signalSent = false;
    // Fire once the relink pass has started: the rewrite goes through a temp
    // file beside model.obj, and both downloads must already be on disk.
    const poll = setInterval(() => {
      if (signalSent || !existsSync(out)) return;
      const names = readdirSync(out);
      if (names.some((n) => n.startsWith(".model.obj.tmp-")) && names.includes("model.mtl")) {
        signalSent = true;
        child?.kill("SIGINT");
      }
    }, 1);
    const r = await runCli(["text-to-3d", "get", "round3-task", ...V1, "-o", out], { env: api.env(), cwd: dir, onSpawn: (c) => (child = c), timeoutMs: 60_000 });
    clearInterval(poll);
    assert.ok(signalSent, "the test caught the relink phase (temp file observed)");
    assert.equal(r.code, 130, `${r.stderr}\n${r.stdout}`);
    const env = parseSingleJson(r.stdout) as { ok: boolean; error: { code: string }; result: { task_id: string; next: { get: string }; downloads: { state: string; failed_step: string; files: Array<{ key: string; path: string; status: string; sha256: string; bytes: number; relinked: boolean }> } } };
    assert.equal(env.ok, false);
    assert.equal(env.error.code, "interrupted");
    assert.equal(env.result.task_id, "round3-task");
    assert.equal(env.result.downloads.state, "partial");
    assert.equal(env.result.downloads.failed_step, "relink");
    assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model_obj", "written"], ["model_mtl", "written"]]);
    for (const f of env.result.downloads.files) {
      assert.ok(existsSync(f.path), `${f.key} stays on disk`);
      assert.equal(sha(f.path), f.sha256, `${f.key}: manifest digest is the file actually on disk`);
      assert.equal(readFileSync(f.path).length, f.bytes);
    }
    const obj = readFileSync(join(out, "model.obj"), "utf8");
    assert.ok(obj === BIG_OBJ || obj === BIG_OBJ.replace("mtllib original.mtl", "mtllib model.mtl"), "the OBJ is either the original or the fully rewritten file, never a partial one");
    assert.ok(!existsSync(join(out, "meta.json")), "no sidecar after an interrupt");
    assert.deepEqual(tmpFiles(out), [], "the unfinished temp file was removed");
    assert.equal(api.requests.filter((q) => q.method !== "GET").length, 0, "no DELETE, no POST");
  } finally {
    await api.close();
  }
});

test("R3-F05 relinkMaterials is cooperative: an aborted signal stops before any read/write and mid-way, leaving the originals intact and no temp files", async () => {
  const dir = tmpDir();
  const objPath = join(dir, "model.obj");
  const mtlPath = join(dir, "model.mtl");
  writeFileSync(objPath, BIG_OBJ);
  writeFileSync(mtlPath, "newmtl a\nmap_Kd tex.png\n");
  const before = sha(objPath);
  const files = [
    { key: "model_obj", path: objPath, sourceName: "large.obj" },
    { key: "model_mtl", path: mtlPath, sourceName: "original.mtl" },
  ];
  // Already aborted: nothing is touched.
  const done = new AbortController();
  done.abort();
  await assert.rejects(relinkMaterials(files, { signal: done.signal }), (e: unknown) => e instanceof CliError && e.code === "interrupted");
  assert.equal(sha(objPath), before);
  // Aborted while the (large) OBJ is being rewritten: the temp file is removed, the original stays.
  const midway = new AbortController();
  setTimeout(() => midway.abort(), 2);
  await assert.rejects(relinkMaterials(files, { signal: midway.signal }), (e: unknown) => e instanceof CliError && e.code === "interrupted");
  assert.equal(sha(objPath), before, "the original OBJ is untouched");
  assert.deepEqual(tmpFiles(dir), []);
  // Without a signal the same set relinks normally.
  const report = await relinkMaterials(files);
  assert.equal(report?.rewritten.length, 1);
  assert.match(readFileSync(objPath, "utf8").slice(0, 40), /^mtllib model\.mtl\n/);
});

// ---------------------------------------------------------------------------
// R3-F06 / C04 — project reached through an alias path
// ---------------------------------------------------------------------------

test("C04/R3-F06 a project reached through a symlinked parent (or the macOS /var alias) still records its downloaded files; files truly outside are not recorded", async () => {
  const host = await startMockApi((_req, res) => {
    res.writeHead(200, { "content-type": "model/gltf-binary" });
    res.end(glb());
  });
  try {
    const dir = tmpDir(); // on macOS this is itself an alias (/var → /private/var)
    const realRoot = join(dir, "real-projects");
    mkdirSync(realRoot);
    const alias = join(dir, "alias-projects");
    symlinkSync(realRoot, alias);
    const env = host.env({ MESHY_API_KEY: undefined });
    const init = await runCli(["project", "init", "--root", alias, "--name", "alias-review"], { env, cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    const projectDir = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    assert.ok(projectDir.startsWith(alias), "the project is addressed through the alias");
    const fixture = join(projectDir, "task.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { glb: `${host.url}/model.glb` } })));
    const r = await runCli(["download", "--task-json", fixture, "--all", "--project", projectDir], { env, cwd: dir });
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    const out = parseSingleJson(r.stdout) as { result: { project: { recorded_files: string[] } }; warnings: Array<{ code: string }> };
    assert.deepEqual(out.result.project.recorded_files, ["model.glb"]);
    assert.ok(!out.warnings.some((w) => w.code === "files_outside_project"), "no false files_outside_project warning");
    const meta = JSON.parse(readFileSync(join(projectDir, "metadata.json"), "utf8")) as { tasks: Array<{ files: string[] }> };
    assert.deepEqual(meta.tasks[0]!.files, ["model.glb"]);
    assert.ok(existsSync(join(realRoot, readdirSync(realRoot).find((n) => n !== "history.json")!, "model.glb")));
    // Files written outside the project (explicit --output-dir elsewhere, no workspace) are still not recorded.
    const elsewhere = join(dir, "elsewhere");
    const outside = await runCli(["download", "--task-json", fixture, "--all", "--project", projectDir, "--output-dir", elsewhere], { env, cwd: dir });
    assert.equal(outside.code, 0, outside.stderr);
    const oo = parseSingleJson(outside.stdout) as { result: { project: { recorded_files: string[] } }; warnings: Array<{ code: string }> };
    assert.deepEqual(oo.result.project.recorded_files, []);
    assert.ok(oo.warnings.some((w) => w.code === "files_outside_project"));
    assert.ok(existsSync(join(elsewhere, "model.glb")));
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// R3-F03 / C05 — texture identity when source names collide with generated names
// ---------------------------------------------------------------------------

test("C05/R3-F03 source names that collide with the CLI's generated names still map to the right image (verified by bytes); a generated-name reference with a different source is ambiguous", async () => {
  const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const green = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const mtl = "newmtl red\nmap_Kd texture_1_base_color.png\nnewmtl green\nmap_Kd texture_0_base_color.png\n";
  const host = await startMockApi((req, res) => {
    if (req.path === "/model.obj") {
      res.writeHead(200, { "content-type": "model/obj" });
      return void res.end("mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 1\nf 1 2 3\n");
    }
    if (req.path === "/model.mtl") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(mtl);
    }
    if (req.path === "/texture_1_base_color.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(red);
    }
    if (req.path === "/texture_0_base_color.png" || req.path === "/a.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(green);
    }
    return jsonReply(res, 404, {});
  });
  try {
    const dir = tmpDir();
    const env = host.env({ MESHY_API_KEY: undefined });
    // texture_urls[0] is served as texture_1_base_color.png (red) and lands as texture_0_base_color.png; [1] the other way round.
    const fixture = join(dir, "collision.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/model.obj`, mtl: `${host.url}/model.mtl` }, texture_urls: [{ base_color: `${host.url}/texture_1_base_color.png` }, { base_color: `${host.url}/texture_0_base_color.png` }] })));
    const out = join(dir, "collision");
    const r = await runCli(["download", "--task-json", fixture, "--model-format", "obj", "--output-dir", out], { env, cwd: dir });
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    const lines = readFileSync(join(out, "model.mtl"), "utf8").split("\n");
    const redRef = lines[lines.indexOf("newmtl red") + 1]!.split(" ")[1]!;
    const greenRef = lines[lines.indexOf("newmtl green") + 1]!.split(" ")[1]!;
    assert.ok(readFileSync(join(out, redRef)).equals(red), `the red material references the red image (${redRef})`);
    assert.ok(readFileSync(join(out, greenRef)).equals(green), `the green material references the green image (${greenRef})`);
    assert.equal(redRef, "texture_0_base_color.png");
    assert.equal(greenRef, "texture_1_base_color.png");
    const env1 = parseSingleJson(r.stdout) as { warnings: Array<{ code: string }>; result: { downloads: { material_links: { status: string; texture_maps: Array<{ material: string; reference: string; resolved_to: string; method: string }> } } } };
    assert.equal(env1.result.downloads.material_links.status, "complete");
    assert.deepEqual(env1.result.downloads.material_links.texture_maps.map((l) => [l.material, l.reference, l.resolved_to, l.method]), [
      ["red", "texture_1_base_color.png", "texture_0_base_color.png", "source_name"],
      ["green", "texture_0_base_color.png", "texture_1_base_color.png", "source_name"],
    ]);
    assert.ok(!env1.warnings.some((w) => w.code.startsWith("material_reference")));

    // A reference that equals a generated name whose source is something else, with no source matching it: ambiguous, kept, warned.
    const fixture2 = join(dir, "collision2.json");
    writeFileSync(fixture2, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/model.obj`, mtl: `${host.url}/model.mtl` }, texture_urls: [{ base_color: `${host.url}/a.png` }] })));
    const out2 = join(dir, "collision2");
    const r2 = await runCli(["download", "--task-json", fixture2, "--model-format", "obj", "--output-dir", out2], { env, cwd: dir });
    assert.equal(r2.code, 0, r2.stderr);
    const saved2 = readFileSync(join(out2, "model.mtl"), "utf8");
    assert.equal(saved2, mtl, "both references stay as written");
    const env2 = parseSingleJson(r2.stdout) as { warnings: Array<{ code: string; message: string }>; result: { downloads: { material_links: { status: string; texture_maps: Array<{ reference: string; resolved_to: string | null; method: string; note?: string }> } } } };
    assert.equal(env2.result.downloads.material_links.status, "incomplete");
    const generated = env2.result.downloads.material_links.texture_maps.find((l) => l.reference === "texture_0_base_color.png")!;
    assert.equal(generated.method, "ambiguous");
    assert.equal(generated.resolved_to, null);
    assert.match(generated.note ?? "", /served as 'a\.png'/);
    assert.ok(env2.warnings.some((w) => w.code === "material_reference_ambiguous" && w.message.includes("served as 'a.png'")));
  } finally {
    await host.close();
  }
});

test("R3-F03 without source evidence a saved-name match is still accepted (conservative fallback)", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "model.obj"), "mtllib m.mtl\nv 0 0 0\n");
  writeFileSync(join(dir, "model.mtl"), "newmtl a\nmap_Kd texture_0_base_color.png\n");
  writeFileSync(join(dir, "texture_0_base_color.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const report = await relinkMaterials([
    { key: "model.obj", path: join(dir, "model.obj") },
    { key: "model.mtl", path: join(dir, "model.mtl") },
    { key: "texture.0.base_color", path: join(dir, "texture_0_base_color.png") },
  ]);
  assert.equal(report?.status, "complete");
  assert.deepEqual(report?.texture_maps.map((l) => [l.reference, l.resolved_to, l.method]), [["texture_0_base_color.png", "texture_0_base_color.png", "unchanged"]]);
});

// ---------------------------------------------------------------------------
// R3-F02 / C06 — legacy schema keeps the accepted task on every download failure
// ---------------------------------------------------------------------------

test("C06/R3-F02 legacy sync create/wait/get: an asset 503, a sidecar failure and SIGINT still report task_id, the real operation_id, next and the manifest; exactly one POST (make: codex-review-round4 R4-T01 with distinct step ids)", async () => {
  let assetMode: "503" | "ok" | "slow" = "503";
  let plant: (() => void) | null = null;
  let child: ChildProcess | null = null;
  const api = await startMockApi(async (req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "paid-legacy-created-id" });
    if (req.method === "DELETE") return jsonReply(res, 500, { message: "never" });
    if (req.path === "/asset.glb") {
      plant?.();
      plant = null;
      if (assetMode === "503") return jsonReply(res, 503, { message: "asset host down" });
      if (assetMode === "slow") {
        child?.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 400));
      }
      try {
        res.writeHead(200, { "content-type": "model/gltf-binary" });
        res.end(glb());
      } catch {
        /* client gone */
      }
      return;
    }
    return jsonReply(res, 200, taskBody({ id: "paid-legacy-created-id", model_urls: { glb: `${api.url}/asset.glb` } }));
  });
  try {
    const dir = tmpDir();
    const env = api.env();
    const configDir = String(env["MESHY_CONFIG_DIR"]);

    // Sync create (default schema), asset host 503.
    const created = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "fixture legacy", "-o", join(dir, "legacy-created")], { env, cwd: dir });
    assert.equal(created.code, 7, `${created.stderr}\n${created.stdout}`);
    const payload = parseSingleJson(created.stdout) as LegacyErrorPayload;
    assert.equal(payload.code, "network");
    assert.equal(payload.status, 503);
    assert.equal(payload.task_id, "paid-legacy-created-id");
    assert.equal(payload.result?.task_id, "paid-legacy-created-id");
    assert.equal(payload.result?.submission?.state, "accepted");
    const [operationId] = journalOperationIds(configDir);
    assert.ok(operationId, "the journal holds the accepted record");
    assert.equal(payload.operation_id, operationId, "the error names the journal's operation id");
    assert.equal(payload.result?.submission?.operation_id, operationId);
    assert.match(payload.result?.next?.wait ?? "", /wait paid-legacy-created-id/);
    assert.deepEqual(payload.result?.downloads?.files.map((f) => [f.key, f.status]), [["model_glb", "failed"]]);
    assert.ok(payload.hint && /paid-legacy-created-id/.test(payload.hint), "the hint (also printed on stderr) names the task");
    assert.match(created.stderr, /paid-legacy-created-id/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
    assert.equal(api.requests.filter((q) => q.method === "DELETE").length, 0);

    // Legacy wait -o: same fields.
    const waited = await runCli(["text-to-3d", "wait", "paid-legacy-created-id", "-o", join(dir, "legacy-wait")], { env, cwd: dir });
    assert.equal(waited.code, 7, waited.stderr);
    const wp = parseSingleJson(waited.stdout) as LegacyErrorPayload;
    assert.equal(wp.task_id, "paid-legacy-created-id");
    assert.equal(wp.status, 503);

    // Legacy sidecar failure after the asset landed.
    assetMode = "ok";
    const sideDir = join(dir, "legacy-sidecar");
    plant = () => {
      mkdirSync(sideDir, { recursive: true });
      mkdirSync(join(sideDir, "meta.json"));
    };
    const side = await runCli(["text-to-3d", "get", "paid-legacy-created-id", "-o", sideDir], { env, cwd: dir });
    assert.equal(side.code, 11, `${side.stderr}\n${side.stdout}`);
    const sp = parseSingleJson(side.stdout) as LegacyErrorPayload;
    assert.equal(sp.task_id, "paid-legacy-created-id");
    assert.equal(sp.result?.downloads?.state, "partial");
    assert.equal(sp.result?.downloads?.failed_step, "sidecar");
    assert.deepEqual(sp.result?.downloads?.files.map((f) => [f.key, f.status]), [["model_glb", "written"]]);
    assert.ok(existsSync(join(sideDir, "model.glb")));

    // Legacy SIGINT during the transfer.
    assetMode = "slow";
    const target = join(dir, "legacy-int.glb");
    const interrupted = await runCli(["text-to-3d", "get", "paid-legacy-created-id", "-o", target], { env, cwd: dir, onSpawn: (c) => (child = c) });
    assert.equal(interrupted.code, 130, `${interrupted.stderr}\n${interrupted.stdout}`);
    const ip = parseSingleJson(interrupted.stdout) as LegacyErrorPayload;
    assert.equal(ip.code, "interrupted");
    assert.equal(ip.task_id, "paid-legacy-created-id");
    assert.ok(!existsSync(target));

  } finally {
    await api.close();
  }
});
