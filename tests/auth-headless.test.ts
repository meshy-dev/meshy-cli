/**
 * E2E tests for the new headless login modes:
 *   - device flow (pending→approved)
 *   - slow_down path
 *   - expired_token path
 *   - access_denied path
 *   - manual flow (OOB redirect_uri, code piped via stdin)
 *   - --no-wait stage 1 (emits JSON shape, writes cache)
 *   - --device-flow stage 2 (resumes from cache, completes)
 *   - cache-miss --device-code degraded path
 *   - 404 → loopback fallback (GUI) and 404 → error (headless)
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);
const repoRoot = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "meshy-auth-headless-test-"));
}

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

const GOOD_TOKEN_RESPONSE = {
  access_token: "e2e-device-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "e2e-device-refresh-token",
  user_id: "user-device-42",
};

const GOOD_DEVICE_AUTH_RESPONSE = {
  device_code: "e2e-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://www.meshy.ai/activate",
  verification_uri_complete: "https://www.meshy.ai/activate?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 0, // will be clamped to 5 in the server, but we use 0.001 in tests
};

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], {
      env: { ...process.env, MESHY_CLI_NO_UPDATE_NOTIFIER: "1", ...env },
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }

    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Device flow: pending → pending → approved → success
// ---------------------------------------------------------------------------

test(
  "E2E device — pending→pending→approved: exit 0, JSON stdout, credentials written",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    let callCount = 0;
    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          callCount++;
          if (callCount < 3) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "authorization_pending" }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          }
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
        },
      );

      assert.equal(result.exitCode, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in");
      assert.equal(parsed["kind"], "oauth");

      // Credentials file should exist with oauth kind.
      assert.ok(existsSync(credFile), "credentials file should exist");
      const creds = JSON.parse(readFileSync(credFile, "utf8")) as {
        profiles: Record<string, { kind: string; access_token: string }>;
      };
      assert.equal(creds.profiles["default"]?.kind, "oauth");
      assert.equal(creds.profiles["default"]?.access_token, "e2e-device-access-token");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Device flow: slow_down path
// ---------------------------------------------------------------------------

test(
  "E2E device — slow_down path: eventually succeeds",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    let callCount = 0;
    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          callCount++;
          if (callCount === 1) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "slow_down" }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          }
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
        },
      );

      assert.equal(result.exitCode, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Device flow: expired_token path
// ---------------------------------------------------------------------------

test(
  "E2E device — expired_token: non-zero exit, stderr mentions timeout",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "expired_token" }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
        },
      );

      assert.notEqual(result.exitCode, 0, "expected non-zero exit on expired_token");
      assert.ok(
        result.stderr.toLowerCase().includes("expir") || result.stderr.toLowerCase().includes("timeout"),
        `stderr should mention expiry/timeout, got: ${result.stderr}`,
      );
      assert.ok(!existsSync(credFile), "no credentials file should be written on expired_token");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Device flow: access_denied path
// ---------------------------------------------------------------------------

test(
  "E2E device — access_denied: non-zero exit, stderr mentions denied",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "access_denied", error_description: "User denied access" }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
        },
      );

      assert.notEqual(result.exitCode, 0, "expected non-zero exit on access_denied");
      assert.ok(
        result.stderr.toLowerCase().includes("denied"),
        `stderr should mention denied, got: ${result.stderr}`,
      );
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Manual flow: authorize URL printed to stderr with OOB redirect_uri, code piped via stdin
// ---------------------------------------------------------------------------

test(
  "E2E manual — authorize URL printed to stderr with OOB redirect_uri, code piped via stdin, exchange called",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    let capturedBody = "";
    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        capturedBody = body;
        if (url.pathname.endsWith("/token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--manual", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_OAUTH_AUTHORIZE_URL: `${stub.url}/oauth/authorize`,
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
        },
        "manual-auth-code-123\n", // pipe the code via stdin
      );

      assert.equal(result.exitCode, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

      // stderr should contain the authorize URL with OOB redirect_uri
      // (may be percent-encoded in the URL).
      assert.ok(
        result.stderr.includes("urn:ietf:wg:oauth:2.0:oob") ||
          result.stderr.includes("urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob"),
        `stderr should contain OOB redirect_uri, got: ${result.stderr}`,
      );

      // Token exchange should have been called with OOB redirect_uri.
      const exchangeBody = JSON.parse(capturedBody) as Record<string, unknown>;
      assert.equal(exchangeBody["redirect_uri"], "urn:ietf:wg:oauth:2.0:oob");
      assert.equal(exchangeBody["grant_type"], "authorization_code");
      assert.equal(exchangeBody["code"], "manual-auth-code-123");

      // Credentials should be written.
      assert.ok(existsSync(credFile), "credentials file should exist");
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// --no-wait stage 1: emits exact JSON shape and writes cache
// ---------------------------------------------------------------------------

test(
  "E2E --no-wait — emits device_flow_started JSON and writes device-flows.json",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");
    const flowsFile = join(dir, "device-flows.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(GOOD_DEVICE_AUTH_RESPONSE));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--no-wait"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      assert.equal(result.exitCode, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

      // stdout should be the device_flow_started JSON.
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "device_flow_started");
      assert.ok(typeof parsed["flow_id"] === "string" && (parsed["flow_id"] as string).length > 0);
      assert.ok(typeof parsed["user_code"] === "string");
      assert.ok(typeof parsed["device_code"] === "string");
      assert.ok(typeof parsed["verification_url"] === "string");
      assert.ok(typeof parsed["expires_in"] === "number");
      assert.ok(typeof parsed["interval"] === "number");
      assert.ok(typeof parsed["poll_command"] === "string");
      assert.ok(
        (parsed["poll_command"] as string).includes(parsed["flow_id"] as string),
        "poll_command should include the flow_id",
      );

      // No credentials file should be written (no polling happened).
      assert.ok(!existsSync(credFile), "no credentials file should be written by --no-wait");

      // device-flows.json should exist with the flow entry.
      assert.ok(existsSync(flowsFile), "device-flows.json should be written");
      const flows = JSON.parse(readFileSync(flowsFile, "utf8")) as {
        flows: Record<string, { flow_id: string; device_code: string }>;
      };
      const flowId = parsed["flow_id"] as string;
      assert.ok(flows.flows[flowId], "flow entry should be in device-flows.json");
      assert.equal(flows.flows[flowId]!.device_code, GOOD_DEVICE_AUTH_RESPONSE.device_code);
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// --device-flow stage 2: resumes from cache and completes
// ---------------------------------------------------------------------------

test(
  "E2E --device-flow — resumes from cache and completes login",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");
    const flowsFile = join(dir, "device-flows.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      // Stage 1: --no-wait to get the flow_id.
      const stage1 = await runCli(
        ["auth", "login", "--no-wait"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      assert.equal(stage1.exitCode, 0, `stage 1 failed\nstdout: ${stage1.stdout}\nstderr: ${stage1.stderr}`);
      const stage1Parsed = JSON.parse(stage1.stdout) as Record<string, unknown>;
      const flowId = stage1Parsed["flow_id"] as string;
      assert.ok(flowId, "flow_id should be present");

      // Stage 2: --device-flow <id> to resume.
      const stage2 = await runCli(
        ["auth", "login", "--device-flow", flowId, "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      assert.equal(stage2.exitCode, 0, `stage 2 failed\nstdout: ${stage2.stdout}\nstderr: ${stage2.stderr}`);
      const stage2Parsed = JSON.parse(stage2.stdout) as Record<string, unknown>;
      assert.equal(stage2Parsed["status"], "logged_in");

      // Credentials should be written.
      assert.ok(existsSync(credFile), "credentials file should exist after stage 2");

      // The flow entry should be deleted from device-flows.json.
      if (existsSync(flowsFile)) {
        const flows = JSON.parse(readFileSync(flowsFile, "utf8")) as {
          flows: Record<string, unknown>;
        };
        assert.ok(!flows.flows[flowId], "flow entry should be deleted after resume");
      }
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Cache-miss --device-code degraded path
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// --device-flow cache-miss → clear UsageError (exit 2)
// ---------------------------------------------------------------------------

test(
  "E2E --device-flow cache-miss — exits with UsageError, mentions flow id",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const result = await runCli(
      ["auth", "login", "--device-flow", "nonexistent-flow-id-xyz", "--no-verify"],
      {
        HOME: dir,
        MESHY_CLI_NO_BROWSER: "1",
        MESHY_BASE_URL_V1: "http://127.0.0.1:1/openapi/v1",
        MESHY_CREDENTIALS_PATH: credFile,
        MESHY_CONFIG_DIR: dir,
      },
    );

    // Must exit with usage-error code (2).
    assert.equal(result.exitCode, 2, `expected exit 2, got ${result.exitCode}\nstderr: ${result.stderr}`);

    // stderr must mention the flow id and that it may have expired.
    assert.ok(
      result.stderr.includes("nonexistent-flow-id-xyz"),
      `stderr should mention the flow id, got: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.toLowerCase().includes("expir") || result.stderr.toLowerCase().includes("consumed"),
      `stderr should mention expiry/consumed, got: ${result.stderr}`,
    );

    // No credentials should be written.
    assert.ok(!existsSync(credFile), "no credentials file should be written on cache miss");
  },
);

test(
  "E2E --device-code cache-miss — degraded path: polls with defaults, completes",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device-code", "some-device-code", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      assert.equal(result.exitCode, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

      // stderr should mention cache miss.
      assert.ok(
        result.stderr.toLowerCase().includes("no cached flow"),
        `stderr should mention cache miss, got: ${result.stderr}`,
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// 404 → loopback fallback (GUI environment)
// ---------------------------------------------------------------------------

test(
  "E2E device 404 → loopback fallback (GUI): falls back to browser flow",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          // 404 — device flow not supported.
          res.writeHead(404);
          res.end("not found");
          return;
        }
        if (url.pathname.endsWith("/token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      // Spawn the CLI with --device but NOT MESHY_CLI_NO_BROWSER (so it's "GUI").
      // We need to drive the loopback callback manually.
      // Also unset headless signals so the CLI thinks it's in a GUI environment.
      const child = spawn(
        process.execPath,
        ["dist/index.js", "auth", "login", "--device", "--no-verify"],
        {
          env: {
            ...process.env,
            HOME: dir,
            // NOT setting MESHY_CLI_NO_BROWSER — simulates GUI environment.
            MESHY_OAUTH_AUTHORIZE_URL: `${stub.url}/oauth/authorize`,
            MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
            MESHY_CREDENTIALS_PATH: credFile,
            MESHY_CONFIG_DIR: dir,
            MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
            // Force GUI mode: override all headless signals (CI, piped stdio, etc.)
            // so the CLI falls back to loopback when device flow returns 404.
            MESHY_CLI_FORCE_GUI: "1",
            // Suppress browser open (we drive the callback manually).
            MESHY_CLI_NO_BROWSER: "1",
          },
          cwd: repoRoot,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      // Wait for the authorize URL on stderr (loopback fallback), then drive the callback.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`timed out waiting for authorize URL. stderr: ${stderr}`)),
          15_000,
        );

        const interval = setInterval(async () => {
          // Look for the authorize URL in stderr.
          const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/);
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
              `http://127.0.0.1:${port}/callback?code=fallback-code&state=${encodeURIComponent(state)}`,
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

      assert.equal(exitCode, 0, `expected exit 0\nstdout: ${stdout}\nstderr: ${stderr}`);

      // stderr should mention the fallback.
      assert.ok(
        stderr.toLowerCase().includes("fallback") || stderr.toLowerCase().includes("browser"),
        `stderr should mention fallback/browser, got: ${stderr}`,
      );

      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// 404 → error (headless environment)
// ---------------------------------------------------------------------------

test(
  "E2E device 404 → error (headless): non-zero exit, stderr mentions device flow not supported",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1", // headless
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      assert.notEqual(result.exitCode, 0, "expected non-zero exit when device flow not supported in headless");
      assert.ok(
        result.stderr.toLowerCase().includes("device") ||
          result.stderr.toLowerCase().includes("not support"),
        `stderr should mention device flow not supported, got: ${result.stderr}`,
      );
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Headless auto-detection: CI env → device mode notice on stderr
// ---------------------------------------------------------------------------

test(
  "E2E headless auto-detect — CI=1 selects device mode, prints notice to stderr",
  { timeout: 30_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(GOOD_TOKEN_RESPONSE));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--no-verify"],
        {
          HOME: dir,
          CI: "1",
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      assert.equal(result.exitCode, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

      // stderr should mention headless detection.
      assert.ok(
        result.stderr.toLowerCase().includes("headless"),
        `stderr should mention headless detection, got: ${result.stderr}`,
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(parsed["status"], "logged_in");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Fix 1: promptForCode — EOF on stdin before any line → UsageError (exit 2)
// ---------------------------------------------------------------------------

test(
  "E2E manual — EOF on stdin (empty pipe) → exit 2, stderr mentions no code",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    // Pass empty stdin so the pipe closes immediately (EOF).
    // The CLI should fail before reaching the token endpoint.
    const result = await runCli(
      ["auth", "login", "--manual", "--no-verify"],
      {
        HOME: dir,
        MESHY_CLI_NO_BROWSER: "1",
        MESHY_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:1/oauth/authorize",
        MESHY_BASE_URL_V1: "http://127.0.0.1:1/openapi/v1",
        MESHY_CREDENTIALS_PATH: credFile,
        MESHY_CONFIG_DIR: dir,
      },
      "", // empty stdin → immediate EOF
    );

    // Must exit with usage-error code (2), not hang.
    assert.equal(result.exitCode, 2, `expected exit 2 on EOF, got ${result.exitCode}\nstderr: ${result.stderr}`);

    // stderr must mention the problem.
    assert.ok(
      result.stderr.toLowerCase().includes("no authorization code") ||
        result.stderr.toLowerCase().includes("eof") ||
        result.stderr.toLowerCase().includes("stdin"),
      `stderr should mention missing code/EOF/stdin, got: ${result.stderr}`,
    );

    // No credentials should be written.
    assert.ok(!existsSync(credFile), "no credentials file should be written on EOF");
  },
);

// ---------------------------------------------------------------------------
// Fix 2: oauth_timeout → exit 8 (TIMED_OUT) on device expired_token
// ---------------------------------------------------------------------------

test(
  "E2E device expired_token — exit code is 8 (TIMED_OUT)",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        void body;
        if (url.pathname.endsWith("/device_authorization")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...GOOD_DEVICE_AUTH_RESPONSE, interval: 0.001 }));
          return;
        }
        if (url.pathname.endsWith("/token")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "expired_token" }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });

    try {
      const result = await runCli(
        ["auth", "login", "--device", "--no-verify"],
        {
          HOME: dir,
          MESHY_CLI_NO_BROWSER: "1",
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
        },
      );

      // Must exit 8 (TIMED_OUT), not 1 (GENERIC).
      assert.equal(result.exitCode, 8, `expected exit 8 (TIMED_OUT), got ${result.exitCode}\nstderr: ${result.stderr}`);
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Fix 3: --json --format pretty on error path → JSON on stdout
// ---------------------------------------------------------------------------

test(
  "E2E --json --format pretty on error path → JSON emitted on stdout",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();

    // Trigger a predictable error: --with-key with an empty key → UsageError.
    const result = await runCli(
      ["auth", "login", "--with-key", "", "--json", "--format", "pretty"],
      {
        HOME: dir,
        MESHY_CLI_NO_BROWSER: "1",
      },
    );

    // Must exit non-zero (UsageError → exit 2).
    assert.equal(result.exitCode, 2, `expected exit 2, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

    // stdout must be valid JSON (--json wins over --format pretty).
    assert.ok(result.stdout.trim().length > 0, "stdout should not be empty");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`stdout must be valid JSON when --json is set, got: ${result.stdout}`);
    }
    assert.ok(typeof parsed["message"] === "string", "error payload must have a message field");
  },
);

// ---------------------------------------------------------------------------
// Fix 4: --no-wait + device 404 → hard error even on GUI (no loopback fallback)
// ---------------------------------------------------------------------------

test(
  "E2E --no-wait device 404 → hard error even on GUI: no blocking loopback fallback",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();
    const credFile = join(dir, "credentials.json");

    const stub = await startStub((req, res) => {
      res.writeHead(404);
      res.end("not found");
    });

    try {
      const result = await runCli(
        ["auth", "login", "--no-wait"],
        {
          HOME: dir,
          MESHY_BASE_URL_V1: `${stub.url}/openapi/v1`,
          MESHY_CREDENTIALS_PATH: credFile,
          MESHY_CONFIG_DIR: dir,
          MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
          // Force GUI mode: the fallback this test guards against only exists
          // on GUI hosts — a GUI fallback to the blocking loopback flow would
          // hang the agent harness that --no-wait is built for.
          MESHY_CLI_FORCE_GUI: "1",
          MESHY_CLI_NO_BROWSER: "1",
        },
      );

      // Must fail fast with the unsupported error, not fall back to loopback.
      assert.notEqual(result.exitCode, 0, `expected non-zero exit, got ${result.exitCode}\nstdout: ${result.stdout}`);
      assert.ok(
        result.stderr.includes("does not support device login"),
        `stderr should mention device login unsupported, got: ${result.stderr}`,
      );
      assert.ok(
        !result.stderr.includes("falling back to browser login"),
        `--no-wait must not fall back to the blocking loopback flow, got: ${result.stderr}`,
      );
      // No device flow should have been cached, no credentials written.
      assert.ok(!existsSync(credFile), "no credentials file should be written");
    } finally {
      await stub.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Fix 5: root-level --format pretty + subcommand-level --json on error path
// → JSON on stdout
// ---------------------------------------------------------------------------

test(
  "E2E root --format pretty + subcommand --json on error path → JSON emitted",
  { timeout: 15_000 },
  async () => {
    const dir = makeTmpDir();

    // --format pretty at ROOT, --json after the SUBCOMMAND: root program.opts()
    // alone cannot see the --json, so this guards the command-tree scan.
    const result = await runCli(
      ["--format", "pretty", "auth", "login", "--with-key", "", "--json"],
      {
        HOME: dir,
        MESHY_CLI_NO_BROWSER: "1",
      },
    );

    // Must exit non-zero (UsageError → exit 2).
    assert.equal(result.exitCode, 2, `expected exit 2, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

    // stdout must be valid JSON (--json at any level wins over --format pretty).
    assert.ok(result.stdout.trim().length > 0, "stdout should not be empty");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`stdout must be valid JSON when --json is set, got: ${result.stdout}`);
    }
    assert.ok(typeof parsed["message"] === "string", "error payload must have a message field");
  },
);
