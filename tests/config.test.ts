/**
 * Tests for loadConfig — ensure env vars, overrides, and placeholders behave.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/internal/config.js";
import { HintedError } from "../src/internal/errors.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    snapshot[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("loadConfig — reads env vars with sensible defaults", () => {
  withEnv(
    {
      MESHY_API_KEY: "msy_abc",
      MESHY_BASE_URL_V1: undefined,
      MESHY_BASE_URL_V2: undefined,
      MESHY_LOG_LEVEL: undefined,
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.apiKey, "msy_abc");
      assert.equal(cfg.baseUrlV1, "https://api.meshy.ai/openapi/v1");
      assert.equal(cfg.baseUrlV2, "https://api.meshy.ai/openapi/v2");
      assert.equal(cfg.logLevel, "warn");
      assert.equal(cfg.pollIntervalMs, 3000);
    },
  );
});

test("loadConfig — overrides win over env vars", () => {
  withEnv(
    {
      MESHY_API_KEY: "msy_env_key",
      MESHY_BASE_URL_V1: "https://env.example/v1/",
    },
    () => {
      const cfg = loadConfig({
        apiKey: "msy_flag_key",
        baseUrlV1: "https://flag.example/v1///",
        logLevel: "debug",
      });
      assert.equal(cfg.apiKey, "msy_flag_key");
      assert.equal(cfg.baseUrlV1, "https://flag.example/v1"); // trailing slashes stripped
      assert.equal(cfg.logLevel, "debug");
    },
  );
});

// Point the store at a path that cannot exist so these cases test "no
// credential anywhere" instead of quietly reading the developer's real
// ~/.config/meshy/credentials.json and passing or failing based on it.
const NO_STORE = "/nonexistent-meshy-test-dir/credentials.json";

test("loadConfig — missing API key throws", () => {
  withEnv({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: NO_STORE }, () => {
    assert.throws(() => loadConfig(), /No credentials found/);
  });
});

test("loadConfig — placeholder API key throws", () => {
  withEnv({ MESHY_API_KEY: "YOUR_MESHY_API_KEY_HERE", MESHY_CREDENTIALS_PATH: NO_STORE }, () => {
    assert.throws(() => loadConfig(), /No credentials found/);
  });
});

test("loadConfig — the unauthenticated error carries the command that fixes it", () => {
  withEnv({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: NO_STORE }, () => {
    assert.throws(
      () => loadConfig(),
      (err: unknown) => {
        assert.ok(err instanceof HintedError);
        assert.equal(err.code, "unauthenticated");
        assert.match(err.hint ?? "", /meshy auth login/);
        return true;
      },
    );
  });
});

test("loadConfig — invalid numeric env var throws", () => {
  withEnv(
    { MESHY_API_KEY: "msy_x", MESHY_POLL_INTERVAL_MS: "not-a-number" },
    () => {
      assert.throws(() => loadConfig(), /MESHY_POLL_INTERVAL_MS/);
    },
  );
});

test("loadConfig — strips trailing slashes from base URLs", () => {
  withEnv(
    {
      MESHY_API_KEY: "msy_x",
      MESHY_BASE_URL_V1: "https://example.com/v1///",
      MESHY_BASE_URL_V2: "https://example.com/v2/",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.baseUrlV1, "https://example.com/v1");
      assert.equal(cfg.baseUrlV2, "https://example.com/v2");
    },
  );
});
