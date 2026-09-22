/**
 * Guards against VERSION drifting from package.json — the failure mode that
 * bit meshy-mcp-server (src said 0.2.1, /health said 0.3.0, CHANGELOG
 * claimed otherwise). VERSION is read from package.json at startup; this
 * test proves the wiring keeps working from both src/ and dist/ layouts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PACKAGE_NAME, VERSION } from "../src/internal/version.js";
import { REQUIRED_NODE } from "../src/internal/doctor.js";

test("VERSION === package.json version", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("PACKAGE_NAME === package.json name", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { name: string };
  assert.equal(PACKAGE_NAME, pkg.name);
});

/**
 * engines.node and the floor `meshy doctor` enforces must move together. They
 * drifted once in the other direction: engines claimed >=24 while nothing in
 * the tree needed more than 22.12, and npm answered by silently resolving
 * `npm i -g meshy-cli` to 0.1.3 for every Node 22 user.
 */
test("engines.node === the floor doctor enforces", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { engines: { node: string } };
  assert.equal(pkg.engines.node, `>=${REQUIRED_NODE}`);
});

test("VERSION is a semver-shaped string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
