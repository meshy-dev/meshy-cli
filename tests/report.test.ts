/**
 * Tests for the status-report renderer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { formatReport } from "../src/internal/report.js";

test("formatReport — SUCCESS lists saved files and metadata path", () => {
  const out = formatReport({
    status: "SUCCESS",
    taskId: "019dae66-1b31",
    type: "text-to-image",
    savedFiles: ["out/image_0.png"],
    metadataPath: "out/meta.json",
  });
  assert.equal(
    out,
    [
      "Status: SUCCESS",
      "Task Id: 019dae66-1b31",
      "Generated text-to-image",
      "Saved to:",
      "- out/image_0.png",
      "Metadata path: out/meta.json",
      "",
    ].join("\n"),
  );
});

test("formatReport — SUCCESS with multiple files", () => {
  const out = formatReport({
    status: "SUCCESS",
    taskId: "t2",
    type: "image-to-3d",
    savedFiles: ["robot/model.glb", "robot/model.fbx", "robot/thumbnail.png"],
    metadataPath: "robot/meta.json",
  });
  assert.match(out, /Saved to:\n- robot\/model\.glb\n- robot\/model\.fbx\n- robot\/thumbnail\.png\nMetadata path: robot\/meta\.json/);
});

test("formatReport — FAIL with error message, no Saved/Metadata lines", () => {
  const out = formatReport({
    status: "FAIL",
    taskId: "t3",
    type: "text-to-3d",
    error: "prompt violates content policy",
  });
  assert.match(out, /^Status: FAIL$/m);
  assert.match(out, /^Generated text-to-3d$/m);
  assert.match(out, /^Error: prompt violates content policy$/m);
  assert.ok(!/Saved to:/.test(out));
  assert.ok(!/Metadata path:/.test(out));
});

test("formatReport — FAIL with timedOut", () => {
  const out = formatReport({
    status: "FAIL",
    taskId: "t4",
    type: "image-to-3d",
    timedOut: true,
  });
  assert.match(out, /Error: polling timed out/);
});

test("formatReport — type falls back to '(unknown)' when empty", () => {
  const out = formatReport({
    status: "SUCCESS",
    taskId: "t5",
    type: "",
    savedFiles: ["x.png"],
    metadataPath: "meta.json",
  });
  assert.match(out, /^Generated \(unknown\)$/m);
});
