/**
 * Regressions for defects found during the live (real-account) verification.
 *
 * L01 — Creative Lab endpoints report `finished_at: null` while a task is
 * IN_PROGRESS (the v2 endpoints report 0). The task schema required a number,
 * so `creative-lab … get`/`wait` failed with "unexpected task shape" (code
 * `server`, HTTP 200) on every poll until the task finished. The body captured
 * live is the fixture; null timestamps and counts now read as 0.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskSchema } from "../src/client/types.js";
import { jsonReply, parseSingleJson, runCli, startMockApi } from "./helpers/cli.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "skill-parity", "creative-lab-lamp-prototype.in-progress.json");
const inProgress = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

test("L01 a Creative Lab task body with finished_at: null (captured live while IN_PROGRESS) parses; null timestamps and counts read as 0, the v2 zero form is unchanged", () => {
  assert.equal(inProgress["finished_at"], null, "the fixture really carries null");
  const parsed = TaskSchema.parse(inProgress);
  assert.equal(parsed.status, "IN_PROGRESS");
  assert.equal(parsed.progress, 5);
  assert.equal(parsed.finished_at, 0, "null → 0, the same value the v2 endpoints send before completion");
  assert.equal(parsed.started_at, 1788845091918);
  assert.equal(parsed.consumed_credits, 30);
  // Every "not yet" field tolerates null and absence alike.
  const sparse = TaskSchema.parse({ id: "x", status: "PENDING", progress: null, preceding_tasks: null, created_at: null, started_at: null, finished_at: null, expires_at: null });
  assert.deepEqual([sparse.progress, sparse.preceding_tasks, sparse.created_at, sparse.started_at, sparse.finished_at, sparse.expires_at], [0, 0, 0, 0, 0, 0]);
  const absent = TaskSchema.parse({ id: "y", status: "PENDING" });
  assert.deepEqual([absent.progress, absent.finished_at], [0, 0]);
  const v2 = TaskSchema.parse({ id: "z", status: "IN_PROGRESS", progress: 40, created_at: 1, started_at: 2, finished_at: 0, expires_at: 3 });
  assert.equal(v2.finished_at, 0);
});

test("L01 creative-lab lamp prototype get/wait on a task that is still IN_PROGRESS: get reports the status (exit 0), wait polls through to SUCCEEDED (2 GETs) instead of failing on the first poll", async () => {
  let gets = 0;
  const api = await startMockApi((req, res) => {
    if (req.method === "GET" && /\/openapi\/creative-lab\/lamp\/v1\/prototype\/cl-live$/.test(req.path)) {
      gets += 1;
      if (gets <= 2) return jsonReply(res, 200, { ...inProgress, id: "cl-live" });
      return jsonReply(res, 200, { ...inProgress, id: "cl-live", status: "SUCCEEDED", progress: 100, finished_at: 1788845191918, thumbnail_url: `${api.url}/thumb.png`, model_urls: { glb: `${api.url}/model.glb` } });
    }
    return jsonReply(res, 404, { message: "unexpected" });
  });
  try {
    const env = api.env({ MESHY_POLL_INTERVAL_MS: "20" });
    const got = await runCli(["creative-lab", "lamp", "prototype", "get", "cl-live", "--output-schema", "v1"], { env });
    assert.equal(got.code, 0, `${got.stderr}\n${got.stdout}`);
    const g = parseSingleJson(got.stdout) as { ok: boolean; result: { task: { status: string; progress: number; finished_at: number } } };
    assert.equal(g.ok, true);
    assert.equal(g.result.task.status, "IN_PROGRESS");
    assert.equal(g.result.task.progress, 5);
    assert.equal(g.result.task.finished_at, null, "the v1 view shows a timestamp that has not happened as null — for the Creative Lab null and the v2 zero alike");

    const waited = await runCli(["creative-lab", "lamp", "prototype", "wait", "cl-live", "--output-schema", "v1"], { env });
    assert.equal(waited.code, 0, `${waited.stderr}\n${waited.stdout}`);
    const w = parseSingleJson(waited.stdout) as { ok: boolean; result: { task: { status: string; finished_at: number }; wait: { polls: number; timed_out: boolean } } };
    assert.equal(w.ok, true);
    assert.equal(w.result.task.status, "SUCCEEDED");
    assert.equal(w.result.task.finished_at, 1788845191918);
    assert.equal(w.result.wait.timed_out, false);
    assert.equal(w.result.wait.polls, 2, "the first poll saw IN_PROGRESS and was accepted, the second saw SUCCEEDED");
    assert.deepEqual(api.requests.map((q) => [q.method, q.path]), [
      ["GET", "/openapi/creative-lab/lamp/v1/prototype/cl-live"],
      ["GET", "/openapi/creative-lab/lamp/v1/prototype/cl-live"],
      ["GET", "/openapi/creative-lab/lamp/v1/prototype/cl-live"],
    ]);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// L02 — the legacy `-o` layout names Creative Lab parts and bundles like `meshy download`
// ---------------------------------------------------------------------------

test("L02 -o on a Creative Lab lamp build saves lamp.stl / base.stl (not model.lamp_stl), and a keychain OBJ bundle saves as model.obj.zip; slot keys and digests unchanged", async () => {
  const { mkdirSync, statSync } = await import("node:fs");
  const { tmpDir } = await import("./helpers/cli.js");
  const stl = Buffer.concat([Buffer.alloc(80, 0), Buffer.from([1, 0, 0, 0]), Buffer.alloc(50, 7)]);
  const zip = Buffer.from("504b0304140000000800" + "00".repeat(20) + "504b0506" + "00".repeat(18), "hex");
  const api = await startMockApi((req, res) => {
    if (req.path === "/lamp.stl" || req.path === "/base.stl") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(stl);
    }
    if (req.path === "/bundle") {
      res.writeHead(200, { "content-type": "application/zip" });
      return void res.end(zip);
    }
    if (/\/openapi\/creative-lab\/lamp\/v1\/build\/lamp-1$/.test(req.path)) {
      return jsonReply(res, 200, { id: "lamp-1", type: "creative-lab-lamp-build", status: "SUCCEEDED", progress: 100, finished_at: 1, model_urls: { lamp_stl: `${api.url}/lamp.stl`, base_stl: `${api.url}/base.stl` } });
    }
    if (/\/openapi\/creative-lab\/keychain\/v1\/build\/key-1$/.test(req.path)) {
      return jsonReply(res, 200, { id: "key-1", type: "creative-lab-keychain-build", status: "SUCCEEDED", progress: 100, finished_at: 1, model_urls: { obj: `${api.url}/bundle` } });
    }
    return jsonReply(res, 404, { message: "unexpected" });
  });
  try {
    const dir = tmpDir();
    const env = api.env();
    const lampOut = join(dir, "lamp");
    mkdirSync(lampOut);
    const lamp = await runCli(["creative-lab", "lamp", "build", "get", "lamp-1", "--output-schema", "v1", "-o", lampOut], { env, cwd: dir });
    assert.equal(lamp.code, 0, `${lamp.stderr}\n${lamp.stdout}`);
    const l = parseSingleJson(lamp.stdout) as { result: { downloads: { files: Array<{ key: string; path: string; bytes: number; status: string }> } } };
    assert.deepEqual(l.result.downloads.files.map((f) => [f.key, f.path.split("/").at(-1), f.status]), [
      ["model_lamp_stl", "lamp.stl", "written"],
      ["model_base_stl", "base.stl", "written"],
    ]);
    for (const f of l.result.downloads.files) assert.equal(statSync(f.path).size, stl.length);
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(join(lampOut, "meta.json"), "utf8")) as { task: { model_urls: Record<string, string> } }).task.model_urls).sort(), ["base_stl", "lamp_stl"]);

    const keyOut = join(dir, "keychain");
    mkdirSync(keyOut);
    const key = await runCli(["creative-lab", "keychain", "build", "get", "key-1", "--output-schema", "v1", "-o", keyOut], { env, cwd: dir });
    assert.equal(key.code, 0, `${key.stderr}\n${key.stdout}`);
    const k = parseSingleJson(key.stdout) as { result: { downloads: { files: Array<{ key: string; path: string; status: string }>; material_links: unknown } } };
    assert.deepEqual(k.result.downloads.files.map((f) => [f.key, f.path.split("/").at(-1), f.status]), [["model_obj", "model.obj.zip", "written"]]);
    assert.ok(readFileSync(k.result.downloads.files[0]!.path).equals(zip), "the bundle bytes are saved untouched");
    assert.equal(k.result.downloads.material_links, null, "a ZIP bundle is not relinked");
  } finally {
    await api.close();
  }
});
