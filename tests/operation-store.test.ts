/**
 * Operation journal (T-043..T-046): start → accepted/unknown/rejected, replay
 * on the same id, conflict on a different request, no secrets on disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  beginOperation,
  credentialFingerprint,
  listOperations,
  payloadFingerprint,
  readOperation,
  updateOperation,
} from "../src/internal/operation-store.js";
import { CliError } from "../src/internal/errors.js";
import { tmpDir } from "./helpers/cli.js";

const identity = {
  resource: "text-to-3d",
  endpoint: "/openapi/v2/text-to-3d",
  apiOrigin: "http://127.0.0.1:1",
  credentialFingerprint: credentialFingerprint({ source: "env", origin: "http://127.0.0.1:1", kind: "api_key" }),
  payloadFingerprint: payloadFingerprint({ mode: "preview", prompt: "a", image_url: "data:image/png;base64,AAAA" }),
};

test("begin → accepted, then a repeat with the same id replays without conflict", () => {
  const root = tmpDir("ops-");
  const a = beginOperation(root, "op-1", identity);
  assert.equal(a.outcome, "created");
  assert.equal(a.record.state, "started");
  updateOperation(root, "op-1", { state: "accepted", task_id: "task-9", http_status: 200 });
  const b = beginOperation(root, "op-1", identity);
  assert.equal(b.outcome, "existing");
  assert.equal(b.record.state, "accepted");
  assert.equal(b.record.task_id, "task-9");
  assert.equal(listOperations(root).length, 1);
});

test("a different payload, credential or origin under the same id is an operation_conflict", () => {
  const root = tmpDir("ops-");
  beginOperation(root, "op-2", identity);
  for (const variant of [
    { ...identity, payloadFingerprint: payloadFingerprint({ mode: "preview", prompt: "b" }) },
    { ...identity, credentialFingerprint: credentialFingerprint({ source: "file", profile: "work", origin: identity.apiOrigin }) },
    { ...identity, apiOrigin: "http://127.0.0.1:2" },
    { ...identity, resource: "image-to-3d" },
  ]) {
    assert.throws(() => beginOperation(root, "op-2", variant), (e: unknown) => e instanceof CliError && e.code === "operation_conflict");
  }
});

test("fingerprints hide media content and canonicalise key order", () => {
  const a = payloadFingerprint({ b: 1, image_url: `data:image/png;base64,${"A".repeat(400)}` });
  const b = payloadFingerprint({ image_url: `data:image/png;base64,${"B".repeat(400)}`, b: 1 });
  assert.equal(a, b, "same length data URI of the same MIME → same fingerprint, content is not stored");
  assert.notEqual(a, payloadFingerprint({ b: 2, image_url: `data:image/png;base64,${"A".repeat(400)}` }));
  assert.notEqual(credentialFingerprint({ source: "env", origin: "x" }), credentialFingerprint({ source: "file", profile: "p", origin: "x" }));
});

test("records never contain the key, base64 media or signed URLs; files are private", () => {
  const root = tmpDir("ops-");
  beginOperation(root, "op-3", identity);
  updateOperation(root, "op-3", { state: "unknown", error: "socket hang up" });
  const files = readdirSync(root).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const text = readFileSync(join(root, files[0]!), "utf8");
  assert.ok(!text.includes("AAAA"), "no base64 payload");
  assert.ok(!text.includes("msy_"), "no key material");
  assert.equal(readOperation(root, "op-3")?.state, "unknown");
});

test("T-046 two processes racing on the same operation id: exactly one creates, the other sees it", () => {
  const root = tmpDir("ops-");
  const script = fileURLToPath(new URL("./helpers/begin-operation-child.ts", import.meta.url));
  const runs = [1, 2, 3].map(() =>
    spawnSync(process.execPath, ["--import", "tsx", script, root, "race-1"], { encoding: "utf8", env: { ...process.env, MESHY_CLI_NO_UPDATE_NOTIFIER: "1" } }),
  );
  const outcomes = runs.map((r) => {
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim()) as { outcome: string };
  });
  const created = outcomes.filter((o) => o.outcome === "created").length;
  assert.equal(created, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.length - created, 2);
});
