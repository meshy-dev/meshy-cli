/**
 * doctor — read-only diagnosis (T-102) and the two opt-in probes (T-103).
 * runDoctor is exercised with injected env / cwd / probe / detector; the
 * command is driven in-process with a loopback mock for --check-api. The
 * default run must never call fetch, the probe or the detector, and no secret
 * value may appear anywhere in the report.
 */

process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshyApiError } from "../src/client/errors.js";
import { TransportError } from "../src/client/transport.js";
import { apiCheckFailure, buildDoctorCommand } from "../src/cmd/doctor.js";
import { resetCommandContextForTests } from "../src/internal/context.js";
import { runDoctor, runDoctorDetailed, type DoctorReport } from "../src/internal/doctor.js";
import { authRequiredError, CliError, UsageError } from "../src/internal/errors.js";
import { mirrorGlobalOptionsToDescendants, registerRootGlobalOptions, walkCommands } from "../src/internal/global-options.js";
import type { V1Envelope } from "../src/internal/result.js";
import type { GlobalFlags } from "../src/internal/runtime.js";
import { VERSION } from "../src/internal/version.js";
import { jsonReply, parseSingleJson, startMockApi } from "./helpers/cli.js";

const FLAG_SECRET = "msy_flag_secret_value_789";
const ENV_SECRET = "msy_env_secret_value_456";
const DOTENV_SECRET = "msy_dotenv_secret_value_123";
const FILE_SECRET = "msy_keyfile_secret_value_321";

function flagsOf(extra: Partial<GlobalFlags> = {}): GlobalFlags {
  return { format: "json", updateCheck: false, verbose: false, ...extra };
}

function tmp(prefix = "meshy-doctor-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A private env for the local checks: nothing from the developer's shell leaks in. */
function isolatedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"], HOME: process.env["HOME"], MESHY_CONFIG_DIR: tmp("meshy-config-"), ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function check(report: DoctorReport, id: string): { id: string; status: string; detail: string } {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `check '${id}' missing; have ${report.checks.map((x) => x.id).join(", ")}`);
  return c;
}

function spy<T>(impl: () => T): (() => T) & { calls: number } {
  const fn = (() => {
    fn.calls += 1;
    return impl();
  }) as (() => T) & { calls: number };
  fn.calls = 0;
  return fn;
}

/** Fail loudly if anything reaches the network while `fn` runs. */
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network touched during a local doctor run");
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** loadConfig reads process.env like every API command; scope the overrides to one test. */
async function withProcessEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

test("T-102 default run: local only — no probe, no detector, no fetch; booleans instead of values; .env named, never read", async () => {
  const cwd = tmp("meshy-cwd-");
  writeFileSync(join(cwd, ".env"), `MESHY_API_KEY=${DOTENV_SECRET}\nNODE_OPTIONS=--require ./evil.js\n`);
  const env = isolatedEnv({ MESHY_API_KEY: ENV_SECRET });
  const probeBalance = spy(() => Promise.resolve(42));
  const detectSlicers = spy(() => ({ platform: "test", slicers: [], unsupported: [] }));

  const report = await withNoNetwork(() =>
    runDoctor({ flags: flagsOf({ apiKey: FLAG_SECRET }), checkApi: false, checkSlicers: false, env, cwd, probeBalance, detectSlicers }),
  );

  assert.equal(probeBalance.calls, 0);
  assert.equal(detectSlicers.calls, 0);
  assert.deepEqual(report.cli, { version: VERSION, node: process.version, platform: process.platform, arch: process.arch });
  assert.equal(report.local_ready, true);
  assert.equal(report.api_ready, null);
  assert.equal(report.api, null);
  assert.equal(report.slicers, null);
  assert.deepEqual(report.credential_sources, {
    flag: true,
    env: true,
    api_key_file: null,
    stored_profile: { path: join(env["MESHY_CONFIG_DIR"]!, "credentials.json"), exists: false },
  });
  assert.deepEqual(report.cwd_env_candidates, [".env"]);
  assert.match(check(report, "cwd_env_files").detail, /\.env found .* not read/);
  assert.deepEqual(report.base_urls, {
    v1: "https://api.meshy.ai/openapi/v1",
    v2: "https://api.meshy.ai/openapi/v2",
    creative_lab: "https://api.meshy.ai/openapi/creative-lab",
    public_web: "https://api.meshy.ai/web/public",
  });
  assert.deepEqual(report.workspace, { path: null, writable: null });
  for (const [id, status] of [["cli", "ok"], ["node", "ok"], ["credentials", "ok"], ["api_key_file", "skipped"], ["workspace", "skipped"], ["api", "skipped"], ["slicers", "skipped"]]) {
    assert.equal(check(report, id!).status, status, id);
  }
  const text = JSON.stringify(report);
  for (const secret of [FLAG_SECRET, ENV_SECRET, DOTENV_SECRET]) {
    assert.ok(!text.includes(secret), `secret ${secret} leaked into the report`);
  }
  assert.ok(!text.includes("evil.js"), "the .env content was read");
});

test("T-102 no credential anywhere: local_ready stays true, credentials check warns, nothing throws", async () => {
  const cwd = tmp("meshy-cwd-");
  const env = isolatedEnv({ MESHY_API_KEY: "" });
  const report = await withNoNetwork(() => runDoctor({ flags: flagsOf(), checkApi: false, checkSlicers: false, env, cwd }));
  assert.equal(report.local_ready, true);
  assert.equal(report.api_ready, null);
  assert.equal(report.credential_sources.env, false, "an empty MESHY_API_KEY means unset");
  assert.equal(report.credential_sources.flag, false);
  assert.equal(check(report, "credentials").status, "warn");
  assert.match(check(report, "credentials").detail, /meshy auth login/);
  assert.deepEqual(report.cwd_env_candidates, []);
  // A placeholder key is also "unset".
  const placeholder = await runDoctor({ flags: flagsOf({ apiKey: "YOUR_MESHY_API_KEY_HERE" }), checkApi: false, checkSlicers: false, env, cwd });
  assert.equal(placeholder.credential_sources.flag, false);
});

test("stored profile: the credentials file is stat'ed, never parsed", async () => {
  const dir = tmp();
  const credFile = join(dir, "credentials.json");
  // Deliberately not JSON: parsing it would throw; doctor must only report existence.
  writeFileSync(credFile, `{ this is not json; token=msy_stored_secret_value_000 `);
  const env = isolatedEnv({ MESHY_CREDENTIALS_PATH: credFile });
  const report = await runDoctor({ flags: flagsOf(), checkApi: false, checkSlicers: false, env, cwd: dir });
  assert.deepEqual(report.credential_sources.stored_profile, { path: credFile, exists: true });
  assert.equal(check(report, "credentials").status, "ok");
  assert.ok(!JSON.stringify(report).includes("msy_stored_secret_value_000"));
  // Non-production v1 base → the dev file is the one that applies.
  const staging = await runDoctor({ flags: flagsOf({ baseUrlV1: "https://staging.example.invalid/openapi/v1/" }), checkApi: false, checkSlicers: false, env: isolatedEnv(), cwd: dir });
  assert.match(staging.credential_sources.stored_profile.path, /credentials\.dev\.json$/);
  assert.equal(staging.credential_sources.stored_profile.exists, false);
});

test("--api-key-file: valid → ok without the value; malformed, missing, keyless → fail checks, never a throw", async () => {
  const cwd = tmp("meshy-cwd-");
  writeFileSync(join(cwd, "good.env"), `# ci key\nexport MESHY_API_KEY="${FILE_SECRET}"\nOTHER=1\n`);
  writeFileSync(join(cwd, "bad.env"), "this line is not an assignment\n");
  writeFileSync(join(cwd, "nokey.env"), "OTHER=1\n");
  writeFileSync(join(cwd, "dup.env"), "MESHY_API_KEY=a1234\nMESHY_API_KEY=b1234\n");
  const env = isolatedEnv();

  const good = await runDoctor({ flags: flagsOf({ envFile: "good.env" }), checkApi: false, checkSlicers: false, env, cwd });
  assert.equal(check(good, "api_key_file").status, "ok");
  assert.match(check(good, "api_key_file").detail, /value not shown/);
  assert.match(check(good, "api_key_file").detail, /1 other key\(s\) ignored: OTHER/);
  assert.equal(good.credential_sources.api_key_file, join(cwd, "good.env"));
  assert.equal(check(good, "credentials").status, "ok");
  assert.ok(!JSON.stringify(good).includes(FILE_SECRET), "the key file value leaked");

  for (const [name, pattern] of [["bad.env", /not a KEY=value assignment/], ["nokey.env", /no usable MESHY_API_KEY/], ["dup.env", /more than once/], ["missing.env", /file not found/]] as const) {
    const report = await runDoctor({ flags: flagsOf({ envFile: name }), checkApi: false, checkSlicers: false, env, cwd });
    assert.equal(check(report, "api_key_file").status, "fail", name);
    assert.match(check(report, "api_key_file").detail, pattern, name);
    assert.equal(report.credential_sources.api_key_file, join(cwd, name), name);
    assert.equal(check(report, "credentials").status, "warn", `${name}: an unusable key file is not a credential source`);
    assert.equal(report.local_ready, true, name);
  }
});

test("workspace: writable directory ok, missing directory warns, a file fails", async () => {
  const cwd = tmp("meshy-cwd-");
  const env = isolatedEnv();
  mkdirSync(join(cwd, "ws"));
  writeFileSync(join(cwd, "afile"), "x");
  const ok = await runDoctor({ flags: flagsOf({ workspace: "ws" }), checkApi: false, checkSlicers: false, env, cwd });
  assert.deepEqual(ok.workspace, { path: join(cwd, "ws"), writable: true });
  assert.equal(check(ok, "workspace").status, "ok");
  const missing = await runDoctor({ flags: flagsOf({ workspace: join(cwd, "later") }), checkApi: false, checkSlicers: false, env, cwd });
  assert.deepEqual(missing.workspace, { path: join(cwd, "later"), writable: null });
  assert.equal(check(missing, "workspace").status, "warn");
  const file = await runDoctor({ flags: flagsOf({ workspace: "afile" }), checkApi: false, checkSlicers: false, env, cwd });
  assert.deepEqual(file.workspace, { path: join(cwd, "afile"), writable: false });
  assert.equal(check(file, "workspace").status, "fail");
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
    mkdirSync(join(cwd, "ro"));
    chmodSync(join(cwd, "ro"), 0o500);
    const ro = await runDoctor({ flags: flagsOf({ workspace: "ro" }), checkApi: false, checkSlicers: false, env, cwd });
    assert.equal(ro.workspace.writable, false);
    assert.equal(check(ro, "workspace").status, "fail");
  }
});

test("base URLs follow flag → env → default, strip trailing slashes and derive Creative Lab only from the standard path", async () => {
  const cwd = tmp("meshy-cwd-");
  const fromEnv = await runDoctor({
    flags: flagsOf(),
    checkApi: false,
    checkSlicers: false,
    env: isolatedEnv({ MESHY_BASE_URL_V1: "https://staging.example.invalid/openapi/v1/", MESHY_BASE_URL_V2: "https://staging.example.invalid/openapi/v2" }),
    cwd,
  });
  assert.deepEqual(fromEnv.base_urls, {
    v1: "https://staging.example.invalid/openapi/v1",
    v2: "https://staging.example.invalid/openapi/v2",
    creative_lab: "https://staging.example.invalid/openapi/creative-lab",
    public_web: "https://staging.example.invalid/web/public",
  });
  assert.equal(check(fromEnv, "base_urls").status, "ok");
  const custom = await runDoctor({
    flags: flagsOf({ baseUrlV1: "https://proxy.example.invalid/meshy" }),
    checkApi: false,
    checkSlicers: false,
    env: isolatedEnv({ MESHY_BASE_URL_V1: "https://ignored.example.invalid/openapi/v1" }),
    cwd,
  });
  assert.equal(custom.base_urls.v1, "https://proxy.example.invalid/meshy", "the flag wins over the env");
  assert.equal(custom.base_urls.creative_lab, null);
  assert.equal(check(custom, "base_urls").status, "warn");
  assert.match(check(custom, "base_urls").detail, /--base-url-creative-lab/);
  const explicit = await runDoctor({
    flags: flagsOf({ baseUrlV1: "https://proxy.example.invalid/meshy", baseUrlCreativeLab: "https://lab.example.invalid/cl/" }),
    checkApi: false,
    checkSlicers: false,
    env: isolatedEnv(),
    cwd,
  });
  assert.equal(explicit.base_urls.creative_lab, "https://lab.example.invalid/cl");
  assert.equal(check(explicit, "base_urls").status, "ok");
});

test("T-103 --check-api: the probe runs exactly once, api_ready true, balance recorded, detector untouched", async () => {
  const cwd = tmp("meshy-cwd-");
  const probeBalance = spy(() => Promise.resolve(42));
  const detectSlicers = spy(() => ({ platform: "test", slicers: [], unsupported: [] }));
  // The flag key resolves through loadConfig without touching process.env or any file.
  const report = await runDoctor({ flags: flagsOf({ apiKey: "msy_fixture_probe_key_555" }), checkApi: true, checkSlicers: false, env: isolatedEnv(), cwd, probeBalance, detectSlicers });
  assert.equal(probeBalance.calls, 1);
  assert.equal(detectSlicers.calls, 0);
  assert.equal(report.api_ready, true);
  assert.deepEqual(report.api, { balance: 42 });
  assert.equal(report.slicers, null);
  assert.equal(check(report, "api").status, "ok");
  assert.match(check(report, "api").detail, /GET .*\/balance succeeded with the flag credential; balance 42/);
  assert.equal(check(report, "slicers").status, "skipped");
  assert.ok(!JSON.stringify(report).includes("msy_fixture_probe_key_555"));
});

test("T-103 --check-api without any credential: api_ready false, fail check, probe never called, report still returned", async () => {
  const dir = tmp();
  const probeBalance = spy(() => Promise.resolve(1));
  await withProcessEnv({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: join(dir, "absent.json"), MESHY_BASE_URL_V1: undefined }, async () => {
    const { report, apiFailure } = await runDoctorDetailed({ flags: flagsOf(), checkApi: true, checkSlicers: false, env: isolatedEnv(), cwd: dir, probeBalance });
    assert.equal(probeBalance.calls, 0);
    assert.equal(report.api_ready, false);
    assert.equal(report.local_ready, true);
    assert.deepEqual(Object.keys(report.api ?? {}), ["error"]);
    assert.equal(check(report, "api").status, "fail");
    assert.match(check(report, "api").detail, /no usable credential/);
    assert.equal(apiFailure?.stage, "credentials");
    // An unusable explicit key file is also "no credential", not a thrown error.
    writeFileSync(join(dir, "bad.env"), "nonsense\n");
    const bad = await runDoctorDetailed({ flags: flagsOf({ envFile: join(dir, "bad.env") }), checkApi: true, checkSlicers: false, env: isolatedEnv(), cwd: dir, probeBalance });
    assert.equal(bad.report.api_ready, false);
    assert.equal(bad.apiFailure?.stage, "credentials");
    assert.equal(check(bad.report, "api_key_file").status, "fail");
    assert.equal(probeBalance.calls, 0);
  });
});

test("T-103 --check-api: a rejected or unreachable balance call is recorded, and the command maps it to exit 3 / 7", async () => {
  const cwd = tmp("meshy-cwd-");
  const rejected = new MeshyApiError({ message: "meshy api 401 on /balance: invalid api key", status: 401, code: "auth", path: "/balance", credentialKind: "api_key" });
  const failing = spy(() => Promise.reject(rejected));
  const { report, apiFailure } = await runDoctorDetailed({ flags: flagsOf({ apiKey: "msy_fixture_probe_key_777" }), checkApi: true, checkSlicers: false, env: isolatedEnv(), cwd, probeBalance: failing });
  assert.equal(failing.calls, 1, "exactly one attempt, no retry");
  assert.equal(report.api_ready, false);
  assert.deepEqual(report.api, { error: "meshy api 401 on /balance: invalid api key" });
  assert.equal(check(report, "api").status, "fail");
  assert.equal(apiFailure?.stage, "balance");

  const auth = apiCheckFailure(apiFailure!, { ...report });
  assert.equal(auth.code, "auth");
  assert.equal(auth.exitCode, 3);
  assert.equal(auth.httpStatus, 401);
  assert.equal((auth.result as unknown as DoctorReport).api_ready, false);
  assert.match(auth.hint ?? "", /Credential rejected/);

  const network = apiCheckFailure(
    { stage: "balance", error: new TransportError({ message: "request to /balance failed: connect ECONNREFUSED", phase: "connect", path: "/balance" }) },
    { ...report },
  );
  assert.equal(network.code, "network");
  assert.equal(network.exitCode, 7);

  const missing = apiCheckFailure({ stage: "credentials", error: authRequiredError() }, { ...report });
  assert.equal(missing.code, "auth");
  assert.equal(missing.exitCode, 3);
  assert.match(missing.hint ?? "", /meshy auth login/);
  const badFile = apiCheckFailure({ stage: "credentials", error: new CliError({ code: "usage", message: "--api-key-file: file not found: x.env" }) }, { ...report });
  assert.equal(badFile.code, "auth", "a credential that cannot be resolved is an auth failure for --check-api");
  assert.equal(badFile.exitCode, 3);

  const server = apiCheckFailure({ stage: "balance", error: new MeshyApiError({ message: "meshy api 500 on /balance: boom", status: 500, code: "server", path: "/balance" }) }, { ...report });
  assert.equal(server.code, "server");
  assert.equal(server.exitCode, 1);
});

test("T-103 --check-slicers: the injected detector runs once with the env; no probe, no network", async () => {
  const cwd = tmp("meshy-cwd-");
  const env = isolatedEnv();
  const detection = {
    platform: "darwin",
    slicers: [{ id: "orca", name: "OrcaSlicer", path: "/Applications/OrcaSlicer.app", multicolor: true, platform: "darwin" }],
    unsupported: [{ id: "ideamaker", name: "ideaMaker", reason: "unsupported_on_platform" }],
  };
  let seenEnv: NodeJS.ProcessEnv | undefined;
  let calls = 0;
  const detectSlicers = (e?: { env?: Record<string, string | undefined> }): unknown => {
    calls += 1;
    seenEnv = e?.env;
    return detection;
  };
  const probeBalance = spy(() => Promise.resolve(1));
  const report = await withNoNetwork(() => runDoctor({ flags: flagsOf(), checkApi: false, checkSlicers: true, env, cwd, detectSlicers, probeBalance }));
  assert.equal(calls, 1);
  assert.equal(seenEnv, env);
  assert.equal(probeBalance.calls, 0);
  assert.equal(report.api_ready, null);
  assert.equal(report.api, null);
  assert.deepEqual(report.slicers, detection);
  assert.equal(check(report, "slicers").status, "ok");
  assert.match(check(report, "slicers").detail, /1 slicer\(s\) detected on darwin: OrcaSlicer/);
  assert.equal(check(report, "api").status, "skipped");

  const broken = await runDoctor({
    flags: flagsOf(),
    checkApi: false,
    checkSlicers: true,
    env,
    cwd,
    detectSlicers: () => {
      throw new Error("registry unreadable");
    },
  });
  assert.equal(check(broken, "slicers").status, "fail");
  assert.deepEqual(broken.slicers, { error: "registry unreadable" });
});

// ---------------------------------------------------------------------------
// The command, in-process
// ---------------------------------------------------------------------------

interface InProcessRun {
  stdout: string;
  error: unknown;
}

function buildTree(cmd: Command): Command {
  const root = new Command("meshy");
  registerRootGlobalOptions(root);
  root.addCommand(cmd);
  mirrorGlobalOptionsToDescendants(root);
  walkCommands(root, (c) => {
    c.exitOverride();
    c.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  });
  return root;
}

async function runDoctorCommand(args: string[]): Promise<InProcessRun> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
    // The node test runner reports to its parent over this same stdout with
    // binary frames; only the CLI's string writes belong to the capture.
    if (typeof chunk !== "string") {
      return (original as (c: string | Uint8Array, e?: unknown, cb?: unknown) => boolean).call(process.stdout, chunk, encodingOrCb, cb);
    }
    chunks.push(chunk);
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : typeof cb === "function" ? cb : undefined;
    if (callback) (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;
  let error: unknown = null;
  try {
    await buildTree(buildDoctorCommand()).parseAsync(["node", "meshy", "doctor", ...args]);
  } catch (err) {
    error = err;
  } finally {
    process.stdout.write = original;
    resetCommandContextForTests();
  }
  return { stdout: chunks.join(""), error };
}

type DoctorResult = DoctorReport & { saved_json: { path: string; bytes: number } | null };

test("T-102 command: the default run emits one ok envelope, exit 0 semantics, and touches no network", async () => {
  const run = await withNoNetwork(() => runDoctorCommand(["--output-schema", "v1"]));
  assert.equal(run.error, null, String(run.error));
  const env = parseSingleJson(run.stdout) as V1Envelope<DoctorResult>;
  assert.deepEqual(Object.keys(env), ["schema_version", "command", "ok", "result", "error", "warnings"]);
  assert.equal(env.command, "doctor");
  assert.equal(env.ok, true);
  assert.equal(env.result!.api_ready, null);
  assert.equal(env.result!.local_ready, true);
  assert.equal(env.result!.saved_json, null);
  assert.equal(env.result!.cli.version, VERSION);
  // Warnings and failed local checks never change the exit: the run still succeeds.
  const missingWs = await withNoNetwork(() => runDoctorCommand(["--workspace", join(tmp(), "nope")]));
  assert.equal(missingWs.error, null);
  assert.equal((parseSingleJson(missingWs.stdout) as V1Envelope<DoctorResult>).ok, true);
});

test("command: --save-json stores the report (not the envelope); legacy schema and -o are usage errors", async () => {
  const dir = tmp();
  const target = join(dir, "doctor.json");
  const run = await runDoctorCommand(["--save-json", target]);
  assert.equal(run.error, null, String(run.error));
  const env = parseSingleJson(run.stdout) as V1Envelope<DoctorResult>;
  assert.equal(env.result!.saved_json?.path, realpathSync(target));
  const saved = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  assert.equal(saved["local_ready"], true);
  assert.ok(!("schema_version" in saved));
  assert.ok(!("saved_json" in saved));
  const legacy = await runDoctorCommand(["--output-schema", "legacy"]);
  assert.ok(legacy.error instanceof UsageError);
  const output = await runDoctorCommand(["-o", "x.json"]);
  assert.ok(output.error instanceof UsageError);
  assert.match((output.error as Error).message, /--save-json/);
});

test("T-103 command --check-api: one GET /balance with the flag key; 401 → exit 3; unreachable → exit 7; no credential → exit 3 and no request", async () => {
  let status = 200;
  const api = await startMockApi((req, res) => {
    if (req.path === "/openapi/v1/balance") return jsonReply(res, status, status === 200 ? { balance: 42 } : { message: "invalid api key" });
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    const common = ["--check-api", "--base-url-v1", `${api.url}/openapi/v1`, "--api-key", "msy_fixture_key_loopback_only"];
    const ok = await runDoctorCommand(common);
    assert.equal(ok.error, null, String(ok.error));
    const env = parseSingleJson(ok.stdout) as V1Envelope<DoctorResult>;
    assert.equal(env.ok, true);
    assert.equal(env.result!.api_ready, true);
    assert.deepEqual(env.result!.api, { balance: 42 });
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0]!.method, "GET");
    assert.equal(api.requests[0]!.path, "/openapi/v1/balance");
    assert.equal(api.requests[0]!.headers["authorization"], "Bearer msy_fixture_key_loopback_only");
    assert.ok(!ok.stdout.includes("msy_fixture_key_loopback_only"));

    status = 401;
    const rejected = await runDoctorCommand(common);
    assert.ok(rejected.error instanceof CliError, String(rejected.error));
    assert.equal(rejected.error.code, "auth");
    assert.equal(rejected.error.exitCode, 3);
    assert.equal((rejected.error.result as unknown as DoctorResult).api_ready, false);
    assert.equal(api.requests.length, 2, "no retry");
    assert.equal(rejected.stdout, "");

    await withProcessEnv({ MESHY_API_KEY: undefined, MESHY_CREDENTIALS_PATH: join(tmp(), "absent.json"), MESHY_BASE_URL_V1: undefined }, async () => {
      const none = await runDoctorCommand(["--check-api"]);
      assert.ok(none.error instanceof CliError, String(none.error));
      assert.equal(none.error.code, "auth");
      assert.equal(none.error.exitCode, 3);
      const result = none.error.result as unknown as DoctorResult;
      assert.equal(result.api_ready, false);
      assert.equal(result.local_ready, true);
      assert.equal(result.checks.find((c) => c.id === "api")?.status, "fail");
    });
    assert.equal(api.requests.length, 2, "no credential → no request");
  } finally {
    await api.close();
  }
  const dead = await startMockApi(() => undefined);
  await dead.close();
  const unreachable = await runDoctorCommand(["--check-api", "--base-url-v1", `${dead.url}/openapi/v1`, "--api-key", "msy_fixture_key_loopback_only"]);
  assert.ok(unreachable.error instanceof CliError, String(unreachable.error));
  assert.equal(unreachable.error.code, "network");
  assert.equal(unreachable.error.exitCode, 7);
  assert.equal((unreachable.error.result as unknown as DoctorResult).api_ready, false);
});
