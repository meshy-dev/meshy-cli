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
  poseAspectRatioWarnings,
} from "../src/internal/image-models.js";
import { UsageError } from "../src/internal/errors.js";
import { jsonReply, parseSingleJson, runCli, startMockApi } from "./helpers/cli.js";

const NANO_BANANA_MODELS = [
  "nano-banana-2-1",
  "nano-banana-2",
  "nano-banana-2-lite",
  "nano-banana-pro",
];

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
  // Mirrors the API: its per-model check lets gpt-image-2 and both 2.5
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

test("the model list includes current nano-banana models and no longer offers the original", () => {
  assert.ok((IMAGE_MODELS as readonly string[]).includes("nano-banana-2-1"));
  assert.ok((IMAGE_MODELS as readonly string[]).includes("nano-banana-2-lite"));
  // The first-generation model was dropped from the flag surface on 2026-09-15;
  // the API still accepts it, so --data '{"ai_model":"nano-banana"}' remains the escape hatch.
  assert.ok(!(IMAGE_MODELS as readonly string[]).includes("nano-banana"));
});

test("poseAspectRatioWarnings — a pose on a nano-banana model says the image comes back 3:4; GPT Image and an explicit 3:4 say nothing", () => {
  for (const model of NANO_BANANA_MODELS) {
    const [w] = poseAspectRatioWarnings({ ai_model: model, pose_mode: "t-pose", aspect_ratio: "16:9" });
    assert.equal(w?.code, "pose_aspect_ratio", model);
    assert.match(w!.message, new RegExp(`^${model} renders a t-pose image at 3:4, so --aspect-ratio 16:9 is not used`));
  }
  assert.match(poseAspectRatioWarnings({ ai_model: "nano-banana-2", pose_mode: "a-pose" })[0]!.message, /the image will not be 1:1/);
  assert.deepEqual(poseAspectRatioWarnings({ ai_model: "nano-banana-2", pose_mode: "t-pose", aspect_ratio: "3:4" }), []);
  assert.deepEqual(poseAspectRatioWarnings({ ai_model: "nano-banana-2", aspect_ratio: "16:9" }), []);
  for (const model of GPT_IMAGE_MODELS) assert.deepEqual(poseAspectRatioWarnings({ ai_model: model, pose_mode: "t-pose", aspect_ratio: "16:9" }), [], model);
  assert.deepEqual(poseAspectRatioWarnings({ pose_mode: "t-pose" }), [], "no model is the GPT default");
});

test("text-to-image / image-to-image: the pose warning rides in the envelope and the request still goes out", async () => {
  const api = await startMockApi((req, res) => (req.method === "POST" ? jsonReply(res, 200, { result: "img-1" }) : jsonReply(res, 404, {})));
  try {
    const t2i = await runCli(["text-to-image", "create", "--ai-model", "nano-banana-2", "--pose-mode", "t-pose", "--aspect-ratio", "16:9", "--prompt", "a knight", "--async"], { env: api.env() });
    assert.equal(t2i.code, 0, t2i.stderr);
    assert.deepEqual((parseSingleJson(t2i.stdout) as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code), ["pose_aspect_ratio"]);
    const i2i = await runCli(["image-to-image", "create", "--ai-model", "nano-banana-pro", "--prompt", "pose it", "--input-task-id", "img-src", "--data", '{"pose_mode":"a-pose"}', "--async"], { env: api.env() });
    assert.equal(i2i.code, 0, i2i.stderr);
    assert.deepEqual((parseSingleJson(i2i.stdout) as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code), ["pose_aspect_ratio"]);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 2, "both requests were sent");
  } finally {
    await api.close();
  }
});

