/**
 * Build a request payload from structured CLI flags and optional raw JSON.
 * Merge order (later wins): CLI defaults < --data < flag-supplied fields —
 * pinned defaults must never clobber an explicit --data payload.
 */

import { readFileSync } from "node:fs";

export function parseJsonFlag(raw: string | undefined, flag: string): Record<string, unknown> {
  if (!raw) return {};
  const trimmed = raw.trim();
  const text = trimmed.startsWith("@") ? readFileSync(trimmed.slice(1), "utf8") : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON passed to ${flag}: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`);
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
