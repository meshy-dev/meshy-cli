/**
 * Tests for src/internal/runtime.ts — buildRuntime OAuth silent refresh,
 * including the B3 concurrent-rotation read-after-write fix, and the
 * refreshOAuthCredentialIfNeeded helper used by auth status.
 *
 * These tests exercise buildRuntime / auth status directly by manipulating
 * the credentials file and mocking endpoints via stub HTTP servers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);
const repoRoot = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "meshy-runtime-test-"));
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

/** Write a credentials file with an oauth profile. */
function writeOauthCreds(
  credFile: string,
  opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    userId?: string;
  },
): void {
  mkdirSync(join(credFile, ".."), { recursive: true });
  writeFileSync(
    credFile,
    JSON.stringify({
      auth_version: 1,
      active_profile: "default",
      profiles: {
        default: {
          kind: "oauth",
          access_token: opts.accessToken,
          refresh_token: opts.refreshToken,
          expires_at: opts.expiresAt,
          ...(opts.userId ? { user_id: opts.userId } : {}),
          created_at: Date.now() - 1000,
        },
      },
    }),
    { mode: 0o600 },
  );
}

/**
 * Invoke buildRuntime in a subprocess so the module-level `cached` singleton
 * doesn't bleed between tests. We use `node -e` with inline code that imports
 * the compiled dist and writes the result to stdout as JSON.
 */
async function runBuildRuntime(opts: {
  credFile: string;
  baseUrlV1: string;
  expectSuccess: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname: pathDirname } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = pathDirname(__filename);
  const repoRoot = join(__dirname, "..");

  // Inline script: import buildRuntime, call it, print the config.apiKey to stdout.
  const script = `
import { buildRuntime } from "./dist/internal/runtime.js";
(async () => {
  try {
    const rt = await buildRuntime({
      format: "json",
      verbose: false,
    });
    process.stdout.write(JSON.stringify({ ok: true, apiKey: rt.config.apiKey }) + "\\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, message: err.message, code: err.code }) + "\\n");
  }
})();
`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      env: {
        ...process.env,
        // loadConfig prefers MESHY_API_KEY over the credentials file, so a key
        // exported in the developer's shell would bypass the OAuth profile this
        // test writes — the B3 assertions would then fail on their machine only
        // (CI has no key in the environment).
        MESHY_API_KEY: "",
        MESHY_CREDENTIALS_PATH: opts.credFile,
        MESHY_BASE_URL_V1: opts.baseUrlV1,
        MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
      },
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin?.write(script);
    child.stdin?.end();
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// B3: Concurrent rotation — refresh fails but file was rotated by another process
// ---------------------------------------------------------------------------

test(
  "B3 — refresh fails (invalid_grant) but file was concurrently rotated → proceeds with new token",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Write an EXPIRED token so needsRefresh=true.
    const expiredAt = Date.now() - 10_000; // expired 10s ago
    writeOauthCreds(credFile, {
      accessToken: "old-expired-token",
      refreshToken: "old-refresh-token",
      expiresAt: expiredAt,
    });

    // Token stub: returns 400 invalid_grant on the first call (simulating
    // server-side rotation already consumed by another process).
    // But BEFORE the stub responds, we update the credentials file to simulate
    // the concurrent rotation having already written a fresh token.
    const newToken = "concurrently-rotated-token";
    const newExpiresAt = Date.now() + 3_600_000; // 1 hour from now

    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          // Simulate concurrent rotation: write the new token to the file
          // before responding with the error.
          writeOauthCreds(credFile, {
            accessToken: newToken,
            refreshToken: "new-refresh-token",
            expiresAt: newExpiresAt,
          });
          // Return invalid_grant.
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Token already used" }));
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const result = await runBuildRuntime({
        credFile,
        baseUrlV1: stub.url,
        expectSuccess: true,
      });

      const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; apiKey?: string; message?: string };
      assert.equal(
        parsed.ok,
        true,
        `expected success but got error: ${parsed.message}\nstderr: ${result.stderr}`,
      );
      // Should have adopted the concurrently-rotated token.
      assert.equal(
        parsed.apiKey,
        newToken,
        `expected the concurrently-rotated token, got: ${parsed.apiKey}`,
      );
    } finally {
      await stub.close();
    }
  },
);

test(
  "B3 — refresh fails and file unchanged + access expired → authRequiredError with meshy auth login hint",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Write an EXPIRED token.
    const expiredAt = Date.now() - 10_000;
    writeOauthCreds(credFile, {
      accessToken: "expired-token",
      refreshToken: "bad-refresh-token",
      expiresAt: expiredAt,
    });

    // Token stub: always returns 400 invalid_grant, does NOT update the file.
    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Bad refresh token" }));
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const result = await runBuildRuntime({
        credFile,
        baseUrlV1: stub.url,
        expectSuccess: false,
      });

      const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; message?: string; code?: string };
      assert.equal(
        parsed.ok,
        false,
        `expected authRequiredError but got success with apiKey: ${(parsed as Record<string, unknown>)["apiKey"]}`,
      );
      // Must mention "meshy auth login" in the message.
      assert.ok(
        parsed.message?.includes("meshy auth login"),
        `error message should mention 'meshy auth login', got: ${parsed.message}`,
      );
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// auth status: silent OAuth refresh (same helper as buildRuntime)
// ---------------------------------------------------------------------------

test(
  "auth status — expired oauth profile: refreshes, reports verified:true with new token, rotates credentials file",
  { timeout: 20_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Write an EXPIRED oauth token.
    writeOauthCreds(credFile, {
      accessToken: "old-expired-status-token",
      refreshToken: "status-refresh-token",
      expiresAt: Date.now() - 10_000, // expired 10s ago
    });

    // Track which Authorization header the balance endpoint received.
    let balanceAuthHeader = "";

    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Token endpoint: return fresh tokens.
      if (url.pathname === "/openapi/v1/oauth/token") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          void body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "fresh-status-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "fresh-status-refresh",
          }));
        });
        return;
      }

      // Balance endpoint: record the auth header and return a balance.
      if (url.pathname === "/openapi/v1/balance") {
        balanceAuthHeader = req.headers["authorization"] ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ balance: 99.0, currency: "USD" }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    try {
      const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["dist/index.js", "auth", "status"],
            {
              env: {
                ...process.env,
                // loadConfig prefers MESHY_API_KEY over the credentials file,
                // so a key exported in the developer's shell would bypass the
                // OAuth profile this test writes — mirror the runBuildRuntime
                // helper's pattern and clear it explicitly.
                MESHY_API_KEY: "",
                MESHY_CREDENTIALS_PATH: credFile,
                MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
                MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
              },
              cwd: repoRoot,
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
          child.on("error", reject);
        },
      );

      assert.equal(
        result.exitCode,
        0,
        `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

      // Must report authenticated and verified.
      assert.equal(parsed["authenticated"], true, "must be authenticated");
      assert.equal(parsed["verified"], true, "must be verified:true after refresh");

      // Balance endpoint must have received the NEW token, not the old one.
      assert.equal(
        balanceAuthHeader,
        "Bearer fresh-status-token",
        `balance request must carry the refreshed token, got: ${balanceAuthHeader}`,
      );

      // Credentials file must now hold the rotated tokens.
      const creds = JSON.parse(readFileSync(credFile, "utf8")) as {
        profiles: Record<string, {
          access_token: string;
          refresh_token: string;
          expires_at: number;
        }>;
      };
      const profile = creds.profiles["default"];
      assert.ok(profile, "default profile must exist");
      assert.equal(profile.access_token, "fresh-status-token", "credentials file must hold new access_token");
      assert.equal(profile.refresh_token, "fresh-status-refresh", "credentials file must hold new refresh_token");
      assert.ok(
        profile.expires_at > Date.now(),
        `expires_at must be in the future, got ${profile.expires_at}`,
      );
    } finally {
      await stub.close();
    }
  },
);

/** Write a credentials file with a static api_key profile. */
function writeApiKeyCreds(credFile: string, apiKey: string): void {
  mkdirSync(join(credFile, ".."), { recursive: true });
  writeFileSync(
    credFile,
    JSON.stringify({
      auth_version: 1,
      active_profile: "default",
      profiles: {
        default: {
          kind: "api_key",
          api_key: apiKey,
          created_at: Date.now() - 1000,
        },
      },
    }),
    { mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// ENG-1567: revoked session → exit 3 + SESSION_REVOKED_HINT on stderr
// ---------------------------------------------------------------------------

test(
  "revoked session — 401 on API call → exit 3 + 'Session revoked or expired' hint on stderr",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Write a non-expired OAuth profile so no refresh is attempted.
    writeOauthCreds(credFile, {
      accessToken: "valid-looking-token",
      refreshToken: "valid-refresh",
      expiresAt: Date.now() + 3_600_000, // 1 hour from now — no refresh needed
    });

    // Stub: answer 401 on the API path (simulates server-side revocation).
    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
    });

    try {
      const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["dist/index.js", "balance"],
            {
              env: {
                ...process.env,
                MESHY_API_KEY: "",
                MESHY_CREDENTIALS_PATH: credFile,
                MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
                MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
              },
              cwd: repoRoot,
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
          child.on("error", reject);
        },
      );

      assert.equal(
        result.exitCode,
        3,
        `expected exit code 3 (AUTH), got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stderr.includes("hint: Session revoked or expired. Run: meshy auth login"),
        `stderr must contain the revoked-session hint, got:\n${result.stderr}`,
      );
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// ENG-1567: auth status kind-aware hint (Bugbot follow-up)
// ---------------------------------------------------------------------------

/** Spawn `node dist/index.js auth status` with a stub and return exit/stdout/stderr. */
async function runAuthStatus(opts: {
  credFile: string;
  baseUrlV1: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["dist/index.js", "auth", "status"],
      {
        env: {
          ...process.env,
          MESHY_API_KEY: "",
          MESHY_CREDENTIALS_PATH: opts.credFile,
          MESHY_BASE_URL_V1: opts.baseUrlV1,
          MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
        },
        cwd: repoRoot,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on("error", reject);
  });
}

test(
  "auth status — oauth profile, balance 401 → exit 3 + SESSION_REVOKED_HINT in stdout hint",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Non-expired OAuth profile — no refresh attempted.
    writeOauthCreds(credFile, {
      accessToken: "oauth-valid-token",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 3_600_000,
    });

    // Stub: balance returns 401 (server-side revocation).
    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
    });

    try {
      const result = await runAuthStatus({
        credFile,
        baseUrlV1: `${stub.url}/openapi/v1`,
      });

      assert.equal(
        result.exitCode,
        3,
        `expected exit 3, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["verified"], false, "must be verified:false");
      assert.equal(
        parsed["hint"],
        "Session revoked or expired. Run: meshy auth login",
        `oauth 401 must yield SESSION_REVOKED_HINT, got: ${String(parsed["hint"])}`,
      );
    } finally {
      await stub.close();
    }
  },
);

test(
  "auth status — api_key profile, balance 401 → exit 3 + CREDENTIAL_REJECTED_HINT in stdout hint",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Static api_key profile.
    writeApiKeyCreds(credFile, "msy_test_static_key");

    // Stub: balance returns 401 (key revoked).
    const stub = await startStub((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
    });

    try {
      const result = await runAuthStatus({
        credFile,
        baseUrlV1: `${stub.url}/openapi/v1`,
      });

      assert.equal(
        result.exitCode,
        3,
        `expected exit 3, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["verified"], false, "must be verified:false");
      assert.match(
        String(parsed["hint"]),
        /Credential rejected or revoked/,
        `api_key 401 must yield CREDENTIAL_REJECTED_HINT, got: ${String(parsed["hint"])}`,
      );
      assert.ok(
        !String(parsed["hint"]).includes("Session revoked"),
        `api_key 401 must NOT yield SESSION_REVOKED_HINT, got: ${String(parsed["hint"])}`,
      );
    } finally {
      await stub.close();
    }
  },
);
