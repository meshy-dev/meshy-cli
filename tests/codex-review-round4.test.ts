/**
 * Codex review round 4 (reviews/cli-s1-235d6de: R4-F01, R4-F02, R4-T01) as
 * positive regressions. Each scenario mirrors the reviewer's probe (D01, D02,
 * round4-context-checks) with real subprocesses, a loopback API/asset host that
 * records every request, synthetic credentials and isolated temp directories,
 * and asserts the required outcome: two different MTL references that only
 * reach the same sole texture through channel fallbacks are never merged (in
 * either order, whichever channel rule each one took), a project-record failure
 * after the transfers keeps the whole download result and says how to redo the
 * bookkeeping alone, foreseeable --project problems are refused before any
 * transfer, and `make`'s reported operation id is the *last* accepted journal
 * record's (two steps with different ids, asset 503 and SIGINT, both schemas).
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";
import { relinkMaterials } from "../src/internal/material-links.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const V1 = ["--output-schema", "v1"];
const ENVELOPE_KEYS = ["schema_version", "command", "ok", "result", "error", "warnings"].sort();

function taskBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "round4-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, ...fields };
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

interface JournalRecord {
  operation_id: string;
  state: string;
  task_id: string | null;
}

function journal(configDir: string): JournalRecord[] {
  const ops = join(configDir, "operations");
  return readdirSync(ops)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ops, f), "utf8")) as JournalRecord);
}

/** Split a recovery command the way a POSIX shell would (bare words, single quotes with the '\'' escape). */
function shellSplit(command: string): string[] {
  const words: string[] = [];
  let cur = "";
  let pending = false;
  let inQuote = false;
  let escape = false;
  for (const ch of command) {
    if (escape) {
      cur += ch;
      escape = false;
      pending = true;
      continue;
    }
    if (inQuote) {
      if (ch === "'") inQuote = false;
      else cur += ch;
      pending = true;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      pending = true;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (pending) {
        words.push(cur);
        cur = "";
        pending = false;
      }
      continue;
    }
    cur += ch;
    pending = true;
  }
  if (pending) words.push(cur);
  return words;
}

interface ManifestFile {
  key: string;
  path: string;
  status: string;
  bytes: number;
  sha256: string;
  relinked: boolean;
}

interface TextureMap {
  line: number;
  material: string | null;
  reference: string;
  resolved_to: string | null;
  method: string;
  candidates?: string[];
  note?: string;
}

interface MaterialEnvelope {
  ok: boolean;
  result: {
    downloads: {
      state: string;
      files: ManifestFile[];
      material_links: { status: string; rewritten: string[]; texture_maps: TextureMap[] };
    };
  };
  warnings: Array<{ code: string; message: string }>;
}

// ---------------------------------------------------------------------------
// R4-F01 / D01 — channel fallbacks compete on the texture they actually reach
// ---------------------------------------------------------------------------

test("D01/R4-F01 two different references that reach the sole base color only through channel fallbacks (key channel and name channel) stay as written in both orders; ambiguous + incomplete with one shared note; MTL byte-identical; digests match disk", async () => {
  const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const refs = ["body_normal.png", "eyes_diffuse.png"] as const;
  for (const order of [
    [0, 1],
    [1, 0],
  ] as const) {
    const first = refs[order[0]];
    const second = refs[order[1]];
    const mtl = `newmtl body\nmap_Kd ${first}\nnewmtl eyes\nmap_Kd ${second}\n`;
    const host = await startMockApi((req, res) => {
      if (req.path === "/model.obj") {
        res.writeHead(200, { "content-type": "model/obj" });
        return void res.end("mtllib original.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 1\nf 1 2 3\n");
      }
      if (req.path === "/original.mtl") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end(mtl);
      }
      if (req.path === "/a.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return void res.end(red);
      }
      return jsonReply(res, 404, {});
    });
    try {
      const label = `${first} then ${second}`;
      const dir = tmpDir();
      const fixture = join(dir, "channel-fallback.json");
      writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/model.obj`, mtl: `${host.url}/original.mtl` }, texture_urls: [{ base_color: `${host.url}/a.png` }] })));
      const out = join(dir, "channel-fallback");
      const r = await runCli(["download", "--task-json", fixture, "--model-format", "obj", "--output-dir", out], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
      assert.equal(r.code, 0, `${label}: ${r.stderr}\n${r.stdout}`);
      const env = parseSingleJson(r.stdout) as MaterialEnvelope & Record<string, unknown>;
      assert.deepEqual(Object.keys(env).sort(), ENVELOPE_KEYS);
      assert.equal(env.ok, true);
      assert.equal(readFileSync(join(out, "model.mtl"), "utf8"), mtl, `${label}: the MTL is byte-identical — neither reference was rewritten`);
      assert.match(readFileSync(join(out, "model.obj"), "utf8"), /^mtllib model\.mtl$/m, `${label}: the OBJ still points at the saved MTL`);
      assert.ok(readFileSync(join(out, "texture_0_base_color.png")).equals(red), `${label}: the one texture is the served image`);
      const dl = env.result.downloads;
      assert.equal(dl.state, "completed", `${label}: every file landed`);
      assert.equal(dl.material_links.status, "incomplete");
      assert.deepEqual(
        dl.material_links.texture_maps.map((l) => [l.material, l.reference, l.resolved_to, l.method, l.candidates]),
        [
          ["body", first, null, "ambiguous", ["texture_0_base_color.png"]],
          ["eyes", second, null, "ambiguous", ["texture_0_base_color.png"]],
        ],
        `${label}: both references are ambiguous, not resolved`,
      );
      for (const l of dl.material_links.texture_maps) {
        assert.match(l.note ?? "", /'body_normal\.png' \(channel_of_key\)/, `${label}: the note names the key-channel fallback`);
        assert.match(l.note ?? "", /'eyes_diffuse\.png' \(channel_in_name\)/, `${label}: the note names the name-channel fallback`);
        assert.match(l.note ?? "", /compete for texture_0_base_color\.png/);
      }
      assert.equal(dl.material_links.texture_maps[0]!.note, dl.material_links.texture_maps[1]!.note, `${label}: one shared note for the group`);
      assert.deepEqual(dl.material_links.rewritten.map((p) => basename(p)), ["model.obj"], `${label}: only the OBJ's mtllib was rewritten`);
      const byKey = Object.fromEntries(dl.files.map((f) => [f.key, f]));
      assert.equal(byKey["model.obj"]!.relinked, true);
      assert.equal(byKey["model.mtl"]!.relinked, false, `${label}: the MTL was not touched`);
      assert.equal(byKey["texture.0.base_color"]!.relinked, false);
      for (const f of dl.files) {
        assert.equal(f.status, "written");
        assert.equal(sha(f.path), f.sha256, `${label}: ${f.key} manifest digest is the file on disk`);
        assert.equal(readFileSync(f.path).length, f.bytes);
      }
      const ambiguous = env.warnings.filter((w) => w.code === "material_reference_ambiguous");
      assert.equal(ambiguous.length, 1, `${label}: exactly one ambiguity warning`);
      assert.match(ambiguous[0]!.message, /'body_normal\.png' \(channel_of_key\) and 'eyes_diffuse\.png' \(channel_in_name\) compete for texture_0_base_color\.png/);
      assert.match(ambiguous[0]!.message, /\(body, eyes\)|\(eyes, body\)/, `${label}: the warning names both material groups`);
      assert.equal(ambiguous[0]!.message.split("compete for").length, 2, `${label}: the shared reason is said once`);
      assert.ok(!env.warnings.some((w) => w.code === "material_reference_unresolved"));
      assert.deepEqual(host.requests.map((q) => [q.method, q.path]), [
        ["GET", "/model.obj"],
        ["GET", "/original.mtl"],
        ["GET", "/a.png"],
      ]);
      assert.deepEqual(tmpFiles(out), []);
    } finally {
      await host.close();
    }
  }
});

test("R4-F01 arbitration: an identity match keeps its texture while a heuristic rival stays as written; an unresolved rival that could mean the texture blocks it too; one reference sent to different textures by different keys is not rewritten; lone and distinct-channel fallbacks still resolve", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const setup = (mtl: string, textures: Array<{ key: string; name: string; sourceName: string | null }>) => {
    const dir = tmpDir();
    writeFileSync(join(dir, "model.obj"), "mtllib m.mtl\nv 0 0 0\n");
    writeFileSync(join(dir, "model.mtl"), mtl);
    for (const t of textures) writeFileSync(join(dir, t.name), png);
    return {
      dir,
      files: [
        { key: "model.obj", path: join(dir, "model.obj"), sourceName: "m.obj" },
        { key: "model.mtl", path: join(dir, "model.mtl"), sourceName: "m.mtl" },
        ...textures.map((t) => ({ key: t.key, path: join(dir, t.name), sourceName: t.sourceName })),
      ],
    };
  };

  // a) identity (source name) + heuristic (name channel) on the same sole texture: identity wins, the heuristic stays as written.
  {
    const mtl = "newmtl body\nmap_Kd body.png\nnewmtl eyes\nmap_Kd eyes_diffuse.png\n";
    const { dir, files } = setup(mtl, [{ key: "texture.0.base_color", name: "texture_0_base_color.png", sourceName: "body.png" }]);
    const report = (await relinkMaterials(files))!;
    assert.equal(report.status, "incomplete");
    assert.deepEqual(report.texture_maps.map((l) => [l.material, l.reference, l.resolved_to, l.method]), [
      ["body", "body.png", "texture_0_base_color.png", "source_name"],
      ["eyes", "eyes_diffuse.png", null, "ambiguous"],
    ]);
    assert.match(report.texture_maps[1]!.note ?? "", /'body\.png' \(source_name\) and 'eyes_diffuse\.png' \(channel_in_name\) compete for texture_0_base_color\.png/);
    assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), "newmtl body\nmap_Kd texture_0_base_color.png\nnewmtl eyes\nmap_Kd eyes_diffuse.png\n");
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0]!.message, /compete for texture_0_base_color\.png; .* name the same image \(eyes\); the references stay as written/);
  }

  // b) a rival that could not be resolved (generated name, other source) still contends for the texture: the heuristic must not take it.
  {
    const mtl = "newmtl red\nmap_Kd texture_1_base_color.png\nnewmtl green\nmap_Kd texture_0_base_color.png\n";
    const { dir, files } = setup(mtl, [{ key: "texture.0.base_color", name: "texture_0_base_color.png", sourceName: "a.png" }]);
    const report = (await relinkMaterials(files))!;
    assert.equal(report.status, "incomplete");
    assert.deepEqual(report.texture_maps.map((l) => [l.reference, l.resolved_to, l.method]), [
      ["texture_1_base_color.png", null, "ambiguous"],
      ["texture_0_base_color.png", null, "ambiguous"],
    ]);
    assert.match(report.texture_maps[0]!.note ?? "", /'texture_0_base_color\.png' \(ambiguous\) and 'texture_1_base_color\.png' \(channel_in_name\) compete for texture_0_base_color\.png/);
    assert.match(report.texture_maps[1]!.note ?? "", /served as 'a\.png'/);
    assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), mtl, "nothing rewritten");
  }

  // c) the same reference under two keys would land on two textures: one reference names one file, so it stays as written.
  {
    const mtl = "newmtl a\nmap_Kd shared.png\nmap_Bump shared.png\n";
    const { dir, files } = setup(mtl, [
      { key: "texture.0.base_color", name: "texture_0_base_color.png", sourceName: "x.png" },
      { key: "texture.0.normal", name: "texture_0_normal.png", sourceName: "y.png" },
    ]);
    const report = (await relinkMaterials(files))!;
    assert.equal(report.status, "incomplete");
    assert.deepEqual(report.texture_maps.map((l) => [l.reference, l.resolved_to, l.method]), [
      ["shared.png", null, "ambiguous"],
      ["shared.png", null, "ambiguous"],
    ]);
    for (const l of report.texture_maps) assert.match(l.note ?? "", /one reference names one file/);
    assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), mtl);
  }

  // d) a lone reference may still fall back by key; two references on distinct channels resolve independently.
  {
    const lone = setup("newmtl a\nmap_Kd body_normal.png\n", [{ key: "texture.0.base_color", name: "texture_0_base_color.png", sourceName: "a.png" }]);
    const r1 = (await relinkMaterials(lone.files))!;
    assert.equal(r1.status, "complete");
    assert.deepEqual(r1.texture_maps.map((l) => [l.reference, l.resolved_to, l.method]), [["body_normal.png", "texture_0_base_color.png", "channel_of_key"]]);
    assert.equal(readFileSync(join(lone.dir, "model.mtl"), "utf8"), "newmtl a\nmap_Kd texture_0_base_color.png\n");

    const two = setup("newmtl a\nmap_Kd skin.png\nmap_Bump -bm 0.5 Body_Normal.png\n", [
      { key: "texture.0.base_color", name: "texture_0_base_color.png", sourceName: "a.png" },
      { key: "texture.0.normal", name: "texture_0_normal.png", sourceName: "b.png" },
    ]);
    const r2 = (await relinkMaterials(two.files))!;
    assert.equal(r2.status, "complete");
    assert.deepEqual(r2.texture_maps.map((l) => [l.reference, l.resolved_to, l.method]), [
      ["skin.png", "texture_0_base_color.png", "channel_of_key"],
      ["Body_Normal.png", "texture_0_normal.png", "channel_in_name"],
    ]);
    assert.equal(readFileSync(join(two.dir, "model.mtl"), "utf8"), "newmtl a\nmap_Kd texture_0_base_color.png\nmap_Bump -bm 0.5 texture_0_normal.png\n");
    assert.deepEqual(r2.warnings, []);
  }
});

// ---------------------------------------------------------------------------
// R4-F02 / D02 — a project-record failure after the transfer keeps the result
// ---------------------------------------------------------------------------

interface ProjectFailureEnvelope {
  schema_version: string;
  command: string;
  ok: boolean;
  result: {
    source: { kind: string; task_id: string };
    selection: { selected: string[]; dependencies: string[] };
    downloads: { state: string; files: ManifestFile[]; metadata_path: null; material_links: unknown };
    unknown_urls: unknown[];
    saved_json: { path: string; bytes: number } | null;
    project: {
      project_dir: string;
      action: string;
      stage: string;
      recorded_files: string[];
      error: { code: string; message: string };
      recovery: { action: string; automatic: boolean; command: string };
    };
  };
  error: { code: string; message: string; http_status: number | null; retryable: boolean; recovery: { action: string; automatic: boolean; command: string }; hint?: string };
  warnings: Array<{ code: string }>;
}

test("D02/R4-F02 download --project: a record failure after the transfer (metadata.json swapped for a symlink, damaged, project dir unwritable) keeps source/selection/manifest/saved_json, reports the project failure with a record-only recovery, exit 11, one GET, assets kept, outside bytes unchanged; the recovery command then records the task", async () => {
  let plant: (() => void) | null = null;
  const api = await startMockApi((req, res) => {
    if (req.path === "/model.glb") {
      // Another process changes the project between the preflight and the record step.
      plant?.();
      plant = null;
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb());
    }
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    const dir = tmpDir();
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const env = api.env({ MESHY_API_KEY: undefined });
    const initProject = async (name: string): Promise<string> => {
      const init = await runCli(["project", "init", "--root", join(workspace, "projects"), "--name", name, "--workspace", workspace], { env, cwd: dir });
      assert.equal(init.code, 0, init.stderr);
      return (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    };
    const fixture = join(workspace, "task.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/model.glb` } })));
    const expectFailure = (r: { code: number; stdout: string; stderr: string }, label: string, recordedFiles: string[] = ["model.glb"]): ProjectFailureEnvelope => {
      assert.equal(r.code, 11, `${label}: ${r.stderr}\n${r.stdout}`);
      const e = parseSingleJson(r.stdout) as ProjectFailureEnvelope;
      assert.deepEqual(Object.keys(e).sort(), ENVELOPE_KEYS, label);
      assert.equal(e.schema_version, "meshy.cli/v1");
      assert.equal(e.command, "download");
      assert.equal(e.ok, false);
      assert.equal(e.error.code, "local_io", label);
      assert.equal(e.error.http_status, null);
      assert.equal(e.error.retryable, false);
      assert.match(e.error.message, /^1 file\(s\) were downloaded to .* but recording task round4-task in project .* failed: /, label);
      assert.equal(e.error.recovery.action, "record_project", label);
      assert.equal(e.error.recovery.automatic, false);
      assert.equal(e.error.hint, e.error.recovery.command, `${label}: the hint is the recovery command`);
      assert.match(r.stderr, /^hint: meshy project record /m, `${label}: stderr carries the same command`);
      // The whole download result survives.
      assert.equal(e.result.source.kind, "task-json");
      assert.equal(e.result.source.task_id, "round4-task");
      assert.deepEqual(e.result.selection, { selected: ["model.glb"], dependencies: [] });
      assert.equal(e.result.downloads.state, "completed", `${label}: the transfer itself completed`);
      assert.deepEqual(e.result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"]]);
      const model = e.result.downloads.files[0]!;
      assert.ok(existsSync(model.path), `${label}: the asset is not rolled back`);
      assert.ok(readFileSync(model.path).equals(glb()), `${label}: the asset has the served bytes`);
      assert.equal(sha(model.path), model.sha256, `${label}: manifest digest is the file on disk`);
      assert.equal(readFileSync(model.path).length, model.bytes);
      assert.deepEqual(e.result.unknown_urls, []);
      // The project record says what failed and how to redo just that.
      assert.equal(e.result.project.action, "failed", label);
      assert.equal(e.result.project.stage, "preview");
      assert.deepEqual(e.result.project.recorded_files, []);
      assert.equal(e.result.project.error.code, "local_io");
      assert.deepEqual(e.result.project.recovery, e.error.recovery);
      assert.match(
        e.error.recovery.command,
        new RegExp(`^meshy project record --project \\S+ --task-id round4-task --stage preview --resource text-to-3d --task-type text-to-3d-preview --status SUCCEEDED${recordedFiles.map((f) => ` --file ${f.replaceAll(".", "\\.")}`).join("")}$`),
        `${label}: the recovery redoes exactly the metadata entry (files that landed inside the project)`,
      );
      return e;
    };

    // (1) metadata.json becomes a symlink to a valid metadata file outside the workspace during the GET.
    const proj1 = await initProject("record-failure");
    const meta1 = join(proj1, "metadata.json");
    const outside = join(dir, "outside-metadata.json");
    copyFileSync(meta1, outside);
    const outsideBefore = readFileSync(outside);
    const backup = join(proj1, "original-metadata.json");
    plant = () => {
      renameSync(meta1, backup);
      symlinkSync(outside, meta1);
    };
    const saveJson = join(workspace, "task-copy.json");
    const r1 = await runCli(["download", "--task-json", fixture, "--all", "--project", proj1, "--workspace", workspace, "--save-json", saveJson], { env, cwd: dir });
    const e1 = expectFailure(r1, "symlink");
    assert.match(e1.error.message, /not a regular file/);
    assert.match(e1.result.project.error.message, /not a regular file/);
    assert.equal(realpathSync(e1.result.project.project_dir), realpathSync(proj1));
    assert.ok(e1.result.saved_json && existsSync(e1.result.saved_json.path), "the raw task JSON was saved and is reported");
    assert.equal((JSON.parse(readFileSync(e1.result.saved_json!.path, "utf8")) as { id: string }).id, "round4-task");
    assert.ok(readFileSync(outside).equals(outsideBefore), "the outside metadata file is untouched");
    assert.ok(lstatSync(meta1).isSymbolicLink(), "the planted symlink was not replaced");
    assert.ok(readFileSync(backup).equals(outsideBefore), "the original metadata is intact");
    assert.deepEqual(tmpFiles(proj1), [], "no temp file left in the project");
    assert.deepEqual(api.requests.map((q) => [q.method, q.path]), [["GET", "/model.glb"]], "one asset GET, nothing else");
    // Repair the directory and run the recovery command verbatim: it records exactly the downloaded file and makes no request.
    unlinkSync(meta1);
    renameSync(backup, meta1);
    const words = shellSplit(e1.error.recovery.command);
    assert.equal(words[0], "meshy");
    const rec = await runCli([...words.slice(1), "--workspace", workspace], { env, cwd: dir });
    assert.equal(rec.code, 0, `${rec.stderr}\n${rec.stdout}`);
    const meta = JSON.parse(readFileSync(meta1, "utf8")) as { tasks: Array<{ task_id: string; stage: string; files: string[]; status: string | null; resource: string | null }> };
    assert.deepEqual(meta.tasks.map((t) => [t.task_id, t.stage, t.files, t.status, t.resource]), [["round4-task", "preview", ["model.glb"], "SUCCEEDED", "text-to-3d"]]);
    assert.equal(api.requests.length, 1, "the recovery made no request");
    assert.ok(existsSync(join(proj1, "model.glb")));

    // (2) metadata.json is damaged (not JSON) during the GET: refused, never overwritten, result kept.
    const proj2 = await initProject("damaged");
    const meta2 = join(proj2, "metadata.json");
    plant = () => writeFileSync(meta2, "{ not json");
    const r2 = await runCli(["download", "--task-json", fixture, "--all", "--project", proj2, "--workspace", workspace], { env, cwd: dir });
    const e2 = expectFailure(r2, "damaged");
    assert.match(e2.error.message, /not valid JSON/);
    assert.equal(readFileSync(meta2, "utf8"), "{ not json", "the damaged file is left for the user to repair, not overwritten");
    assert.equal(e2.result.saved_json, null);
    assert.ok(existsSync(join(proj2, "model.glb")));
    assert.deepEqual(api.requests.slice(1).map((q) => [q.method, q.path]), [["GET", "/model.glb"]]);

    // (3) the project directory becomes unwritable during the GET (the asset goes elsewhere in the workspace): the lock cannot be created — a plain errno, still local_io with the result.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const proj3 = await initProject("unwritable");
      const elsewhere = join(workspace, "elsewhere");
      plant = () => chmodSync(proj3, 0o555);
      try {
        const r3 = await runCli(["download", "--task-json", fixture, "--all", "--project", proj3, "--output-dir", elsewhere, "--workspace", workspace], { env, cwd: dir });
        const e3 = expectFailure(r3, "unwritable", []);
        assert.match(e3.error.message, /EACCES|permission denied/i);
        assert.ok(e3.warnings.some((w) => w.code === "files_outside_project") === false, "the record never ran, so no outside-file warning is invented");
        assert.ok(existsSync(join(elsewhere, "model.glb")));
        assert.equal(readdirSync(proj3).includes(".meshy.lock"), false, "no lock file appeared");
      } finally {
        chmodSync(proj3, 0o755);
      }
      assert.equal((JSON.parse(readFileSync(join(proj3, "metadata.json"), "utf8")) as { tasks: unknown[] }).tasks.length, 0, "metadata untouched");
    }
  } finally {
    await api.close();
  }
});

test("R4-F02 preflight: a --project whose metadata.json is a symlink or damaged, a task JSON without an id, or a blank --stage is refused before any transfer — no request, nothing written; a healthy project still records normally", async () => {
  const api = await startMockApi((req, res) => {
    if (req.path === "/model.glb") {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb());
    }
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    const dir = tmpDir();
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const env = api.env({ MESHY_API_KEY: undefined });
    const initProject = async (name: string): Promise<string> => {
      const init = await runCli(["project", "init", "--root", join(workspace, "projects"), "--name", name, "--workspace", workspace], { env, cwd: dir });
      assert.equal(init.code, 0, init.stderr);
      return (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    };
    const fixture = join(workspace, "task.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/model.glb` } })));
    const refused = (r: { code: number; stdout: string; stderr: string }, code: number, re: RegExp, label: string): void => {
      assert.equal(r.code, code, `${label}: ${r.stderr}\n${r.stdout}`);
      const e = parseSingleJson(r.stdout) as { ok: boolean; result: unknown; error: { code: string; message: string } };
      assert.equal(e.ok, false);
      assert.match(e.error.message, re, label);
      assert.equal(api.requests.length, 0, `${label}: nothing was requested`);
    };

    // metadata.json is a symlink before the run
    const projA = await initProject("symlinked");
    const outside = join(dir, "outside.json");
    renameSync(join(projA, "metadata.json"), outside);
    symlinkSync(outside, join(projA, "metadata.json"));
    const a = await runCli(["download", "--task-json", fixture, "--all", "--project", projA, "--workspace", workspace], { env, cwd: dir });
    refused(a, 11, /metadata\.json is not a regular file \(a symbolic link\); nothing was downloaded/, "symlink");
    assert.ok(!existsSync(join(projA, "model.glb")), "symlink: nothing written");

    // metadata.json is damaged before the run
    const projB = await initProject("damaged");
    writeFileSync(join(projB, "metadata.json"), "{ not json");
    const b = await runCli(["download", "--task-json", fixture, "--all", "--project", projB, "--workspace", workspace], { env, cwd: dir });
    refused(b, 11, /not valid JSON.*\(nothing was downloaded\)/, "damaged");
    assert.ok(!existsSync(join(projB, "model.glb")));

    // a task JSON without an id is not a task the CLI can record: refused as usage before the transfer
    const projC = await initProject("healthy");
    const noId = join(workspace, "no-id.json");
    const body = taskBody({ model_urls: { glb: `${api.url}/model.glb` } });
    delete body["id"];
    writeFileSync(noId, JSON.stringify(body));
    const c = await runCli(["download", "--task-json", noId, "--all", "--project", projC, "--workspace", workspace], { env, cwd: dir });
    refused(c, 2, /does not contain a task/, "no id");
    assert.ok(!existsSync(join(projC, "model.glb")));

    // blank --stage
    const d = await runCli(["download", "--task-json", fixture, "--all", "--project", projC, "--stage", "  ", "--workspace", workspace], { env, cwd: dir });
    refused(d, 2, /--stage must not be blank/, "blank stage");

    // the healthy project records as before
    const ok = await runCli(["download", "--task-json", fixture, "--all", "--project", projC, "--workspace", workspace], { env, cwd: dir });
    assert.equal(ok.code, 0, `${ok.stderr}\n${ok.stdout}`);
    const e = parseSingleJson(ok.stdout) as { result: { project: { project_dir: string; action: string; stage: string; recorded_files: string[] } }; warnings: Array<{ code: string }> };
    assert.deepEqual(e.result.project, { project_dir: e.result.project.project_dir, action: "added", stage: "preview", recorded_files: ["model.glb"] });
    assert.ok(!e.warnings.some((w) => w.code === "index_dirty" || w.code === "files_outside_project"));
    assert.deepEqual(api.requests.map((q) => [q.method, q.path]), [["GET", "/model.glb"]]);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R4-T01 — make reports the last step's identity, reconciled with the journal
// ---------------------------------------------------------------------------

interface MakeResult {
  task_id: string;
  submission: { state: string; operation_id: string | null; task_id?: string };
  executed: Array<{ step: number; task_id: string; status: string | null; operation_id: string }>;
  next: { wait: string };
  downloads: { state: string; files: Array<{ key: string; status: string }> };
}

test("R4-T01 make: two chain steps get different task ids; submission.operation_id, executed[-1].operation_id and the legacy top-level operation_id are the last accepted journal record's, refine carries step 1's id as preview_task_id — asset 503 and SIGINT, legacy and v1, POST GET POST GET GET", async () => {
  for (const schema of ["legacy", "v1"] as const) {
    for (const mode of ["503", "sigint"] as const) {
      const label = `${schema}/${mode}`;
      let n = 0;
      let child: ChildProcess | null = null;
      const api = await startMockApi(async (req, res) => {
        if (req.method === "POST") return jsonReply(res, 200, { result: `${schema}-${mode}-step-${++n}` });
        if (req.path === "/asset.glb") {
          if (mode === "503") return jsonReply(res, 503, { message: "asset host down" });
          child?.kill("SIGINT");
          await new Promise((r) => setTimeout(r, 400));
          try {
            res.writeHead(200, { "content-type": "model/gltf-binary" });
            res.end(glb());
          } catch {
            /* client gone */
          }
          return;
        }
        if (req.method !== "GET") return jsonReply(res, 500, { message: "unexpected" });
        const id = req.path.split("/").at(-1)!;
        return jsonReply(res, 200, taskBody({ id, model_urls: { glb: `${api.url}/asset.glb` } }));
      });
      try {
        const dir = tmpDir();
        const env = api.env();
        const configDir = String(env["MESHY_CONFIG_DIR"]);
        const target = mode === "503" ? join(dir, "out") : join(dir, "out.glb");
        const r = await runCli(["make", "a fixture cactus", ...(schema === "v1" ? V1 : []), "-o", target], { env, cwd: dir, onSpawn: (c) => (child = c) });
        assert.equal(r.code, mode === "503" ? 7 : 130, `${label}: ${r.stderr}\n${r.stdout}`);
        const out = parseSingleJson(r.stdout) as Record<string, unknown> & { result: MakeResult };
        const step1 = `${schema}-${mode}-step-1`;
        const step2 = `${schema}-${mode}-step-2`;
        const result = out.result;
        if (schema === "v1") {
          assert.deepEqual(Object.keys(out).sort(), ENVELOPE_KEYS, label);
          assert.equal(out["ok"], false);
          const error = out["error"] as { code: string; http_status: number | null };
          assert.equal(error.code, mode === "503" ? "network" : "interrupted", label);
          assert.equal(error.http_status, mode === "503" ? 503 : null);
        } else {
          assert.equal(out["code"], mode === "503" ? "network" : "interrupted", label);
          if (mode === "503") assert.equal(out["status"], 503);
          assert.equal(out["task_id"], step2, `${label}: the legacy top-level task_id is the last step's`);
        }
        assert.equal(result.task_id, step2, `${label}: the reported task is the last step, not the preview`);
        assert.equal(result.submission.state, "accepted");
        assert.equal(result.submission.task_id, step2);
        assert.deepEqual(
          result.executed.map((e) => [e.step, e.task_id, e.status]),
          [
            [1, step1, "SUCCEEDED"],
            [2, step2, "SUCCEEDED"],
          ],
          label,
        );
        const records = journal(configDir);
        assert.equal(records.length, 2, `${label}: exactly two journal records — nothing was re-submitted`);
        const rec1 = records.find((o) => o.task_id === step1)!;
        const rec2 = records.find((o) => o.task_id === step2)!;
        assert.ok(rec1 && rec2, `${label}: both steps are journaled`);
        assert.equal(rec1.state, "accepted");
        assert.equal(rec2.state, "accepted");
        assert.notEqual(rec1.operation_id, rec2.operation_id);
        assert.equal(result.submission.operation_id, rec2.operation_id, `${label}: submission.operation_id is the last accepted record's`);
        assert.equal(result.executed.at(-1)!.operation_id, rec2.operation_id, `${label}: executed[-1].operation_id matches the journal`);
        assert.equal(result.executed[0]!.operation_id, rec1.operation_id, `${label}: executed[0].operation_id is step 1's own record`);
        if (schema === "legacy") assert.equal(out["operation_id"], rec2.operation_id, `${label}: the legacy top-level operation_id is the last step's`);
        assert.match(result.next.wait, new RegExp(`wait ${step2}`), label);
        assert.deepEqual(api.requests.map((q) => q.method), ["POST", "GET", "POST", "GET", "GET"], label);
        const bodies = api.requests.map((q) => q.json as Record<string, unknown> | undefined);
        assert.equal(bodies[0]!["mode"], "preview");
        assert.equal(bodies[2]!["mode"], "refine");
        assert.equal(bodies[2]!["preview_task_id"], step1, `${label}: refine names step 1`);
        assert.ok(api.requests[1]!.path.endsWith(`/${step1}`), `${label}: step 1 was polled by its own id`);
        assert.ok(api.requests[3]!.path.endsWith(`/${step2}`), `${label}: step 2 was polled by its own id`);
        assert.equal(api.requests[4]!.path, "/asset.glb");
        if (mode === "503") {
          assert.deepEqual(result.downloads.files.map((f) => [f.key, f.status]), [["model_glb", "failed"]], label);
        } else {
          assert.notEqual(result.downloads.state, "completed", label);
          assert.ok(!existsSync(target), `${label}: no final file after the interrupt`);
        }
      } finally {
        await api.close();
      }
    }
  }
});
