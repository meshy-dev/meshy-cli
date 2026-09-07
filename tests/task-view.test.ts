/**
 * TaskView normalisation (T-008): 0 stays 0, missing stays null, extra fields
 * survive in raw, and every saved-JSON shape yields the same task.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractTaskObject, toTaskView } from "../src/internal/task-view.js";
import { requireTaskResource } from "../src/client/resource-registry.js";

const rigFixture = JSON.parse(readFileSync(new URL("./fixtures/skill-parity/task-rigging.synthetic.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("face_count and consumed_credits: 0 is 0, null is null, missing is null", () => {
  const base = { id: "t", status: "SUCCEEDED" };
  assert.equal(toTaskView({ ...base, face_count: 0, consumed_credits: 0 }).face_count, 0);
  assert.equal(toTaskView({ ...base, face_count: 0, consumed_credits: 0 }).consumed_credits, 0);
  assert.equal(toTaskView({ ...base, face_count: null }).face_count, null);
  assert.equal(toTaskView(base).face_count, null);
  assert.equal(toTaskView(base).consumed_credits, null);
  assert.equal(toTaskView({ ...base, face_count: "1234" }).face_count, null, "strings are not silently parsed");
  assert.equal(toTaskView({ ...base, face_count: Number.NaN }).face_count, null);
});

test("missing optional fields are null/empty, never defaulted to 0 or ''", () => {
  const v = toTaskView({ id: "t" });
  assert.equal(v.status, null);
  assert.equal(v.progress, null);
  assert.equal(v.created_at, null);
  assert.equal(v.type, null);
  assert.deepEqual(v.model_urls, {});
  assert.deepEqual(v.image_urls, []);
  assert.equal(v.thumbnail_urls, null);
  assert.equal(v.task_error, null);
});

test("descriptor supplies resource/endpoint; include-raw keeps every extra field and the original shape", () => {
  const raw = { ...rigFixture, novel_field: { deep: [1, 2] } };
  const v = toTaskView(raw, { descriptor: requireTaskResource("rigging"), includeRaw: true });
  assert.equal(v.resource, "rigging");
  assert.equal(v.endpoint, "/openapi/v1/rigging");
  assert.equal(v.face_count, 250000);
  assert.equal(v.consumed_credits, 5);
  assert.deepEqual(v.result?.["basic_animations"], (rigFixture["result"] as Record<string, unknown>)["basic_animations"]);
  assert.deepEqual((v.raw as Record<string, unknown>)["novel_field"], { deep: [1, 2] });
  assert.equal("raw" in toTaskView(raw), false);
});

test("thumbnail_urls object keyed by view is preserved; non-string entries become null", () => {
  const v = toTaskView({ id: "t", thumbnail_urls: { front: "https://a/f.png", back: 3 } });
  assert.deepEqual(v.thumbnail_urls, { front: "https://a/f.png", back: null });
});

test("extractTaskObject accepts API task, meta.json, v1 envelope with raw and plain v1 result", () => {
  const api = extractTaskObject(rigFixture);
  assert.equal(api?.source, "api");
  const meta = extractTaskObject({ resource: "rigging", task: rigFixture, saved_files: [] });
  assert.equal(meta?.source, "meta.json");
  assert.equal(meta?.task["id"], "fixture-rig-1");
  const view = toTaskView(rigFixture, { includeRaw: true });
  const env = extractTaskObject({ schema_version: "meshy.cli/v1", command: "rigging.get", ok: true, result: { task: view }, error: null, warnings: [] });
  assert.equal(env?.source, "v1-envelope");
  assert.equal(env?.task["id"], "fixture-rig-1");
  const plain = extractTaskObject({ result: { task: toTaskView(rigFixture) } });
  assert.equal(plain?.source, "v1-result");
  assert.equal(plain?.task["id"], "fixture-rig-1");
  assert.equal(extractTaskObject({ hello: 1 }), null);
  assert.equal(extractTaskObject([1]), null);
});
