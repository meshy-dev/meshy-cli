/**
 * Codex review round 5 (reviews/cli-s1-68690f9: R5-F01–R5-F03) as positive
 * regressions with real subprocesses, a loopback API that records every request,
 * synthetic credentials and isolated temp directories. The recovery command a
 * project-record failure hands out keeps the original `--workspace` and is
 * replayed *verbatim* (nothing appended) — a workspace equal to the project must
 * still leave the parent's history index alone; one MTL reference used under
 * several keys is reconciled across them, an ambiguous key included; and the
 * task verbs put the project's location and metadata checks inside the recovery
 * context (missing/damaged metadata → record_project with the task's journal
 * identity and workspace; a project that left the workspace → no command that
 * would cross the boundary).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { relinkMaterials } from "../src/internal/material-links.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

const V1 = ["--output-schema", "v1"];
const ENVELOPE_KEYS = ["schema_version", "command", "ok", "result", "error", "warnings"].sort();

function taskBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "round5-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, ...fields };
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

function optionValue(words: string[], flag: string): string | undefined {
  const i = words.indexOf(flag);
  return i === -1 ? undefined : words[i + 1];
}

interface RecordReplay {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Replay a `meshy project record …` recovery command exactly as handed out
 * (only the launcher word is replaced by the test's dist entry) and check that
 * it redid the record under the original boundary: the record lands, the
 * parent's history index is untouched and reported as skipped, no lock or temp
 * file appears outside, and no request is made.
 */
async function replayRecord(
  command: string,
  env: Record<string, string | undefined>,
  cwd: string,
  expect: { projectDir: string; workspace: string; taskId: string; requestsBefore: number; requests: () => number },
): Promise<{ replay: RecordReplay; words: string[]; entry: Record<string, unknown> }> {
  const words = shellSplit(command);
  assert.equal(words[0], "meshy");
  assert.equal(words[1], "project");
  assert.equal(words[2], "record");
  assert.equal(realpathSync(optionValue(words, "--project")!), realpathSync(expect.projectDir), "the command names the same project");
  assert.equal(realpathSync(optionValue(words, "--workspace")!), realpathSync(expect.workspace), "the command carries the original --workspace, resolved");
  assert.equal(optionValue(words, "--task-id"), expect.taskId);
  const parent = dirname(expect.projectDir);
  const historyPath = join(parent, "history.json");
  const historyBefore = readFileSync(historyPath);
  const parentBefore = listing(parent);
  const replay = await runCli(words.slice(1), { env, cwd });
  assert.equal(replay.code, 0, `verbatim replay: ${replay.stderr}\n${replay.stdout}`);
  const out = parseSingleJson(replay.stdout) as { ok: boolean; result: { action: string; entry: Record<string, unknown>; index: { updated: boolean; error: string | null } }; warnings: Array<{ code: string }> };
  assert.equal(out.ok, true);
  assert.equal(out.result.action, "added");
  assert.equal(out.result.index.updated, false, "workspace == project: the parent's index is not touched");
  assert.match(out.result.index.error ?? "", /outside --workspace/);
  assert.ok(out.warnings.some((w) => w.code === "index_dirty"), "index_dirty says exactly that: metadata committed, history not updated");
  assert.ok(readFileSync(historyPath).equals(historyBefore), "the parent's history.json bytes are unchanged");
  assert.deepEqual(listing(parent).filter((n) => n.includes(".lock") || n.includes(".tmp-")), [], "no lock or temp file outside the boundary");
  assert.deepEqual(listing(parent), parentBefore, "nothing appeared in the parent directory");
  assert.equal(expect.requests(), expect.requestsBefore, "the recovery made no request");
  const meta = JSON.parse(readFileSync(join(expect.projectDir, "metadata.json"), "utf8")) as { tasks: Array<Record<string, unknown>> };
  assert.equal(meta.tasks.length, 1, "exactly one task recorded");
  assert.equal(meta.tasks[0]!["task_id"], expect.taskId);
  return { replay, words, entry: meta.tasks[0]! };
}

// ---------------------------------------------------------------------------
// R5-F01 / E01 — the recovery command keeps the original write boundary
// ---------------------------------------------------------------------------

test("E01/R5-F01 download --project P --workspace P (path with a space and a quote): the record_project command carries --workspace and, replayed verbatim after the repair, records the task with 0 requests, leaves the parent history.json bytes unchanged and reports index_dirty; without --workspace the command has none and the index is updated as before", async () => {
  let plant: (() => void) | null = null;
  const api = await startMockApi((req, res) => {
    if (req.path === "/model.glb") {
      plant?.();
      plant = null;
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb());
    }
    return jsonReply(res, 500, { message: "unexpected" });
  });
  try {
    const dir = tmpDir();
    const env = api.env({ MESHY_API_KEY: undefined });
    const fixture = join(dir, "task.json");
    writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { glb: `${api.url}/model.glb` } })));

    // (1) workspace == project, and the path needs shell quoting.
    const awkward = join(dir, "work space's");
    mkdirSync(awkward);
    const init = await runCli(["project", "init", "--root", join(awkward, "projects"), "--name", "recovery scope"], { env, cwd: dir });
    assert.equal(init.code, 0, init.stderr);
    const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
    const parent = dirname(proj);
    assert.ok(existsSync(join(parent, "history.json")), "the parent holds a history index the recovery must not touch");
    const meta = join(proj, "metadata.json");
    const outside = join(dir, "outside-metadata.json");
    writeFileSync(outside, readFileSync(meta));
    const outsideBefore = readFileSync(outside);
    plant = () => {
      renameSync(meta, `${meta}.backup`);
      symlinkSync(outside, meta);
    };
    const r = await runCli(["download", "--task-json", fixture, "--all", "--project", proj, "--workspace", proj], { env, cwd: dir });
    assert.equal(r.code, 11, `${r.stderr}\n${r.stdout}`);
    const e = parseSingleJson(r.stdout) as { error: { code: string; recovery: { action: string; command: string }; hint: string }; result: { project: { action: string; recovery: { command: string } }; downloads: { files: Array<{ path: string; sha256: string }> } } };
    assert.equal(e.error.code, "local_io");
    assert.equal(e.error.recovery.action, "record_project");
    assert.equal(e.error.hint, e.error.recovery.command);
    assert.equal(e.result.project.action, "failed");
    assert.equal(e.result.project.recovery.command, e.error.recovery.command);
    assert.match(e.error.recovery.command, /--workspace '.*work space'\\''s\/projects\/[^']+'$/, "the workspace is quoted for a shell and carries the quote character");
    assert.match(e.error.recovery.command, /--project '.*work space'\\''s\/projects\/[^']+' --task-id round5-task/, "the project path is quoted the same way");
    assert.ok(readFileSync(outside).equals(outsideBefore), "the outside metadata is untouched");
    assert.equal(sha(e.result.downloads.files[0]!.path), e.result.downloads.files[0]!.sha256);
    const requestsAfterDownload = api.requests.length;
    assert.equal(requestsAfterDownload, 1);
    // Repair, then replay exactly the command that was handed out.
    unlinkSync(meta);
    renameSync(`${meta}.backup`, meta);
    const { entry } = await replayRecord(e.error.recovery.command, env, dir, { projectDir: proj, workspace: proj, taskId: "round5-task", requestsBefore: requestsAfterDownload, requests: () => api.requests.length });
    assert.deepEqual([entry["stage"], entry["files"], entry["status"], entry["resource"]], ["preview", ["model.glb"], "SUCCEEDED", "text-to-3d"]);

    // (2) no explicit workspace: the command has none and the parent's index is refreshed, as it always was.
    const init2 = await runCli(["project", "init", "--root", join(dir, "plain-projects"), "--name", "plain"], { env, cwd: dir });
    assert.equal(init2.code, 0, init2.stderr);
    const proj2 = (parseSingleJson(init2.stdout) as { result: { project_dir: string } }).result.project_dir;
    const meta2 = join(proj2, "metadata.json");
    plant = () => {
      renameSync(meta2, `${meta2}.backup`);
      symlinkSync(outside, meta2);
    };
    const r2 = await runCli(["download", "--task-json", fixture, "--all", "--project", proj2], { env, cwd: dir });
    assert.equal(r2.code, 11, `${r2.stderr}\n${r2.stdout}`);
    const e2 = parseSingleJson(r2.stdout) as { error: { recovery: { command: string } } };
    const words2 = shellSplit(e2.error.recovery.command);
    assert.equal(words2.includes("--workspace"), false, "no workspace was given, none is invented");
    unlinkSync(meta2);
    renameSync(`${meta2}.backup`, meta2);
    const historyBefore = readFileSync(join(dirname(proj2), "history.json"));
    const rec2 = await runCli(words2.slice(1), { env, cwd: dir });
    assert.equal(rec2.code, 0, `${rec2.stderr}\n${rec2.stdout}`);
    const o2 = parseSingleJson(rec2.stdout) as { result: { index: { updated: boolean } }; warnings: Array<{ code: string }> };
    assert.equal(o2.result.index.updated, true, "without a workspace the parent index is refreshed as before");
    assert.ok(!o2.warnings.some((w) => w.code === "index_dirty"));
    assert.ok(!readFileSync(join(dirname(proj2), "history.json")).equals(historyBefore), "the parent history now lists the task");
    assert.equal(api.requests.length, 2, "one GET per download, nothing during either replay");
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// R5-F02 / E02 — one reference used under several keys is reconciled across them
// ---------------------------------------------------------------------------

interface TextureMap {
  material: string | null;
  reference: string;
  resolved_to: string | null;
  method: string;
  candidates?: string[];
  note?: string;
}

test("E02/R5-F02 map_Kd shared.png + map_Bump shared.png with one base color and two normals: neither line is rewritten in either order (MTL byte-identical), both are ambiguous with their own candidates and one cross-key note; digests match disk", async () => {
  const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const lines = ["map_Kd shared.png", "map_Bump shared.png"] as const;
  for (const order of [
    [0, 1],
    [1, 0],
  ] as const) {
    const mtl = `newmtl a\n${lines[order[0]]}\n${lines[order[1]]}\n`;
    const label = `${lines[order[0]]} first`;
    const host = await startMockApi((req, res) => {
      if (req.path === "/model.obj") {
        res.writeHead(200, { "content-type": "model/obj" });
        return void res.end("mtllib original.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 1\nf 1 2 3\n");
      }
      if (req.path === "/original.mtl") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end(mtl);
      }
      if (/\.png$/.test(req.path)) {
        res.writeHead(200, { "content-type": "image/png" });
        return void res.end(red);
      }
      return jsonReply(res, 404, {});
    });
    try {
      const dir = tmpDir();
      const fixture = join(dir, "mixed.json");
      writeFileSync(fixture, JSON.stringify(taskBody({ model_urls: { obj: `${host.url}/model.obj`, mtl: `${host.url}/original.mtl` }, texture_urls: [{ base_color: `${host.url}/a.png`, normal: `${host.url}/n1.png` }, { normal: `${host.url}/n2.png` }] })));
      const out = join(dir, "mixed");
      const r = await runCli(["download", "--task-json", fixture, "--model-format", "obj", "--output-dir", out], { env: host.env({ MESHY_API_KEY: undefined }), cwd: dir });
      assert.equal(r.code, 0, `${label}: ${r.stderr}\n${r.stdout}`);
      assert.equal(readFileSync(join(out, "model.mtl"), "utf8"), mtl, `${label}: the MTL is byte-identical`);
      const env = parseSingleJson(r.stdout) as { result: { downloads: { state: string; files: Array<{ key: string; path: string; sha256: string; bytes: number; relinked: boolean }>; material_links: { status: string; rewritten: string[]; texture_maps: TextureMap[] } } }; warnings: Array<{ code: string; message: string }> };
      const dl = env.result.downloads;
      assert.equal(dl.state, "completed");
      assert.equal(dl.material_links.status, "incomplete");
      const byKey = new Map(dl.material_links.texture_maps.map((l) => [l.reference + "/" + (l.candidates ?? []).join(","), l]));
      assert.equal(dl.material_links.texture_maps.length, 2);
      for (const l of dl.material_links.texture_maps) {
        assert.equal(l.reference, "shared.png");
        assert.equal(l.resolved_to, null, `${label}: nothing rewritten`);
        assert.equal(l.method, "ambiguous");
        assert.match(l.note ?? "", /'shared\.png' is used by map_Kd and map_Bump|'shared\.png' is used by map_Bump and map_Kd/, `${label}: the note names both keys`);
        assert.match(l.note ?? "", /map_Kd would make it texture_0_base_color\.png \(channel_of_key\)/);
        assert.match(l.note ?? "", /map_Bump could only make it texture_0_normal\.png or texture_1_normal\.png/);
        assert.match(l.note ?? "", /one reference names one file/);
      }
      assert.ok(byKey.has("shared.png/texture_0_base_color.png"), `${label}: the map_Kd line lists its own candidate`);
      assert.ok(byKey.has("shared.png/texture_0_normal.png,texture_1_normal.png"), `${label}: the map_Bump line lists its own candidates`);
      assert.deepEqual(dl.material_links.rewritten.map((p) => basename(p)), ["model.obj"], `${label}: only the OBJ's mtllib changed`);
      for (const f of dl.files) {
        assert.equal(sha(f.path), f.sha256, `${label}: ${f.key} digest matches disk`);
        assert.equal(readFileSync(f.path).length, f.bytes);
      }
      assert.equal(dl.files.find((f) => f.key === "model.mtl")!.relinked, false);
      const ambiguous = env.warnings.filter((w) => w.code === "material_reference_ambiguous");
      assert.equal(ambiguous.length, 1, `${label}: one warning, said once`);
      assert.equal(ambiguous[0]!.message.split("one reference names one file").length, 2);
      assert.deepEqual(host.requests.map((q) => q.method), ["GET", "GET", "GET", "GET", "GET"]);
    } finally {
      await host.close();
    }
  }
});

test("R5-F02 arbitration matrix: eight key/reference combinations in both orders — identity keeps its texture, ambiguous rivals block heuristics, one reference is reconciled across keys (two hits, hit + ambiguity, same identity, same fallback), distinct channels stay independent", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const B = { key: "texture.0.base_color", name: "texture_0_base_color.png", sourceName: "a.png" };
  const N = { key: "texture.0.normal", name: "texture_0_normal.png", sourceName: "n1.png" };
  const N2 = { key: "texture.1.normal", name: "texture_1_normal.png", sourceName: "n2.png" };
  type Tex = { key: string; name: string; sourceName: string };
  const cases: Array<{ id: string; lines: [string, string]; textures: Tex[]; expected: [Array<string | null>, Array<string | null>]; note?: RegExp }> = [
    { id: "identity-plus-heuristic", lines: ["map_Kd body.png", "map_Kd eyes_diffuse.png"], textures: [{ ...B, sourceName: "body.png" }], expected: [["texture_0_base_color.png", "source_name"], [null, "ambiguous"]], note: /compete for texture_0_base_color\.png/ },
    { id: "ambiguous-plus-heuristic", lines: ["map_Kd texture_0_base_color.png", "map_Kd eyes_diffuse.png"], textures: [B], expected: [[null, "ambiguous"], [null, "ambiguous"]] },
    { id: "same-ref-two-hits", lines: ["map_Kd shared.png", "map_Bump shared.png"], textures: [B, N], expected: [[null, "ambiguous"], [null, "ambiguous"]], note: /one reference names one file/ },
    { id: "same-ref-hit-and-ambiguous", lines: ["map_Kd shared.png", "map_Bump shared.png"], textures: [B, N, N2], expected: [[null, "ambiguous"], [null, "ambiguous"]], note: /one reference names one file/ },
    { id: "same-ref-same-identity", lines: ["map_Kd a.png", "map_Bump a.png"], textures: [B, N], expected: [["texture_0_base_color.png", "source_name"], ["texture_0_base_color.png", "source_name"]] },
    { id: "same-ref-same-fallback", lines: ["map_Bump unknown_normal.png", "norm unknown_normal.png"], textures: [B, N], expected: [["texture_0_normal.png", "channel_in_name"], ["texture_0_normal.png", "channel_in_name"]] },
    { id: "distinct-channel-fallbacks", lines: ["map_Kd skin.png", "map_Bump other_normal.png"], textures: [B, N], expected: [["texture_0_base_color.png", "channel_of_key"], ["texture_0_normal.png", "channel_in_name"]] },
    { id: "identity-with-ambiguous-source-rival", lines: ["map_Kd a.png", "map_Bump shared.png"], textures: [B, N, N2], expected: [["texture_0_base_color.png", "source_name"], [null, "ambiguous"]] },
  ];
  for (const c of cases) {
    for (const reversed of [false, true]) {
      const label = `${c.id}${reversed ? " (reversed)" : ""}`;
      const order = reversed ? [1, 0] : [0, 1];
      const dir = tmpDir();
      const mtl = `newmtl fixture\n${order.map((i) => c.lines[i]!).join("\n")}\n`;
      writeFileSync(join(dir, "model.obj"), "mtllib old.mtl\nv 0 0 0\n");
      writeFileSync(join(dir, "model.mtl"), mtl);
      for (const t of c.textures) writeFileSync(join(dir, t.name), png);
      const report = (await relinkMaterials([
        { key: "model.obj", path: join(dir, "model.obj"), sourceName: "source.obj" },
        { key: "model.mtl", path: join(dir, "model.mtl"), sourceName: "old.mtl" },
        ...c.textures.map((t) => ({ key: t.key, path: join(dir, t.name), sourceName: t.sourceName })),
      ]))!;
      const expected = order.map((i) => c.expected[i]!);
      assert.deepEqual(report.texture_maps.map((l) => [l.resolved_to, l.method]), expected, label);
      if (expected.every((x) => x[0] === null)) assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), mtl, `${label}: nothing rewritten`);
      if (c.note) for (const l of report.texture_maps.filter((l) => l.method === "ambiguous")) assert.match(l.note ?? "", c.note, label);
      assert.equal(report.status, expected.some((x) => x[0] === null) ? "incomplete" : "complete", label);
      if (c.id === "same-ref-hit-and-ambiguous") {
        const sets = report.texture_maps.map((l) => (l.candidates ?? []).join(",")).sort();
        assert.deepEqual(sets, ["texture_0_base_color.png", "texture_0_normal.png,texture_1_normal.png"], `${label}: each line keeps its own candidate set`);
        assert.equal(report.warnings.length, 1, `${label}: the cross-key reason is one warning`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// R5-F03 / E03 — project location and metadata checks inside the recovery context
// ---------------------------------------------------------------------------

type Verb = "get" | "wait" | "stream" | "create-async" | "create-sync";
type Fault = "missing" | "damaged";

test("E03/R5-F03 legacy/v1 × get/wait/stream/create-async/create-sync × metadata missing/damaged during the request (--project P --workspace P): exit 11 with the task, journal operation and a record_project command that carries --workspace and --operation-id; single POST for create; verbatim replay after the repair records the task with 0 requests and index_dirty", async () => {
  for (const schema of ["legacy", "v1"] as const) {
    for (const verb of ["get", "wait", "stream", "create-async", "create-sync"] as Verb[]) {
      for (const fault of ["missing", "damaged"] as Fault[]) {
        const id = `${schema}-${verb}-${fault}`;
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
          const init = await runCli(["project", "init", "--root", join(dir, "projects"), "--name", id], { env, cwd: dir });
          assert.equal(init.code, 0, init.stderr);
          const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
          const meta = join(proj, "metadata.json");
          const original = readFileSync(meta);
          plant = fault === "missing" ? () => renameSync(meta, `${meta}.backup`) : () => writeFileSync(meta, "{ invalid json");
          const args = verb.startsWith("create") ? ["text-to-3d", "create", "--mode", "preview", "--prompt", "fixture", ...(verb === "create-async" ? ["--async"] : [])] : ["text-to-3d", verb, id];
          const r = await runCli([...args, ...(schema === "v1" ? V1 : []), "--project", proj, "--workspace", proj], { env, cwd: dir });
          assert.equal(r.code, 11, `${id}: ${r.stderr}\n${r.stdout}`);
          const out = parseSingleJson(r.stdout) as Record<string, unknown>;
          const result = out["result"] as { task_id: string; submission: { state: string; operation_id: string | null; task_id?: string } };
          const isCreate = verb.startsWith("create");
          const records = journal(configDir);
          let command: string;
          if (schema === "v1") {
            assert.deepEqual(Object.keys(out).sort(), ENVELOPE_KEYS, id);
            const error = out["error"] as { code: string; message: string; recovery: { action: string; automatic: boolean; command: string } | null; hint?: string };
            assert.equal(error.code, "local_io", id);
            assert.ok(error.recovery, `${id}: a recovery is offered`);
            assert.equal(error.recovery!.action, "record_project", id);
            assert.equal(error.hint, error.recovery!.command, id);
            assert.match(error.message, fault === "missing" ? /has no metadata\.json any more/ : /not valid JSON/, id);
            command = error.recovery!.command;
          } else {
            assert.equal(out["code"], "local_io", id);
            assert.equal(out["task_id"], id, `${id}: the legacy payload names the task`);
            assert.ok(String(out["hint"]).startsWith("meshy project record "), `${id}: the legacy hint is the record command: ${String(out["hint"])}`);
            command = String(out["hint"]);
          }
          assert.equal(result.task_id, id, `${id}: the task is kept`);
          assert.equal(result.submission.state, "accepted");
          const words = shellSplit(command);
          assert.equal(optionValue(words, "--stage"), "preview", id);
          assert.equal(optionValue(words, "--resource"), "text-to-3d", id);
          if (isCreate) {
            assert.equal(records.length, 1, `${id}: exactly one journal record — nothing re-submitted`);
            assert.equal(records[0]!.state, "accepted");
            assert.equal(records[0]!.task_id, id);
            assert.equal(result.submission.operation_id, records[0]!.operation_id, `${id}: submission names the journal record`);
            if (schema === "legacy") assert.equal(out["operation_id"], records[0]!.operation_id, id);
            assert.equal(optionValue(words, "--operation-id"), records[0]!.operation_id, `${id}: the recovery keeps the operation id`);
            assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, id);
          } else {
            assert.equal(records.length, 0, id);
            assert.equal(api.requests.filter((q) => q.method === "POST").length, 0, id);
          }
          if (verb === "get" || verb === "stream" || verb === "create-async") assert.equal(api.requests.length, 1, `${id}: one request only`);
          assert.equal(api.requests.filter((q) => q.method === "DELETE").length, 0);
          // A damaged metadata still lets the snapshot land; a missing one does not — and the command says which.
          const taskJson = optionValue(words, "--task-json");
          if (fault === "missing" || verb === "create-async") assert.equal(taskJson, undefined, `${id}: no snapshot was written`);
          else {
            assert.equal(taskJson, `task_${id}.json`, id);
            assert.ok(existsSync(join(proj, taskJson!)), `${id}: the snapshot exists in the project`);
          }
          // Repair the project, then replay exactly the command handed out.
          if (fault === "missing") renameSync(`${meta}.backup`, meta);
          else writeFileSync(meta, original);
          const before = api.requests.length;
          const { entry } = await replayRecord(command, env, dir, { projectDir: proj, workspace: proj, taskId: id, requestsBefore: before, requests: () => api.requests.length });
          assert.equal(entry["stage"], "preview", id);
          assert.equal(entry["resource"], "text-to-3d", id);
          if (isCreate) assert.equal(entry["operation_id"], records[0]!.operation_id, `${id}: the journal operation is recorded`);
          if (taskJson) assert.equal(entry["task_json"], taskJson, id);
        } finally {
          await api.close();
        }
      }
    }
  }
});

test("R5-F03 a project that leaves the workspace during the request (replaced by a symlink to an outside directory) is refused without any record command: exit 11, task and journal kept, nothing written outside, recovery null", async () => {
  let plant: (() => void) | null = null;
  let taskId = "";
  const api = await startMockApi((req, res) => {
    plant?.();
    plant = null;
    if (req.method === "POST") return jsonReply(res, 200, { result: taskId });
    return jsonReply(res, 200, taskBody({ id: taskId }));
  });
  try {
    const dir = tmpDir();
    const env = api.env();
    const configDir = String(env["MESHY_CONFIG_DIR"]);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    for (const schema of ["legacy", "v1"] as const) {
      taskId = `escaped-${schema}`;
      const init = await runCli(["project", "init", "--root", join(workspace, "projects"), "--name", `escape-${schema}`], { env, cwd: dir });
      assert.equal(init.code, 0, init.stderr);
      const proj = (parseSingleJson(init.stdout) as { result: { project_dir: string } }).result.project_dir;
      const outside = join(dir, `outside-${schema}`);
      // The project passes the preflight, then leaves the workspace while the POST is in flight.
      plant = () => {
        renameSync(proj, outside);
        symlinkSync(outside, proj);
      };
      api.requests.length = 0;
      const r = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "fixture", "--async", ...(schema === "v1" ? V1 : []), "--project", proj, "--workspace", workspace], { env, cwd: dir });
      assert.equal(r.code, 11, `${schema}: ${r.stderr}\n${r.stdout}`);
      assert.equal(api.requests.filter((q) => q.method === "POST").length, 1, `${schema}: the POST happened (the preflight had passed)`);
      const out = parseSingleJson(r.stdout) as Record<string, unknown>;
      const result = out["result"] as { task_id: string; submission: { operation_id: string | null } };
      assert.equal(result.task_id, taskId, `${schema}: the accepted task is named`);
      const records = journal(configDir).filter((j) => j.task_id === taskId);
      assert.equal(records.length, 1, `${schema}: journaled exactly once`);
      assert.equal(records[0]!.state, "accepted");
      assert.equal(result.submission.operation_id, records[0]!.operation_id);
      const message = schema === "v1" ? (out["error"] as { message: string }).message : String(out["message"]);
      assert.match(message, /no longer a target inside the workspace/, schema);
      assert.match(message, /symbolic link|outside the authorised root/, schema);
      assert.match(message, /nothing was recorded/, schema);
      assert.match(message, new RegExp(`operation ${records[0]!.operation_id}`), `${schema}: the journal operation is named`);
      const hint = schema === "v1" ? (out["error"] as { hint?: string }).hint : (out["hint"] as string | undefined);
      assert.ok(!(hint ?? "").startsWith("meshy project record"), `${schema}: no record command that would cross the boundary`);
      if (schema === "v1") assert.equal((out["error"] as { recovery: unknown }).recovery, null, "no recovery that drops the workspace");
      else assert.equal(out["task_id"], taskId);
      assert.deepEqual(listing(outside), ["metadata.json"], `${schema}: nothing was written through the symlink (no snapshot, no lock, no temp)`);
      assert.equal((JSON.parse(readFileSync(join(outside, "metadata.json"), "utf8")) as { tasks: unknown[] }).tasks.length, 0, `${schema}: the escaped metadata was not written`);
    }
  } finally {
    await api.close();
  }
});
