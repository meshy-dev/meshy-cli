/**
 * Codex review round 6 (reviews/cli-s1-7b7c24c: R6-F01, R6-F02) as positive
 * regressions with real subprocesses, a loopback API that records every request,
 * synthetic credentials and isolated temp directories. The write boundary is
 * frozen when a command starts — the real path and the directory identity of
 * the --workspace (or of the project directory when no workspace is given) —
 * and every later check proves that this very directory is still there and
 * that the target resolves inside it. While a request is in flight the project
 * directory, its parent, the workspace itself or the alias the workspace was
 * given through is replaced by a symlink to an outside directory holding a
 * valid project: the download command and every task verb refuse to record,
 * keep the completed manifest / accepted task, write nothing outside (bytes of
 * the outside metadata.json and history.json compared whole), and offer no
 * command that would write across the boundary. Stable aliases keep working.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const V1 = ["--output-schema", "v1"];
const ENVELOPE_KEYS = ["schema_version", "command", "ok", "result", "error", "warnings"].sort();

function taskBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "round6-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, ...fields };
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

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Every file under `dir` (relative POSIX paths → sha256), so "nothing changed outside" is a whole-tree statement. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.isFile()) out[relative(dir, p).split("\\").join("/")] = sha(p);
      else out[relative(dir, p).split("\\").join("/")] = `<${name.isSymbolicLink() ? "symlink" : "special"}>`;
    }
  };
  walk(dir);
  return out;
}

interface JournalRecord {
  operation_id: string;
  state: string;
  task_id: string | null;
}

function journal(configDir: string): JournalRecord[] {
  const ops = join(configDir, "operations");
  if (!existsSync(ops)) return [];
  return readdirSync(ops)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ops, f), "utf8")) as JournalRecord);
}

interface ProjectFailure {
  project_dir: string;
  action: string;
  stage: string;
  recorded_files: string[];
  error: { code: string; message: string };
  recovery: unknown;
}

// ---------------------------------------------------------------------------
// R6-F01 — the download command re-validates the project against the frozen boundary
// ---------------------------------------------------------------------------

test("R6-F01 download --project P --workspace W --output-dir W/assets: when P (leaf) or W/projects (parent) is replaced by a symlink to an outside project during the asset GET — task-json and API sources — the record is refused: exit 11, completed manifest kept, project.failed with recovery null, outside tree byte-identical, exact requests; a healthy run still records", async () => {
  let plant: (() => void) | null = null;
  const api = await startMockApi((req, res) => {
    if (req.path === "/model.glb") {
      plant?.();
      plant = null;
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb());
    }
    if (req.path.startsWith("/openapi/")) return jsonReply(res, 200, taskBody({ model_urls: { glb: `${api.url}/model.glb` } }));
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    const dir = tmpDir();
    const env = api.env();
    const fixture = join(dir, "task.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/model.glb` } })));
    for (const source of ["task-json", "api"] as const) {
      for (const target of ["leaf", "parent"] as const) {
        const label = `${source}/${target}`;
        const workspace = join(dir, `ws-${source}-${target}`);
        mkdirSync(workspace);
        const init = await runCli(["project", "init", "--root", join(workspace, "projects"), "--name", "escape"], { env, cwd: dir });
        assert.equal(init.code, 0, init.stderr);
        const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
        // A valid project tree outside the workspace, mirroring what the symlink will point at.
        const outside = join(dir, `outside-${source}-${target}`);
        cpSync(target === "leaf" ? proj : join(workspace, "projects"), outside, { recursive: true });
        const outsideBefore = treeDigest(outside);
        const replaced = target === "leaf" ? proj : join(workspace, "projects");
        plant = () => {
          renameSync(replaced, `${replaced}.moved`);
          symlinkSync(outside, replaced);
        };
        const assets = join(workspace, "assets");
        api.requests.length = 0;
        const args = source === "task-json" ? ["download", "--task-json", fixture] : ["download", "--resource", "text-to-3d", "--task-id", "round6-task"];
        const r = await runCli([...args, "--all", "--project", proj, "--workspace", workspace, "--output-dir", assets], { env, cwd: dir });
        assert.equal(r.code, 11, `${label}: ${r.stderr}\n${r.stdout}`);
        const e = parseSingleJson(r.stdout) as { ok: boolean; result: { source: { task_id: string }; downloads: { state: string; files: Array<{ key: string; path: string; status: string; bytes: number; sha256: string }> }; project: ProjectFailure }; error: { code: string; message: string; recovery: unknown; hint?: string }; warnings: Array<{ code: string }> };
        assert.deepEqual(Object.keys(e).sort(), ENVELOPE_KEYS, label);
        assert.equal(e.ok, false);
        assert.equal(e.error.code, "local_io", label);
        assert.match(e.error.message, /no longer a target inside the authorised boundary/, label);
        assert.match(e.error.message, target === "leaf" ? /symbolic link/ : /outside the authorised root/, label);
        assert.match(e.error.message, /nothing was recorded/, label);
        assert.equal(e.error.recovery, null, `${label}: no command that would write across the boundary`);
        assert.ok(!(e.error.hint ?? "").startsWith("meshy project record"), label);
        assert.equal(e.result.source.task_id, "round6-task");
        assert.equal(e.result.downloads.state, "completed", `${label}: the transfer itself completed`);
        assert.deepEqual(e.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"]]);
        const model = e.result.downloads.files[0]!;
        assert.ok(existsSync(model.path) && readFileSync(model.path).equals(glb()), `${label}: the asset is on disk and not rolled back`);
        assert.equal(sha(model.path), model.sha256);
        assert.equal(readFileSync(model.path).length, model.bytes);
        assert.equal(realpathSync(model.path), realpathSync(join(assets, "model.glb")));
        assert.equal(e.result.project.action, "failed", label);
        assert.deepEqual(e.result.project.recorded_files, []);
        assert.equal(e.result.project.error.code, "local_io");
        assert.equal(e.result.project.recovery, null, label);
        assert.ok(!e.warnings.some((w) => w.code === "index_dirty"), `${label}: a boundary refusal is not disguised as index_dirty`);
        assert.deepEqual(treeDigest(outside), outsideBefore, `${label}: the outside tree is byte-identical (metadata.json, history.json), no snapshot/lock/temp`);
        assert.deepEqual(
          api.requests.map((q) => [q.method, q.path]),
          source === "task-json" ? [["GET", "/model.glb"]] : [["GET", "/openapi/v2/text-to-3d/round6-task"], ["GET", "/model.glb"]],
          `${label}: exact requests, no retry, no POST`,
        );
        // The moved original project was not written either.
        const original = target === "leaf" ? `${proj}.moved` : join(`${replaced}.moved`, basename(proj));
        assert.equal((JSON.parse(readFileSync(join(original, "metadata.json"), "utf8")) as { tasks: unknown[] }).tasks.length, 0, `${label}: the original project is untouched`);
      }
    }
    // Healthy control: nothing planted — the record lands, assets outside the project are reported as such.
    const workspace = join(dir, "ws-healthy");
    mkdirSync(workspace);
    const init = await runCli(["project", "init", "--root", join(workspace, "projects"), "--name", "healthy"], { env, cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    api.requests.length = 0;
    const ok = await runCli(["download", "--task-json", fixture, "--all", "--project", proj, "--workspace", workspace, "--output-dir", join(workspace, "assets")], { env, cwd: dir });
    assert.equal(ok.code, 0, `${ok.stderr}\n${ok.stdout}`);
    const o = parseSingleJson(ok.stdout) as { result: { project: { action: string; recorded_files: string[] } }; warnings: Array<{ code: string }> };
    assert.equal(o.result.project.action, "added");
    assert.deepEqual(o.result.project.recorded_files, []);
    assert.ok(o.warnings.some((w) => w.code === "files_outside_project"));
    assert.equal((JSON.parse(readFileSync(join(proj, "metadata.json"), "utf8")) as { tasks: Array<{ task_id: string }> }).tasks[0]!.task_id, "round6-task");
    assert.deepEqual(api.requests.map((q) => [q.method, q.path]), [["GET", "/model.glb"]]);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R6-F02 — the authorised root is frozen before the first request
// ---------------------------------------------------------------------------

type Verb = "get" | "wait" | "stream" | "create-async" | "create-sync";
type Swap = "directory" | "alias";

test("R6-F02 legacy/v1 × get/wait/stream/create-async/create-sync × workspace replaced (the directory itself swapped for a symlink to an outside copy, or the alias the workspace was given through re-pointed) while the request is in flight: exit 11, task and accepted journal kept, single POST, exact method/path, outside tree byte-identical, no snapshot/lock/temp, no cross-boundary record command", async () => {
  for (const schema of ["legacy", "v1"] as const) {
    for (const verb of ["get", "wait", "stream", "create-async", "create-sync"] as Verb[]) {
      for (const swap of ["directory", "alias"] as Swap[]) {
        const id = `${schema}-${verb}-${swap}`;
        let plant: (() => void) | null = null;
        const api = await startMockApi((req, res) => {
          plant?.();
          plant = null;
          if (req.method === "POST") return jsonReply(res, 200, { result: id });
          if (req.method === "DELETE") return jsonReply(res, 500, { message: "never" });
          const body = taskBody({ id });
          if (req.path.endsWith("/stream")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            return void res.end(`data: ${JSON.stringify(body)}\n\n`);
          }
          return jsonReply(res, 200, body);
        });
        try {
          const dir = tmpDir();
          const env = api.env();
          const configDir = String(env["MESHY_CONFIG_DIR"]);
          const real = join(dir, "real-workspace");
          mkdirSync(real);
          // "directory": the workspace is a plain directory that gets swapped for a symlink.
          // "alias": the workspace is given through a symlink that keeps pointing at `real` … until it is re-pointed.
          const workspace = swap === "directory" ? real : join(dir, "workspace-alias");
          if (swap === "alias") symlinkSync(real, workspace);
          const init = await runCli(["project", "init", "--root", join(workspace, "projects"), "--name", id], { env, cwd: dir });
          assert.equal(init.code, 0, init.stderr);
          const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
          const outside = join(dir, "outside");
          cpSync(real, outside, { recursive: true });
          const outsideBefore = treeDigest(outside);
          const realBefore = treeDigest(real);
          plant =
            swap === "directory"
              ? () => {
                  renameSync(real, `${real}.moved`);
                  symlinkSync(outside, real);
                }
              : () => {
                  unlinkSync(workspace);
                  symlinkSync(outside, workspace);
                };
          const args = verb.startsWith("create") ? ["text-to-3d", "create", "--mode", "preview", "--prompt", "fixture", ...(verb === "create-async" ? ["--async"] : [])] : ["text-to-3d", verb, id];
          const r = await runCli([...args, ...(schema === "v1" ? V1 : []), "--project", proj, "--workspace", workspace], { env, cwd: dir });
          assert.equal(r.code, 11, `${id}: ${r.stderr}\n${r.stdout}`);
          const out = parseSingleJson(r.stdout) as Record<string, unknown>;
          const result = out["result"] as { task_id: string; submission: { state: string; operation_id: string | null } };
          assert.equal(result.task_id, id, `${id}: the task is kept`);
          assert.equal(result.submission.state, "accepted");
          const message = schema === "v1" ? (out["error"] as { message: string }).message : String(out["message"]);
          assert.match(message, /no longer a target inside the authorised boundary/, id);
          assert.match(message, /changed since the command started|outside the authorised root|symbolic link/, id);
          assert.match(message, /nothing was recorded/, id);
          const hint = schema === "v1" ? (out["error"] as { hint?: string }).hint : (out["hint"] as string | undefined);
          assert.ok(!(hint ?? "").startsWith("meshy project record"), `${id}: no record command that would cross the boundary`);
          if (schema === "v1") {
            assert.deepEqual(Object.keys(out).sort(), ENVELOPE_KEYS, id);
            assert.equal((out["error"] as { code: string }).code, "local_io", id);
            assert.equal((out["error"] as { recovery: unknown }).recovery, null, `${id}: recovery null`);
          } else {
            assert.equal(out["code"], "local_io", id);
            assert.equal(out["task_id"], id, id);
          }
          const records = journal(configDir);
          const isCreate = verb.startsWith("create");
          if (isCreate) {
            assert.equal(records.length, 1, `${id}: exactly one accepted journal record — nothing re-submitted`);
            assert.equal(records[0]!.state, "accepted");
            assert.equal(records[0]!.task_id, id);
            assert.equal(result.submission.operation_id, records[0]!.operation_id, id);
            if (schema === "legacy") assert.equal(out["operation_id"], records[0]!.operation_id, id);
          } else {
            assert.equal(records.length, 0, id);
          }
          const base = "/openapi/v2/text-to-3d";
          const expected: Array<[string, string]> =
            verb === "get" || verb === "wait" ? [["GET", `${base}/${id}`]] : verb === "stream" ? [["GET", `${base}/${id}/stream`]] : verb === "create-async" ? [["POST", base]] : [["POST", base], ["GET", `${base}/${id}`]];
          assert.deepEqual(api.requests.map((q) => [q.method, q.path]), expected, `${id}: exact request sequence`);
          assert.deepEqual(treeDigest(outside), outsideBefore, `${id}: the outside tree is byte-identical (no metadata/history change, no snapshot/lock/temp)`);
          const original = swap === "directory" ? `${real}.moved` : real;
          assert.deepEqual(treeDigest(original), realBefore, `${id}: the original workspace tree is untouched too`);
        } finally {
          await api.close();
        }
      }
    }
  }
});

test("R6-F02 stable aliases keep working: a workspace given through a symlink that stays put, and a project inside a symlinked parent, record normally (snapshot in the real project, index refreshed)", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "alias-ok" });
    return jsonReply(res, 200, taskBody({ id: "alias-ok" }));
  });
  try {
    const dir = tmpDir();
    const env = api.env();
    const real = join(dir, "real");
    mkdirSync(real);
    const alias = join(dir, "alias");
    symlinkSync(real, alias);
    const init = await runCli(["project", "init", "--root", join(alias, "projects"), "--name", "alias-ok"], { env, cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    assert.ok(proj.startsWith(alias));
    const r = await runCli(["text-to-3d", "get", "alias-ok", ...V1, "--project", proj, "--workspace", alias], { env, cwd: dir });
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    const o = parseSingleJson(r.stdout) as { result: { project: { action: string; snapshot: string | null; index: { updated: boolean } } } };
    assert.equal(o.result.project.action, "added");
    assert.equal(o.result.project.index.updated, true);
    assert.ok(o.result.project.snapshot && existsSync(o.result.project.snapshot));
    assert.equal(realpathSync(o.result.project.snapshot!), join(realpathSync(real), "projects", basename(proj), "task_alias-ok.json"));
    const meta = JSON.parse(readFileSync(join(real, "projects", basename(proj), "metadata.json"), "utf8")) as { tasks: Array<{ task_id: string; task_json: string | null }> };
    assert.deepEqual(meta.tasks.map((t) => [t.task_id, t.task_json]), [["alias-ok", "task_alias-ok.json"]]);
    assert.deepEqual(listing(join(real, "projects")).includes("history.json"), true);
    assert.deepEqual(api.requests.map((q) => [q.method, q.path]), [["GET", "/openapi/v2/text-to-3d/alias-ok"]]);
  } finally {
    await api.close();
  }
});
