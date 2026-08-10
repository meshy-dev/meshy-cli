/**
 * Tests for the credential store: path resolution, the prod/dev split, file
 * permissions, corrupt-file behaviour, profile operations, and the cross-process
 * lock that keeps parallel agents from shredding the file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CredentialsFileError,
  DEFAULT_PROFILE,
  configDir,
  credentialsPath,
  deleteCredentialsFile,
  isNonProdBaseUrl,
  maskSecret,
  readCredentials,
  removeProfile,
  resolveStoredCredential,
  saveProfile,
  setActiveProfile,
  withCredentialsLock,
  writeCredentials,
} from "../src/internal/credentials.js";
import { loadConfig } from "../src/internal/config.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "meshy-creds-")), "credentials.json");
}

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

// ---------------------------------------------------------------------------
// Paths and the prod/dev split
// ---------------------------------------------------------------------------

test("configDir — defaults under ~/.config on every platform", () => {
  withEnv({ MESHY_CONFIG_DIR: undefined }, () => {
    assert.equal(configDir(), join(homedir(), ".config", "meshy"));
  });
});

test("configDir — MESHY_CONFIG_DIR wins", () => {
  assert.equal(configDir({ MESHY_CONFIG_DIR: "/custom/dir" }), "/custom/dir");
});

test("isNonProdBaseUrl — production host is the only prod case", () => {
  assert.equal(isNonProdBaseUrl("https://api.meshy.ai/openapi/v1"), false);
  assert.equal(isNonProdBaseUrl("https://staging.meshy.ai/openapi/v1"), true);
  assert.equal(isNonProdBaseUrl("http://localhost:8080/v1"), true);
  assert.equal(isNonProdBaseUrl(undefined), false);
});

test("isNonProdBaseUrl — an unparseable URL counts as non-prod", () => {
  // A typo must not be able to touch the production credentials file.
  assert.equal(isNonProdBaseUrl("not a url"), true);
});

test("credentialsPath — prod and non-prod resolve to separate files", () => {
  const env = { MESHY_CONFIG_DIR: "/cfg", MESHY_CREDENTIALS_PATH: undefined };
  assert.equal(credentialsPath("https://api.meshy.ai/openapi/v1", env), "/cfg/credentials.json");
  assert.equal(credentialsPath("https://staging.meshy.ai/v1", env), "/cfg/credentials.dev.json");
});

test("credentialsPath — MESHY_CREDENTIALS_PATH overrides even the dev split", () => {
  const env = { MESHY_CONFIG_DIR: "/cfg", MESHY_CREDENTIALS_PATH: "/exact/file.json" };
  assert.equal(credentialsPath("https://staging.meshy.ai/v1", env), "/exact/file.json");
});

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

test("readCredentials — a missing file is 'not logged in', not an error", () => {
  assert.equal(readCredentials("/nonexistent-meshy/credentials.json"), null);
});

test("writeCredentials → readCredentials round-trip", () => {
  const file = tmpFile();
  writeCredentials(
    {
      auth_version: 1,
      active_profile: "work",
      profiles: { work: { kind: "api_key", api_key: "msy_work" } },
    },
    file,
  );
  const state = readCredentials(file);
  assert.equal(state?.active_profile, "work");
  assert.equal(state?.profiles["work"]?.api_key, "msy_work");
});

test("writeCredentials — file is 0600 and leaves no temp file behind", () => {
  const file = tmpFile();
  saveProfile(file, DEFAULT_PROFILE, { kind: "api_key", api_key: "msy_a" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const leftovers = readdirSync(dirname(file)).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("readCredentials — corrupt JSON throws CredentialsFileError naming the path", () => {
  const file = tmpFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{not json", "utf8");
  assert.throws(
    () => readCredentials(file),
    (err: unknown) => {
      assert.ok(err instanceof CredentialsFileError);
      assert.equal(err.path, file);
      assert.match(err.message, /Invalid credentials file/);
      return true;
    },
  );
});

test("readCredentials — a JSON array or a file without profiles is invalid", () => {
  const arrayFile = tmpFile();
  writeFileSync(arrayFile, "[]", "utf8");
  assert.throws(() => readCredentials(arrayFile), CredentialsFileError);

  const noProfiles = tmpFile();
  writeFileSync(noProfiles, JSON.stringify({ auth_version: 1 }), "utf8");
  assert.throws(() => readCredentials(noProfiles), CredentialsFileError);
});

// ---------------------------------------------------------------------------
// Profile operations
// ---------------------------------------------------------------------------

test("saveProfile — first profile becomes active; makeActive:false keeps the old one", () => {
  const file = tmpFile();
  saveProfile(file, "one", { kind: "api_key", api_key: "msy_1" });
  assert.equal(readCredentials(file)?.active_profile, "one");

  saveProfile(file, "two", { kind: "api_key", api_key: "msy_2" }, { makeActive: false });
  const state = readCredentials(file);
  assert.equal(state?.active_profile, "one");
  assert.deepEqual(Object.keys(state?.profiles ?? {}).sort(), ["one", "two"]);
});

test("saveProfile — stamps created_at and preserves existing profiles", () => {
  const file = tmpFile();
  saveProfile(file, "one", { kind: "api_key", api_key: "msy_1" });
  saveProfile(file, "two", { kind: "api_key", api_key: "msy_2" });
  const state = readCredentials(file);
  assert.equal(typeof state?.profiles["one"]?.created_at, "number");
  assert.equal(state?.profiles["one"]?.api_key, "msy_1");
});

test("removeProfile — reports whether it existed and repoints the active profile", () => {
  const file = tmpFile();
  saveProfile(file, "one", { kind: "api_key", api_key: "msy_1" }, { makeActive: false });
  saveProfile(file, "two", { kind: "api_key", api_key: "msy_2" });
  assert.equal(readCredentials(file)?.active_profile, "two");

  assert.equal(removeProfile(file, "two"), true);
  // Never leave active_profile pointing at a profile that is gone.
  assert.equal(readCredentials(file)?.active_profile, "one");
  assert.equal(removeProfile(file, "ghost"), false);
});

test("setActiveProfile — unknown profile throws with the command that lists them", () => {
  const file = tmpFile();
  saveProfile(file, "one", { kind: "api_key", api_key: "msy_1" });
  assert.throws(() => setActiveProfile(file, "nope"), /meshy auth list/);
});

test("deleteCredentialsFile — reports whether anything was deleted", () => {
  const file = tmpFile();
  saveProfile(file, DEFAULT_PROFILE, { kind: "api_key", api_key: "msy_1" });
  assert.equal(deleteCredentialsFile(file), true);
  assert.equal(deleteCredentialsFile(file), false);
  assert.equal(readCredentials(file), null);
});

// ---------------------------------------------------------------------------
// resolveStoredCredential
// ---------------------------------------------------------------------------

test("resolveStoredCredential — api_key profile", () => {
  const file = tmpFile();
  saveProfile(file, "work", { kind: "api_key", api_key: "msy_work" });
  assert.deepEqual(resolveStoredCredential(file), {
    profile: "work",
    kind: "api_key",
    apiKey: "msy_work",
  });
});

test("resolveStoredCredential — oauth profile returns the access token", () => {
  const file = tmpFile();
  saveProfile(file, "o", { kind: "oauth", access_token: "tok", expires_at: 123 });
  assert.deepEqual(resolveStoredCredential(file), {
    profile: "o",
    kind: "oauth",
    accessToken: "tok",
    expiresAt: 123,
  });
});

test("resolveStoredCredential — null for missing file, absent profile, or empty secret", () => {
  assert.equal(resolveStoredCredential("/nonexistent-meshy/credentials.json"), null);

  const dangling = tmpFile();
  writeCredentials({ auth_version: 1, active_profile: "gone", profiles: {} }, dangling);
  assert.equal(resolveStoredCredential(dangling), null);

  const empty = tmpFile();
  writeCredentials(
    { auth_version: 1, active_profile: "e", profiles: { e: { kind: "api_key" } } },
    empty,
  );
  assert.equal(resolveStoredCredential(empty), null);
});

test("maskSecret — keeps enough to identify, not enough to use", () => {
  assert.equal(maskSecret("msy_abcdefghijklmnop"), "msy_abcd…mnop");
  assert.equal(maskSecret("short"), "sh…");
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

test("withCredentialsLock — releases the lock file afterwards", () => {
  const file = tmpFile();
  const result = withCredentialsLock(file, () => "done");
  assert.equal(result, "done");
  const lock = join(dirname(file), "locks", "credentials.json.lock");
  assert.throws(() => statSync(lock), /ENOENT/);
});

test("withCredentialsLock — releases the lock even when the body throws", () => {
  const file = tmpFile();
  assert.throws(() => withCredentialsLock(file, () => { throw new Error("boom"); }), /boom/);
  // A failed mutation must not wedge every later invocation.
  assert.equal(withCredentialsLock(file, () => "after"), "after");
});

test("withCredentialsLock — a stale lock is broken instead of blocking forever", () => {
  const file = tmpFile();
  const lock = join(dirname(file), "locks", "credentials.json.lock");
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, "", "utf8");
  // Backdate past the stale threshold, as a killed process would leave it.
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(withCredentialsLock(file, () => "recovered"), "recovered");
});

test("parallel processes writing the same file keep it valid and lose nothing", async () => {
  const file = tmpFile();
  const child = join(HERE, "helpers", "save-profile-child.ts");
  const names = Array.from({ length: 12 }, (_, i) => `p${i}`);

  await Promise.all(
    names.map((name) =>
      execFileAsync(process.execPath, ["--import", "tsx", child, file, name], {
        env: { ...process.env, MESHY_CLI_NO_UPDATE_NOTIFIER: "1" },
      }),
    ),
  );

  // Valid JSON (no interleaved half-writes) and every writer's profile present.
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    profiles: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(parsed.profiles).sort(), [...names].sort());
});

// ---------------------------------------------------------------------------
// loadConfig integration — the priority chain
// ---------------------------------------------------------------------------

test("loadConfig — flag beats env beats stored profile", () => {
  const file = tmpFile();
  saveProfile(file, "stored", { kind: "api_key", api_key: "msy_stored" });

  withEnv({ MESHY_CREDENTIALS_PATH: file, MESHY_API_KEY: "msy_env" }, () => {
    assert.equal(loadConfig({ apiKey: "msy_flag" }).credentialSource, "flag");
    assert.equal(loadConfig({ apiKey: "msy_flag" }).apiKey, "msy_flag");

    const fromEnv = loadConfig();
    assert.equal(fromEnv.apiKey, "msy_env");
    assert.equal(fromEnv.credentialSource, "env");
  });

  withEnv({ MESHY_CREDENTIALS_PATH: file, MESHY_API_KEY: undefined }, () => {
    const fromFile = loadConfig();
    assert.equal(fromFile.apiKey, "msy_stored");
    assert.equal(fromFile.credentialSource, "file");
    assert.equal(fromFile.credentialProfile, "stored");
    assert.equal(fromFile.credentialsFile, file);
  });
});

test("loadConfig — a non-prod base URL reads the dev credentials file", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-creds-split-"));
  saveProfile(join(dir, "credentials.json"), "prod", { kind: "api_key", api_key: "msy_prod" });
  saveProfile(join(dir, "credentials.dev.json"), "dev", { kind: "api_key", api_key: "msy_dev" });

  withEnv(
    { MESHY_CONFIG_DIR: dir, MESHY_CREDENTIALS_PATH: undefined, MESHY_API_KEY: undefined },
    () => {
      assert.equal(loadConfig().apiKey, "msy_prod");
      assert.equal(loadConfig({ baseUrlV1: "https://staging.meshy.ai/v1" }).apiKey, "msy_dev");
    },
  );
});

test("loadConfig — a corrupt store surfaces instead of reading as 'not logged in'", () => {
  const file = tmpFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{broken", "utf8");
  withEnv({ MESHY_CREDENTIALS_PATH: file, MESHY_API_KEY: undefined }, () => {
    assert.throws(() => loadConfig(), CredentialsFileError);
  });
});
