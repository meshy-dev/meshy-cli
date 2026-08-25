/**
 * Unit tests for the shared 2D-image model table (src/internal/image-models.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { checkImageCombo, DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from "../src/internal/image-models.js";
import { UsageError } from "../src/internal/errors.js";

test("gpt-image-2 is the default model and part of the model list", () => {
  assert.equal(DEFAULT_IMAGE_MODEL, "gpt-image-2");
  assert.ok((IMAGE_MODELS as readonly string[]).includes(DEFAULT_IMAGE_MODEL));
});

test("checkImageCombo — multi-view excludes aspect-ratio", () => {
  assert.throws(
    () => checkImageCombo({ aiModel: "nano-banana", aspectRatio: "1:1", generateMultiView: true }),
    UsageError,
  );
  // multi-view without a ratio is fine
  checkImageCombo({ aiModel: "nano-banana", generateMultiView: true });
});

test("checkImageCombo — gpt-image-2 accepts square, widescreen, and native ratios", () => {
  for (const ratio of ["1:1", "16:9", "9:16", "3:2", "2:3"]) {
    checkImageCombo({ aiModel: "gpt-image-2", aspectRatio: ratio });
  }
  for (const ratio of ["4:3", "3:4"]) {
    assert.throws(
      () => checkImageCombo({ aiModel: "gpt-image-2", aspectRatio: ratio }),
      /not supported by gpt-image-2/,
    );
  }
});

test("checkImageCombo — nano-banana family accepts photo/video ratios, not gpt-only ones", () => {
  for (const model of ["nano-banana", "nano-banana-2", "nano-banana-2-lite", "nano-banana-pro"]) {
    for (const ratio of ["1:1", "16:9", "9:16", "4:3", "3:4"]) {
      checkImageCombo({ aiModel: model, aspectRatio: ratio });
    }
    for (const ratio of ["3:2", "2:3"]) {
      assert.throws(
        () => checkImageCombo({ aiModel: model, aspectRatio: ratio }),
        /only supported by gpt-image-2/,
      );
    }
  }
});

test("checkImageCombo — no ratio means nothing to validate", () => {
  checkImageCombo({ aiModel: "gpt-image-2" });
  checkImageCombo({});
});

test("checkImageCombo — unknown model (driven via --data) defers the ratio check to the server", () => {
  checkImageCombo({ aspectRatio: "16:9" });
  // ...but multi-view exclusivity is model-independent and still enforced.
  assert.throws(() => checkImageCombo({ aspectRatio: "16:9", generateMultiView: true }), UsageError);
});

test("the model list includes nano-banana-2-lite", () => {
  assert.ok((IMAGE_MODELS as readonly string[]).includes("nano-banana-2-lite"));
});
