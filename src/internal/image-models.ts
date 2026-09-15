/**
 * Shared model/aspect-ratio table for the 2D image commands, so text-to-image
 * and image-to-image can't drift apart as Meshy ships new models.
 *
 * The ratio rules mirror the server's own per-model check
 * (meshyd pkg/server/api_image_generation_handlers.go): every GPT Image model
 * accepts all seven ratios; the nano-banana family rejects 3:2 and 2:3.
 */

import { UsageError } from "./errors.js";

export const IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2-5-flare",
  "gpt-image-2-5-sunburst",
  "nano-banana-pro",
  "nano-banana-2",
  "nano-banana-2-lite",
] as const;

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

/** OpenAI GPT Image models of any generation — the ones that take every aspect ratio. */
export const GPT_IMAGE_MODELS = ["gpt-image-2", "gpt-image-2-5-flare", "gpt-image-2-5-sunburst"] as const;

export const IMAGE_MODEL_HELP =
  "gpt-image-2 (default) | gpt-image-2-5-flare (GPT Image 2.5, fast tier) | " +
  "gpt-image-2-5-sunburst (GPT Image 2.5, precision-edit tier) | nano-banana-pro | " +
  "nano-banana-2 | nano-banana-2-lite (fastest, cheapest)";

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

export const ASPECT_RATIO_HELP =
  "default: 1:1. gpt-image-*: 1:1|16:9|9:16|4:3|3:4|3:2|2:3. " +
  "nano-banana*: 1:1|16:9|9:16|4:3|3:4. " +
  "Mutually exclusive with --generate-multi-view";

const GPT_IMAGE_MODEL_SET: ReadonlySet<string> = new Set(GPT_IMAGE_MODELS);
const NANO_BANANA_RATIOS: ReadonlySet<string> = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

export function isGptImageModel(model: string): boolean {
  return GPT_IMAGE_MODEL_SET.has(model);
}

/**
 * Cross-validate model × aspect-ratio × multi-view before any credits are
 * spent, with a message that names the fix. When the model is unknown at
 * parse time (driven via --data), the ratio check is left to the server.
 */
export function checkImageCombo(opts: {
  aiModel?: string;
  aspectRatio?: string;
  generateMultiView?: boolean;
}): void {
  if (opts.generateMultiView === true && opts.aspectRatio) {
    throw new UsageError("--generate-multi-view true is mutually exclusive with --aspect-ratio");
  }
  const ratio = opts.aspectRatio;
  if (!ratio || !opts.aiModel) return;
  // GPT Image models (2 and 2.5) accept every ratio the flag offers; only the
  // nano-banana family is narrower.
  if (isGptImageModel(opts.aiModel)) return;
  if (!NANO_BANANA_RATIOS.has(ratio)) {
    throw new UsageError(
      `--aspect-ratio ${ratio} is only supported by the GPT Image models (${GPT_IMAGE_MODELS.join(", ")})`,
    );
  }
}
