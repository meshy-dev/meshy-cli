/**
 * Sign-in behaviour that sandboxed agents and host apps depend on: a store
 * this process cannot write never spends its refresh token; a credential a
 * host app hands over (DSH_MESHY_*) is used as-is; `auth status` names the
 * account and, on request, prints the credential; a login asks for the
 * identity scope and keeps the account; a refresh keeps the profile's region
 * and account.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveRegion } from "../src/internal/config.js";
import { saveProfile, type CredentialProfile } from "../src/internal/credentials.js";
import { operationsRoot } from "../src/internal/operation-store.js";
import { jsonReply, parseSingleJson, runCli, startMockApi, tmpDir, type MockApi } from "./helpers/cli.js";
import { openStoredProfile } from "./helpers/credentials.js";

interface Envelope {
  ok: boolean;
  result: Record<string, unknown> | null;
  error: { code: string; message: string; hint?: string } | null;
}
const envelope = (stdout: string): Envelope => parseSingleJson(stdout) as Envelope;

function oauthStore(expiresAt: number, extra: Partial<CredentialProfile> = {}): string {
  const file = join(tmpDir("meshy-host-"), "credentials.v2.json");
  saveProfile(file, "default", {
    kind: "oauth",
    access_token: "msy_at_stored_token",
    refresh_token: "msy_rt_stored_refresh",
    expires_at: expiresAt,
    login_id: "login-1",
    ...extra,
  });
  return file;
}

/** Makes the store unwritable for the probe on every platform: `locks` cannot be created as a directory. */
function blockWrites(file: string): void {
  const locks = join(dirname(file), "locks");
  rmSync(locks, { recursive: true, force: true });
  writeFileSync(locks, "");
}

async function api(): Promise<MockApi> {
  return startMockApi((req, res) => {
    if (req.path.endsWith("/oauth/token")) {
      return jsonReply(res, 200, { access_token: "msy_at_fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "msy_rt_fresh" });
    }
    if (req.path.endsWith("/oauth/device_authorization")) {
      return jsonReply(res, 200, {
        device_code: "dev-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://www.meshy.ai/activate",
        verification_uri_complete: "https://www.meshy.ai/activate?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 0.001,
      });
    }
    if (req.path === "/openapi/oauth/userinfo") {
      return jsonReply(res, 200, { sub: "user-9", name: "Ada Lovelace", email: "ada@example.com" });
    }
    if (req.path.endsWith("/balance")) return jsonReply(res, 200, { balance: 42 });
    return jsonReply(res, 404, { message: "not found" });
  });
}

const tokenRequests = (m: MockApi): number => m.requests.filter((r) => r.path.endsWith("/oauth/token")).length;

test("an expired login in a store this process cannot write is kept, not refreshed", async () => {
  const m = await api();
  try {
    const file = oauthStore(Date.now() - 1_000);
    blockWrites(file);
    const run = await runCli(["balance", "--format", "json"], { env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file }) });
    const out = envelope(run.stdout);
    assert.equal(run.code, 3, run.stderr);
    assert.equal(out.error?.code, "auth");
    assert.match(out.error?.message ?? "", /not writable here, so it was not refreshed; the stored login is kept/);
    assert.equal(tokenRequests(m), 0, "no refresh was attempted");
    assert.equal(openStoredProfile(file).refresh_token, "msy_rt_stored_refresh");
  } finally {
    await m.close();
  }
});

test("a valid token inside the refresh window is used as-is when the store cannot be written", async () => {
  const m = await api();
  try {
    const file = oauthStore(Date.now() + 10 * 60_000);
    blockWrites(file);
    const run = await runCli(["balance", "--format", "json"], { env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file }) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(tokenRequests(m), 0);
    const balance = m.requests.find((r) => r.path.endsWith("/balance"));
    assert.equal(balance?.headers["authorization"], "Bearer msy_at_stored_token");
  } finally {
    await m.close();
  }
});

test("a writable store refreshes 30 minutes ahead and keeps the region and the account", async () => {
  const m = await api();
  try {
    const file = oauthStore(Date.now() + 10 * 60_000, { region: "cn", account: { name: "Ada Lovelace" } });
    const run = await runCli(["balance", "--format", "json"], { env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file }) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(tokenRequests(m), 1);
    const stored = openStoredProfile(file);
    assert.equal(stored.access_token, "msy_at_fresh");
    assert.equal(stored.region, "cn", "a refresh must not move a China-site login to the global site");
    assert.deepEqual(stored.account, { name: "Ada Lovelace" });
    assert.equal(stored.login_id, "login-1");
  } finally {
    await m.close();
  }
});

test("a host credential outranks the stored profile, is never refreshed, and --show-token prints it", async () => {
  const m = await api();
  try {
    const file = oauthStore(Date.now() - 1_000);
    const env = m.env({
      MESHY_API_KEY: undefined,
      MESHY_CREDENTIALS_PATH: file,
      DSH_MESHY_CREDENTIAL: "msy_at_host_token",
      DSH_MESHY_SUBJECT: "user-9",
    });
    const run = await runCli(["auth", "status", "--show-token", "--format", "json"], { env });
    const out = envelope(run.stdout).result!;
    assert.equal(run.code, 0, run.stderr);
    assert.equal(out["source"], "host");
    assert.equal(out["token"], "msy_at_host_token");
    assert.equal(out["subject"], "user-9");
    assert.deepEqual(out["account"], { name: "Ada Lovelace", email: "ada@example.com" });
    assert.equal(tokenRequests(m), 0, "the stored profile is not touched while a host credential is set");

    const plain = envelope((await runCli(["auth", "status", "--format", "json"], { env })).stdout).result!;
    assert.equal("token" in plain, false, "the credential is printed only on request");

    const envKey = envelope((await runCli(["auth", "status", "--offline", "--format", "json"], { env: { ...env, MESHY_API_KEY: "msy_env_key_1234567890" } })).stdout).result!;
    assert.equal(envKey["source"], "env", "an exported MESHY_API_KEY still wins");
  } finally {
    await m.close();
  }
});

test("DSH_MESHY_REGION names the site of a host credential, and only then", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-host-region-"));
  assert.equal(resolveRegion({ MESHY_CONFIG_DIR: dir, DSH_MESHY_CREDENTIAL: "msy_at_x", DSH_MESHY_REGION: "cn" }), "cn");
  assert.equal(resolveRegion({ MESHY_CONFIG_DIR: dir, DSH_MESHY_REGION: "cn" }), "global");
  assert.equal(resolveRegion({ MESHY_CONFIG_DIR: dir, MESHY_REGION: "global", DSH_MESHY_CREDENTIAL: "msy_at_x", DSH_MESHY_REGION: "cn" }), "global");
});

test("auth status --offline shows the stored account; online it asks the API", async () => {
  const m = await api();
  try {
    const file = oauthStore(Date.now() + 3_600_000, { account: { name: "Stored Name" } });
    const env = m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file });
    const offline = envelope((await runCli(["auth", "status", "--offline", "--format", "json"], { env })).stdout).result!;
    assert.deepEqual(offline["account"], { name: "Stored Name" });
    assert.equal(typeof offline["expires_at"], "number");
    assert.equal(m.requests.some((r) => r.path.endsWith("/userinfo")), false);
    const online = envelope((await runCli(["auth", "status", "--format", "json"], { env })).stdout).result!;
    assert.deepEqual(online["account"], { name: "Ada Lovelace", email: "ada@example.com" });
  } finally {
    await m.close();
  }
});

test("a login asks for the identity scope and keeps the account it reports", async () => {
  const m = await api();
  try {
    const file = join(tmpDir("meshy-host-login-"), "credentials.v2.json");
    const run = await runCli(["auth", "login", "--device", "--no-verify", "--format", "json"], {
      env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file }),
    });
    assert.equal(run.code, 0, run.stderr);
    const started = m.requests.find((r) => r.path.endsWith("/oauth/device_authorization"));
    assert.equal((started?.json as { scope?: string }).scope, "openid profile email");
    assert.deepEqual(envelope(run.stdout).result!["account"], { name: "Ada Lovelace", email: "ada@example.com" });
    assert.deepEqual(openStoredProfile(file).account, { name: "Ada Lovelace", email: "ada@example.com" });
  } finally {
    await m.close();
  }
});

test("operationsRoot follows DSH_MESHY_STATE_DIR", () => {
  assert.equal(operationsRoot({ MESHY_CONFIG_DIR: "/cfg" }), join("/cfg", "operations"));
  assert.equal(operationsRoot({ MESHY_CONFIG_DIR: "/cfg", DSH_MESHY_STATE_DIR: "/ws/.meshy" }), join("/ws/.meshy", "operations"));
});

// ---------------------------------------------------------------------------
// One process's refresh must not break the others: the API ends the previous
// access token the moment it issues a new one.
// ---------------------------------------------------------------------------

const authOf = (r: { headers: Record<string, string | string[] | undefined> }): unknown => r.headers["authorization"];

test("processes that need a refresh at the same time refresh once and all use the new token", async () => {
  let refreshes = 0;
  const m = await startMockApi(async (req, res) => {
    if (req.path.endsWith("/oauth/token")) {
      refreshes++;
      await new Promise((r) => setTimeout(r, 500));
      return jsonReply(res, 200, { access_token: "msy_at_fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "msy_rt_fresh" });
    }
    if (req.path.endsWith("/balance")) return jsonReply(res, 200, { balance: 42 });
    return jsonReply(res, 404, {});
  });
  try {
    const file = oauthStore(Date.now() + 10 * 60_000);
    const env = m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file });
    const runs = await Promise.all([1, 2, 3].map(() => runCli(["balance", "--format", "json"], { env })));
    for (const run of runs) assert.equal(run.code, 0, run.stderr);
    assert.equal(refreshes, 1, "the refresh token is spent once");
    assert.deepEqual(m.requests.filter((r) => r.path.endsWith("/balance")).map(authOf), Array(3).fill("Bearer msy_at_fresh"));
    assert.equal(openStoredProfile(file).refresh_token, "msy_rt_fresh");
  } finally {
    await m.close();
  }
});

test("Ctrl-C twice during a refresh still saves the new tokens before exiting", { skip: process.platform === "win32" && "no POSIX signals" }, async () => {
  let child: import("node:child_process").ChildProcess | undefined;
  const m = await startMockApi(async (req, res) => {
    if (req.path.endsWith("/oauth/token")) {
      // The second Ctrl-C forces an exit; it must wait for the save.
      child?.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 100));
      child?.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 300));
      return jsonReply(res, 200, { access_token: "msy_at_fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "msy_rt_fresh" });
    }
    return jsonReply(res, 200, { balance: 42 });
  });
  try {
    const file = oauthStore(Date.now() - 1_000);
    const run = await runCli(["balance", "--format", "json"], {
      env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file }),
      onSpawn: (c) => { child = c; },
    });
    assert.equal(run.code, 130, "the forced exit happens once the save is done");
    assert.equal(openStoredProfile(file).refresh_token, "msy_rt_fresh", "the rotated refresh token was not lost");
    assert.equal(m.requests.some((r) => r.path.endsWith("/balance")), false, "nothing runs after the forced exit");
  } finally {
    await m.close();
  }
});

function rejectingApi(valid: string, onFirstRejection?: () => void): Promise<MockApi> {
  let rejected = false;
  return startMockApi((req, res) => {
    if (!req.path.endsWith("/balance")) return jsonReply(res, 404, {});
    if (authOf(req) === `Bearer ${valid}`) return jsonReply(res, 200, { balance: 42 });
    if (!rejected) onFirstRejection?.();
    rejected = true;
    return jsonReply(res, 401, { message: "Invalid access token" });
  });
}

test("a host credential another process replaced is retried once with the stored token of the same login", async () => {
  const m = await rejectingApi("msy_at_stored_token");
  try {
    const file = oauthStore(Date.now() + 3_600_000);
    const run = await runCli(["balance", "--format", "json"], {
      env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file, DSH_MESHY_CREDENTIAL: "msy_at_replaced", DSH_MESHY_SUBJECT: "login-1" }),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(m.requests.map(authOf), ["Bearer msy_at_replaced", "Bearer msy_at_stored_token"]);
  } finally {
    await m.close();
  }
});

test("a 401 is not retried with another account's stored token", async () => {
  const m = await rejectingApi("msy_at_stored_token");
  try {
    const file = oauthStore(Date.now() + 3_600_000);
    const run = await runCli(["balance", "--format", "json"], {
      env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file, DSH_MESHY_CREDENTIAL: "msy_at_replaced", DSH_MESHY_SUBJECT: "someone-else" }),
    });
    assert.equal(run.code, 3);
    assert.equal(m.requests.length, 1);
  } finally {
    await m.close();
  }
});

test("a running command whose token another process refreshed carries on with the new one", async () => {
  const file = oauthStore(Date.now() + 3_600_000);
  // The first request finds its token replaced in the store, as after another process's refresh.
  const m = await rejectingApi("msy_at_rotated", () =>
    saveProfile(file, "default", { kind: "oauth", access_token: "msy_at_rotated", refresh_token: "msy_rt_rotated", expires_at: Date.now() + 3_600_000, login_id: "login-1" }),
  );
  try {
    const run = await runCli(["balance", "--format", "json"], { env: m.env({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: file }) });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(m.requests.map(authOf), ["Bearer msy_at_stored_token", "Bearer msy_at_rotated"]);
  } finally {
    await m.close();
  }
});
