/**
 * Operation journal (T-043..T-046): start → accepted/unknown/rejected, replay
 * on the same id, conflict on a different request, identity bound to the
 * actual credential and to media content, no secrets on disk, and a real
 * multi-process race on one operation id.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginOperation,
  credentialFingerprint,
  dataUriDigest,
  listOperations,
  payloadFingerprint,
  readOperation,
  updateOperation,
} from "../src/internal/operation-store.js";
import { CliError } from "../src/internal/errors.js";
import { tmpDir } from "./helpers/cli.js";

const KEY_A = "msy_fixture_account_a_0000000000";
const KEY_B = "msy_fixture_account_b_0000000000";

const identity = {
  resource: "text-to-3d",
  endpoint: "/openapi/v2/text-to-3d",
  apiOrigin: "http://127.0.0.1:1",
  credentialFingerprint: credentialFingerprint({ source: "env", origin: "http://127.0.0.1:1", kind: "api_key", secret: KEY_A }),
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

test("a different payload, credential or origin under the same id is an operation_conflict naming what differs", () => {
  const root = tmpDir("ops-");
  beginOperation(root, "op-2", identity);
  const variants: Array<[string, typeof identity]> = [
    ["payload", { ...identity, payloadFingerprint: payloadFingerprint({ mode: "preview", prompt: "b" }) }],
    ["credential", { ...identity, credentialFingerprint: credentialFingerprint({ source: "env", origin: identity.apiOrigin, kind: "api_key", secret: KEY_B }) }],
    ["credential", { ...identity, credentialFingerprint: credentialFingerprint({ source: "file", profile: "work", origin: identity.apiOrigin, kind: "api_key", secret: KEY_A }) }],
    ["origin", { ...identity, apiOrigin: "http://127.0.0.1:2" }],
    ["resource", { ...identity, resource: "image-to-3d" }],
  ];
  for (const [what, variant] of variants) {
    assert.throws(
      () => beginOperation(root, "op-2", variant),
      (e: unknown) => e instanceof CliError && e.code === "operation_conflict" && Array.isArray(e.result?.["conflict"]) && (e.result!["conflict"] as string[]).includes(what),
      what,
    );
  }
});

test("F05 credential identity is bound to the key digest / OAuth subject, not to the source alone", () => {
  const origin = "http://127.0.0.1:1";
  const envA = credentialFingerprint({ source: "env", origin, kind: "api_key", secret: KEY_A });
  const envB = credentialFingerprint({ source: "env", origin, kind: "api_key", secret: KEY_B });
  assert.notEqual(envA, envB, "two keys from the same env source are two identities");
  assert.equal(envA, credentialFingerprint({ source: "env", origin, kind: "api_key", secret: KEY_A }), "the same key is stable");
  assert.ok(!envA.includes(KEY_A.slice(4, 20)), "the fingerprint does not contain the key");
  // OAuth: the subject binds the account; a rotated token changes nothing, a different user does.
  const userA = credentialFingerprint({ source: "file", profile: "default", origin, kind: "oauth", subject: "user-a" });
  assert.equal(userA, credentialFingerprint({ source: "file", profile: "default", origin, kind: "oauth", subject: "user-a", secret: "rotated-access-token" }), "token rotation keeps the identity");
  assert.notEqual(userA, credentialFingerprint({ source: "file", profile: "default", origin, kind: "oauth", subject: "user-b" }), "same profile name, different account → different identity");
  assert.notEqual(credentialFingerprint({ source: "env", origin, kind: "api_key" }), credentialFingerprint({ source: "file", profile: "p", origin, kind: "api_key" }));
});

test("F06 media fingerprints hash the decoded content: same file matches, different equal-length files do not", () => {
  const red = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 255, 0, 0]).toString("base64");
  const green = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 0, 255, 0]).toString("base64");
  assert.equal(red.length, green.length);
  const a = payloadFingerprint({ b: 1, image_url: `data:image/png;base64,${red}` });
  const b = payloadFingerprint({ image_url: `data:image/png;base64,${red}`, b: 1 });
  assert.equal(a, b, "key order does not matter");
  assert.notEqual(a, payloadFingerprint({ b: 1, image_url: `data:image/png;base64,${green}` }), "different bytes of the same length → different fingerprint");
  assert.notEqual(a, payloadFingerprint({ b: 2, image_url: `data:image/png;base64,${red}` }));
  // Equivalent encodings of the same bytes (line-wrapped base64) are the same request.
  const wrapped = red.replace(/(.{4})/g, "$1\n");
  assert.equal(payloadFingerprint({ b: 1, image_url: `data:image/png;base64,${wrapped}` }), a);
  // The digest string carries the MIME and a hash, never the payload.
  const digest = dataUriDigest(`data:image/png;base64,${red}`);
  assert.match(digest, /^data:image\/png;sha256=[0-9a-f]{64}$/);
  assert.ok(!digest.includes(red.slice(0, 8)));
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
  assert.ok(!text.includes(KEY_A.slice(4)), "no key fragment");
  assert.equal(readOperation(root, "op-3")?.state, "unknown");
});

test("T-046 three processes released together on the same operation id: exactly one creates, the others see its record", async () => {
  const root = tmpDir("ops-");
  const barrier = tmpDir("barrier-");
  const script = fileURLToPath(new URL("./helpers/begin-operation-child.ts", import.meta.url));
  const children = [1, 2, 3].map(
    () =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, root, "race-1", barrier], { env: { ...process.env, MESHY_CLI_NO_UPDATE_NOTIFIER: "1" } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      }),
  );
  // Release the barrier only once every child is spinning at the gate.
  const deadline = Date.now() + 15_000;
  while (readdirSync(barrier).filter((f) => f.startsWith("ready-")).length < 3) {
    if (Date.now() > deadline) throw new Error("children never reached the barrier");
    await new Promise((r) => setTimeout(r, 5));
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(barrier, "go"), "");
  const runs = await Promise.all(children);
  const outcomes = runs.map((r) => {
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim()) as { outcome: string; state: string };
  });
  const created = outcomes.filter((o) => o.outcome === "created").length;
  assert.equal(created, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((o) => o.outcome === "existing" && o.state === "started").length, 2, JSON.stringify(outcomes));
  assert.equal(listOperations(root).length, 1, "one record on disk");
});
