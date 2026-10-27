/**
 * Texturing on the image-driven generators (image-to-3d, multi-image-to-3d).
 *
 * The API textures by default (`should_texture` defaults to true), and so
 * does the CLI: `should_texture: false` is the untextured draft mesh. The
 * game-ready texture settings ride only when texturing is on, because the
 * API refuses texture settings on an untextured run.
 */

import { UsageError } from "./errors.js";

/**
 * Default texture settings — the full PBR map set and a 4k base color —
 * unless the flags or `--data` turn texturing off (the flag wins, as in the
 * merged payload).
 */
export function texturingDefaults(opts: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const shouldTexture = opts.shouldTexture ?? data["should_texture"];
  if (shouldTexture === false) return {};
  return { enable_pbr: true, texture_resolution: "4k" };
}

/** Refuse texture settings on an untextured run, before the POST the API would answer with a 400. */
export function refuseTextureSettingsWithoutTexture(payload: Record<string, unknown>, keys: readonly string[]): void {
  if (payload["should_texture"] !== false) return;
  const set = keys.filter((k) => payload[k] !== undefined).map((k) => `--${k.replace(/_/g, "-")}`);
  if (set.length > 0) {
    throw new UsageError(`${set.join(", ")} cannot be used with --should-texture false: the API refuses texture settings on an untextured run`);
  }
}
