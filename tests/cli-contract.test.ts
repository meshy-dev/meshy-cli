/**
 * Black-box contract tests for the output schema layer (T-001..T-005, T-010,
 * T-012, T-100, T-102). Every run is a real subprocess against dist/ with an
 * isolated config dir; API calls go to a loopback mock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isolatedEnv,
  jsonReply,
  parseSingleJson,
  runCli,
  startMockApi,
  tmpDir,
} from "./helpers/cli.js";

const SIX = ["schema_version", "command", "ok", "result", "error", "warnings"];

test("--version and --help stay plain text and exit 0", async () => {
  const v = await runCli(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
  const h = await runCli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /USAGE:/);
  const sub = await runCli(["balance", "--help"]);
  assert.equal(sub.code, 0);
  assert.match(sub.stdout, /--save-json/);
});

test("T-005 legacy: unknown option exits 2 with a parseable payload and no API request", async () => {
  const r = await runCli(["balance", "--bogus"]);
  assert.equal(r.code, 2, r.stderr);
  const payload = parseSingleJson(r.stdout) as Record<string, unknown>;
  assert.equal(payload["name"], "UsageError");
  assert.match(String(payload["message"]), /unknown option/);
});

test("T-005 v1: unknown command, missing argument and bad --format are usage errors in the envelope", async () => {
  const unknown = await runCli(["--output-schema", "v1", "no-such-command"]);
  assert.equal(unknown.code, 2, unknown.stderr);
  const env1 = parseSingleJson(unknown.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(env1), SIX);
  assert.equal(env1["ok"], false);
  assert.equal((env1["error"] as Record<string, unknown>)["code"], "usage");

  const missing = await runCli(["text-to-3d", "get", "--output-schema", "v1"]);
  assert.equal(missing.code, 2, missing.stderr);
  const env2 = parseSingleJson(missing.stdout) as Record<string, unknown>;
  assert.equal(env2["command"], "text-to-3d.get");
  assert.equal((env2["error"] as Record<string, unknown>)["code"], "usage");

  const badFormat = await runCli(["--output-schema", "v1", "--format", "yaml", "balance"]);
  assert.equal(badFormat.code, 2, badFormat.stderr);
  const env3 = parseSingleJson(badFormat.stdout) as Record<string, unknown>;
  assert.equal(env3["ok"], false);
});

test("T-002 v1 success: balance emits one six-key envelope; pretty and ndjson share semantics (T-003)", async () => {
  const api = await startMockApi((req, res) => {
    if (req.path === "/openapi/v1/balance") return jsonReply(res, 200, { balance: 42, currency: "credits" });
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const json = await runCli(["balance", "--output-schema", "v1"], { env: api.env() });
    assert.equal(json.code, 0, json.stderr);
    const env = parseSingleJson(json.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(env), SIX);
    assert.equal(env["schema_version"], "meshy.cli/v1");
    assert.equal(env["command"], "balance");
    assert.equal(env["ok"], true);
    assert.deepEqual(env["result"], { balance: 42, saved_json: null });
    assert.equal(env["error"], null);
    assert.deepEqual(env["warnings"], []);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0]!.headers["authorization"], "Bearer msy_fixture_key_loopback_only");

    const nd = await runCli(["--output-schema", "v1", "--format", "ndjson", "balance"], { env: api.env() });
    assert.equal(nd.code, 0);
    assert.equal(nd.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(nd.stdout.trim())["result"], { balance: 42, saved_json: null });

    const pretty = await runCli(["balance", "--format", "pretty", "--output-schema", "v1"], { env: api.env() });
    assert.equal(pretty.code, 0);
    assert.match(pretty.stdout, /^schema_version: meshy\.cli\/v1$/m);
    assert.match(pretty.stdout, /balance: 42/);
  } finally {
    await api.close();
  }
});

test("T-001 legacy: balance output shape is unchanged without --output-schema", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { balance: 7 }));
  try {
    const r = await runCli(["balance"], { env: api.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '{\n  "balance": 7\n}\n');
    const file = join(tmpDir(), "out.json");
    const r2 = await runCli(["balance", "-o", file], { env: api.env() });
    assert.equal(r2.code, 0);
    assert.equal(r2.stdout, "");
    assert.equal(readFileSync(file, "utf8"), '{\n  "balance": 7\n}\n');
  } finally {
    await api.close();
  }
});

test("T-004 global flags resolve identically at root, middle and end", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { balance: 1 }));
  try {
    const a = await runCli(["--output-schema", "v1", "--format", "ndjson", "balance"], { env: api.env() });
    const b = await runCli(["balance", "--output-schema", "v1", "--format", "ndjson"], { env: api.env() });
    const c = await runCli(["--format", "pretty", "balance", "--json", "--output-schema", "v1"], { env: api.env() });
    assert.equal(a.stdout, b.stdout);
    // --json wins over --format pretty.
    assert.equal((parseSingleJson(c.stdout) as Record<string, unknown>)["ok"], true);
  } finally {
    await api.close();
  }
});

test("T-010 v1: --save-json stores the raw body, -o is refused, existing files are never overwritten", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { balance: 3, extra: { nested: true } }));
  try {
    const dir = tmpDir();
    const target = join(dir, "raw.json");
    const ok = await runCli(["balance", "--output-schema", "v1", "--save-json", target], { env: api.env(), cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { balance: 3, extra: { nested: true } });
    const env = parseSingleJson(ok.stdout) as { result: { saved_json: { path: string; bytes: number } } };
    assert.equal(env.result.saved_json.path, realpathSync(target));

    const again = await runCli(["balance", "--output-schema", "v1", "--save-json", target], { env: api.env(), cwd: dir });
    assert.equal(again.code, 11, again.stderr);
    const err = parseSingleJson(again.stdout) as { error: { code: string } };
    assert.equal(err.error.code, "local_io");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { balance: 3, extra: { nested: true } }, "original file untouched");

    const withOutput = await runCli(["balance", "--output-schema", "v1", "-o", join(dir, "x.json")], { env: api.env(), cwd: dir });
    assert.equal(withOutput.code, 2);
    assert.ok(!existsSync(join(dir, "x.json")));
    // -o was rejected before any request.
    assert.equal(api.requests.length, 2);
  } finally {
    await api.close();
  }
});

test("T-011 v1: API failures map to codes/exits and never include the key", async () => {
  const api = await startMockApi((_req, res) => jsonReply(res, 402, { message: "Insufficient credits" }));
  try {
    const r = await runCli(["balance", "--output-schema", "v1"], { env: api.env() });
    assert.equal(r.code, 9, r.stderr);
    const env = parseSingleJson(r.stdout) as { ok: boolean; error: { code: string; http_status: number; recovery: unknown } };
    assert.equal(env.ok, false);
    assert.equal(env.error.code, "credit");
    assert.equal(env.error.http_status, 402);
    assert.ok(!r.stdout.includes("msy_fixture_key_loopback_only"));
    assert.ok(!r.stderr.includes("msy_fixture_key_loopback_only"));
  } finally {
    await api.close();
  }
});

test("--env-file is refused with an explanation (Node.js intercepts it)", async () => {
  const dir = tmpDir();
  const file = join(dir, "k.env");
  writeFileSync(file, "MESHY_API_KEY=msy_x\n");
  const r = await runCli(["balance", "--env-file", file, "--output-schema", "v1"], { cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  const env = parseSingleJson(r.stdout) as { error: { message: string } };
  assert.match(env.error.message, /--api-key-file/);
});

test("T-100 credential priority: flag > env > api-key-file > profile; a broken key file never falls through", async () => {
  const seen: string[] = [];
  const api = await startMockApi((req, res) => {
    seen.push(String(req.headers["authorization"]));
    jsonReply(res, 200, { balance: 1 });
  });
  try {
    const dir = tmpDir();
    const envFile = join(dir, "keys.env");
    writeFileSync(envFile, "MESHY_API_KEY=msy_from_file\n");

    // env-file wins when neither flag nor env var is set.
    const noEnv = await runCli(["balance", "--api-key-file", envFile], { env: api.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(noEnv.code, 0, noEnv.stderr);
    assert.equal(seen.at(-1), "Bearer msy_from_file");

    // env var beats env-file.
    const withEnv = await runCli(["balance", "--api-key-file", envFile], { env: api.env(), cwd: dir });
    assert.equal(withEnv.code, 0, withEnv.stderr);
    assert.equal(seen.at(-1), "Bearer msy_fixture_key_loopback_only");

    // flag beats both.
    const withFlag = await runCli(["balance", "--api-key-file", envFile, "--api-key", "msy_flag"], { env: api.env(), cwd: dir });
    assert.equal(withFlag.code, 0, withFlag.stderr);
    assert.equal(seen.at(-1), "Bearer msy_flag");

    // A malformed explicit file is an error even though the env var could have been used.
    writeFileSync(envFile, "MESHY_API_KEY=$(curl evil)\n");
    const broken = await runCli(["balance", "--api-key-file", envFile, "--output-schema", "v1"], { env: api.env(), cwd: dir });
    assert.equal(broken.code, 3, broken.stderr);
    const before = seen.length;
    // A missing file is a usage error and makes no request.
    const missing = await runCli(["balance", "--api-key-file", join(dir, "absent.env"), "--output-schema", "v1"], { env: api.env(), cwd: dir });
    assert.equal(missing.code, 2, missing.stderr);
    assert.equal(seen.length, before);
    // A file without the key does not fall back to the stored profile.
    writeFileSync(envFile, "OTHER=1\n");
    const keyless = await runCli(["balance", "--api-key-file", envFile, "--output-schema", "v1"], { env: api.env({ MESHY_API_KEY: undefined }), cwd: dir });
    assert.equal(keyless.code, 3, keyless.stderr);
    assert.equal(seen.length, before);
  } finally {
    await api.close();
  }
});

test("T-102 local commands run without a credential, without network and without an update child", async () => {
  // A loopback "npm registry": the detached refresh child would GET it. The
  // isolated config dir has no update cache, so any API command that is
  // allowed to check for updates spawns the child (positive control) while a
  // local command must not.
  let registryHits = 0;
  const registry = await startMockApi((_req, res) => {
    registryHits += 1;
    jsonReply(res, 200, { version: "0.0.1" });
  });
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { balance: 1 }));
  try {
    const env = api.env({
      MESHY_CLI_NO_UPDATE_NOTIFIER: undefined,
      MESHY_CLI_UPDATE_REGISTRY_URL: `${registry.url}/meshy-cli/latest`,
      MESHY_API_KEY: undefined,
    });
    const r = await runCli(["resources"], { env });
    assert.equal(r.code, 0, r.stderr);
    const list = parseSingleJson(r.stdout) as unknown[];
    assert.ok(Array.isArray(list) && list.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(registryHits, 0, "a local command must not spawn the update child");
    assert.ok(!existsSync(join(String(env["MESHY_CONFIG_DIR"]), "update-state.json")));

    // --no-update-check also silences an API command.
    const quiet = await runCli(["balance", "--no-update-check"], { env: { ...env, MESHY_API_KEY: "msy_x" } });
    assert.equal(quiet.code, 0, quiet.stderr);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(registryHits, 0, "--no-update-check must not spawn the update child");

    // Positive control: the same API command without the opt-out does check.
    const loud = await runCli(["balance"], { env: { ...env, MESHY_API_KEY: "msy_x" } });
    assert.equal(loud.code, 0, loud.stderr);
    const deadline = Date.now() + 8000;
    while (registryHits === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(registryHits >= 1, "an API command with a stale cache must refresh it");
  } finally {
    await registry.close();
    await api.close();
  }
});

test("T-012 consecutive runs never reuse a previous key or URL (no runtime cache across processes)", async () => {
  const seenA: string[] = [];
  const seenB: string[] = [];
  const a = await startMockApi((req, res) => { seenA.push(String(req.headers["authorization"])); jsonReply(res, 200, { balance: 1 }); });
  const b = await startMockApi((req, res) => { seenB.push(String(req.headers["authorization"])); jsonReply(res, 200, { balance: 2 }); });
  try {
    const ra = await runCli(["balance"], { env: a.env({ MESHY_API_KEY: "msy_a" }) });
    const rb = await runCli(["balance"], { env: b.env({ MESHY_API_KEY: "msy_b" }) });
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.deepEqual(seenA, ["Bearer msy_a"]);
    assert.deepEqual(seenB, ["Bearer msy_b"]);
  } finally {
    await a.close();
    await b.close();
  }
});
