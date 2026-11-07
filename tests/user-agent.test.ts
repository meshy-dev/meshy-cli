/**
 * MESHY_CLI_CLIENT lets a product that drives meshy-cli (Meshy DCC Core) tag
 * its requests. The value lands in an HTTP header, so it must never smuggle a
 * line break or grow without bound.
 *
 * The AI agent running the command goes inside the parentheses (D-092): the
 * known readers take the platform from the parentheses (their first token)
 * and the tool name from after them, so both readings must stay as they were.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { userAgent } from "../src/internal/user-agent.js";
import { VERSION } from "../src/internal/version.js";

/** The plain string with an agent segment added inside the parentheses. */
function withAgent(agent: string): string {
  return userAgent({}).replace(/\)$/, `; agent ${agent})`);
}

test("userAgent — no client keeps the plain meshy-cli string", () => {
  assert.match(userAgent({}), new RegExp(`^meshy-cli/${VERSION.replace(/\./g, "\\.")} \\(.+\\)$`));
  assert.ok(!userAgent({}).includes("agent"));
  assert.equal(userAgent({ MESHY_CLI_CLIENT: "   " }), userAgent({}));
});

test("userAgent — the client is appended after the meshy-cli part", () => {
  assert.equal(userAgent({ MESHY_CLI_CLIENT: "meshy-dcc/0.2.2 (blender)" }), `${userAgent({})} meshy-dcc/0.2.2 (blender)`);
});

test("userAgent — a DeepSeek Harness shell is tagged dsh unless MESHY_CLI_CLIENT names the product", () => {
  assert.equal(userAgent({ DSH_SHELL: "1" }), `${withAgent("dsh")} dsh`);
  assert.equal(userAgent({ DSH_SHELL: "1", MESHY_CLI_CLIENT: "meshy-dcc/0.2.2" }), `${withAgent("dsh")} meshy-dcc/0.2.2`);
  assert.equal(userAgent({ DSH_SHELL: "0" }), userAgent({}));
});

test("userAgent — control characters and non-ASCII are dropped, length is capped", () => {
  const ua = userAgent({ MESHY_CLI_CLIENT: "meshy-dcc/0.2.2\r\nX-Injected: 1 é" });
  assert.ok(!/[\r\n]/.test(ua));
  assert.ok(ua.endsWith("meshy-dcc/0.2.2X-Injected: 1"));
  assert.equal(userAgent({ MESHY_CLI_CLIENT: "x".repeat(500) }).length, userAgent({}).length + 1 + 100);
});

test("userAgent — the agent goes inside the parentheses, after the Node version", () => {
  assert.equal(userAgent({ CURSOR_AGENT: "1" }), withAgent("cursor"));
  assert.equal(
    userAgent({ CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", MESHY_CLI_CLIENT: "meshy-3d-agent/0.9.2" }),
    `${withAgent("claude-code/desktop")} meshy-3d-agent/0.9.2`,
  );
  assert.equal(userAgent({ CURSOR_AGENT: "1", MESHY_CLI_AGENT: "none" }), userAgent({}));
});

test("userAgent — the platform and the client read the same with an agent segment", () => {
  const ua = userAgent({ CURSOR_AGENT: "1", MESHY_CLI_CLIENT: "meshy-dcc/0.2.2 (blender)" });
  // As the account settings page reads it: the first token inside the first parentheses.
  const inner = /\(([^)]+)\)/.exec(ua)?.[1] ?? "";
  assert.equal(inner.split(/[\s;]/)[0], process.platform);
  // As the API reads the tool: the first product after the meshy-cli parentheses.
  const after = ua.slice(ua.indexOf(")") + 1).trim();
  assert.equal(after.split(/[\s/;]/)[0], "meshy-dcc");
});
