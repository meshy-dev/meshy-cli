/**
 * Small reusable Commander `<arg>` parsers.
 */

import { UsageError } from "./errors.js";

export function parseBool(raw: string): boolean {
  const v = raw.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new UsageError(`expected true/false, got '${raw}'`);
}

export function parseInt10(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new UsageError(`expected integer, got '${raw}'`);
  return n;
}

export function parseNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`expected number, got '${raw}'`);
  return n;
}

export function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function collect(raw: string, prev: string[] = []): string[] {
  return [...prev, raw];
}
