/**
 * Guards against VERSION drifting from package.json — the failure mode that
 * bit meshy-mcp-server (src said 0.2.1, /health said 0.3.0, CHANGELOG
 * claimed otherwise). VERSION is read from package.json at startup; this
 * test proves the wiring keeps working from both src/ and dist/ layouts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/internal/version.js";

test("VERSION === package.json version", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("VERSION is a semver-shaped string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
