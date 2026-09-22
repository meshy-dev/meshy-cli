import { readFileSync } from "node:fs";

/**
 * package.json is the single source of truth for the version and the published
 * package name — read it at startup instead of hardcoding. This file sits
 * exactly two directories below package.json in both layouts that matter
 * (src/internal/ under tsx, dist/internal/ after `tsc`), and
 * tests/version.test.ts pins VERSION === package.json#version so the two can
 * never drift again.
 */
const { version, name } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string; name: string };

export const VERSION = version;

/**
 * The npm package this build was installed from. The release workflow
 * publishes the same tree twice — as `meshy-cli` and, after `npm pkg set
 * name`, as the scoped alias `@meshy-ai/cli` — and both declare the same
 * `meshy` / `meshy-cli` bins. npm refuses to relink a bin owned by the other
 * package, so telling an `@meshy-ai/cli` user to run `npm i -g meshy-cli` is
 * an EEXIST waiting to happen. Everything user-facing that names the package
 * reads it from here.
 */
export const PACKAGE_NAME = name;
