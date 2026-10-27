/**
 * Codex review round 4 (reviews/cli-s1-235d6de: R4-T01) as a positive
 * regression with real subprocesses, a loopback API/asset host that records
 * every request, synthetic credentials and isolated temp directories: `make`'s
 * reported operation id is the *last* accepted journal record's (two steps with
 * different ids, asset 503 and SIGINT).
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir } from "./helpers/cli.js";

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

test("R4-T01 make: two chain steps get different task ids; submission.operation_id, executed[-1].operation_id are the last accepted journal record's, refine carries step 1's id as preview_task_id — asset 503 and SIGINT, POST GET POST GET GET", async () => {
  for (const mode of ["503", "sigint"] as const) {
    const label = mode;
    let n = 0;
    let child: ChildProcess | null = null;
    const api = await startMockApi(async (req, res) => {
      if (req.method === "POST") return jsonReply(res, 200, { result: `${mode}-step-${++n}` });
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
      const r = await runCli(["make", "a fixture cactus", "-o", target], { env, cwd: dir, onSpawn: (c) => (child = c) });
      assert.equal(r.code, mode === "503" ? 7 : 130, `${label}: ${r.stderr}\n${r.stdout}`);
      const out = parseSingleJson(r.stdout) as Record<string, unknown> & { result: MakeResult };
      const step1 = `${mode}-step-1`;
      const step2 = `${mode}-step-2`;
      const result = out.result;
      assert.deepEqual(Object.keys(out).sort(), ENVELOPE_KEYS, label);
      assert.equal(out["ok"], false);
      const error = out["error"] as { code: string; http_status: number | null };
      assert.equal(error.code, mode === "503" ? "network" : "interrupted", label);
      assert.equal(error.http_status, mode === "503" ? 503 : null);
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
        assert.deepEqual(result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "failed"]], label);
      } else {
        assert.equal(result.downloads.state, "failed", `${label}: the interrupted transfer wrote nothing, so the manifest says failed (not not_requested)`);
        assert.deepEqual(result.downloads.files.map((f) => [f.key, f.status]), [["model.glb", "failed"]], label);
        assert.ok(!existsSync(target), `${label}: no final file after the interrupt`);
      }
    } finally {
      await api.close();
    }
  }
});
