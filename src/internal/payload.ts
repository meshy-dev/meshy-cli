/**
 * Build a request payload from structured CLI flags and optional raw JSON.
 * Merge order (later wins): CLI defaults < --data < flag-supplied fields —
 * pinned defaults must never clobber an explicit --data payload.
 *
 * Merging is shallow on purpose: arrays and plain fields replace wholesale so a
 * `--data` array is exactly what is sent. The one exception is the small set of
 * nested option objects a resource declares (`nestedObjectKeys`, e.g. Creative
 * Lab `options`/`output`): those are merged field by field across the same
 * layers, so `--data '{"options":{...}}'` and `--options '{...}'` compose
 * instead of the later one silently deleting the earlier one's settings.
 */

import { readFileSync } from "node:fs";
import { UsageError } from "./errors.js";

export function parseJsonFlag(raw: string | undefined, flag: string): Record<string, unknown> {
  if (!raw) return {};
  const trimmed = raw.trim();
  let text: string;
  if (trimmed.startsWith("@")) {
    try {
      text = readFileSync(trimmed.slice(1), "utf8");
    } catch (err) {
      throw new UsageError(`${flag}: cannot read ${trimmed.slice(1)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    text = trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`invalid JSON passed to ${flag}: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`${flag} must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`);
  }
  return parsed as Record<string, unknown>;
}

export function dropNullish(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function mergePayload(...layers: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    // Within a layer an undefined value must not erase a weaker layer's value.
    Object.assign(merged, dropNullish(layer));
  }
  return merged;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Field-level merge for the declared nested object keys, applied on top of a
 * shallow `mergePayload` result. Layers are ordered weakest → strongest; within
 * a key, a later layer's fields win, unspecified fields survive, and explicit
 * `false`/`0`/`""` are kept. If the strongest layer that names the key is not
 * an object (a deliberate replacement), the shallow result stands.
 */
export function mergeNestedObjects(
  merged: Record<string, unknown>,
  layers: readonly Record<string, unknown>[],
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...merged };
  for (const key of keys) {
    const present = layers.filter((l) => l[key] !== undefined && l[key] !== null);
    if (present.length === 0) continue;
    const strongest = present[present.length - 1]!;
    if (!isPlainObject(strongest[key])) continue;
    const combined: Record<string, unknown> = {};
    for (const layer of present) {
      if (isPlainObject(layer[key])) Object.assign(combined, dropNullish(layer[key]));
    }
    out[key] = combined;
  }
  return out;
}
