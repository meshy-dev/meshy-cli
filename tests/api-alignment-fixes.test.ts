/**
 * Request-shape and error-class fixes against the public API: each test pins
 * what reaches (or never reaches) the wire.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskEndpoint } from "../src/client/endpoints/base.js";
import { MeshyApiError, mapHttpError, parseRetryAfter } from "../src/client/errors.js";
import { findTaskResource } from "../src/client/resource-registry.js";
import type { Task } from "../src/client/types.js";
import { exitCodeFor } from "../src/internal/errors.js";
import { pollUntilTerminal } from "../src/internal/poll.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);

async function withApi(handler: Parameters<typeof startMockApi>[0], fn: (api: MockApi) => Promise<void>): Promise<void> {
  const api = await startMockApi(handler);
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

const accept = (id = "task-new"): Parameters<typeof startMockApi>[0] => (req, res) =>
  req.method === "POST" ? jsonReply(res, 200, { result: id }) : jsonReply(res, 500, { message: "unexpected" });

const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, type: "text-to-3d-preview", status, progress: status === "SUCCEEDED" ? 100 : 10, created_at: 1, started_at: 1, finished_at: 0, expires_at: 0, task_error: null, ...extra,
});

// ---------------------------------------------------------------------------
// printability takes inline models as glTF only
// ---------------------------------------------------------------------------

test("analyze/repair: a local .stl/.obj/.fbx is refused before the wire with a way forward; a local .glb goes inline as model/gltf-binary", async () => {
  await withApi(accept(), async (api) => {
    const cwd = tmpDir("meshy-print-");
    writeFileSync(join(cwd, "part.stl"), "solid x\nendsolid x\n");
    writeFileSync(join(cwd, "part.obj"), "v 0 0 0\n");
    writeFileSync(join(cwd, "part.glb"), GLB);
    for (const cmd of ["analyze-printability", "repair-printability"]) {
      for (const file of ["part.stl", "part.obj"]) {
        const r = await runCli([cmd, "create", "--model-url", file, "--async"], { env: api.env(), cwd });
        assert.equal(r.code, 2, `${cmd} ${file}: ${r.stdout}${r.stderr}`);
        const out = parseSingleJson(r.stdout) as { error: { code: string; message: string } };
        assert.equal(out.error.code, "usage");
        assert.match(out.error.message, /glb\/gltf only/);
        assert.match(out.error.message, /http\(s\) URL, or --input-task-id/);
      }
      // A data: URI the server would refuse (FBX rides as octet-stream) is caught the same way.
      const fbx = await runCli([cmd, "create", "--data", '{"model_url":"data:application/octet-stream;base64,AAAA"}', "--async"], { env: api.env(), cwd });
      assert.equal(fbx.code, 2, fbx.stdout);
    }
    assert.equal(api.requests.length, 0, "nothing the server would refuse reaches it");

    const ok = await runCli(["analyze-printability", "create", "--model-url", "part.glb", "--async"], { env: api.env(), cwd });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(String((api.requests[0]!.json as Record<string, unknown>)["model_url"]), /^data:model\/gltf-binary;base64,/);
  });
});

test("every other model input refuses a local non-glTF file the same way; .glb (and .gltf where supported) still goes inline", async () => {
  const FBX = Buffer.concat([Buffer.from("Kaydara FBX Binary  \0"), Buffer.alloc(16)]);
  await withApi(accept(), async (api) => {
    const cwd = tmpDir("meshy-model-in-");
    writeFileSync(join(cwd, "part.stl"), "solid x\nendsolid x\n");
    writeFileSync(join(cwd, "part.obj"), "v 0 0 0\n");
    writeFileSync(join(cwd, "part.fbx"), FBX);
    writeFileSync(join(cwd, "part.glb"), GLB);
    writeFileSync(join(cwd, "part.gltf"), JSON.stringify({ asset: { version: "2.0" } }));
    const commands: Array<[string, string[], string[]]> = [
      ["remesh", [], ["glb", "gltf"]],
      ["convert", ["--target-formats", "stl"], ["glb", "gltf"]],
      ["resize", ["--resize-height", "1"], ["glb", "gltf"]],
      ["retexture", ["--text-style-prompt", "gold"], ["glb", "gltf"]],
      ["multi-color-print", [], ["glb"]],
    ];
    let posts = 0;
    for (const [cmd, extra, accepted] of commands) {
      for (const ext of ["stl", "obj", "fbx", "glb", "gltf"]) {
        const r = await runCli([cmd, "create", "--model-url", `part.${ext}`, ...extra, "--async"], { env: api.env(), cwd });
        if (accepted.includes(ext)) {
          assert.equal(r.code, 0, `${cmd} .${ext}: ${r.stdout}${r.stderr}`);
          posts += 1;
          const sent = String((api.requests[posts - 1]!.json as Record<string, unknown>)["model_url"]);
          assert.match(sent, ext === "glb" ? /^data:model\/gltf-binary;base64,/ : /^data:model\/gltf\+json;base64,/, `${cmd} .${ext}`);
        } else {
          assert.equal(r.code, 2, `${cmd} .${ext}: ${r.stdout}${r.stderr}`);
          const out = parseSingleJson(r.stdout) as { error: { message: string } };
          assert.match(out.error.message, /http\(s\) URL, or --input-task-id/, `${cmd} .${ext}`);
        }
      }
    }
    assert.equal(api.requests.length, posts, "a refused input costs no request");
    // A data: URI labelled application/octet-stream (the docs' spelling) is fine when it is a GLB, refused otherwise.
    const glbData = `data:application/octet-stream;base64,${GLB.toString("base64")}`;
    const ok = await runCli(["remesh", "create", "--data", JSON.stringify({ model_url: glbData }), "--async"], { env: api.env(), cwd });
    assert.equal(ok.code, 0, ok.stdout);
    const fbxData = `data:application/octet-stream;base64,${FBX.toString("base64")}`;
    const bad = await runCli(["remesh", "create", "--data", JSON.stringify({ model_url: fbxData }), "--async"], { env: api.env(), cwd });
    assert.equal(bad.code, 2, bad.stdout);
    assert.equal(api.requests.length, posts + 1);
  });
});

test("analyze/repair: an http(s) .stl URL is still passed through (the server fetches it)", async () => {
  await withApi((req, res) => {
    if (req.method === "HEAD" && req.path === "/files/part.stl") return void res.writeHead(200).end();
    return accept()(req, res, undefined as never);
  }, async (api) => {
    const r = await runCli(["repair-printability", "create", "--model-url", `${api.origin}/files/part.stl`, "--async"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    const post = api.requests.find((q) => q.method === "POST")!;
    assert.equal((post.json as Record<string, unknown>)["model_url"], `${api.origin}/files/part.stl`);
  });
});

// ---------------------------------------------------------------------------
// refine pins only what every refine target accepts
// ---------------------------------------------------------------------------

test("text-to-3d refine: no remove_lighting or texture_resolution unless asked (a meshy-6-lite preview refuses both)", async () => {
  await withApi(accept(), async (api) => {
    const r = await runCli(["text-to-3d", "create", "--mode", "refine", "--preview-task-id", "p1", "--async"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.requests[0]!.json, { mode: "refine", preview_task_id: "p1", enable_pbr: true, target_formats: ["glb"] });

    const asked = await runCli(["text-to-3d", "create", "--mode", "refine", "--preview-task-id", "p1", "--texture-resolution", "4k", "--remove-lighting", "true", "--async"], { env: api.env() });
    assert.equal(asked.code, 0, asked.stderr);
    const body = api.requests[1]!.json as Record<string, unknown>;
    assert.equal(body["texture_resolution"], "4k");
    assert.equal(body["remove_lighting"], true);
  });
});

test("make still refines at 4k (it made the preview on latest), and its resume command asks for the same", async () => {
  let posts = 0;
  await withApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: `t-${++posts}` });
    return jsonReply(res, 200, task(req.path.split("/").pop()!, "SUCCEEDED"));
  }, async (api) => {
    const r = await runCli(["make", "a fixture cactus"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    const refine = api.requests.filter((q) => q.method === "POST")[1]!.json as Record<string, unknown>;
    assert.equal(refine["texture_resolution"], "4k");
    const pending = await runCli(["make", "a fixture cactus", "--async"], { env: api.env() });
    const out = parseSingleJson(pending.stdout) as { result: { pending_steps: Array<{ command: string }> } };
    assert.equal(out.result.pending_steps[0]!.command, "meshy text-to-3d create --mode refine --texture-resolution 4k --preview-task-id <preview-task-id>");
  });
});

// ---------------------------------------------------------------------------
// smart-topology has no lighting / enhancement knobs
// ---------------------------------------------------------------------------

test("image-to-3d --model-type smart-topology refuses --remove-lighting / --image-enhancement (flag or --data) before the wire", async () => {
  await withApi(accept(), async (api) => {
    const base = ["image-to-3d", "create", "--image-url", "https://example.invalid/a.png", "--model-type", "smart-topology", "--async"];
    for (const extra of [["--remove-lighting", "false"], ["--image-enhancement", "true"], ["--data", '{"remove_lighting":true}']]) {
      const r = await runCli([...base, ...extra], { env: api.env() });
      assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stdout}`);
      assert.match((parseSingleJson(r.stdout) as { error: { message: string } }).error.message, /--model-type standard only/);
    }
    assert.equal(api.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// a failed status request is retried at the next tick
// ---------------------------------------------------------------------------

test("wait: a 503, a 429 and a 500 while polling are retried; the task's real outcome is reported with a poll_retried warning", async () => {
  let gets = 0;
  await withApi((req, res) => {
    if (req.method !== "GET") return jsonReply(res, 500, { message: "unexpected" });
    gets += 1;
    if (gets === 1) return jsonReply(res, 503, { message: "temporary outage" });
    if (gets === 2) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      return void res.end(JSON.stringify({ message: "slow down" }));
    }
    if (gets === 3) return jsonReply(res, 500, { message: "boom" });
    return jsonReply(res, 200, task("t-1", "SUCCEEDED"));
  }, async (api) => {
    const r = await runCli(["text-to-3d", "wait", "t-1"], { env: api.env() });
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    const out = parseSingleJson(r.stdout) as { ok: boolean; result: { task: { status: string }; wait: { polls: number; failed_polls: number; last_poll_error: { http_status: number } } }; warnings: Array<{ code: string }> };
    assert.equal(out.ok, true);
    assert.equal(out.result.task.status, "SUCCEEDED");
    assert.equal(out.result.wait.polls, 1);
    assert.equal(out.result.wait.failed_polls, 3);
    assert.equal(out.result.wait.last_poll_error.http_status, 500);
    assert.ok(out.warnings.some((w) => w.code === "poll_retried"));
  });
});

test("wait: an outage that outlasts the deadline is a timeout (exit 8) that keeps the task id and names the last failure; 401/404 still end it at once", async () => {
  await withApi((req, res) => jsonReply(res, req.path.endsWith("/gone") ? 404 : 503, { message: "outage" }), async (api) => {
    const r = await runCli(["text-to-3d", "wait", "t-2", "--timeout", "1"], { env: api.env() });
    assert.equal(r.code, 8, r.stdout);
    const out = parseSingleJson(r.stdout) as { error: { code: string; message: string }; result: { task_id: string; wait: { failed_polls: number } } };
    assert.equal(out.error.code, "timed_out");
    assert.match(out.error.message, /status request\(s\) failed, last: meshy api 503/);
    assert.equal(out.result.task_id, "t-2");
    assert.ok(out.result.wait.failed_polls >= 2, "kept polling");

    const before = api.requests.length;
    const gone = await runCli(["text-to-3d", "wait", "gone", "--timeout", "5"], { env: api.env() });
    assert.equal(gone.code, 5, gone.stdout);
    assert.equal(api.requests.length - before, 1, "a 404 is not retried");
  });
});

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

test("pollUntilTerminal honours Retry-After — on a 429/503 and as the server's poll hint on a task read", async () => {
  const clock = fakeClock();
  const steps: Array<() => { task: Task; raw: unknown; retryAfterMs?: number }> = [
    () => { throw new MeshyApiError({ message: "429", status: 429, code: "rate_limit", retryAfterMs: 7000 }); },
    () => { const t = task("x", "IN_PROGRESS") as unknown as Task; return { task: t, raw: t, retryAfterMs: 4000 }; },
    () => { const t = task("x", "SUCCEEDED") as unknown as Task; return { task: t, raw: t }; },
  ];
  let i = 0;
  const ep = { async retrieveDetailed() { return steps[i++]!(); } } as unknown as TaskEndpoint;
  const res = await pollUntilTerminal(ep, "x", { timeoutSeconds: 60, intervalMs: 300, now: clock.now, sleep: clock.sleep });
  assert.equal(res.task?.status, "SUCCEEDED");
  assert.equal(res.failedPolls, 1);
  assert.deepEqual(clock.sleeps, [7000, 4000], "the server's hint replaces the local backoff");
});

test("Retry-After is parsed (seconds or HTTP date) and kept on the API error", async () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  const err = await mapHttpError(new Response(JSON.stringify({ message: "slow" }), { status: 429, headers: { "retry-after": "2" } }), "/x");
  assert.equal(err.retryAfterMs, 2000);
  assert.equal(err.code, "rate_limit");
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test("delete of an IN_PROGRESS task (409) is its own class: conflict, exit 14, with the wait command", async () => {
  await withApi((req, res) => jsonReply(res, 409, { message: "Task is IN_PROGRESS and cannot be deleted." }), async (api) => {
    const r = await runCli(["image-to-3d", "delete", "t-run"], { env: api.env() });
    assert.equal(r.code, 14, r.stdout);
    const out = parseSingleJson(r.stdout) as { error: { code: string; http_status: number; hint: string; recovery: { command: string } } };
    assert.equal(out.error.code, "conflict");
    assert.equal(out.error.http_status, 409);
    assert.equal(out.error.recovery.command, "meshy image-to-3d wait t-run");
    assert.doesNotMatch(out.error.hint, /delete again|then delete/i, "deleting the finished task would destroy the paid result");
    const top = await runCli(["delete", "t-run"], { env: api.env() });
    assert.equal(top.code, 14, top.stdout);
    assert.equal((parseSingleJson(top.stdout) as { error: { code: string } }).error.code, "conflict");
    // Top-level delete does not know the resource: a recovery command must be runnable verbatim, so there is none.
    const topV1 = await runCli(["delete", "t-run"], { env: api.env() });
    assert.equal(topV1.code, 14, topV1.stdout);
    const topOut = parseSingleJson(topV1.stdout) as { error: { code: string; recovery: Record<string, unknown> } };
    assert.equal(topOut.error.code, "conflict");
    assert.deepEqual(topOut.error.recovery, { action: "wait", automatic: false });
  });
  assert.equal(exitCodeFor(new MeshyApiError({ message: "x", status: 409, code: "conflict" })), 14);
});

test("Creative Lab delete cancels: the result says canceled, not deleted", async () => {
  await withApi((req, res) => {
    if (req.method === "DELETE") return void res.writeHead(204).end();
    return jsonReply(res, 500, {});
  }, async (api) => {
    const r = await runCli(["creative-lab", "keychain", "prototype", "delete", "t-cl"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    const out = parseSingleJson(r.stdout) as { result: { deleted: boolean; canceled: boolean } };
    assert.equal(out.result.deleted, false);
    assert.equal(out.result.canceled, true);
    assert.equal(api.requests[0]!.path, "/openapi/creative-lab/keychain/v1/prototype/t-cl");
  });
});

test("top-level delete: a 404 points at the Creative Lab delete (the shared route never reaches those tasks)", async () => {
  await withApi((req, res) => jsonReply(res, 404, { message: "Task not found" }), async (api) => {
    const r = await runCli(["delete", "t-cl"], { env: api.env() });
    assert.equal(r.code, 5, r.stdout);
    assert.match((parseSingleJson(r.stdout) as { error: { message: string } }).error.message, /meshy creative-lab <product> <stage> delete/);
    assert.equal(api.requests[0]!.path, "/openapi/v2/text-to-3d/t-cl");
  });
});

// ---------------------------------------------------------------------------
// the server's task type for animations is `animate`
// ---------------------------------------------------------------------------

test("an animation task (type animate) is matched to the animate resource by download --task-json", async () => {
  assert.deepEqual([...findTaskResource("animate")!.taskTypes], ["animate"]);
  const cwd = tmpDir("meshy-anim-");
  writeFileSync(join(cwd, "anim.json"), JSON.stringify({ id: "a-1", type: "animate", status: "SUCCEEDED", result: { animation_glb_url: "https://assets.example.invalid/a.glb" } }));
  const r = await runCli(["download", "--task-json", "anim.json", "--list"], { cwd });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = parseSingleJson(r.stdout) as { result: { source: { resource: string } } };
  assert.equal(out.result.source.resource, "animate");
});

test("a keycap build's obj_zip is a ZIP bundle saved as model.obj.zip", async () => {
  const cwd = tmpDir("meshy-keycap-");
  writeFileSync(join(cwd, "keycap.json"), JSON.stringify({ id: "k-1", type: "creative-lab-keycap-build", status: "SUCCEEDED", model_urls: { glb: "https://assets.example.invalid/model.glb", obj_zip: "https://assets.example.invalid/model-obj.zip" } }));
  const r = await runCli(["download", "--task-json", "keycap.json", "--list"], { cwd });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = parseSingleJson(r.stdout) as { result: { source: { resource: string }; assets: Array<{ key: string; filename: string; format: string }> } };
  assert.equal(out.result.source.resource, "creative-lab.keycap.build");
  const bundle = out.result.assets.find((a) => a.key === "model.obj_zip")!;
  assert.equal(bundle.filename, "model.obj.zip");
  assert.equal(bundle.format, "zip");
});
