/**
 * Unit tests for the shared 2D-image model table (src/internal/image-models.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ASPECT_RATIOS,
  checkImageCombo,
  DEFAULT_IMAGE_MODEL,
  GPT_IMAGE_MODELS,
  IMAGE_MODELS,
  isGptImageModel,
} from "../src/internal/image-models.js";
import { UsageError } from "../src/internal/errors.js";

const NANO_BANANA_MODELS = ["nano-banana-2", "nano-banana-2-lite", "nano-banana-pro"];

test("gpt-image-2 is the default model and part of the model list", () => {
  assert.equal(DEFAULT_IMAGE_MODEL, "gpt-image-2");
  assert.ok((IMAGE_MODELS as readonly string[]).includes(DEFAULT_IMAGE_MODEL));
});

test("the model list covers both GPT Image 2.5 tiers", () => {
  for (const model of ["gpt-image-2-5-flare", "gpt-image-2-5-sunburst"]) {
    assert.ok((IMAGE_MODELS as readonly string[]).includes(model), `missing ${model}`);
    assert.ok((GPT_IMAGE_MODELS as readonly string[]).includes(model), `${model} is not a GPT Image model`);
    assert.ok(isGptImageModel(model));
  }
  // Every model is classified exactly one way, so a new entry can't fall
  // through the ratio check unnoticed.
  for (const model of IMAGE_MODELS) {
    assert.equal(isGptImageModel(model), !NANO_BANANA_MODELS.includes(model), model);
  }
});

test("checkImageCombo — multi-view excludes aspect-ratio", () => {
  assert.throws(
    () => checkImageCombo({ aiModel: "nano-banana-2-lite", aspectRatio: "1:1", generateMultiView: true }),
    UsageError,
  );
  // multi-view without a ratio is fine
  checkImageCombo({ aiModel: "nano-banana-2-lite", generateMultiView: true });
});

test("checkImageCombo — every GPT Image model accepts every aspect ratio the flag offers", () => {
  // Mirrors meshyd: the server's per-model check lets gpt-image-2 and both 2.5
  // tiers through for 1:1/16:9/9:16/4:3/3:4/3:2/2:3 (verified live: gpt-image-2
  // + 4:3 is accepted with 202).
  for (const model of GPT_IMAGE_MODELS) {
    for (const ratio of ASPECT_RATIOS) {
      checkImageCombo({ aiModel: model, aspectRatio: ratio });
    }
  }
});

test("checkImageCombo — nano-banana family accepts photo/video ratios, not the GPT-only ones", () => {
  for (const model of NANO_BANANA_MODELS) {
    for (const ratio of ["1:1", "16:9", "9:16", "4:3", "3:4"]) {
      checkImageCombo({ aiModel: model, aspectRatio: ratio });
    }
    for (const ratio of ["3:2", "2:3"]) {
      assert.throws(
        () => checkImageCombo({ aiModel: model, aspectRatio: ratio }),
        /only supported by the GPT Image models \(gpt-image-2, gpt-image-2-5-flare, gpt-image-2-5-sunburst\)/,
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

test("the model list includes nano-banana-2-lite and no longer offers the original nano-banana", () => {
  assert.ok((IMAGE_MODELS as readonly string[]).includes("nano-banana-2-lite"));
  // The first-generation model was dropped from the flag surface on 2026-09-15;
  // the API still accepts it, so --data '{"ai_model":"nano-banana"}' remains the escape hatch.
  assert.ok(!(IMAGE_MODELS as readonly string[]).includes("nano-banana"));
});
