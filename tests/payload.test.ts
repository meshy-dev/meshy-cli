/**
 * Unit tests for payload helpers (src/internal/payload.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropNullish, mergePayload, parseJsonFlag } from "../src/internal/payload.js";

test("dropNullish — removes undefined and null, keeps falsy", () => {
  const out = dropNullish({
    a: 1,
    b: undefined,
    c: null,
    d: 0,
    e: "",
    f: false,
  });
  assert.deepEqual(out, { a: 1, d: 0, e: "", f: false });
});

test("mergePayload — flag values override base JSON", () => {
  const base = { prompt: "old", seed: 42, legacy: "keep" };
  const flags = { prompt: "new", enablePbr: undefined, moderation: true };
  assert.deepEqual(mergePayload(base, flags), {
    prompt: "new",
    seed: 42,
    legacy: "keep",
    moderation: true,
  });
});

test("mergePayload — three layers: defaults < --data < flags", () => {
  const defaults = { ai_model: "gpt-image-2", enable_pbr: true, target_formats: ["glb"] };
  const data = { ai_model: "nano-banana-2-lite", enable_pbr: false };
  const flags = { prompt: "a fox", ai_model: undefined };
  assert.deepEqual(mergePayload(defaults, data, flags), {
    ai_model: "nano-banana-2-lite", // --data beats the pinned default
    enable_pbr: false,              // --data can switch a default off
    target_formats: ["glb"],        // untouched default survives
    prompt: "a fox",
  });
});

test("parseJsonFlag — empty returns empty object", () => {
  assert.deepEqual(parseJsonFlag(undefined, "--data"), {});
  assert.deepEqual(parseJsonFlag("", "--data"), {});
});

test("parseJsonFlag — inline object", () => {
  assert.deepEqual(
    parseJsonFlag('{"a":1,"b":"x"}', "--data"),
    { a: 1, b: "x" },
  );
});

test("parseJsonFlag — @file loads from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-cli-test-"));
  const file = join(dir, "payload.json");
  writeFileSync(file, '{"prompt":"from file","seed":7}', "utf8");
  const out = parseJsonFlag(`@${file}`, "--data");
  assert.deepEqual(out, { prompt: "from file", seed: 7 });
});

test("parseJsonFlag — rejects invalid JSON with flag name in message", () => {
  assert.throws(() => parseJsonFlag("{not json}", "--data"), /invalid JSON passed to --data/);
});

test("parseJsonFlag — rejects arrays and primitives", () => {
  assert.throws(() => parseJsonFlag("[1,2,3]", "--data"), /must be a JSON object/);
  assert.throws(() => parseJsonFlag("42", "--data"), /must be a JSON object/);
});
