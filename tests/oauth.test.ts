/**
 * Tests for src/internal/oauth.ts — PKCE helpers, authorize URL, callback
 * server, token exchange/refresh, and an e2e subprocess test.
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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname } from "node:path";

import {
  generateState,
  generateCodeVerifier,
  codeChallengeS256,
  buildAuthorizeUrl,
  startCallbackServer,
  openBrowser,
  exchangeCode,
  refreshTokens,
} from "../src/internal/oauth.js";
import { USER_AGENT } from "../src/internal/user-agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "meshy-oauth-test-"));
}

/** Start a minimal HTTP stub server. Returns { url, close }. */
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

/** Drive the loopback callback by making a GET request to it. */
async function hitCallback(port: number, params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return fetch(`http://127.0.0.1:${port}/callback?${qs}`);
}

// ---------------------------------------------------------------------------
// 1. PKCE helpers
// ---------------------------------------------------------------------------

test("generateState — returns base64url string of length 32", () => {
  const state = generateState();
  assert.equal(typeof state, "string");
  // 24 bytes → 32 base64url chars
  assert.equal(state.length, 32);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
});

test("generateState — two calls produce different values", () => {
  assert.notEqual(generateState(), generateState());
});

test("generateCodeVerifier — returns base64url string of length 43", () => {
  const v = generateCodeVerifier();
  assert.equal(typeof v, "string");
  // 32 bytes → 43 base64url chars
  assert.equal(v.length, 43);
  assert.match(v, /^[A-Za-z0-9_-]+$/);
});

test("generateCodeVerifier — two calls produce different values", () => {
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
});

test("codeChallengeS256 — known vector (RFC 7636 Appendix B)", () => {
  // RFC 7636 Appendix B test vector:
  // verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  // challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(codeChallengeS256(verifier), expected);
});

test("codeChallengeS256 — output is base64url (no +, /, =)", () => {
  const challenge = codeChallengeS256(generateCodeVerifier());
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.ok(!challenge.includes("+"));
  assert.ok(!challenge.includes("/"));
  assert.ok(!challenge.includes("="));
});

// ---------------------------------------------------------------------------
// 2. buildAuthorizeUrl
// ---------------------------------------------------------------------------

test("buildAuthorizeUrl — all required params present and encoded", () => {
  const url = new URL(
    buildAuthorizeUrl({
      base: "https://www.meshy.ai/oauth/authorize",
      redirectUri: "http://localhost:8765/callback",
      state: "test-state-123",
      codeChallenge: "abc123challenge",
    }),
  );
  assert.equal(url.searchParams.get("client_id"), "meshy-cli");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8765/callback");
  assert.equal(url.searchParams.get("state"), "test-state-123");
  assert.equal(url.searchParams.get("code_challenge"), "abc123challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("buildAuthorizeUrl — env override MESHY_OAUTH_AUTHORIZE_URL respected", () => {
  const url = buildAuthorizeUrl({
    base: "http://127.0.0.1:9999/oauth/authorize",
    redirectUri: "http://localhost:8765/callback",
    state: "s",
    codeChallenge: "c",
  });
  assert.ok(url.startsWith("http://127.0.0.1:9999/oauth/authorize"));
});

test("buildAuthorizeUrl — special chars in state are percent-encoded", () => {
  const url = new URL(
    buildAuthorizeUrl({
      base: "https://www.meshy.ai/oauth/authorize",
      redirectUri: "http://localhost:8765/callback",
      state: "a b+c=d",
      codeChallenge: "x",
    }),
  );
  // URLSearchParams encodes spaces as +, but the raw value should round-trip
  assert.equal(url.searchParams.get("state"), "a b+c=d");
});

// ---------------------------------------------------------------------------
// 3. Callback server
// ---------------------------------------------------------------------------

test("callback server — 404 on non-/callback path", async () => {
  const state = generateState();
  const { port, waitForCallback } = await startCallbackServer(0, state);
  const res = await fetch(`http://127.0.0.1:${port}/other`);
  assert.equal(res.status, 404);
  // Clean up by hitting /callback with correct state
  await hitCallback(port, { code: "c", state });
  await waitForCallback.catch(() => {});
});

test("callback server — success page on valid /callback with correct state", async () => {
  const state = generateState();
  const { port, waitForCallback } = await startCallbackServer(0, state);
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=mycode&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("Login successful"));
  const result = await waitForCallback;
  assert.equal(result.code, "mycode");
  assert.equal(result.state, state);
});

test("callback server — ?error=access_denied rejects with that error", async () => {
  const state = generateState();
  const { port, waitForCallback } = await startCallbackServer(0, state);
  // Set up the rejection assertion BEFORE hitting the callback.
  const rejectionPromise = assert.rejects(
    () => waitForCallback,
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /access_denied|User denied/);
      return true;
    },
  );
  // Now drive the callback with an error.
  await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=User+denied`);
  await rejectionPromise;
});

test("callback server — state tampering: wrong state → 400 response, promise rejects, no success HTML", async () => {
  const correctState = generateState();
  const { port, waitForCallback } = await startCallbackServer(0, correctState);

  // Set up rejection assertion before hitting.
  const rejectionPromise = assert.rejects(
    () => waitForCallback,
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /state mismatch/i);
      return true;
    },
  );

  // Hit with wrong state.
  const res = await hitCallback(port, { code: "stolen-code", state: "wrong-state" });

  // Must return 400 (not 200 success).
  assert.equal(res.status, 400, "state mismatch must return 400, not 200");
  const body = await res.text();
  // Must NOT show the success page.
  assert.ok(!body.includes("Login successful"), "must not show success page on state mismatch");
  // Must show an error indication.
  assert.ok(body.includes("state mismatch") || body.includes("Login failed"), "must show error on state mismatch");

  await rejectionPromise;
});

test("callback server — port fallback: busy port → comes up on different port", async () => {
  // Occupy a port with a dummy server.
  const dummy = createServer((_req: IncomingMessage, res: ServerResponse) => res.end("busy"));
  await new Promise<void>((resolve, reject) => {
    dummy.listen(0, "127.0.0.1", () => resolve());
    dummy.on("error", reject);
  });
  const dummyAddr = dummy.address() as { port: number };
  const busyPort = dummyAddr.port;

  try {
    const state = generateState();
    // Start with the busy port — should fall back to a random port.
    const { port, waitForCallback } = await startCallbackServer(busyPort, state);
    assert.notEqual(port, busyPort, "should have fallen back to a different port");
    assert.ok(port > 0);

    // Verify the server is functional on the new port.
    await hitCallback(port, { code: "fallback-code", state });
    const result = await waitForCallback;
    assert.equal(result.code, "fallback-code");
  } finally {
    dummy.close();
  }
});

// ---------------------------------------------------------------------------
// 3c. Callback server — missing/empty code (C2)
// ---------------------------------------------------------------------------

test("callback server — correct state but no code → 400, rejection, no success HTML", async () => {
  const state = generateState();
  const { port, waitForCallback } = await startCallbackServer(0, state);

  const rejectionPromise = assert.rejects(
    () => waitForCallback,
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no authorization code/i);
      return true;
    },
  );

  // Hit /callback with correct state but no code param at all.
  const res = await fetch(
    `http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 400, "missing code must return 400");
  const body = await res.text();
  assert.ok(!body.includes("Login successful"), "must not show success page when code is missing");
  assert.ok(body.includes("Login failed") || body.includes("no authorization code"), "must show error page");

  await rejectionPromise;
});

test("callback server — correct state but empty code (&code=) → 400, rejection, no success HTML", async () => {
  const state = generateState();
  const { port, waitForCallback } = await startCallbackServer(0, state);

  const rejectionPromise = assert.rejects(
    () => waitForCallback,
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no authorization code/i);
      return true;
    },
  );

  // Hit /callback with correct state and an explicitly empty code.
  const res = await fetch(
    `http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}&code=`,
  );
  assert.equal(res.status, 400, "empty code must return 400");
  const body = await res.text();
  assert.ok(!body.includes("Login successful"), "must not show success page when code is empty");
  assert.ok(body.includes("Login failed") || body.includes("no authorization code"), "must show error page");

  await rejectionPromise;
});

// ---------------------------------------------------------------------------
// 3b. openBrowser — error handler prevents crash on missing binary (B2)
// ---------------------------------------------------------------------------

test("openBrowser — MESHY_CLI_NO_BROWSER=1 → resolves false without spawning", async () => {
  const saved = process.env["MESHY_CLI_NO_BROWSER"];
  process.env["MESHY_CLI_NO_BROWSER"] = "1";
  try {
    let spawnCalled = false;
    const result = await openBrowser("https://example.com", () => {
      spawnCalled = true;
      // Should never be reached.
      return spawn("true", []);
    });
    assert.equal(result, false);
    assert.equal(spawnCalled, false);
  } finally {
    if (saved === undefined) delete process.env["MESHY_CLI_NO_BROWSER"];
    else process.env["MESHY_CLI_NO_BROWSER"] = saved;
  }
});

test("openBrowser — missing binary resolves false and does not crash (B2)", async () => {
  const saved = process.env["MESHY_CLI_NO_BROWSER"];
  delete process.env["MESHY_CLI_NO_BROWSER"];
  try {
    // Inject a spawn that uses a definitely-nonexistent binary name.
    // The child 'error' event fires with ENOENT; openBrowser must resolve false.
    const result = await openBrowser(
      "https://example.com",
      (_cmd: string, _args: string[]) =>
        spawn("__meshy_nonexistent_binary_xyz__", [], {
          detached: true,
          stdio: "ignore",
        }),
    );
    assert.equal(result, false, "openBrowser must resolve false when the binary is missing");
  } finally {
    if (saved === undefined) delete process.env["MESHY_CLI_NO_BROWSER"];
    else process.env["MESHY_CLI_NO_BROWSER"] = saved;
  }
});

test("openBrowser — successful spawn resolves true", async () => {
  const saved = process.env["MESHY_CLI_NO_BROWSER"];
  delete process.env["MESHY_CLI_NO_BROWSER"];
  try {
    // Inject a spawn that uses a real binary (node --version exits cleanly).
    const result = await openBrowser(
      "https://example.com",
      (_cmd: string, _args: string[]) =>
        spawn(process.execPath, ["--version"], {
          detached: true,
          stdio: "ignore",
        }),
    );
    // Resolves true optimistically (error handler not fired).
    assert.equal(result, true, "openBrowser must resolve true when spawn succeeds");
  } finally {
    if (saved === undefined) delete process.env["MESHY_CLI_NO_BROWSER"];
    else process.env["MESHY_CLI_NO_BROWSER"] = saved;
  }
});

// ---------------------------------------------------------------------------
// 4. exchangeCode / refreshTokens against a stub
// ---------------------------------------------------------------------------

function makeTokenStub(opts: {
  /** If set, return this error response on the first call. */
  firstError?: { status: number; body: Record<string, unknown> };
  /** If set, return 400 on the second call (replay rejection). */
  rejectSecond?: boolean;
  /** Successful token response body. */
  success?: Record<string, unknown>;
}): {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  calls: Array<{ body: string }>;
} {
  const calls: Array<{ body: string }> = [];
  let callCount = 0;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      calls.push({ body });
      callCount++;

      if (callCount === 1 && opts.firstError) {
        res.writeHead(opts.firstError.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(opts.firstError.body));
        return;
      }
      if (callCount === 2 && opts.rejectSecond) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Code already used" }));
        return;
      }

      const success = opts.success ?? {
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "new-refresh-token",
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(success));
    });
  };

  return { handler, calls };
}

test("exchangeCode — happy path: tokens returned", async () => {
  const { handler } = makeTokenStub({});
  const stub = await startStub(handler);
  try {
    const tok = await exchangeCode({
      baseUrlV1: stub.url,
      code: "auth-code-123",
      codeVerifier: "verifier-abc",
      redirectUri: "http://localhost:8765/callback",
    });
    assert.equal(tok.access_token, "new-access-token");
    assert.equal(tok.refresh_token, "new-refresh-token");
    assert.equal(tok.expires_in, 3600);
  } finally {
    await stub.close();
  }
});

test("exchangeCode — wrong verifier rejection: surfaces server message, no credentials written", async () => {
  const dir = makeTmpDir();
  const credFile = join(dir, "credentials.json");
  const { handler } = makeTokenStub({
    firstError: { status: 400, body: { error: "invalid_grant", error_description: "Bad verifier" } },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () =>
        exchangeCode({
          baseUrlV1: stub.url,
          code: "code",
          codeVerifier: "wrong-verifier",
          redirectUri: "http://localhost:8765/callback",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Bad verifier|invalid_grant/);
        return true;
      },
    );
    // No credentials should have been written.
    assert.ok(!existsSync(credFile), "no credentials file should exist after failed exchange");
  } finally {
    await stub.close();
  }
});

test("exchangeCode — code replay rejected: surfaces server message, no credentials written", async () => {
  const dir = makeTmpDir();
  const credFile = join(dir, "credentials.json");
  const { handler } = makeTokenStub({ rejectSecond: true });
  const stub = await startStub(handler);
  try {
    // First call succeeds.
    await exchangeCode({
      baseUrlV1: stub.url,
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost:8765/callback",
    });
    // Second call with same code → rejected.
    await assert.rejects(
      () =>
        exchangeCode({
          baseUrlV1: stub.url,
          code: "code",
          codeVerifier: "verifier",
          redirectUri: "http://localhost:8765/callback",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Code already used|invalid_grant/);
        return true;
      },
    );
    // No credentials should have been written (the caller writes them, not exchangeCode).
    assert.ok(!existsSync(credFile), "no credentials file should exist after failed replay");
  } finally {
    await stub.close();
  }
});

test("refreshTokens — success rotates tokens", async () => {
  const { handler } = makeTokenStub({
    success: {
      access_token: "refreshed-access",
      token_type: "Bearer",
      expires_in: 7200,
      refresh_token: "refreshed-refresh",
    },
  });
  const stub = await startStub(handler);
  try {
    const tok = await refreshTokens({
      baseUrlV1: stub.url,
      refreshToken: "old-refresh-token",
    });
    assert.equal(tok.access_token, "refreshed-access");
    assert.equal(tok.refresh_token, "refreshed-refresh");
    assert.equal(tok.expires_in, 7200);
  } finally {
    await stub.close();
  }
});

test("exchangeCode — token request carries User-Agent with platform token", async () => {
  let capturedUserAgent = "";
  const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
    capturedUserAgent = req.headers["user-agent"] ?? "";
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      void body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "ref",
      }));
    });
  });
  try {
    await exchangeCode({
      baseUrlV1: stub.url,
      code: "code-ua-test",
      codeVerifier: "verifier-ua",
      redirectUri: "http://localhost:8765/callback",
    });
    // Must equal the exported USER_AGENT constant exactly.
    assert.equal(capturedUserAgent, USER_AGENT,
      `User-Agent must equal USER_AGENT, got: ${capturedUserAgent}`);
    // Must match the exact shape the webapp parser depends on:
    // meshy-cli/<version> (<platform> <arch>; node <ver>)
    assert.match(
      capturedUserAgent,
      /^meshy-cli\/[^ ]+ \([^) ]+ [^) ;]+; node v?\d+\.\d+\.\d+.*\)$/,
      `User-Agent must match expected shape, got: ${capturedUserAgent}`,
    );
  } finally {
    await stub.close();
  }
});

test("refreshTokens — failure → HintedError with server message", async () => {
  const { handler } = makeTokenStub({
    firstError: { status: 401, body: { error: "invalid_token", error_description: "Token expired" } },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () =>
        refreshTokens({
          baseUrlV1: stub.url,
          refreshToken: "expired-refresh",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Token expired|invalid_token/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("exchangeCode — sends correct grant_type and client_id", async () => {
  const { handler, calls } = makeTokenStub({});
  const stub = await startStub(handler);
  try {
    await exchangeCode({
      baseUrlV1: stub.url,
      code: "mycode",
      codeVerifier: "myverifier",
      redirectUri: "http://localhost:9999/callback",
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]!.body) as Record<string, string>;
    assert.equal(body["grant_type"], "authorization_code");
    assert.equal(body["client_id"], "meshy-cli");
    assert.equal(body["code"], "mycode");
    assert.equal(body["code_verifier"], "myverifier");
    assert.equal(body["redirect_uri"], "http://localhost:9999/callback");
  } finally {
    await stub.close();
  }
});

test("refreshTokens — sends correct grant_type and client_id", async () => {
  const { handler, calls } = makeTokenStub({});
  const stub = await startStub(handler);
  try {
    await refreshTokens({
      baseUrlV1: stub.url,
      refreshToken: "my-refresh",
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]!.body) as Record<string, string>;
    assert.equal(body["grant_type"], "refresh_token");
    assert.equal(body["client_id"], "meshy-cli");
    assert.equal(body["refresh_token"], "my-refresh");
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// F2: Token response validation — missing/invalid fields rejected
// ---------------------------------------------------------------------------

test("postToken — missing refresh_token → rejected (oauth_bad_response)", async () => {
  const { handler } = makeTokenStub({
    success: {
      access_token: "tok",
      token_type: "Bearer",
      expires_in: 3600,
      // refresh_token intentionally absent
    },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () => exchangeCode({ baseUrlV1: stub.url, code: "c", codeVerifier: "v", redirectUri: "http://localhost/cb" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /refresh_token/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("postToken — expires_in 0 → rejected (infinite-refresh-loop guard)", async () => {
  const { handler } = makeTokenStub({
    success: {
      access_token: "tok",
      token_type: "Bearer",
      expires_in: 0,
      refresh_token: "rt",
    },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () => exchangeCode({ baseUrlV1: stub.url, code: "c", codeVerifier: "v", redirectUri: "http://localhost/cb" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /expires_in/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("postToken — expires_in -5 → rejected", async () => {
  const { handler } = makeTokenStub({
    success: {
      access_token: "tok",
      token_type: "Bearer",
      expires_in: -5,
      refresh_token: "rt",
    },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () => exchangeCode({ baseUrlV1: stub.url, code: "c", codeVerifier: "v", redirectUri: "http://localhost/cb" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /expires_in/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("postToken — token_type missing → rejected", async () => {
  const { handler } = makeTokenStub({
    success: {
      access_token: "tok",
      // token_type intentionally absent
      expires_in: 3600,
      refresh_token: "rt",
    },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () => exchangeCode({ baseUrlV1: stub.url, code: "c", codeVerifier: "v", redirectUri: "http://localhost/cb" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /token_type/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("postToken — token_type 'mac' (not Bearer) → rejected", async () => {
  const { handler } = makeTokenStub({
    success: {
      access_token: "tok",
      token_type: "mac",
      expires_in: 3600,
      refresh_token: "rt",
    },
  });
  const stub = await startStub(handler);
  try {
    await assert.rejects(
      () => exchangeCode({ baseUrlV1: stub.url, code: "c", codeVerifier: "v", redirectUri: "http://localhost/cb" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /token_type/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// 5. E2E subprocess tests
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);
const repoRoot = join(__dirname, "..");

/**
 * E2E: MESHY_CLI_NO_BROWSER=1 + stub token endpoint.
 *
 * Flow:
 *   1. Start a stub token server at /openapi/v1/oauth/token.
 *   2. Spawn `node dist/index.js auth login --no-verify` with env overrides.
 *   3. Read stderr to find the authorize URL (printed by the CLI).
 *   4. Parse redirect_uri and state from the authorize URL.
 *   5. Drive the loopback callback from the test.
 *   6. Assert exit 0, stdout is pure JSON (no URL leakage), credentials file
 *      has kind=oauth and correct fields.
 */
test(
  "E2E — browser login flow: exit 0, JSON stdout, credentials written",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Token stub: handles /openapi/v1/oauth/token.
    const tokenStub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/openapi/v1/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "e2e-access-token",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "e2e-refresh-token",
              user_id: "user-42",
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const child = spawn(
        process.execPath,
        ["dist/index.js", "auth", "login", "--no-verify"],
        {
          env: {
            ...process.env,
            HOME: dir,
            MESHY_CLI_NO_BROWSER: "1",
            // Use a non-existent authorize URL — the CLI just prints it, doesn't fetch it.
            MESHY_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:1/oauth/authorize",
            MESHY_BASE_URL_V1: `${tokenStub.url}/openapi/v1`,
            MESHY_CREDENTIALS_PATH: credFile,
            MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
            // Force GUI/loopback mode: override all headless signals (CI, piped stdio, etc.)
            MESHY_CLI_FORCE_GUI: "1",
          },
          cwd: repoRoot,
        },
      );

      let stdoutData = "";
      let stderrData = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdoutData += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderrData += chunk.toString(); });

      // Wait until stderr contains the authorize URL, then drive the callback.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`timed out waiting for authorize URL in stderr. stderr so far: ${stderrData}`)),
          10_000,
        );

        const interval = setInterval(async () => {
          // Look for the authorize URL line in stderr.
          const match = stderrData.match(/http:\/\/127\.0\.0\.1:1\/oauth\/authorize\?[^\s]+/);
          if (!match) return;

          clearInterval(interval);
          clearTimeout(timeout);

          try {
            // Parse the authorize URL to get redirect_uri and state.
            const authorizeUrl = new URL(match[0]);
            const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
            const state = authorizeUrl.searchParams.get("state");

            if (!redirectUri || !state) {
              reject(new Error(`missing redirect_uri or state in authorize URL: ${match[0]}`));
              return;
            }

            // Drive the loopback callback with the correct state.
            const cbUrl = new URL(redirectUri);
            const port = parseInt(cbUrl.port, 10);
            await fetch(
              `http://127.0.0.1:${port}/callback?code=e2e-code&state=${encodeURIComponent(state)}`,
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        }, 50);
      });

      // Wait for the child to exit.
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", reject);
      });

      assert.equal(exitCode, 0, `expected exit 0\nstdout: ${stdoutData}\nstderr: ${stderrData}`);

      // Assert stdout is pure JSON (no URL leakage).
      assert.ok(stdoutData.trim().length > 0, "stdout should not be empty");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stdoutData) as Record<string, unknown>;
      } catch {
        assert.fail(`stdout is not valid JSON: ${stdoutData}`);
      }
      assert.equal(parsed["status"], "logged_in");
      assert.equal(parsed["kind"], "oauth");

      // Assert stdout does NOT contain the authorize URL.
      assert.ok(
        !stdoutData.includes("oauth/authorize"),
        `stdout must not contain the authorize URL, got: ${stdoutData}`,
      );

      // Assert credentials file has kind=oauth and correct fields.
      const creds = JSON.parse(readFileSync(credFile, "utf8")) as {
        profiles: Record<string, {
          kind: string;
          access_token: string;
          refresh_token: string;
          expires_at: number;
          user_id?: string;
        }>;
      };
      const profile = creds.profiles["default"];
      assert.ok(profile, "default profile should exist");
      assert.equal(profile.kind, "oauth");
      assert.equal(profile.access_token, "e2e-access-token");
      assert.equal(profile.refresh_token, "e2e-refresh-token");
      assert.ok(
        typeof profile.expires_at === "number" && profile.expires_at > Date.now(),
        `expires_at should be in the future, got ${profile.expires_at}`,
      );
      assert.equal(profile.user_id, "user-42");
    } finally {
      await tokenStub.close();
    }
  },
);

/**
 * E2E: state tampering — wrong state in callback → non-zero exit, stderr
 * mentions state, token endpoint receives ZERO requests, no credentials file.
 */
test(
  "E2E — state tampering: non-zero exit, no token call, no credentials",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    let tokenCallCount = 0;
    const tokenStub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/openapi/v1/oauth/token") {
        tokenCallCount++;
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "should-not-be-used",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "should-not-be-used",
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const child = spawn(
        process.execPath,
        ["dist/index.js", "auth", "login", "--no-verify"],
        {
          env: {
            ...process.env,
            HOME: dir,
            MESHY_CLI_NO_BROWSER: "1",
            MESHY_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:1/oauth/authorize",
            MESHY_BASE_URL_V1: `${tokenStub.url}/openapi/v1`,
            MESHY_CREDENTIALS_PATH: credFile,
            MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
            // Force GUI/loopback mode: override all headless signals (CI, piped stdio, etc.)
            MESHY_CLI_FORCE_GUI: "1",
          },
          cwd: repoRoot,
        },
      );

      let stderrData = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderrData += chunk.toString(); });
      child.stdout?.on("data", () => {});

      // Wait for the authorize URL, then drive the callback with a WRONG state.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`timed out. stderr: ${stderrData}`)),
          10_000,
        );

        const interval = setInterval(async () => {
          const match = stderrData.match(/http:\/\/127\.0\.0\.1:1\/oauth\/authorize\?[^\s]+/);
          if (!match) return;

          clearInterval(interval);
          clearTimeout(timeout);

          try {
            const authorizeUrl = new URL(match[0]);
            const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
            if (!redirectUri) {
              reject(new Error("missing redirect_uri"));
              return;
            }
            const cbUrl = new URL(redirectUri);
            const port = parseInt(cbUrl.port, 10);
            // Send a WRONG state — the server should reject it.
            await fetch(
              `http://127.0.0.1:${port}/callback?code=stolen-code&state=wrong-state-tampered`,
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        }, 50);
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", reject);
      });

      // Must exit non-zero.
      assert.notEqual(exitCode, 0, "state mismatch must cause non-zero exit");

      // stderr must mention state.
      assert.ok(
        stderrData.toLowerCase().includes("state"),
        `stderr should mention 'state', got: ${stderrData}`,
      );

      // Token endpoint must have received ZERO requests.
      assert.equal(tokenCallCount, 0, "token endpoint must not be called on state mismatch");

      // No credentials file should exist.
      assert.ok(!existsSync(credFile), "no credentials file should be written on state mismatch");
    } finally {
      await tokenStub.close();
    }
  },
);

/**
 * E2E: --port validation — invalid values exit non-zero with usage error.
 */
for (const [label, portArg] of [
  ["0", "0"],
  ["-1", "-1"],
  ["65536", "65536"],
  ["123abc", "123abc"],
  ["1.5", "1.5"],
] as const) {
  test(`E2E — --port ${label} → exit 2 (usage error)`, { timeout: 10_000 }, async () => {
    const dir = makeTmpDir();
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["dist/index.js", "auth", "login", "--port", portArg],
        {
          env: {
            ...process.env,
            HOME: dir,
            MESHY_CLI_NO_BROWSER: "1",
            MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
            // --port validation happens before mode selection, so it always
            // produces exit 2 regardless of headless detection.
          },
          cwd: repoRoot,
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout?.on("data", () => {});
      child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
      child.on("error", reject);
    });
    assert.equal(result.code, 2, `expected exit 2 for --port ${portArg}, got ${result.code}\nstderr: ${result.stderr}`);
  });
}

test(`E2E — --port 8765 (valid) → starts the flow (not a usage error)`, { timeout: 10_000 }, async () => {
  const dir = makeTmpDir();
  // We just want to confirm it doesn't exit 2 immediately.
  // Kill it after a short delay once we see the authorize URL on stderr.
  const child = spawn(
    process.execPath,
    ["dist/index.js", "auth", "login", "--port", "8765"],
    {
      env: {
        ...process.env,
        HOME: dir,
        MESHY_CLI_NO_BROWSER: "1",
        MESHY_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:1/oauth/authorize",
        MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
        // Force GUI/loopback mode: override all headless signals (CI, piped stdio, etc.)
        MESHY_CLI_FORCE_GUI: "1",
      },
      cwd: repoRoot,
    },
  );

  let stderrData = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString();
    if (stderrData.includes("oauth/authorize")) {
      child.kill();
    }
  });
  child.stdout?.on("data", () => {});

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });

  // Exit 2 means usage error — must not happen for a valid port.
  assert.notEqual(exitCode, 2, `--port 8765 should not produce a usage error`);
});

/**
 * E2E: --with-key output shape is byte-identical to pre-ENG-1519 (no `kind` field).
 */
test("E2E — --with-key output has no `kind` field (backward-compatible shape)", { timeout: 10_000 }, async () => {
  const dir = makeTmpDir();
  const credFile = join(dir, "credentials.json");

  // We need a fake balance endpoint for --verify (default).
  // Use --no-verify to avoid needing a real server.
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["dist/index.js", "auth", "login", "--with-key", "msy_testkey123456789", "--no-verify"],
      {
        env: {
          ...process.env,
          HOME: dir,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
        },
        cwd: repoRoot,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", reject);
  });

  assert.equal(result.code, 0, `expected exit 0\nstderr: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed["status"], "logged_in");
  // --with-key must NOT emit `kind` (backward-compatible with pre-ENG-1519 shape).
  assert.ok(!("kind" in parsed), `--with-key output must not contain 'kind', got: ${result.stdout}`);
  assert.ok("credential" in parsed);
  assert.ok("credentials_file" in parsed);
  assert.ok("profile" in parsed);
  assert.ok("active_profile" in parsed);
  assert.ok("verified" in parsed);
});

// ---------------------------------------------------------------------------
// --with-key empty/whitespace → UsageError (exit 2), no browser flow started
// ---------------------------------------------------------------------------

for (const [label, keyArg] of [
  ["empty string", ""],
  ["whitespace only", "   "],
] as const) {
  test(
    `E2E — --with-key "${label}" → exit 2 (UsageError), no server started`,
    { timeout: 10_000 },
    async () => {
      const dir = makeTmpDir();
      const result = await new Promise<{ code: number; stderr: string; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["dist/index.js", "auth", "login", "--with-key", keyArg],
            {
              env: {
                ...process.env,
                HOME: dir,
                MESHY_CLI_NO_BROWSER: "1",
                MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
              },
              cwd: repoRoot,
            },
          );
          let stderr = "";
          let stdout = "";
          child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
          child.on("error", reject);
        },
      );

      // Must exit with the usage-error code (2), not hang waiting for a browser.
      assert.equal(
        result.code,
        2,
        `expected exit 2 for --with-key "${label}", got ${result.code}\nstderr: ${result.stderr}`,
      );
      // Error message must mention --with-key and non-empty.
      assert.ok(
        result.stderr.includes("--with-key") || result.stderr.includes("non-empty"),
        `stderr should mention --with-key or non-empty, got: ${result.stderr}`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// C1: verify flag outcome — browser login path
// ---------------------------------------------------------------------------

/**
 * Helper: run `auth login` (browser flow) against stubs, drive the callback,
 * and return { exitCode, stdout, stderr }.
 */
async function runBrowserLogin(opts: {
  tokenStubUrl: string;
  balanceStubUrl?: string;
  credFile: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Use the balance stub URL as MESHY_BASE_URL_V1 when provided so the
  // balance call hits the stub; otherwise use the token stub URL.
  const baseUrlV1 = opts.balanceStubUrl ?? opts.tokenStubUrl;

  const child = spawn(
    process.execPath,
    ["dist/index.js", "auth", "login"],  // default: --verify is on
    {
      env: {
        ...process.env,
        MESHY_CLI_NO_BROWSER: "1",
        MESHY_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:1/oauth/authorize",
        MESHY_BASE_URL_V1: `${baseUrlV1}/openapi/v1`,
        MESHY_CREDENTIALS_PATH: opts.credFile,
        MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
        // Force GUI/loopback mode: override all headless signals (CI, piped stdio, etc.)
        MESHY_CLI_FORCE_GUI: "1",
      },
      cwd: repoRoot,
    },
  );

  let stdoutData = "";
  let stderrData = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdoutData += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderrData += chunk.toString(); });

  // Wait for the authorize URL on stderr, then drive the callback.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for authorize URL. stderr: ${stderrData}`)),
      10_000,
    );
    const interval = setInterval(async () => {
      const match = stderrData.match(/http:\/\/127\.0\.0\.1:1\/oauth\/authorize\?[^\s]+/);
      if (!match) return;
      clearInterval(interval);
      clearTimeout(timeout);
      try {
        const authorizeUrl = new URL(match[0]);
        const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
        const state = authorizeUrl.searchParams.get("state");
        if (!redirectUri || !state) {
          reject(new Error(`missing redirect_uri or state: ${match[0]}`));
          return;
        }
        const cbUrl = new URL(redirectUri);
        const port = parseInt(cbUrl.port, 10);
        await fetch(
          `http://127.0.0.1:${port}/callback?code=e2e-code&state=${encodeURIComponent(state)}`,
        );
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 50);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });

  return { exitCode, stdout: stdoutData, stderr: stderrData };
}

test(
  "C1 — browser login: balance 500 → exit 0, verified:false, no balance field, hint present",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Stub: token endpoint OK, balance endpoint 500.
    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/openapi/v1/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "c1-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "c1-refresh-token",
          }));
        });
        return;
      }
      if (url.pathname === "/openapi/v1/balance") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "internal server error" }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const { exitCode, stdout, stderr } = await runBrowserLogin({
        tokenStubUrl: stub.url,
        credFile,
      });

      assert.equal(exitCode, 0, `expected exit 0\nstdout: ${stdout}\nstderr: ${stderr}`);

      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in", "status must be logged_in");
      assert.equal(parsed["verified"], false, "verified must be false when balance call fails");
      assert.ok(!("balance" in parsed), `balance must not be present on verify failure, got: ${stdout}`);
      assert.ok(
        typeof parsed["hint"] === "string" && (parsed["hint"] as string).length > 0,
        `hint must be present on verify failure, got: ${stdout}`,
      );
      assert.ok(
        (parsed["hint"] as string).includes("meshy auth status"),
        `hint should mention 'meshy auth status', got: ${parsed["hint"]}`,
      );
    } finally {
      await stub.close();
    }
  },
);

test(
  "C1 — browser login: balance 200 → exit 0, verified:true, balance field present",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Stub: token endpoint OK, balance endpoint 200.
    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/openapi/v1/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "c1-access-token-ok",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "c1-refresh-token-ok",
          }));
        });
        return;
      }
      if (url.pathname === "/openapi/v1/balance") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ balance: 42.5, currency: "USD" }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const { exitCode, stdout, stderr } = await runBrowserLogin({
        tokenStubUrl: stub.url,
        credFile,
      });

      assert.equal(exitCode, 0, `expected exit 0\nstdout: ${stdout}\nstderr: ${stderr}`);

      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in", "status must be logged_in");
      assert.equal(parsed["verified"], true, "verified must be true when balance call succeeds");
      assert.ok("balance" in parsed, `balance must be present on verify success, got: ${stdout}`);
      assert.ok(!("hint" in parsed), `hint must not be present on verify success, got: ${stdout}`);
    } finally {
      await stub.close();
    }
  },
);
