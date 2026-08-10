/**
 * Credit estimates for the chains `make` runs.
 *
 * Deliberately narrow: only the operations `make` can start are listed. A
 * fuller table would rot silently — nothing in the CLI verifies these numbers
 * against the server, so every value here is an *estimate* shown before the
 * spend, never an accounting record. `meshy balance` is the source of truth.
 *
 * Prices: https://docs.meshy.ai/en/api/pricing
 */

export const PRICING_DOCS = "https://docs.meshy.ai/en/api/pricing";

/** Per-operation estimates, keyed by the step name `make` reports. */
export const CREDIT_ESTIMATES = {
  /** text-to-3d --mode preview: geometry only. */
  "text-to-3d:preview": 20,
  /** text-to-3d --mode refine: textures the preview it came from. */
  "text-to-3d:refine": 10,
  /** image-to-3d --should-texture true: geometry and textures in one task. */
  "image-to-3d:textured": 30,
} as const;

export type PricedOperation = keyof typeof CREDIT_ESTIMATES;

export function estimateFor(op: PricedOperation): number {
  return CREDIT_ESTIMATES[op];
}
