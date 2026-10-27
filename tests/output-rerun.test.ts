/**
 * Rerunning `-o` with real subprocesses and a loopback API/asset host: the
 * same command for the same task passes again and replaces what its earlier
 * run saved; a transfer that failed part-way hands out that very command as
 * its recovery (absolute paths, --all-assets and --workspace kept, shell-quoted)
 * and running it verbatim completes the set; a create never spends credits to
 * land on another task's files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

function glb(payload: string): Buffer {
  const chunk = Buffer.from(`{"asset":{"version":"2.0"},"x":"${payload}"}   `);
  const head = Buffer.alloc(20);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + chunk.length, 8);
  head.writeUInt32LE(chunk.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, chunk]);
}

/** Split a command the way a POSIX shell would (bare words, single quotes with the '\'' escape). */
function shellSplit(command: string): string[] {
  const words: string[] = [];
  let cur = "";
  let pending = false;
  let quoted = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quoted) {
      if (ch === "'") quoted = false;
      else cur += ch;
    } else if (ch === "'") {
      quoted = true;
      pending = true;
    } else if (ch === "\\") {
      cur += command[(i += 1)] ?? "";
      pending = true;
    } else if (ch === " ") {
      if (pending) words.push(cur);
      cur = "";
      pending = false;
    } else {
      cur += ch;
      pending = true;
    }
  }
  if (pending) words.push(cur);
  return words;
}

function savedFiles(dir: string): string[] {
  return (JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { saved_files: string[] }).saved_files.sort();
}

interface Envelope {
  ok: boolean;
  error: { code: string; message: string; recovery: { action: string; command?: string } | null } | null;
  result: { downloads: { state: string; metadata_path: string | null; files: Array<{ key: string; status: string; path: string }> } };
}

test("rerunning -o for the same task passes and replaces its own files; a failed transfer's recovery is that rerun, verbatim; a create never lands on another task's files", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  let thumbnailUp = false;
  const api = await startMockApi((req, res) => {
    if (req.path === "/m.glb") {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      return void res.end(glb("rerun"));
    }
    if (req.path === "/t.png") {
      if (!thumbnailUp) return jsonReply(res, 503, { message: "asset host outage" });
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(png);
    }
    if (req.method === "POST") return jsonReply(res, 200, { result: "new-task" });
    return jsonReply(res, 200, { id: "rerun-task", status: "SUCCEEDED", type: "text-to-3d-preview", progress: 100, model_urls: { glb: `${api.url}/m.glb` }, thumbnail_url: `${api.url}/t.png` });
  });
  try {
    const dir = tmpDir();
    const workspace = join(dir, "work space");
    const out = join(workspace, "it's here");
    mkdirSync(workspace);

    // 1. The thumbnail fails: exit 7, the model and a sidecar that lists it stay, the recovery is the same -o.
    const first = await runCli(["text-to-3d", "get", "rerun-task", "-o", out, "--all-assets", "--workspace", workspace], { env: api.env(), cwd: dir });
    assert.equal(first.code, 7, `${first.stderr}\n${first.stdout}`);
    const failed = parseSingleJson(first.stdout) as Envelope;
    assert.equal(failed.result.downloads.metadata_path, join(out, "meta.json"));
    assert.deepEqual(savedFiles(out), [join(out, "model.glb")]);
    const command = failed.error!.recovery!.command!;
    assert.equal(command, `meshy text-to-3d get rerun-task -o '${workspace}/it'\\''s here' --all-assets --workspace '${workspace}'`);
    assert.doesNotMatch(command, /<dir>/);

    // 2. The host recovers: the recovery, run verbatim from another directory, completes the set.
    thumbnailUp = true;
    const words = shellSplit(command);
    assert.equal(words[0], "meshy");
    const resumed = await runCli(words.slice(1), { env: api.env(), cwd: tmpDir() });
    assert.equal(resumed.code, 0, `${resumed.stderr}\n${resumed.stdout}`);
    assert.deepEqual(readdirSync(out).sort(), ["meta.json", "model.glb", "thumbnail.png"]);
    assert.deepEqual(savedFiles(out), [join(out, "model.glb"), join(out, "thumbnail.png")]);

    // 3. And once more: a complete set is replaced, not refused.
    const again = await runCli(["text-to-3d", "get", "rerun-task", "-o", out, "--all-assets", "--workspace", workspace], { env: api.env(), cwd: dir });
    assert.equal(again.code, 0, `${again.stderr}\n${again.stdout}`);
    assert.deepEqual((parseSingleJson(again.stdout) as Envelope).result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "written"], ["thumbnail.primary", "written"]]);

    // 4. A create would be a new task, which owns none of this: refused before the POST.
    const before = api.requests.length;
    const create = await runCli(["text-to-3d", "create", "--mode", "preview", "--prompt", "again", "-o", out], { env: api.env(), cwd: dir });
    assert.equal(create.code, 11, `${create.stderr}\n${create.stdout}`);
    assert.match((parseSingleJson(create.stdout) as Envelope).error!.message, /meta\.json already exists; a new task does not replace them.*nothing was submitted/);
    assert.equal(api.requests.length, before, "no request at all");
  } finally {
    await api.close();
  }
});
