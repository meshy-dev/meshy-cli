/**
 * Subprocess harness for black-box CLI tests.
 *
 * Every run gets an isolated MESHY_CONFIG_DIR (so no developer credential or
 * update cache leaks in), the update notifier disabled, MESHY_API_KEY cleared
 * unless the test sets it, and a private cwd. Tests inject a loopback API via
 * MESHY_BASE_URL_V1/V2 when they need one.
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIST_ENTRY = join(repoRoot, "dist", "index.js");

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  /** Send SIGINT after this many ms. */
  sigintAfterMs?: number;
  stdin?: string;
}

export function tmpDir(prefix = "meshy-cli-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function isolatedEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const configDir = tmpDir("meshy-config-");
  const env: Record<string, string | undefined> = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    TMPDIR: process.env["TMPDIR"],
    SystemRoot: process.env["SystemRoot"],
    MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
    MESHY_CLI_NO_BROWSER: "1",
    MESHY_CONFIG_DIR: configDir,
    MESHY_API_KEY: undefined,
    MESHY_BASE_URL_V1: undefined,
    MESHY_BASE_URL_V2: undefined,
    MESHY_BASE_URL_CREATIVE_LAB: undefined,
    MESHY_CREDENTIALS_PATH: undefined,
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

export function runCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_ENTRY, ...args], {
      env: opts.env ?? isolatedEnv(),
      cwd: opts.cwd ?? tmpDir("meshy-cwd-"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 20_000);
    let sigint: NodeJS.Timeout | undefined;
    if (opts.sigintAfterMs !== undefined) sigint = setTimeout(() => child.kill("SIGINT"), opts.sigintAfterMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (sigint) clearTimeout(sigint);
      resolve({ code: code ?? -1, signal, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

export type Handler = (req: RecordedRequest, res: ServerResponse, raw: IncomingMessage) => void | Promise<void>;

export interface MockApi {
  url: string;
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
  /** Environment pointing every base URL at this server. */
  env(extra?: Record<string, string | undefined>): Record<string, string | undefined>;
}

/** Loopback HTTP server; handler receives the buffered request. */
export async function startMockApi(handler: Handler): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (raw, res) => {
    let body = "";
    for await (const chunk of raw) body += chunk;
    let json: unknown = undefined;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const rec: RecordedRequest = {
      method: raw.method ?? "GET",
      url: raw.url ?? "/",
      path: (raw.url ?? "/").split("?")[0] ?? "/",
      headers: raw.headers,
      body,
      json,
    };
    requests.push(rec);
    try {
      await handler(rec, res, raw);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(err) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    url: origin,
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    env: (extra = {}) =>
      isolatedEnv({
        MESHY_API_KEY: "msy_fixture_key_loopback_only",
        MESHY_BASE_URL_V1: `${origin}/openapi/v1`,
        MESHY_BASE_URL_V2: `${origin}/openapi/v2`,
        MESHY_POLL_INTERVAL_MS: "20",
        ...extra,
      }),
  };
}

export function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Parse stdout as exactly one JSON document (fails on stray text). */
export function parseSingleJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  assertNoTrailingGarbage(trimmed);
  return JSON.parse(trimmed);
}

function assertNoTrailingGarbage(text: string): void {
  // JSON.parse throws on trailing content; the helper exists to name the failure.
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`stdout is not a single JSON document:\n${text}\n(${(err as Error).message})`);
  }
}

export function parseNdjson(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}
