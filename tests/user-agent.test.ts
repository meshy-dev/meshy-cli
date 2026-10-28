/**
 * MESHY_CLI_CLIENT lets a product that drives meshy-cli (Meshy DCC Core) tag
 * its requests. The value lands in an HTTP header, so it must never smuggle a
 * line break or grow without bound.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { userAgent } from "../src/internal/user-agent.js";
import { VERSION } from "../src/internal/version.js";

test("userAgent — no client keeps the plain meshy-cli string", () => {
  assert.match(userAgent({}), new RegExp(`^meshy-cli/${VERSION.replace(/\./g, "\\.")} \\(.+\\)$`));
  assert.equal(userAgent({ MESHY_CLI_CLIENT: "   " }), userAgent({}));
});

test("userAgent — the client is appended after the meshy-cli part", () => {
  assert.equal(userAgent({ MESHY_CLI_CLIENT: "meshy-dcc/0.2.2 (blender)" }), `${userAgent({})} meshy-dcc/0.2.2 (blender)`);
});

test("userAgent — control characters and non-ASCII are dropped, length is capped", () => {
  const ua = userAgent({ MESHY_CLI_CLIENT: "meshy-dcc/0.2.2\r\nX-Injected: 1 é" });
  assert.ok(!/[\r\n]/.test(ua));
  assert.ok(ua.endsWith("meshy-dcc/0.2.2X-Injected: 1"));
  assert.equal(userAgent({ MESHY_CLI_CLIENT: "x".repeat(500) }).length, userAgent({}).length + 1 + 100);
});
