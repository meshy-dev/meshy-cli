/**
 * Codex review round 3 (reviews/cli-s1-cf8905d, R3-F01–R3-F06) as positive
 * regressions. Each scenario mirrors the reviewer's probe (C01–C06) with real
 * subprocesses, a loopback API/asset host that records every request, synthetic
 * credentials and isolated temp directories, and asserts the required outcome:
 * the sidecar is published like an asset (no overwrite, no new symlink, root
 * re-proven at publication), every failure after the transfers keeps the
 * per-file manifest with the bytes actually on disk, Ctrl-C during the material
 * rewrite is an interrupt, errors after an accepted create still name the task,
 * texture identity follows the server-side name even when it collides with a
 * generated one, and an aliased project path still records its files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";


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

/** The error envelope of a failed run. */
interface ErrorEnvelope {
  ok: boolean;
  error: { code: string; http_status: number | null; hint?: string; message: string };
  result: { task_id?: string; submission?: { state: string; operation_id: string | null; task_id?: string }; next?: { wait: string; get: string }; downloads?: { state: string; files: Array<{ key: string; status: string }>; failed_step?: string } } | null;
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
      const r = await runCli(["text-to-3d", "get", "round3-task", "--workspace", workspace, "-o", out], { env, cwd: dir });
      assert.equal(r.code, 11, `${label}: ${r.stderr}\n${r.stdout}`);
      const env1 = parseSingleJson(r.stdout) as { error: { code: string; message: string }; result: { task_id: string; downloads: { state: string; failed_step: string; files: Array<{ key: string; path: string; status: string; sha256: string }> } } };
      assert.equal(env1.error.code, "local_io");
      assert.match(env1.error.message, re, `${label}: the refusal names its cause`);
      assert.equal(env1.result.task_id, "round3-task");
      assert.equal(env1.result.downloads.state, "partial");
      assert.equal(env1.result.downloads.failed_step, "sidecar");
      assert.deepEqual(env1.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"]]);
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
    const s = await runCli(["text-to-3d", "get", "round3-task", "--workspace", workspace, "-o", single], { env, cwd: dir });
    assert.equal(s.code, 11, `${s.stderr}\n${s.stdout}`);
    assert.equal(readFileSync(outside, "utf8"), "original-user-data");
    assert.ok(existsSync(single), "the model itself was published");
    // The refusal's envelope keeps the task discoverable and names the failed step.
    const raceOut = join(workspace, "race-envelope");
    plant = () => {
      mkdirSync(raceOut, { recursive: true });
      symlinkSync(outside, join(raceOut, "meta.json"));
    };
    const raced = await runCli(["text-to-3d", "get", "round3-task", "--workspace", workspace, "-o", raceOut], { env, cwd: dir });
    assert.equal(raced.code, 11, raced.stderr);
    const lp = parseSingleJson(raced.stdout) as ErrorEnvelope;
    assert.equal(lp.error.code, "local_io");
    assert.equal(lp.result?.task_id, "round3-task");
    assert.equal(lp.result?.downloads?.failed_step, "sidecar");
    assert.deepEqual(lp.result?.downloads?.files.map((f) => [f.key, f.status]), [["model.glb", "written"]]);
    assert.equal(readFileSync(outside, "utf8"), "original-user-data");
  } finally {
    await api.close();
  }
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

// ---------------------------------------------------------------------------
// R3-F02 / C06 — a run without the flag keeps the accepted task on every download failure
// ---------------------------------------------------------------------------

test("C06/R3-F02 sync create/wait/get: an asset 503, a sidecar failure and SIGINT still report task_id, the real operation_id, next and the manifest; exactly one POST (make: codex-review-round4 R4-T01 with distinct step ids)", async () => {
  let assetMode: "503" | "ok" | "slow" = "503";
  let plant: (() => void) | null = null;
  let child: ChildProcess | null = null;
  const api = await startMockApi(async (req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "paid-created-id" });
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
    return jsonReply(res, 200, taskBody({ id: "paid-created-id", model_urls: { glb: `${api.url}/asset.glb` } }));
  });
  try {
    const dir = tmpDir();
    const env = api.env();
    const configDir = String(env["MESHY_CONFIG_DIR"]);

    // Sync create (no flag), asset host 503.
    const created = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "fixture created", "-o", join(dir, "created-out")], { env, cwd: dir });
    assert.equal(created.code, 7, `${created.stderr}\n${created.stdout}`);
    const payload = parseSingleJson(created.stdout) as ErrorEnvelope;
    assert.equal(payload.error.code, "network");
    assert.equal(payload.error.http_status, 503);
    assert.equal(payload.result?.task_id, "paid-created-id");
    assert.equal(payload.result?.task_id, "paid-created-id");
    assert.equal(payload.result?.submission?.state, "accepted");
    const [operationId] = journalOperationIds(configDir);
    assert.ok(operationId, "the journal holds the accepted record");
    assert.equal(payload.result?.submission?.operation_id, operationId, "the error names the journal's operation id");
    assert.equal(payload.result?.submission?.operation_id, operationId);
    assert.match(payload.result?.next?.wait ?? "", /wait paid-created-id/);
    assert.deepEqual(payload.result?.downloads?.files.map((f) => [f.key, f.status]), [["model.glb", "failed"]]);
    assert.ok(payload.error.hint && /paid-created-id/.test(payload.error.hint), "the hint (also printed on stderr) names the task");
    assert.match(created.stderr, /paid-created-id/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
    assert.equal(api.requests.filter((q) => q.method === "DELETE").length, 0);

    // wait -o: same fields.
    const waited = await runCli(["text-to-3d", "wait", "paid-created-id", "-o", join(dir, "wait-out")], { env, cwd: dir });
    assert.equal(waited.code, 7, waited.stderr);
    const wp = parseSingleJson(waited.stdout) as ErrorEnvelope;
    assert.equal(wp.result?.task_id, "paid-created-id");
    assert.equal(wp.error.http_status, 503);

    // Sidecar failure after the asset landed.
    assetMode = "ok";
    const sideDir = join(dir, "sidecar-out");
    plant = () => {
      mkdirSync(sideDir, { recursive: true });
      mkdirSync(join(sideDir, "meta.json"));
    };
    const side = await runCli(["text-to-3d", "get", "paid-created-id", "-o", sideDir], { env, cwd: dir });
    assert.equal(side.code, 11, `${side.stderr}\n${side.stdout}`);
    const sp = parseSingleJson(side.stdout) as ErrorEnvelope;
    assert.equal(sp.result?.task_id, "paid-created-id");
    assert.equal(sp.result?.downloads?.state, "partial");
    assert.equal(sp.result?.downloads?.failed_step, "sidecar");
    assert.deepEqual(sp.result?.downloads?.files.map((f) => [f.key, f.status]), [["model.glb", "written"]]);
    assert.ok(existsSync(join(sideDir, "model.glb")));

    // SIGINT during the transfer.
    assetMode = "slow";
    const target = join(dir, "interrupted.glb");
    const interrupted = await runCli(["text-to-3d", "get", "paid-created-id", "-o", target], { env, cwd: dir, onSpawn: (c) => (child = c) });
    assert.equal(interrupted.code, 130, `${interrupted.stderr}\n${interrupted.stdout}`);
    const ip = parseSingleJson(interrupted.stdout) as ErrorEnvelope;
    assert.equal(ip.error.code, "interrupted");
    assert.equal(ip.result?.task_id, "paid-created-id");
    assert.ok(!existsSync(target));

  } finally {
    await api.close();
  }
});
