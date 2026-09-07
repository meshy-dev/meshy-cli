/**
 * Codex review round 1 (reviews/cli-s1-6273d9a, F01–F10) turned into positive
 * regression tests. Every scenario mirrors the reviewer's independent probe
 * (R01–R12): real subprocesses, a loopback API/asset host that records every
 * request, synthetic credentials, isolated temp directories. Where the probe
 * demonstrated a defect, the test now asserts the required behaviour.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { jsonReply, parseNdjson, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";

const KEY_A = "msy_review_fixture_account_a";
const KEY_B = "msy_review_fixture_account_b";
const CREATE = ["text-to-3d", "create", "--mode", "preview", "--prompt", "review fixture", "--async", "--output-schema", "v1"];

function taskBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "review-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, ...fields };
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

function laterReply(res: Parameters<typeof jsonReply>[0], ms: number, status: number, body: unknown): void {
  setTimeout(() => {
    try {
      jsonReply(res, status, body);
    } catch {
      /* the client is gone — that is the point of the test */
    }
  }, ms);
}

type Env = Record<string, string | undefined>;

function withoutKey(env: Env, extra: Env = {}): Env {
  const next: Env = { ...env, ...extra };
  delete next["MESHY_API_KEY"];
  return next;
}

// ---------------------------------------------------------------------------
// F05 / R01 — credential identity
// ---------------------------------------------------------------------------

test("R01/F05 a different API key under the same --operation-id conflicts before any request; the same key replays", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "account-a-task" }) : jsonReply(res, 404, {})));
  try {
    const env = api.env({ MESHY_API_KEY: KEY_A });
    const args = [...CREATE, "--operation-id", "same-credential-op"];
    const first = await runCli(args, { env });
    assert.equal(first.code, 0, first.stderr);
    const other = await runCli(args, { env: { ...env, MESHY_API_KEY: KEY_B } });
    assert.equal(other.code, 2, other.stderr);
    const out = parseSingleJson(other.stdout) as { ok: boolean; error: { code: string; message: string }; result: { conflict: string[]; submission: { task_id: string } } };
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "operation_conflict");
    assert.deepEqual(out.result.conflict, ["credential"]);
    assert.equal(out.result.submission.task_id, "account-a-task", "the record is reported, never re-used for the other account");
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, "account B sent nothing");
    const again = await runCli(args, { env });
    assert.equal(again.code, 0, again.stderr);
    assert.equal((parseSingleJson(again.stdout) as { warnings: Array<{ code: string }> }).warnings[0]?.code, "operation_replayed");
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
  } finally {
    await api.close();
  }
});

test("R01/F05 OAuth: a rotated token is the same account (replay); a different user under the same profile name conflicts", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "oauth-task" }) : jsonReply(res, 404, {})));
  try {
    const dir = tmpDir();
    const credFile = join(dir, "credentials.json");
    const profile = (accessToken: string, userId: string) =>
      JSON.stringify({ auth_version: 1, active_profile: "default", profiles: { default: { kind: "oauth", access_token: accessToken, refresh_token: "r", expires_at: Date.now() + 3_600_000, user_id: userId, created_at: 1 } } });
    writeFileSync(credFile, profile("tok-1", "user-a"));
    const env = withoutKey(api.env(), { MESHY_CREDENTIALS_PATH: credFile });
    const args = [...CREATE, "--operation-id", "oauth-op"];
    const first = await runCli(args, { env, cwd: dir });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(api.requests[0]!.headers["authorization"], "Bearer tok-1");
    writeFileSync(credFile, profile("tok-2", "user-a"));
    const rotated = await runCli(args, { env, cwd: dir });
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.equal((parseSingleJson(rotated.stdout) as { warnings: Array<{ code: string }> }).warnings[0]?.code, "operation_replayed");
    writeFileSync(credFile, profile("tok-3", "user-b"));
    const otherUser = await runCli(args, { env, cwd: dir });
    assert.equal(otherUser.code, 2, otherUser.stderr);
    assert.equal((parseSingleJson(otherUser.stdout) as { error: { code: string } }).error.code, "operation_conflict");
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F06 / R02 — media content in the fingerprint
// ---------------------------------------------------------------------------

test("R02/F06 two equal-length images differ: the second conflicts; the same image (even re-wrapped) replays; no base64 in the journal", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "red-image-task" }) : jsonReply(res, 404, {})));
  try {
    const red = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const green = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#00ff00" } }).png().toBuffer();
    assert.ok(!red.equals(green));
    assert.equal(red.toString("base64").length, green.toString("base64").length, "the probe's premise: equal encoded length");
    const env = api.env({ MESHY_API_KEY: KEY_A });
    const args = (b64: string) => ["image-to-3d", "create", "--image-url", `data:image/png;base64,${b64}`, "--operation-id", "same-media-op", "--async", "--output-schema", "v1"];
    const first = await runCli(args(red.toString("base64")), { env });
    assert.equal(first.code, 0, first.stderr);
    const changed = await runCli(args(green.toString("base64")), { env });
    assert.equal(changed.code, 2, changed.stderr);
    const out = parseSingleJson(changed.stdout) as { error: { code: string }; result: { conflict: string[] } };
    assert.equal(out.error.code, "operation_conflict");
    assert.deepEqual(out.result.conflict, ["payload"]);
    const wrapped = red.toString("base64").replace(/(.{40})/g, "$1\n");
    const same = await runCli(args(wrapped), { env });
    assert.equal(same.code, 0, same.stderr);
    assert.equal((parseSingleJson(same.stdout) as { warnings: Array<{ code: string }> }).warnings[0]?.code, "operation_replayed");
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, "exactly one billable request across three invocations");
    const ops = join(String(env["MESHY_CONFIG_DIR"]), "operations");
    for (const f of readdirSync(ops).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(join(ops, f), "utf8");
      assert.ok(!text.includes(red.toString("base64").slice(0, 16)), "journal holds no image bytes");
      assert.ok(!text.includes(KEY_A), "journal holds no key");
    }
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F07 / R03 — the wait deadline binds in-flight requests
// ---------------------------------------------------------------------------

test("R03/F07 wait: a GET that answers after the deadline is a timeout (exit 8) with the task id, not a late success", async () => {
  const api = await startMockApi((_req, res) => laterReply(res, 400, 200, taskBody()));
  try {
    const started = Date.now();
    const r = await runCli(["text-to-3d", "wait", "review-task", "--timeout", "0.05", "--output-schema", "v1"], { env: api.env() });
    const elapsed = Date.now() - started;
    assert.equal(r.code, 8, `${r.stderr}\n${r.stdout}`);
    const out = parseSingleJson(r.stdout) as { ok: boolean; error: { code: string; recovery: { command: string } }; result: { task: unknown; task_id: string; wait: { timed_out: boolean; polls: number }; next: { wait: string } } };
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "timed_out");
    assert.equal(out.result.task, null, "no status was received in time, none is invented");
    assert.equal(out.result.task_id, "review-task");
    assert.equal(out.result.wait.timed_out, true);
    assert.equal(out.result.wait.polls, 0);
    assert.match(out.error.recovery.command, /wait review-task/);
    assert.ok(elapsed < 3000, `the command did not wait for the late body (${elapsed} ms)`);
    // Legacy schema: same decision, legacy shape.
    const legacy = await runCli(["text-to-3d", "wait", "review-task", "--timeout", "0.05"], { env: api.env() });
    assert.equal(legacy.code, 8, legacy.stderr);
    const lp = parseSingleJson(legacy.stdout) as Record<string, unknown>;
    assert.equal(lp["id"], "review-task");
    assert.equal(lp["timed_out"], true);
  } finally {
    await api.close();
  }
});

test("R03/F07 wait: slow body, expiry during sleep and --timeout 0 behave as specified; no GET is started after the deadline", async () => {
  let mode: "slow-body" | "instant" | "slow-200" = "slow-body";
  const stamps: number[] = [];
  let origin = Date.now();
  const api = await startMockApi((_req, res) => {
    stamps.push(Date.now() - origin);
    if (mode === "slow-body") {
      res.writeHead(200, { "content-type": "application/json" });
      setTimeout(() => {
        try {
          res.end(JSON.stringify(taskBody()));
        } catch {
          /* client gone */
        }
      }, 400);
      return;
    }
    if (mode === "slow-200") return laterReply(res, 200, 200, taskBody({ status: "IN_PROGRESS", progress: 10 }));
    return jsonReply(res, 200, taskBody({ status: "IN_PROGRESS", progress: 10 }));
  });
  try {
    const slowBody = await runCli(["text-to-3d", "wait", "review-task", "--timeout", "0.05", "--output-schema", "v1"], { env: api.env() });
    assert.equal(slowBody.code, 8, `${slowBody.stderr}\n${slowBody.stdout}`);
    assert.equal((parseSingleJson(slowBody.stdout) as { error: { code: string } }).error.code, "timed_out");

    // Expiry while sleeping: budget 300 ms, interval 250 ms → one GET, then the
    // sleep runs out the budget; no second GET after the deadline.
    mode = "instant";
    stamps.length = 0;
    origin = Date.now();
    const expiry = await runCli(["text-to-3d", "wait", "review-task", "--timeout", "0.3", "--output-schema", "v1"], { env: api.env({ MESHY_POLL_INTERVAL_MS: "250" }) });
    assert.equal(expiry.code, 8, expiry.stderr);
    const eo = parseSingleJson(expiry.stdout) as { result: { task: { status: string }; wait: { polls: number } } };
    assert.equal(eo.result.task.status, "IN_PROGRESS", "the last status seen is reported");
    assert.ok(eo.result.wait.polls >= 1 && eo.result.wait.polls <= 2, `polls=${eo.result.wait.polls}`);
    const firstGet = stamps[0]!;
    assert.ok(stamps.every((t) => t - firstGet <= 300 + 60), `every GET started within the budget: ${JSON.stringify(stamps.map((t) => t - firstGet))}`);

    // --timeout 0: exactly one query bounded by the read timeout, not by a zero budget.
    mode = "slow-200";
    stamps.length = 0;
    const single = await runCli(["text-to-3d", "wait", "review-task", "--timeout", "0", "--output-schema", "v1"], { env: api.env() });
    assert.equal(single.code, 8, single.stderr);
    const so = parseSingleJson(single.stdout) as { result: { task: { status: string }; wait: { polls: number } } };
    assert.equal(so.result.task.status, "IN_PROGRESS", "the single query completed although it took 200 ms");
    assert.equal(so.result.wait.polls, 1);
    assert.equal(stamps.length, 1);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F08 / R04 — Creative Lab options compose across --data, --options and typed flags
// ---------------------------------------------------------------------------

test("R04/F08 --data.options, --options and typed flags merge field by field (typed wins, false survives)", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "lamp-build-task" }) : jsonReply(res, 404, {})));
  try {
    const r = await runCli(
      [
        "creative-lab", "lamp", "build", "create", "--input-task-id", "parent-prototype",
        "--data", '{"options":{"diameter_mm":180,"rotate_x_deg":90,"include_result_json":false},"output":{"format":"stl"}}',
        "--options", '{"thickness_mm":1.5,"include_result_json":false}',
        "--include-result-json", "--model-format", "zip", "--async",
      ],
      { env: api.env() },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.requests.at(-1)!.json, {
      input_task_id: "parent-prototype",
      options: { diameter_mm: 180, rotate_x_deg: 90, include_result_json: true, thickness_mm: 1.5 },
      output: { format: "zip" },
    });
    // The reviewer's exact probe: --data options + --options.
    const probe = await runCli(["creative-lab", "lamp", "build", "create", "--input-task-id", "parent-prototype", "--data", '{"options":{"diameter_mm":180,"rotate_x_deg":90}}', "--options", '{"thickness_mm":1.5}', "--async"], { env: api.env() });
    assert.equal(probe.code, 0, probe.stderr);
    assert.deepEqual((api.requests.at(-1)!.json as { options: unknown }).options, { diameter_mm: 180, rotate_x_deg: 90, thickness_mm: 1.5 });
    // Keychain: explicit false from --data survives an --options layer.
    const kc = await runCli(["creative-lab", "keychain", "build", "create", "--input-task-id", "p", "--data", '{"options":{"has_closed_back":false}}', "--options", '{"badge_shape":"star"}', "--async"], { env: api.env() });
    assert.equal(kc.code, 0, kc.stderr);
    assert.deepEqual((api.requests.at(-1)!.json as { options: unknown }).options, { has_closed_back: false, badge_shape: "star" });
    // Validation still sees the merged object: an out-of-range value from --data is refused before the POST.
    const before = api.requests.length;
    const bad = await runCli(["creative-lab", "lamp", "build", "create", "--input-task-id", "p", "--data", '{"options":{"diameter_mm":10}}', "--options", '{"thickness_mm":1.5}', "--async"], { env: api.env() });
    assert.equal(bad.code, 2, bad.stderr);
    assert.equal(api.requests.length, before);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F01 / R05, R06 — the accepted task id survives every later failure
// ---------------------------------------------------------------------------

test("R05/F01 --save-json: an existing target is refused before the POST; a failure after the POST still reports the accepted id", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "accepted-before-save-error" }) : jsonReply(res, 404, {})));
  try {
    const dir = tmpDir();
    writeFileSync(join(dir, "occupied.json"), "existing-user-data");
    const preflight = await runCli([...CREATE, "--save-json", "occupied.json"], { env: api.env(), cwd: dir });
    assert.equal(preflight.code, 11, preflight.stderr);
    const pf = parseSingleJson(preflight.stdout) as { error: { code: string; message: string } };
    assert.equal(pf.error.code, "local_io");
    assert.match(pf.error.message, /nothing was submitted/);
    assert.equal(api.requests.length, 0, "a detectable conflict costs zero requests");
    assert.equal(readFileSync(join(dir, "occupied.json"), "utf8"), "existing-user-data");

    // A save that can only fail after the POST (the parent "directory" is a file).
    writeFileSync(join(dir, "blocked"), "i am a file");
    const late = await runCli([...CREATE, "--save-json", join("blocked", "task.json")], { env: api.env(), cwd: dir });
    assert.equal(late.code, 11, `${late.stderr}\n${late.stdout}`);
    const out = parseSingleJson(late.stdout) as { ok: boolean; error: { code: string }; result: { task_id: string; submission: { state: string; task_id: string; operation_id: string }; next: { get: string; wait: string } } };
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "local_io");
    assert.equal(out.result.task_id, "accepted-before-save-error");
    assert.equal(out.result.submission.state, "accepted");
    assert.equal(out.result.submission.task_id, "accepted-before-save-error");
    assert.match(out.result.next.get, /get accepted-before-save-error/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
  } finally {
    await api.close();
  }
});

test("R06/F01 sync create: a 503 while polling keeps the created id, submission and resume commands; exactly one POST", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "accepted-before-get-error" }) : jsonReply(res, 503, { message: "synthetic temporary outage" })));
  try {
    const r = await runCli(CREATE.filter((a) => a !== "--async"), { env: api.env() });
    assert.equal(r.code, 1, `${r.stderr}\n${r.stdout}`);
    const out = parseSingleJson(r.stdout) as { ok: boolean; error: { code: string; http_status: number }; result: { task: unknown; task_id: string; submission: { state: string; task_id: string }; next: { wait: string }; wait: { polls: number } } };
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "server");
    assert.equal(out.error.http_status, 503);
    assert.equal(out.result.task_id, "accepted-before-get-error");
    assert.equal(out.result.submission.state, "accepted");
    assert.equal(out.result.submission.task_id, "accepted-before-get-error");
    assert.match(out.result.next.wait, /wait accepted-before-get-error/);
    assert.equal(out.result.wait.polls, 0);
    assert.deepEqual(api.requests.map((q) => q.method), ["POST", "GET"]);
    // The same for a bare `wait`, and for the legacy schema.
    const w = await runCli(["text-to-3d", "wait", "some-task", "--output-schema", "v1"], { env: api.env() });
    assert.equal(w.code, 1, w.stderr);
    assert.equal((parseSingleJson(w.stdout) as { result: { task_id: string } }).result.task_id, "some-task");
    const legacy = await runCli(CREATE.filter((a) => a !== "--async" && a !== "--output-schema" && a !== "v1"), { env: api.env() });
    assert.equal(legacy.code, 1, legacy.stderr);
    const lp = parseSingleJson(legacy.stdout) as { code: string; result: { task_id: string } };
    assert.equal(lp.code, "server");
    assert.equal(lp.result.task_id, "accepted-before-get-error");
  } finally {
    await api.close();
  }
});

test("F01 make: a polling failure after step 1 was accepted keeps executed steps, the task id and the resume command", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "prev-accepted" }) : jsonReply(res, 503, { message: "outage" })));
  try {
    const r = await runCli(["make", "a fixture cactus", "--output-schema", "v1"], { env: api.env() });
    assert.equal(r.code, 1, `${r.stderr}\n${r.stdout}`);
    const out = parseSingleJson(r.stdout) as { error: { code: string; http_status: number }; result: { task_id: string; executed: Array<{ task_id: string }>; submission: { state: string }; next: { wait: string } } };
    assert.equal(out.error.code, "server");
    assert.equal(out.error.http_status, 503);
    assert.equal(out.result.task_id, "prev-accepted");
    assert.equal(out.result.executed[0]!.task_id, "prev-accepted");
    assert.equal(out.result.submission.state, "accepted");
    assert.match(out.result.next.wait, /wait prev-accepted/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F09 / R07 — downloaded OBJ/MTL reference the files actually saved
// ---------------------------------------------------------------------------

test("R07/F09 download: mtllib and map_* references are rewritten to the saved names; manifest digests describe the rewritten files", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).png().toBuffer();
  const obj = "# meshy\nmtllib box.mtl\nv 0 0 0\nv 1 1 0\nv 0 1 1\nusemtl sample\nf 1 2 3\n";
  const mtl = "newmtl sample\nKd 0.8 0.8 0.8\nmap_Kd texture.png\nmap_Bump -bm 0.5 normal_map.png\n";
  const host = await startMockApi((req, res) => {
    const bodies: Record<string, { body: Buffer | string; type: string }> = {
      "/box.obj": { body: obj, type: "model/obj" },
      "/box.mtl": { body: mtl, type: "text/plain" },
      "/bc.png": { body: png, type: "image/png" },
      "/n.png": { body: png, type: "image/png" },
    };
    const entry = bodies[req.path];
    if (!entry) return jsonReply(res, 404, {});
    res.writeHead(200, { "content-type": entry.type });
    res.end(entry.body);
  });
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "obj-task.json");
    writeFileSync(taskJson, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/box.obj`, mtl: `${host.url}/box.mtl` }, texture_urls: [{ base_color: `${host.url}/bc.png`, normal: `${host.url}/n.png` }] })));
    const out = join(dir, "obj-download");
    const r = await runCli(["download", "--task-json", taskJson, "--model-format", "obj", "--output-dir", out], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    assert.deepEqual(readdirSync(out).sort(), ["model.mtl", "model.obj", "texture_0_base_color.png", "texture_0_normal.png"]);
    const savedObj = readFileSync(join(out, "model.obj"), "utf8");
    assert.match(savedObj, /^mtllib model\.mtl$/m);
    assert.ok(!savedObj.includes("box.mtl"));
    assert.ok(savedObj.includes("usemtl sample") && savedObj.includes("f 1 2 3"), "everything else is verbatim");
    const savedMtl = readFileSync(join(out, "model.mtl"), "utf8");
    assert.match(savedMtl, /^map_Kd texture_0_base_color\.png$/m);
    assert.match(savedMtl, /^map_Bump -bm 0\.5 texture_0_normal\.png$/m);
    for (const ref of savedMtl.match(/^map_\w+ (?:-\S+ \S+ )?(\S+)$/gm)!.map((l) => l.split(" ").at(-1)!)) {
      assert.ok(existsSync(join(out, ref)), `${ref} exists next to the MTL`);
    }
    const env = parseSingleJson(r.stdout) as { result: { downloads: { files: Array<{ key: string; path: string; sha256: string; relinked: boolean }>; material_links: { rewritten: string[]; mtllib: Array<{ resolved_to: string }>; texture_maps: Array<{ reference: string; resolved_to: string | null; method: string }> } } }; warnings: Array<{ code: string }> };
    const files = Object.fromEntries(env.result.downloads.files.map((f) => [f.key, f]));
    assert.equal(files["model.obj"]!.relinked, true);
    assert.equal(files["model.mtl"]!.relinked, true);
    assert.equal(files["texture.0.base_color"]!.relinked, false);
    for (const f of env.result.downloads.files) assert.equal(f.sha256, sha(f.path), `${f.key}: manifest digest matches the file on disk`);
    assert.equal(env.result.downloads.material_links.rewritten.length, 2);
    assert.deepEqual(env.result.downloads.material_links.mtllib.map((l) => l.resolved_to), ["model.mtl"]);
    assert.deepEqual(env.result.downloads.material_links.texture_maps.map((l) => [l.reference, l.resolved_to, l.method]), [
      ["texture.png", "texture_0_base_color.png", "channel_of_key"],
      ["normal_map.png", "texture_0_normal.png", "channel_in_name"],
    ]);
    assert.ok(!env.warnings.some((w) => w.code === "material_reference_unresolved"));

    // Legacy `-o` (all artifacts) relinks too.
    const api = await startMockApi((req, res) => {
      if (req.path.startsWith("/openapi/")) return jsonReply(res, 200, taskBody({ model_urls: { obj: `${host.url}/box.obj`, mtl: `${host.url}/box.mtl` }, texture_urls: [{ base_color: `${host.url}/bc.png`, normal: `${host.url}/n.png` }] }));
      return jsonReply(res, 404, {});
    });
    try {
      const legacyOut = join(dir, "legacy");
      const legacy = await runCli(["text-to-3d", "get", "review-task", "-o", legacyOut], { env: api.env(), cwd: dir });
      assert.equal(legacy.code, 0, legacy.stderr);
      assert.match(readFileSync(join(legacyOut, "model.obj"), "utf8"), /^mtllib model\.mtl$/m);
      assert.match(readFileSync(join(legacyOut, "model.mtl"), "utf8"), /^map_Kd texture_0_base_color\.png$/m);
    } finally {
      await api.close();
    }

    // Geometry only: the OBJ keeps its reference and the result says so.
    const geo = await runCli(["download", "--task-json", taskJson, "--asset", "model.obj", "--geometry-only", "--output-dir", join(dir, "geo")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(geo.code, 0, geo.stderr);
    assert.match(readFileSync(join(dir, "geo", "model.obj"), "utf8"), /^mtllib box\.mtl$/m);
    const gw = parseSingleJson(geo.stdout) as { warnings: Array<{ code: string }> };
    assert.ok(gw.warnings.some((w) => w.code === "geometry_only"));
    assert.ok(gw.warnings.some((w) => w.code === "material_reference_unresolved"));
  } finally {
    await host.close();
  }
});

test("F09 an MTL map that matches no downloaded texture stays as written and is reported, never silently dropped", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).png().toBuffer();
  const host = await startMockApi((req, res) => {
    if (req.path === "/m.obj") {
      res.writeHead(200, { "content-type": "model/obj" });
      {
      res.end("mtllib m.mtl\nv 0 0 0\n");
      return;
    }
    }
    if (req.path === "/m.mtl") {
      res.writeHead(200, { "content-type": "text/plain" });
      {
      res.end("newmtl a\nmap_Kd albedo.png\nmap_Ks specular_only.png\n");
      return;
    }
    }
    if (req.path === "/bc.png") {
      res.writeHead(200, { "content-type": "image/png" });
      {
      res.end(png);
      return;
    }
    }
    return jsonReply(res, 404, {});
  });
  try {
    const dir = tmpDir();
    const taskJson = join(dir, "t.json");
    writeFileSync(taskJson, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/m.obj`, mtl: `${host.url}/m.mtl` }, texture_urls: [{ base_color: `${host.url}/bc.png` }] })));
    const r = await runCli(["download", "--task-json", taskJson, "--asset", "model.obj", "--output-dir", join(dir, "out")], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const savedMtl = readFileSync(join(dir, "out", "model.mtl"), "utf8");
    assert.match(savedMtl, /^map_Kd texture_0_base_color\.png$/m, "albedo → base color by channel word");
    assert.match(savedMtl, /^map_Ks specular_only\.png$/m, "unresolved reference untouched");
    const env = parseSingleJson(r.stdout) as { warnings: Array<{ code: string; message: string }>; result: { downloads: { material_links: { texture_maps: Array<{ reference: string; resolved_to: string | null }> } } } };
    assert.ok(env.warnings.some((w) => w.code === "material_reference_unresolved" && w.message.includes("specular_only.png")));
    assert.deepEqual(env.result.downloads.material_links.texture_maps.map((l) => [l.reference, l.resolved_to]), [["albedo.png", "texture_0_base_color.png"], ["specular_only.png", null]]);
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// F03 / R08, R09 — --workspace confines every write path
// ---------------------------------------------------------------------------

test("R08/F03 project init/record/rebuild-index refuse roots and projects outside --workspace before writing", async () => {
  const dir = tmpDir();
  const workspace = join(dir, "workspace");
  const outside = join(dir, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const env = { PATH: process.env["PATH"], HOME: process.env["HOME"], MESHY_CLI_NO_UPDATE_NOTIFIER: "1", MESHY_CONFIG_DIR: tmpDir("cfg-") };
  const init = await runCli(["project", "init", "--workspace", workspace, "--root", join(outside, "projects"), "--name", "review"], { cwd: dir, env });
  assert.equal(init.code, 11, `${init.stderr}\n${init.stdout}`);
  assert.equal((parseSingleJson(init.stdout) as { error: { code: string } }).error.code, "local_io");
  assert.deepEqual(readdirSync(outside), [], "nothing was created outside the workspace");

  const inside = await runCli(["project", "init", "--workspace", workspace, "--root", join(workspace, "projects"), "--name", "review"], { cwd: dir, env });
  assert.equal(inside.code, 0, inside.stderr);
  const projectDir = (parseSingleJson(inside.stdout) as { result: { project_dir: string } }).result.project_dir;
  assert.ok(existsSync(join(projectDir, "metadata.json")));

  // A project that lives outside the workspace cannot be written to.
  const foreign = await runCli(["project", "init", "--root", join(outside, "projects"), "--name", "foreign"], { cwd: dir, env });
  assert.equal(foreign.code, 0, foreign.stderr);
  const foreignDir = (parseSingleJson(foreign.stdout) as { result: { project_dir: string } }).result.project_dir;
  const rec = await runCli(["project", "record", "--workspace", workspace, "--project", foreignDir, "--task-id", "t", "--stage", "preview"], { cwd: dir, env });
  assert.equal(rec.code, 11, rec.stderr);
  assert.equal((JSON.parse(readFileSync(join(foreignDir, "metadata.json"), "utf8")) as { tasks: unknown[] }).tasks.length, 0);
  const rebuild = await runCli(["project", "rebuild-index", "--workspace", workspace, "--root", join(outside, "projects")], { cwd: dir, env });
  assert.equal(rebuild.code, 11, rebuild.stderr);
  // Task verbs: --project outside the workspace is refused before the POST.
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "never" }) : jsonReply(res, 404, {})));
  try {
    const create = await runCli([...CREATE, "--workspace", workspace, "--project", foreignDir], { cwd: dir, env: api.env() });
    assert.equal(create.code, 11, create.stderr);
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("R09/F03 task -o (get/wait/create/make) honours --workspace like standalone download; nothing outside is written or fetched", async () => {
  const dir = tmpDir();
  const workspace = join(dir, "workspace");
  const outside = join(dir, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const api = await startMockApi((req, res) => {
    if (req.path === "/asset.glb") {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      {
      res.end(glb());
      return;
    }
    }
    if (req.method === "POST") return jsonReply(res, 200, { result: "review-task" });
    return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/asset.glb` } }));
  });
  try {
    const env = api.env();
    const outsideModel = join(outside, "model.glb");
    const get = await runCli(["text-to-3d", "get", "review-task", "--output-schema", "v1", "--workspace", workspace, "-o", outsideModel], { env, cwd: dir });
    assert.equal(get.code, 11, `${get.stderr}\n${get.stdout}`);
    const go = parseSingleJson(get.stdout) as { error: { code: string }; result: { task_id: string; downloads: { state: string } } };
    assert.equal(go.error.code, "local_io");
    assert.equal(go.result.task_id, "review-task", "the task is still reported");
    assert.equal(go.result.downloads.state, "failed");
    assert.ok(!existsSync(outsideModel));
    assert.equal(api.requests.filter((q) => q.path === "/asset.glb").length, 0, "nothing was fetched for a refused target");

    // Symlinked directory inside the workspace pointing outside.
    symlinkSync(outside, join(workspace, "link"));
    const viaLink = await runCli(["text-to-3d", "wait", "review-task", "--output-schema", "v1", "--workspace", workspace, "-o", join(workspace, "link", "m.glb")], { env, cwd: dir });
    assert.equal(viaLink.code, 11, viaLink.stderr);
    assert.deepEqual(readdirSync(outside), []);

    // create / make: refused before the POST.
    const before = api.requests.length;
    const create = await runCli([...CREATE, "--workspace", workspace, "-o", outsideModel], { env, cwd: dir });
    assert.equal(create.code, 11, create.stderr);
    const make = await runCli(["make", "a fixture cactus", "--workspace", workspace, "-o", outsideModel, "--output-schema", "v1"], { env, cwd: dir });
    assert.equal(make.code, 11, make.stderr);
    assert.equal(api.requests.length, before, "no request for a target outside the workspace");
    assert.deepEqual(readdirSync(outside), []);

    // Inside the workspace the same commands work.
    const ok = await runCli(["text-to-3d", "get", "review-task", "--output-schema", "v1", "--workspace", workspace, "-o", join(workspace, "sub", "model.glb")], { env, cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(existsSync(join(workspace, "sub", "model.glb")));
    // Legacy schema, same boundary.
    const legacy = await runCli(["text-to-3d", "get", "review-task", "--workspace", workspace, "-o", join(outside, "legacy.glb")], { env, cwd: dir });
    assert.equal(legacy.code, 11, legacy.stderr);
    assert.ok(!existsSync(join(outside, "legacy.glb")));
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F10 / R10 — stream honours -o in every output format
// ---------------------------------------------------------------------------

test("R10/F10 stream -o downloads the assets in ndjson, json and pretty; a download failure is one outcome with the task kept", async () => {
  let assetOk = true;
  const api = await startMockApi((req, res) => {
    if (req.path.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/asset.glb` } }))}\n\n`);
      return;
    }
    if (req.path === "/asset.glb") {
      if (!assetOk) return jsonReply(res, 404, { message: "gone" });
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(glb());
      return;
    }
    return jsonReply(res, 404, {});
  });
  try {
    const dir = tmpDir();
    for (const format of ["ndjson", "json", "pretty"] as const) {
      api.requests.length = 0;
      const target = join(dir, `${format}.glb`);
      const r = await runCli(["text-to-3d", "stream", "review-task", "--format", format, "--output-schema", "v1", "-o", target], { env: api.env(), cwd: dir });
      assert.equal(r.code, 0, `${format}: ${r.stderr}\n${r.stdout}`);
      assert.ok(existsSync(target), `${format}: the asset landed`);
      assert.deepEqual(api.requests.map((q) => q.path), ["/openapi/v2/text-to-3d/review-task/stream", "/asset.glb"], `${format}: one SSE GET, one asset GET`);
      if (format === "ndjson") {
        const lines = parseNdjson(r.stdout) as Array<{ event: string; ok: boolean; result: { downloads: { state: string; files: Array<{ path: string }> } } }>;
        assert.deepEqual(lines.map((l) => l.event), ["task", "outcome"]);
        assert.equal(lines[1]!.ok, true);
        assert.equal(lines[1]!.result.downloads.state, "completed");
        assert.equal(lines[1]!.result.downloads.files[0]!.path, target);
      } else if (format === "json") {
        const env = parseSingleJson(r.stdout) as { result: { downloads: { state: string } } };
        assert.equal(env.result.downloads.state, "completed");
      } else {
        assert.match(r.stdout, /state: completed/);
      }
    }
    // Download failure: exactly one outcome line, ok:false, task kept, exit code of the failure.
    assetOk = false;
    api.requests.length = 0;
    const target = join(dir, "failing.glb");
    const bad = await runCli(["text-to-3d", "stream", "review-task", "--format", "ndjson", "--output-schema", "v1", "-o", target], { env: api.env(), cwd: dir });
    // The asset host's 404 keeps its own class (round 2, R2-F04): not_found / exit 5, never a bare local_io.
    assert.equal(bad.code, 5, `${bad.stderr}\n${bad.stdout}`);
    const lines = parseNdjson(bad.stdout) as Array<{ event: string; ok: boolean; error: { code: string; http_status: number | null } | null; result: { task_id: string; task: { status: string }; downloads: { state: string; files: Array<{ key: string; status: string }> } } }>;
    assert.deepEqual(lines.map((l) => l.event), ["task", "outcome"], "one outcome, no second envelope");
    assert.equal(lines[1]!.ok, false);
    assert.equal(lines[1]!.error!.code, "not_found");
    assert.equal(lines[1]!.error!.http_status, 404);
    assert.equal(lines[1]!.result.task_id, "review-task");
    assert.equal(lines[1]!.result.task.status, "SUCCEEDED");
    assert.equal(lines[1]!.result.downloads.state, "failed");
    assert.deepEqual(lines[1]!.result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "failed"]]);
    assert.ok(!existsSync(target));
    const badJson = await runCli(["text-to-3d", "stream", "review-task", "--output-schema", "v1", "-o", join(dir, "failing2.glb")], { env: api.env(), cwd: dir });
    assert.equal(badJson.code, 5, badJson.stderr);
    assert.equal((parseSingleJson(badJson.stdout) as { result: { task_id: string } }).result.task_id, "review-task");
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F02 / R11 — make: journal failure after acceptance is local_io with the id
// ---------------------------------------------------------------------------

test("R11/F02 make: a journal write failure after the server accepted is local_io (11) with the known id, never submission_unknown", async () => {
  let operations = "";
  const api = await startMockApi((_req, res) => {
    // Deterministic local journal failure after the POST reached the server:
    // the `started` record vanishes before the CLI can mark it accepted.
    for (const name of readdirSync(operations).filter((n) => n.endsWith(".json"))) {
      const full = join(operations, name);
      if ((JSON.parse(readFileSync(full, "utf8")) as { state: string }).state === "started") unlinkSync(full);
    }
    jsonReply(res, 200, { result: "make-known-accepted-id" });
  });
  try {
    const shared = api.env();
    operations = join(String(shared["MESHY_CONFIG_DIR"]), "operations");
    const text = await runCli(["make", "a fixture cactus", "--async", "--output-schema", "v1"], { env: shared });
    assert.equal(text.code, 11, `${text.stderr}\n${text.stdout}`);
    const out = parseSingleJson(text.stdout) as { error: { code: string }; result: { submission: { state: string; task_id: string }; task_id: string; step: number; next: { wait: string } } };
    assert.equal(out.error.code, "local_io");
    assert.equal(out.result.submission.state, "accepted");
    assert.equal(out.result.submission.task_id, "make-known-accepted-id");
    assert.equal(out.result.task_id, "make-known-accepted-id");
    assert.equal(out.result.step, 1);
    assert.match(out.result.next.wait, /wait make-known-accepted-id/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);

    // Image route: same contract.
    api.requests.length = 0;
    const dir = tmpDir();
    const png = join(dir, "cat.png");
    writeFileSync(png, await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());
    const img = await runCli(["make", png, "--async", "--output-schema", "v1"], { env: shared, cwd: dir });
    assert.equal(img.code, 11, `${img.stderr}\n${img.stdout}`);
    const io = parseSingleJson(img.stdout) as { error: { code: string }; result: { submission: { state: string; task_id: string } } };
    assert.equal(io.error.code, "local_io");
    assert.equal(io.result.submission.state, "accepted");
    assert.equal(io.result.submission.task_id, "make-known-accepted-id");
    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), ["POST /openapi/v1/image-to-3d"]);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// F04 / R12 — OBJ dependency copies cannot escape through a symlinked parent
// ---------------------------------------------------------------------------

test("R12/F04 prepare-print: a symlinked materials/ (or texture) directory under the target cannot receive a copy; real directories still work", async () => {
  const dir = tmpDir();
  const workspace = join(dir, "workspace");
  const escape = join(dir, "escaped-materials");
  mkdirSync(join(workspace, "source", "materials", "tex"), { recursive: true });
  mkdirSync(escape);
  writeFileSync(join(workspace, "source", "mesh.obj"), "mtllib materials/a.mtl\nv 0 0 0\nv 1 1 0\nv 0 1 1\nf 1 2 3\n");
  writeFileSync(join(workspace, "source", "materials", "a.mtl"), "newmtl sample\nKd 0.8 0.8 0.8\nmap_Kd tex/t.png\n");
  writeFileSync(join(workspace, "source", "materials", "tex", "t.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const env = { PATH: process.env["PATH"], HOME: process.env["HOME"], MESHY_CLI_NO_UPDATE_NOTIFIER: "1", MESHY_CONFIG_DIR: tmpDir("cfg-") };

  // materials/ under the target is a symlink to a directory outside the workspace.
  mkdirSync(join(workspace, "target"));
  symlinkSync(escape, join(workspace, "target", "materials"));
  const r = await runCli(["mesh", "prepare-print", join(workspace, "source", "mesh.obj"), "--workspace", workspace, "-o", join(workspace, "target", "mesh.obj")], { cwd: dir, env });
  assert.equal(r.code, 11, `${r.stderr}\n${r.stdout}`);
  assert.match((parseSingleJson(r.stdout) as { error: { message: string } }).error.message, /material dependency target/);
  assert.deepEqual(readdirSync(escape), [], "nothing was written outside");
  assert.ok(!existsSync(join(workspace, "target", "mesh.obj")), "no output either: the run is all or nothing");

  // Same escape one level down: materials/ is real, materials/tex is the symlink.
  mkdirSync(join(workspace, "target2", "materials"), { recursive: true });
  symlinkSync(escape, join(workspace, "target2", "materials", "tex"));
  const r2 = await runCli(["mesh", "prepare-print", join(workspace, "source", "mesh.obj"), "--workspace", workspace, "-o", join(workspace, "target2", "mesh.obj")], { cwd: dir, env });
  assert.equal(r2.code, 11, r2.stderr);
  assert.deepEqual(readdirSync(escape), []);
  assert.ok(!existsSync(join(workspace, "target2", "mesh.obj")));

  // Without --workspace the output directory is the root: still refused.
  mkdirSync(join(dir, "target3"));
  symlinkSync(escape, join(dir, "target3", "materials"));
  const r3 = await runCli(["mesh", "prepare-print", join(workspace, "source", "mesh.obj"), "-o", join(dir, "target3", "mesh.obj")], { cwd: dir, env });
  assert.equal(r3.code, 11, r3.stderr);
  assert.deepEqual(readdirSync(escape), []);

  // Real directories: dependencies are copied inside the target tree and reported.
  const ok = await runCli(["mesh", "prepare-print", join(workspace, "source", "mesh.obj"), "--workspace", workspace, "-o", join(workspace, "target4", "mesh.obj")], { cwd: dir, env });
  assert.equal(ok.code, 0, `${ok.stderr}\n${ok.stdout}`);
  assert.ok(existsSync(join(workspace, "target4", "mesh.obj")));
  assert.ok(existsSync(join(workspace, "target4", "materials", "a.mtl")));
  assert.ok(existsSync(join(workspace, "target4", "materials", "tex", "t.png")));
  const rep = parseSingleJson(ok.stdout) as { result: { material: { copied: string[] } } };
  assert.equal(rep.result.material.copied.length, 2);
});

// ---------------------------------------------------------------------------
// Reviewer note — a real two-process race on one operation id at the CLI level
// ---------------------------------------------------------------------------

test("two concurrent creates with the same --operation-id send exactly one POST", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? laterReply(res, 150, 200, { result: "raced-task" }) : jsonReply(res, 404, {})));
  try {
    const env = api.env();
    const args = [...CREATE, "--operation-id", "race-op"];
    const [a, b] = await Promise.all([runCli(args, { env }), runCli(args, { env })]);
    const codes = [a.code, b.code].sort();
    assert.ok(codes.every((c) => c === 0 || c === 10), `codes ${JSON.stringify(codes)}: ${a.stderr} ${b.stderr}`);
    assert.ok(codes.includes(0), "one invocation owns the accepted submission");
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, "the journal serialises the two processes onto one request");
    for (const r of [a, b]) {
      const out = parseSingleJson(r.stdout) as { ok: boolean; result: { submission: { state: string; operation_id: string } }; error: { code: string } | null };
      assert.equal(out.result.submission.operation_id, "race-op");
      if (!out.ok) assert.equal(out.error!.code, "submission_unknown", "the loser sees the in-flight record and never re-sends");
    }
  } finally {
    await api.close();
  }
});

// Keep the MockApi type in use for readers of this file.
export type { MockApi };
