/**
 * Agent detection: the shared case table (tests/fixtures/agent-env-cases.json)
 * is the oracle — each case is an agent's environment, captured or read from
 * its shipped code, and the segment the User-Agent must carry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { agentToken, detectAgent } from "../src/internal/agent.js";

interface Case {
  name: string;
  platform: NodeJS.Platform;
  env: Record<string, string>;
  existing_paths?: string[];
  agent: string;
  via?: string;
  override?: string;
}

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/agent-env-cases.json", import.meta.url), "utf8")) as {
  cases: Case[];
};

for (const c of cases) {
  test(`detectAgent — ${c.name}`, () => {
    const paths = new Set(c.existing_paths ?? []);
    const detection = detectAgent(c.env, c.platform, (p) => paths.has(p));
    assert.equal(agentToken(detection), c.agent);
    if (detection.agent) {
      assert.equal(typeof detection.agent.id, "string");
      assert.equal(typeof detection.agent.surface, "string");
    }
    if (c.via !== undefined) assert.equal(detection.agent?.via, c.via);
    assert.equal(detection.override, c.override ?? "unset");
  });
}

test("detectAgent — the cloud socket is only probed for Cursor on Linux", () => {
  const probed: string[] = [];
  const exists = (p: string): boolean => {
    probed.push(p);
    return false;
  };
  detectAgent({ CLAUDE_CODE_CHILD_SESSION: "1" }, "linux", exists);
  detectAgent({ CURSOR_AGENT: "1" }, "darwin", exists);
  assert.deepEqual(probed, []);
  detectAgent({ CURSOR_AGENT: "1" }, "linux", exists);
  assert.deepEqual(probed, ["/run/cursor/api.sock"]);
});

test("detectAgent — a long or odd AI_AGENT stays within the id charset and 32 characters", () => {
  const { agent } = detectAgent({ AI_AGENT: `-A.${"x".repeat(80)}\r\nY` }, "linux", () => false);
  assert.ok(agent);
  assert.match(agent.id, /^[a-z0-9][a-z0-9.-]{0,31}$/);
});
