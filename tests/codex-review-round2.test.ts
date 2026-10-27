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
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialBinding } from "../src/internal/operation-store.js";
import { jsonReply, parseNdjson, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const CREATE = ["text-to-3d", "create", "--mode", "preview", "--prompt", "round two", "--async"];

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
      const r = await runCli(["analyze-printability", verb, "round2-task", "--workspace", workspace, "-o", file], { env, cwd: dir });
      assert.equal(r.code, 11, `${verb} file: ${r.stderr}\n${r.stdout}`);
      const out = (verb === "stream" ? parseSingleJson(r.stdout) : parseSingleJson(r.stdout)) as { error: { code: string }; result: { task_id: string; downloads: { state: string } } };
      assert.equal(out.error.code, "local_io");
      assert.equal(out.result.task_id, "round2-task");
      assert.equal(out.result.downloads.state, "failed");
      assert.ok(!existsSync(join(outside, `report-${verb}`)), `${verb}: the parent directory was not created`);
      // Directory form.
      const d = await runCli(["analyze-printability", verb, "round2-task", "--workspace", workspace, "-o", join(outside, `dir-${verb}`)], { env, cwd: dir });
      assert.equal(d.code, 11, `${verb} dir: ${d.stderr}`);
      assert.ok(!existsSync(join(outside, `dir-${verb}`)));
    }
    assert.deepEqual(listing(outside), outsideBefore, "nothing outside the workspace changed");
    // Symlinked parent inside the workspace pointing outside.
    symlinkSync(outside, join(workspace, "link"));
    const viaLink = await runCli(["analyze-printability", "get", "round2-task", "--workspace", workspace, "-o", join(workspace, "link", "report.json")], { env, cwd: dir });
    assert.equal(viaLink.code, 11, viaLink.stderr);
    assert.deepEqual(listing(outside), outsideBefore);
    // Inside the workspace: file and directory forms both write the report.
    const okFile = await runCli(["analyze-printability", "get", "round2-task", "--workspace", workspace, "-o", join(workspace, "reports", "r.json")], { env, cwd: dir });
    assert.equal(okFile.code, 0, `${okFile.stderr}\n${okFile.stdout}`);
    assert.equal((JSON.parse(readFileSync(join(workspace, "reports", "r.json"), "utf8")) as { status: string }).status, "healthy", "the file is the report");
    assert.equal((JSON.parse(readFileSync(join(workspace, "reports", "r_meta.json"), "utf8")) as { task: { id: string } }).task.id, "round2-task");
    assert.equal((parseSingleJson(okFile.stdout) as { result: { downloads: { state: string; metadata_path: string } } }).result.downloads.state, "completed");
    const okDir = await runCli(["analyze-printability", "wait", "round2-task", "--workspace", workspace, "-o", join(workspace, "report-dir")], { env, cwd: dir });
    assert.equal(okDir.code, 0, okDir.stderr);
    assert.ok(existsSync(join(workspace, "report-dir", "meta.json")));
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
// R2-F03 / N05 — every post-stream failure ends in one outcome event
// ---------------------------------------------------------------------------

test("N05/R2-F03 stream: a save-json conflict and a download failure each end in exactly one outcome with the next sequence", async () => {
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
      ["asset 404", ["-o", join(dir, "asset.glb")], 5, "not_found"],
    ];
    for (const [label, extra, exitCode, code] of cases) {
      const nd = await runCli(["text-to-3d", "stream", "round2-task", "--format", "ndjson", ...extra], { env: api.env(), cwd: dir });
      assert.equal(nd.code, exitCode, `${label}: ${nd.stderr}\n${nd.stdout}`);
      const lines = parseNdjson(nd.stdout) as Array<{ event?: string; sequence?: number; ok: boolean; error: { code: string } | null; result: { task_id: string; task: { status: string } } }>;
      assert.deepEqual(lines.map((l) => l.event), ["task", "outcome"], `${label}: one task event, one outcome`);
      assert.deepEqual(lines.map((l) => l.sequence), [1, 2], `${label}: sequence keeps counting`);
      assert.equal(lines[1]!.ok, false);
      assert.equal(lines[1]!.error!.code, code);
      assert.equal(lines[1]!.result.task_id, "round2-task");
      assert.equal(lines[1]!.result.task.status, "SUCCEEDED");
      // json/pretty: exactly one final document with the same classification.
      const js = await runCli(["text-to-3d", "stream", "round2-task", ...extra], { env: api.env(), cwd: dir });
      assert.equal(js.code, exitCode, `${label} json: ${js.stderr}`);
      const env = parseSingleJson(js.stdout) as { ok: boolean; error: { code: string }; result: { task_id: string } };
      assert.equal(env.ok, false);
      assert.equal(env.error.code, code);
      assert.equal(env.result.task_id, "round2-task");
      const pretty = await runCli(["text-to-3d", "stream", "round2-task", "--format", "pretty", ...extra], { env: api.env(), cwd: dir });
      assert.equal(pretty.code, exitCode, `${label} pretty: ${pretty.stderr}`);
      // pretty: a person gets the error on stderr, and stdout carries no envelope.
      assert.equal(pretty.stdout, "", `${label} pretty: no envelope on stdout`);
      assert.equal((pretty.stderr.match(/^error: /gm) ?? []).length, 1, `${label} pretty: one error line`);
    }
    assert.equal(readFileSync(occupied, "utf8"), "do not overwrite");
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R2-F04 / N06 — partial downloads keep their manifest and HTTP class
// ---------------------------------------------------------------------------

test("N06/R2-F04 task -o: first asset written, second asset 503/404/403 → the manifest lists both, the HTTP class and status survive, files stay on disk, the sidecar records them and the recovery is the same -o", async () => {
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
        const r = await runCli(["text-to-3d", verb, "round2-task", "-o", out], { env: api.env(), cwd: dir });
        assert.equal(r.code, exitCode, `${verb} ${status}: ${r.stderr}\n${r.stdout}`);
        const env = parseSingleJson(r.stdout) as { error: { code: string; http_status: number; recovery: { command: string } }; result: { task_id: string; downloads: { state: string; metadata_path: string | null; files: Array<{ key: string; path: string; status: string; sha256: string; error: string | null }> } } };
        assert.equal(env.error.code, code);
        assert.equal(env.error.http_status, status);
        assert.equal(env.result.task_id, "round2-task");
        assert.equal(env.result.downloads.state, "partial");
        assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"], ["thumbnail.primary", "failed"]]);
        const written = env.result.downloads.files[0]!;
        assert.equal(written.path, join(out, "model.glb"));
        assert.ok(existsSync(written.path), "the committed file is not rolled back");
        assert.equal(sha(written.path), written.sha256);
        assert.match(env.result.downloads.files[1]!.error ?? "", new RegExp(String(status)));
        assert.equal(env.result.downloads.metadata_path, join(out, "meta.json"));
        assert.deepEqual((JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as { saved_files: string[] }).saved_files, [written.path], "the sidecar records what landed");
        assert.equal(env.error.recovery.command, `meshy text-to-3d get round2-task -o ${out}`);
        assert.deepEqual(readdirSync(out).sort(), ["meta.json", "model.glb"], "no temp files linger");
      }
    }
    // make: same rule on its final download.
    second = { status: 503, body: { message: "outage" } };
    const makeOut = join(dir, "make-out");
    const mk = await runCli(["make", "a cactus", "-o", makeOut], { env: api.env(), cwd: dir });
    assert.equal(mk.code, 7, `${mk.stderr}\n${mk.stdout}`);
    const mo = parseSingleJson(mk.stdout) as { error: { code: string; http_status: number; recovery: { command: string } }; result: { task_id: string; executed: unknown[]; downloads: { state: string; files: Array<{ key: string; status: string }> } } };
    assert.equal(mo.error.code, "network");
    assert.equal(mo.error.http_status, 503);
    assert.equal(mo.result.task_id, "round2-task");
    assert.equal(mo.result.executed.length, 2);
    assert.equal(mo.result.downloads.state, "partial");
    assert.deepEqual(mo.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"], ["thumbnail.primary", "failed"]]);
    assert.ok(existsSync(join(makeOut, "model.glb")));
    assert.equal(mo.error.recovery.command, `meshy text-to-3d get round2-task -o ${makeOut}`);
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
      const r = await runCli(["text-to-3d", "get", "round2-task", "-o", target], { env: api.env(), cwd: dir, onSpawn: (c) => (child = c) });
      assert.equal(r.code, 130, `${m}: ${r.stderr}\n${r.stdout}`);
      const env = parseSingleJson(r.stdout) as { error: { code: string }; result: { task_id: string; submission: { state: string }; next: { get: string }; downloads: { state: string; files: Array<{ key: string; status: string; error: string | null }> } } };
      assert.equal(env.error.code, "interrupted");
      assert.equal(env.result.task_id, "round2-task");
      assert.equal(env.result.submission.state, "accepted");
      assert.match(env.result.next.get, /get round2-task/);
      assert.equal(env.result.downloads.state, "failed");
      assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "failed"]]);
      assert.ok(!existsSync(target), `${m}: no final file`);
      assert.ok(!existsSync(join(dir, `${m}_meta.json`)), `${m}: no sidecar`);
      assert.ok(!readdirSync(dir).some((f) => f.includes(".tmp-")), `${m}: temp file cleaned`);
      assert.deepEqual(api.requests.map((q) => q.method), ["GET", "GET"], `${m}: task GET + one asset GET, nothing else`);
    }
    // Second asset: the first stays committed in the manifest.
    mode = "second";
    api.requests.length = 0;
    const out = join(dir, "second");
    const r = await runCli(["text-to-3d", "wait", "round2-task", "-o", out], { env: api.env(), cwd: dir, onSpawn: (c) => (child = c) });
    assert.equal(r.code, 130, `${r.stderr}\n${r.stdout}`);
    const env = parseSingleJson(r.stdout) as { error: { code: string }; result: { downloads: { state: string; files: Array<{ key: string; status: string; path: string }> } } };
    assert.equal(env.error.code, "interrupted");
    assert.equal(env.result.downloads.state, "partial");
    assert.deepEqual(env.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"], ["thumbnail.primary", "failed"]]);
    assert.ok(existsSync(env.result.downloads.files[0]!.path));
    assert.deepEqual(readdirSync(out).sort(), ["meta.json", "model.glb"], "no temp file; the sidecar records what landed");
    assert.ok(!api.requests.some((q) => q.method === "DELETE" || q.method === "POST"));
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
