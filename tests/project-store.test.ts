/**
 * Project store (T-072..T-077): layout, legacy compatibility, de-duplication,
 * concurrency, index repair and path safety — plus the `--project` hook on
 * task verbs and the `project` subcommands as black boxes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeRelativeFile,
  initProject,
  listProjects,
  normalizeMetadata,
  projectFolderName,
  readProject,
  rebuildIndex,
  recordTask,
} from "../src/internal/project-store.js";
import { CliError, UsageError } from "../src/internal/errors.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const fixedNow = () => new Date("2026-09-07T10:20:30.000Z");

test("T-072 init → record → show: exact layout, metadata v2, history index", () => {
  const root = tmpDir("proj-root-");
  const init = initProject(root, { name: "Demo Fixture", taskId: "fixture-task-a", now: fixedNow });
  assert.match(init.folder, /^\d{8}_\d{6}_demo-fixture_fixture-$/);
  assert.ok(existsSync(join(init.project_dir, "metadata.json")));
  assert.equal(init.index.updated, true);
  const history = JSON.parse(readFileSync(join(root, "history.json"), "utf8")) as { version: number; projects: Array<{ folder: string; task_count: number }> };
  assert.equal(history.version, 1);
  assert.equal(history.projects[0]!.folder, init.folder);
  assert.equal(history.projects[0]!.task_count, 0);

  const rec = recordTask(init.project_dir, { taskId: "fixture-task-a", stage: "preview", resource: "text-to-3d", taskType: "text-to-3d-preview", endpoint: "/openapi/v2/text-to-3d", status: "SUCCEEDED", files: ["preview.glb"], taskJson: "task_fixture-task-a.json", operationId: "fixture-op-1" }, { root, now: fixedNow });
  assert.equal(rec.action, "added");
  const meta = readProject(init.project_dir).metadata;
  assert.equal(meta.schema_version, 2);
  assert.deepEqual(meta.tasks[0], {
    task_id: "fixture-task-a",
    task_type: "text-to-3d-preview",
    resource: "text-to-3d",
    endpoint: "/openapi/v2/text-to-3d",
    stage: "preview",
    parent_task_id: null,
    status: "SUCCEEDED",
    files: ["preview.glb"],
    task_json: "task_fixture-task-a.json",
    operation_id: "fixture-op-1",
    created_at: "2026-09-07T10:20:30.000Z",
    updated_at: "2026-09-07T10:20:30.000Z",
  });
  const h2 = JSON.parse(readFileSync(join(root, "history.json"), "utf8")) as { projects: Array<{ task_count: number; root_task_id: string }> };
  assert.equal(h2.projects[0]!.task_count, 1);
  assert.equal(h2.projects[0]!.root_task_id, "fixture-task-a");
});

test("T-074 (task_id, stage) is merged, different stages and tasks are kept", () => {
  const root = tmpDir("proj-root-");
  const init = initProject(root, { name: "dedupe", now: fixedNow });
  recordTask(init.project_dir, { taskId: "t1", stage: "preview", files: ["a.glb"], status: "IN_PROGRESS" }, { root });
  const merged = recordTask(init.project_dir, { taskId: "t1", stage: "preview", files: ["a.glb", "thumb.png"], status: "SUCCEEDED" }, { root });
  assert.equal(merged.action, "merged");
  recordTask(init.project_dir, { taskId: "t2", stage: "refine", files: ["b.glb"] }, { root });
  recordTask(init.project_dir, { taskId: "t1", stage: "rigged", files: ["rig.glb"] }, { root });
  const meta = readProject(init.project_dir).metadata;
  assert.deepEqual(meta.tasks.map((t) => [t.task_id, t.stage, t.files, t.status]), [
    ["t1", "preview", ["a.glb", "thumb.png"], "SUCCEEDED"],
    ["t2", "refine", ["b.glb"], null],
    ["t1", "rigged", ["rig.glb"], null],
  ]);
  assert.equal(meta.root_task_id, "t1");
});

test("T-073 legacy metadata.json (no schema_version) is read as v1, migrated on write with a backup, unknown fields kept; download meta.json is never accepted as metadata", () => {
  const root = tmpDir("proj-root-");
  const folder = "20260101_120000_legacy_abcdef12";
  const dir = join(root, folder);
  mkdirSync(dir);
  const legacy = {
    project_name: "legacy",
    folder,
    root_task_id: "abcdef12-legacy",
    created_at: "2026-01-01T12:00:00",
    updated_at: "2026-01-01T12:00:00",
    tasks: [{ task_id: "abcdef12-legacy", task_type: "text-to-3d", stage: "preview", files: ["preview.glb"], created_at: "2026-01-01T12:00:00" }],
    custom_note: "keep me",
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(legacy, null, 2));
  writeFileSync(join(root, "history.json"), JSON.stringify({ version: 1, projects: [{ folder, prompt: "legacy", task_type: "text-to-3d", root_task_id: "abcdef12-legacy", created_at: legacy.created_at, updated_at: legacy.updated_at, task_count: 1 }] }));

  const read = readProject(dir);
  assert.equal(read.legacy, true);
  assert.equal(read.metadata.tasks[0]!.resource, null);
  assert.equal(read.metadata.tasks[0]!.status, null);
  assert.equal(read.metadata["custom_note"], "keep me");
  // show does not rewrite the file
  assert.equal(JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).schema_version, undefined);

  const rec = recordTask(dir, { taskId: "abcdef12-legacy", stage: "refined", files: ["refined.glb"] }, { root, now: fixedNow });
  assert.equal(rec.migrated_from_legacy, true);
  const after = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as Record<string, unknown>;
  assert.equal(after["schema_version"], 2);
  assert.equal(after["custom_note"], "keep me");
  assert.equal((after["tasks"] as unknown[]).length, 2);
  const backups = readdirSync(dir).filter((f) => f.startsWith("metadata.json.bak-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, backups[0]!), "utf8")), legacy);
  const hist = JSON.parse(readFileSync(join(root, "history.json"), "utf8")) as { version: number; projects: Array<{ task_count: number }> };
  assert.equal(hist.version, 1);
  assert.equal(hist.projects[0]!.task_count, 2);

  // A CLI download meta.json is not project metadata.
  const other = join(root, "20260101_120001_dl_deadbeef");
  mkdirSync(other);
  writeFileSync(join(other, "metadata.json"), JSON.stringify({ resource: "image-to-3d", task: { id: "x" }, saved_files: [] }));
  const view = readProject(other).metadata;
  assert.deepEqual(view.tasks, [], "no tasks array → no tasks, nothing invented");
});

test("T-077 unsafe names and paths are refused or skipped; damaged JSON is never overwritten", () => {
  const root = tmpDir("proj-root-");
  const init = initProject(root, { name: "安全 名称 with, comma", now: fixedNow });
  assert.match(init.folder, /^\d{8}_\d{6}_with-comma_[0-9a-f]{4}$/, "only the ASCII part survives in the slug");
  assert.equal(init.metadata.project_name, "安全 名称 with, comma");
  const cjk = initProject(root, { name: "安全名称", now: fixedNow });
  assert.match(cjk.folder, /^\d{8}_\d{6}_project_[0-9a-f]{4}$/, "a name without ASCII falls back to a safe slug");
  assert.equal(cjk.metadata.project_name, "安全名称");
  for (const bad of ["../x.glb", "/abs/x.glb", "C:\\x.glb", "a//b", ""]) {
    assert.throws(() => assertSafeRelativeFile(bad, "--file"), UsageError, bad);
  }
  assert.equal(assertSafeRelativeFile("sub\\dir\\model, with comma.glb", "--file"), "sub/dir/model, with comma.glb");
  // Same second, same name → distinct folders.
  const a = projectFolderName("same", null, fixedNow(), () => "aaaa");
  const b = projectFolderName("same", null, fixedNow(), () => "bbbb");
  assert.notEqual(a, b);
  const c = initProject(root, { name: "same", now: fixedNow });
  const d = initProject(root, { name: "same", now: fixedNow });
  assert.notEqual(c.folder, d.folder);
  // Damaged metadata: readProject throws, file untouched; recordTask throws too.
  const broken = join(root, "20260101_120000_broken_00000000");
  mkdirSync(broken);
  writeFileSync(join(broken, "metadata.json"), "{ not json");
  assert.throws(() => readProject(broken), (e: unknown) => e instanceof CliError && e.code === "local_io");
  assert.throws(() => recordTask(broken, { taskId: "t", stage: "s" }, { root }), CliError);
  assert.equal(readFileSync(join(broken, "metadata.json"), "utf8"), "{ not json");
  // history.json pointing outside the root is reported as absent, and rebuild skips a symlinked folder.
  const outside = tmpDir("outside-");
  mkdirSync(join(outside, "victim"));
  writeFileSync(join(outside, "victim", "metadata.json"), JSON.stringify({ schema_version: 2, project_name: "v", folder: "victim", root_task_id: null, created_at: "", updated_at: "", tasks: [] }));
  symlinkSync(join(outside, "victim"), join(root, "linked"));
  const rebuilt = rebuildIndex(root, { now: fixedNow });
  assert.ok(rebuilt.skipped.some((s) => s.folder === "linked"));
  assert.ok(rebuilt.backup && existsSync(rebuilt.backup), "previous index backed up");
  writeFileSync(join(root, "history.json"), JSON.stringify({ version: 1, projects: [{ folder: "../../etc", prompt: "x", task_type: "", root_task_id: null, created_at: "", updated_at: "", task_count: 0 }] }));
  const listed = listProjects(root);
  assert.equal(listed.projects[0]!.present, false);
  assert.equal(listed.index_dirty, true);
  assert.throws(() => normalizeMetadata([1, 2], "f"), CliError);
});

test("T-075 concurrent records from separate processes lose nothing and keep valid JSON", () => {
  const root = tmpDir("proj-root-");
  const init = initProject(root, { name: "race", now: fixedNow });
  const script = fileURLToPath(new URL("./helpers/record-task-child.ts", import.meta.url));
  const children = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) =>
    spawnSync(process.execPath, ["--import", "tsx", script, init.project_dir, id, "preview", root], { encoding: "utf8", env: { ...process.env, MESHY_CLI_NO_UPDATE_NOTIFIER: "1" } }),
  );
  for (const c of children) assert.equal(c.status, 0, c.stderr);
  const meta = readProject(init.project_dir).metadata;
  assert.deepEqual(meta.tasks.map((t) => t.task_id).sort(), ["t1", "t2", "t3", "t4", "t5", "t6"]);
  const hist = JSON.parse(readFileSync(join(root, "history.json"), "utf8")) as { projects: Array<{ task_count: number }> };
  assert.equal(hist.projects.length, 1);
  assert.equal(hist.projects[0]!.task_count, 6);
});

test("T-076 metadata committed but index update failing is reported as index_dirty and repaired by rebuild-index", () => {
  const root = tmpDir("proj-root-");
  const init = initProject(root, { name: "dirty", now: fixedNow });
  // Corrupt the history index so the second phase fails.
  writeFileSync(join(root, "history.json"), "[]");
  const rec = recordTask(init.project_dir, { taskId: "t1", stage: "preview" }, { root });
  assert.equal(rec.action, "added");
  assert.equal(rec.index.updated, false);
  assert.match(rec.index.error ?? "", /not a history index/);
  assert.equal(readProject(init.project_dir).metadata.tasks.length, 1, "metadata is never rolled back");
  assert.equal(readFileSync(join(root, "history.json"), "utf8"), "[]", "damaged index untouched");
  assert.throws(() => listProjects(root), CliError);
  const rebuilt = rebuildIndex(root, { now: fixedNow });
  assert.equal(rebuilt.indexed, 1);
  assert.ok(rebuilt.backup);
  const listed = listProjects(root);
  assert.equal(listed.index_dirty, false);
  assert.equal(listed.projects[0]!.task_count, 1);
});

test("T-072 CLI: project init/record/show/list/rebuild-index run without a key or network", async () => {
  const cwd = tmpDir("proj-cli-");
  const env = { PATH: process.env["PATH"], HOME: process.env["HOME"], MESHY_CLI_NO_UPDATE_NOTIFIER: "1", MESHY_CONFIG_DIR: tmpDir("cfg-") };
  const init = await runCli(["project", "init", "--name", "demo", "--task-id", "fixture-task-a"], { cwd, env });
  assert.equal(init.code, 0, init.stderr);
  const initEnv = parseSingleJson(init.stdout) as { command: string; result: { project_dir: string; folder: string } };
  assert.equal(initEnv.command, "project.init");
  assert.ok(existsSync(join(cwd, "meshy_output", initEnv.result.folder, "metadata.json")));
  writeFileSync(join(initEnv.result.project_dir, "preview.glb"), "glb");
  const rec = await runCli(["project", "record", "--project", initEnv.result.project_dir, "--task-id", "fixture-task-a", "--resource", "text-to-3d", "--stage", "preview", "--file", "preview.glb", "--file", "thumb, with comma.png"], { cwd, env });
  assert.equal(rec.code, 0, rec.stderr);
  const recEnv = parseSingleJson(rec.stdout) as { result: { entry: { files: string[] }; action: string }; warnings: Array<{ code: string }> };
  assert.deepEqual(recEnv.result.entry.files, ["preview.glb", "thumb, with comma.png"]);
  assert.ok(recEnv.warnings.some((w) => w.code === "recorded_file_missing"));
  const show = await runCli(["project", "show", "--project", initEnv.result.project_dir], { cwd, env });
  assert.equal(show.code, 0, show.stderr);
  const showEnv = parseSingleJson(show.stdout) as { result: { legacy_format: boolean; files: Array<{ file: string; present: boolean }> } };
  assert.equal(showEnv.result.legacy_format, false);
  assert.deepEqual(showEnv.result.files.map((f) => [f.file, f.present]), [["preview.glb", true], ["thumb, with comma.png", false]]);
  const list = await runCli(["project", "list"], { cwd, env });
  assert.equal(list.code, 0, list.stderr);
  assert.equal((parseSingleJson(list.stdout) as { result: { projects: unknown[]; index_dirty: boolean } }).result.index_dirty, false);
  const rebuild = await runCli(["project", "rebuild-index"], { cwd, env });
  assert.equal(rebuild.code, 0, rebuild.stderr);
  const missing = await runCli(["project", "record", "--project", join(cwd, "nope"), "--task-id", "x", "--stage", "s"], { cwd, env });
  assert.equal(missing.code, 2);
});

test("--project on task verbs: async create records the id immediately; wait snapshots the final task", async () => {
  let gets = 0;
  const api = await startMockApi((req, res) => {
    if (req.method === "POST") return jsonReply(res, 200, { result: "task-p" });
    gets += 1;
    return jsonReply(res, 200, { id: "task-p", type: "text-to-3d-preview", status: gets < 2 ? "IN_PROGRESS" : "SUCCEEDED", progress: 100 });
  });
  try {
    const cwd = tmpDir("proj-cli-");
    const env = api.env();
    const init = await runCli(["project", "init", "--name", "chain"], { cwd, env });
    assert.equal(init.code, 0, init.stderr);
    const dir = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    const created = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "p", "--async", "--project", dir, "--output-schema", "v1"], { cwd, env });
    assert.equal(created.code, 0, created.stderr);
    const cEnv = parseSingleJson(created.stdout) as { result: { project: { stage: string; action: string; snapshot: string | null } } };
    assert.equal(cEnv.result.project.stage, "preview");
    assert.equal(cEnv.result.project.snapshot, null);
    let meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as { tasks: Array<{ task_id: string; status: string | null; operation_id: string | null; task_json: string | null }> };
    assert.equal(meta.tasks[0]!.task_id, "task-p");
    assert.equal(meta.tasks[0]!.status, null);
    assert.ok(meta.tasks[0]!.operation_id);

    const waited = await runCli(["text-to-3d", "wait", "task-p", "--project", dir, "--output-schema", "v1"], { cwd, env });
    assert.equal(waited.code, 0, waited.stderr);
    const wEnv = parseSingleJson(waited.stdout) as { result: { project: { action: string; snapshot: string } } };
    assert.equal(wEnv.result.project.action, "merged");
    assert.ok(existsSync(join(dir, "task_task-p.json")));
    meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as typeof meta;
    assert.equal(meta.tasks.length, 1, "same task+stage merged, not duplicated");
    assert.equal(meta.tasks[0]!.status, "SUCCEEDED");
    assert.equal(meta.tasks[0]!.task_json, "task_task-p.json");

    // Not an initialised project → local_io with the task id kept.
    const bad = await runCli(["text-to-3d", "get", "task-p", "--project", join(cwd, "nope"), "--output-schema", "v1"], { cwd, env });
    assert.equal(bad.code, 11, bad.stderr);
    const bEnv = parseSingleJson(bad.stdout) as { result: { task_id: string } };
    assert.equal(bEnv.result.task_id, "task-p");
  } finally {
    await api.close();
  }
});
