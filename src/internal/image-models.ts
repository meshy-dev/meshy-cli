/**
 * Shared model/aspect-ratio table for the 2D image commands, so text-to-image
 * and image-to-image can't drift apart as Meshy ships new models.
 */

import { UsageError } from "./errors.js";

export const IMAGE_MODELS = [
  "gpt-image-2",
  "nano-banana-pro",
  "nano-banana-2",
  "nano-banana-2-lite",
  "nano-banana",
] as const;

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

export const IMAGE_MODEL_HELP =
  "gpt-image-2 (default, best; ratios 1:1|3:2|2:3) | nano-banana-pro | nano-banana-2 | " +
  "nano-banana-2-lite (fastest, cheapest) | nano-banana (legacy)";

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

export const ASPECT_RATIO_HELP =
  "default: 1:1. nano-banana*: 1:1|16:9|9:16|4:3|3:4. gpt-image-2: 1:1|3:2|2:3. " +
  "Mutually exclusive with --generate-multi-view";

const GPT_IMAGE_2_RATIOS = new Set(["1:1", "3:2", "2:3"]);
const NANO_BANANA_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

/**
 * Cross-validate model × aspect-ratio × multi-view before any credits are
 * spent; the API's own 400 is less specific. When the model is unknown at
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
  const supported = opts.aiModel === "gpt-image-2" ? GPT_IMAGE_2_RATIOS : NANO_BANANA_RATIOS;
  if (!supported.has(ratio)) {
    throw new UsageError(
      opts.aiModel === "gpt-image-2"
        ? `--aspect-ratio ${ratio} is not supported by gpt-image-2 (use 1:1, 3:2, or 2:3)`
        : `--aspect-ratio ${ratio} is only supported by gpt-image-2`,
    );
  }
}
