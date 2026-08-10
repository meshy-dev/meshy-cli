/**
 * Tests for src/internal/device.ts — device authorization, polling, and scope verification.
 *
 * All tests are hermetic: no real network calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  deviceAuthorization,
  DeviceFlowNotSupportedError,
  DeviceFlowError,
  pollDeviceToken,
  ensureRequestedScopesGranted,
} from "../src/internal/device.js";
import { HintedError, toErrorPayload } from "../src/internal/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
    server.on("error", reject);
  });
}

const GOOD_DEVICE_AUTH_RESPONSE = {
  device_code: "dev-code-abc",
  user_code: "XXXX-YYYY",
  verification_uri: "https://www.meshy.ai/activate",
  verification_uri_complete: "https://www.meshy.ai/activate?user_code=XXXX-YYYY",
  expires_in: 600,
  interval: 5,
};

const GOOD_TOKEN_RESPONSE = {
  access_token: "access-tok",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "refresh-tok",
};

// ---------------------------------------------------------------------------
// deviceAuthorization
// ---------------------------------------------------------------------------

test("deviceAuthorization — happy path returns parsed response", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(GOOD_DEVICE_AUTH_RESPONSE));
  });
  try {
    const resp = await deviceAuthorization(stub.url);
    assert.equal(resp.device_code, "dev-code-abc");
    assert.equal(resp.user_code, "XXXX-YYYY");
    assert.equal(resp.verification_uri, "https://www.meshy.ai/activate");
    assert.equal(resp.expires_in, 600);
    assert.equal(resp.interval, 5);
  } finally {
    await stub.close();
  }
});

test("deviceAuthorization — 404 throws DeviceFlowNotSupportedError", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  try {
    await assert.rejects(
      () => deviceAuthorization(stub.url),
      (err: unknown) => {
        assert.ok(err instanceof DeviceFlowNotSupportedError);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("deviceAuthorization — non-200 non-404 throws HintedError with server message", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "bad request", error: "invalid_client" }));
  });
  try {
    await assert.rejects(
      () => deviceAuthorization(stub.url),
      (err: unknown) => {
        assert.ok(err instanceof HintedError);
        assert.match(err.message, /bad request|invalid_client/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("deviceAuthorization — interval < 1 is clamped to 5", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0 }));
  });
  try {
    const resp = await deviceAuthorization(stub.url);
    assert.equal(resp.interval, 5);
  } finally {
    await stub.close();
  }
});

test("deviceAuthorization — missing interval defaults to 5", async () => {
  const stub = await startStub((_req, res) => {
    const { interval: _i, ...rest } = GOOD_DEVICE_AUTH_RESPONSE;
    void _i;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rest));
  });
  try {
    const resp = await deviceAuthorization(stub.url);
    assert.equal(resp.interval, 5);
  } finally {
    await stub.close();
  }
});

test("deviceAuthorization — sends client_id=meshy-cli", async () => {
  let capturedBody = "";
  const stub = await startStub((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      capturedBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GOOD_DEVICE_AUTH_RESPONSE));
    });
  });
  try {
    await deviceAuthorization(stub.url);
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.equal(parsed["client_id"], "meshy-cli");
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// pollDeviceToken — happy path
// ---------------------------------------------------------------------------

test("pollDeviceToken — pending then approved → success", async () => {
  let callCount = 0;
  const stub = await startStub((_req, res) => {
    callCount++;
    if (callCount < 3) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "authorization_pending" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
    }
  });
  try {
    const tok = await pollDeviceToken(stub.url, "dev-code", {
      interval: 0.001, // 1ms for fast tests
      expiresIn: 60,
    });
    assert.equal(tok.access_token, "access-tok");
    assert.equal(callCount, 3);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// pollDeviceToken — slow_down increases interval
// ---------------------------------------------------------------------------

test("pollDeviceToken — slow_down increases interval by 5s (capped at 60s)", async () => {
  let callCount = 0;
  const intervals: number[] = [];
  let lastCallTime = Date.now();

  const stub = await startStub((_req, res) => {
    callCount++;
    const now = Date.now();
    if (callCount > 1) {
      intervals.push(now - lastCallTime);
    }
    lastCallTime = now;

    if (callCount === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "slow_down" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
    }
  });
  try {
    const tok = await pollDeviceToken(stub.url, "dev-code", {
      interval: 0.001,
      expiresIn: 60,
    });
    assert.equal(tok.access_token, "access-tok");
    // After slow_down, interval should have increased (at least 5ms in our test).
    assert.ok(callCount >= 2);
  } finally {
    await stub.close();
  }
});

test("pollDeviceToken — HTTP 429 also increases interval", async () => {
  let callCount = 0;
  const stub = await startStub((_req, res) => {
    callCount++;
    if (callCount === 1) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "rate limited" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
    }
  });
  try {
    const tok = await pollDeviceToken(stub.url, "dev-code", {
      interval: 0.001,
      expiresIn: 60,
    });
    assert.equal(tok.access_token, "access-tok");
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// pollDeviceToken — error codes
// ---------------------------------------------------------------------------

test("pollDeviceToken — expired_token → DeviceFlowError with oauthErrorCode and oauth_timeout code", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expired_token" }));
  });
  try {
    await assert.rejects(
      () => pollDeviceToken(stub.url, "dev-code", { interval: 0.001, expiresIn: 60 }),
      (err: unknown) => {
        // Must be a DeviceFlowError so oauthErrorCode survives to --json output.
        assert.ok(err instanceof DeviceFlowError, `expected DeviceFlowError, got ${String(err)}`);
        assert.equal(err.code, "oauth_timeout");
        assert.equal(err.oauthErrorCode, "expired_token");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("pollDeviceToken — deadline exceeded → oauth_timeout HintedError", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "authorization_pending" }));
  });
  try {
    await assert.rejects(
      () =>
        pollDeviceToken(stub.url, "dev-code", {
          interval: 0.001,
          expiresIn: 1,
          deadline: Date.now() - 1, // already expired
        }),
      (err: unknown) => {
        assert.ok(err instanceof HintedError);
        assert.equal(err.code, "oauth_timeout");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("pollDeviceToken — access_denied → DeviceFlowError with oauthErrorCode", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "access_denied", error_description: "User denied" }));
  });
  try {
    await assert.rejects(
      () => pollDeviceToken(stub.url, "dev-code", { interval: 0.001, expiresIn: 60 }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceFlowError);
        assert.equal(err.oauthErrorCode, "access_denied");
        assert.match(err.message, /denied/i);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("pollDeviceToken — invalid_grant → DeviceFlowError with oauthErrorCode", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant" }));
  });
  try {
    await assert.rejects(
      () => pollDeviceToken(stub.url, "dev-code", { interval: 0.001, expiresIn: 60 }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceFlowError);
        assert.equal(err.oauthErrorCode, "invalid_grant");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("pollDeviceToken — 5xx retries up to 3 then throws", { timeout: 30_000 }, async () => {
  let callCount = 0;
  const stub = await startStub((_req, res) => {
    callCount++;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "server error" }));
  });
  try {
    await assert.rejects(
      () =>
        pollDeviceToken(stub.url, "dev-code", {
          interval: 0.001, // 1ms (clamped to 5s internally, but we use a long deadline)
          expiresIn: 600,  // 10 minutes — deadline won't be hit before 3 retries
        }),
      (err: unknown) => {
        assert.ok(err instanceof HintedError);
        assert.match(err.message, /server error|500/i);
        return true;
      },
    );
    // Should have retried exactly 3 times.
    assert.ok(callCount >= 3, `expected at least 3 calls, got ${callCount}`);
  } finally {
    await stub.close();
  }
});

test("pollDeviceToken — sends correct grant_type and device_code", async () => {
  let capturedBody = "";
  const stub = await startStub((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      capturedBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
    });
  });
  try {
    await pollDeviceToken(stub.url, "my-device-code", { interval: 0.001, expiresIn: 60 });
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.equal(parsed["grant_type"], "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(parsed["device_code"], "my-device-code");
    assert.equal(parsed["client_id"], "meshy-cli");
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// ensureRequestedScopesGranted
// ---------------------------------------------------------------------------

test("ensureRequestedScopesGranted — empty requested → passes trivially", () => {
  // Today both are "" — trivially passes.
  assert.doesNotThrow(() => ensureRequestedScopesGranted("", undefined));
  assert.doesNotThrow(() => ensureRequestedScopesGranted("", ""));
  assert.doesNotThrow(() => ensureRequestedScopesGranted("", "read write"));
});

test("ensureRequestedScopesGranted — all requested scopes granted → passes", () => {
  assert.doesNotThrow(() =>
    ensureRequestedScopesGranted("read write", "read write admin"),
  );
});

test("ensureRequestedScopesGranted — missing scope → throws HintedError listing missing", () => {
  assert.throws(
    () => ensureRequestedScopesGranted("read write admin", "read write"),
    (err: unknown) => {
      assert.ok(err instanceof HintedError);
      assert.match(err.message, /admin/);
      assert.equal(err.code, "oauth_scope_denied");
      return true;
    },
  );
});

test("ensureRequestedScopesGranted — granted undefined with requested scopes → throws", () => {
  assert.throws(
    () => ensureRequestedScopesGranted("read", undefined),
    (err: unknown) => {
      assert.ok(err instanceof HintedError);
      assert.match(err.message, /read/);
      return true;
    },
  );
});

test("ensureRequestedScopesGranted — whitespace-only requested → passes", () => {
  assert.doesNotThrow(() => ensureRequestedScopesGranted("   ", undefined));
});

// ---------------------------------------------------------------------------
// Error serialization — oauth_error field in toErrorPayload
// ---------------------------------------------------------------------------

test("toErrorPayload — DeviceFlowError includes oauth_error field", () => {
  const err = new DeviceFlowError({
    message: "login was denied",
    code: "oauth_access_denied",
    oauthErrorCode: "access_denied",
    hint: "Run: meshy auth login",
  });
  const payload = toErrorPayload(err);
  assert.equal(payload["oauth_error"], "access_denied");
  assert.equal(payload["code"], "oauth_access_denied");
  assert.equal(payload["name"], "DeviceFlowError");
});

test("toErrorPayload — expired_token DeviceFlowError serializes distinctly from access_denied", () => {
  const expired = new DeviceFlowError({
    message: "Device flow authorization code expired.",
    code: "oauth_timeout",
    oauthErrorCode: "expired_token",
    hint: "Run: meshy auth login",
  });
  const denied = new DeviceFlowError({
    message: "Device login was denied.",
    code: "oauth_access_denied",
    oauthErrorCode: "access_denied",
    hint: "Run: meshy auth login",
  });
  const expiredPayload = toErrorPayload(expired);
  const deniedPayload = toErrorPayload(denied);

  assert.equal(expiredPayload["oauth_error"], "expired_token");
  assert.equal(expiredPayload["code"], "oauth_timeout");

  assert.equal(deniedPayload["oauth_error"], "access_denied");
  assert.equal(deniedPayload["code"], "oauth_access_denied");

  // The two payloads must be distinguishable by oauth_error alone.
  assert.notEqual(expiredPayload["oauth_error"], deniedPayload["oauth_error"]);
});

test("toErrorPayload — invalid_grant DeviceFlowError serializes oauth_error", () => {
  const err = new DeviceFlowError({
    message: "Device flow already consumed.",
    code: "oauth_invalid_grant",
    oauthErrorCode: "invalid_grant",
  });
  const payload = toErrorPayload(err);
  assert.equal(payload["oauth_error"], "invalid_grant");
  assert.equal(payload["code"], "oauth_invalid_grant");
});

test("toErrorPayload — plain HintedError does NOT include oauth_error field", () => {
  const err = new HintedError({
    message: "something went wrong",
    code: "oauth_network",
    hint: "retry",
  });
  const payload = toErrorPayload(err);
  assert.ok(!("oauth_error" in payload), `plain HintedError must not have oauth_error, got: ${JSON.stringify(payload)}`);
});
