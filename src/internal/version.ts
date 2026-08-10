import { readFileSync } from "node:fs";

/**
 * package.json is the single source of truth for the version — read it at
 * startup instead of hardcoding. This file sits exactly two directories
 * below package.json in both layouts that matter (src/internal/ under tsx,
 * dist/internal/ after `tsc`), and tests/version.test.ts pins VERSION ===
 * package.json#version so the two can never drift again.
 */
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VERSION = version;
