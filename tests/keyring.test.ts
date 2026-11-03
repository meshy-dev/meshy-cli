/**
 * Sealing for the credential store. Everything here runs on the file key
 * (tests/test.env); the last test drives the real OS store only when
 * MESHY_TEST_OS_KEYRING=1, under a throwaway service name, and removes it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { openSecret, platformKeyStore, sealSecret } from "../src/internal/keyring.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "meshy-keyring-"));

test("seal → open round-trip; the ciphertext differs every time and names its key store", () => {
  const dir = tmp();
  const a = sealSecret(dir, "msy_secret_value");
  const b = sealSecret(dir, "msy_secret_value");
  assert.notEqual(a, b, "a fresh IV per seal");
  assert.match(a, /^v1\.file\./);
  assert.ok(!a.includes("msy_secret_value"));
  assert.equal(openSecret(dir, a), "msy_secret_value");
});

test("the file key is 0600 and reused by later seals", { skip: process.platform === "win32" }, () => {
  const dir = tmp();
  sealSecret(dir, "x");
  const key = readFileSync(join(dir, "master.key"), "utf8");
  assert.equal(statSync(join(dir, "master.key")).mode & 0o777, 0o600);
  sealSecret(dir, "y");
  assert.equal(readFileSync(join(dir, "master.key"), "utf8"), key);
});

test("a tampered or foreign value is an auth error", () => {
  const dir = tmp();
  const sealed = sealSecret(dir, "msy_secret_value");
  const [v, store, payload] = sealed.split(".");
  const raw = Buffer.from(payload!, "base64");
  raw[raw.length - 20]! ^= 0xff;
  const isAuth = (err: unknown): boolean => (err as { code?: string }).code === "unauthenticated";
  assert.throws(() => openSecret(dir, `${v}.${store}.${raw.toString("base64")}`), isAuth);
  assert.throws(() => openSecret(tmp(), sealed), isAuth, "another directory has another key");
  assert.throws(() => openSecret(dir, "v9.file.AAAA"), isAuth);
  assert.throws(() => openSecret(dir, "v1.vault.AAAA"), isAuth);
});

test("platformKeyStore — the OS store per platform, the file when there is none or MESHY_KEYRING=file", () => {
  assert.equal(platformKeyStore({}, "darwin"), "keychain");
  assert.equal(platformKeyStore({}, "win32"), "dpapi");
  assert.equal(platformKeyStore({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, "linux"), "secret-service");
  assert.equal(platformKeyStore({}, "linux"), "file", "no session bus, no Secret Service");
  assert.equal(platformKeyStore({}, "freebsd"), "file");
  assert.equal(platformKeyStore({ MESHY_KEYRING: "file" }, "darwin"), "file");
});

test("macOS: a HOME without a keychain uses the key file and never asks the Keychain to store", { skip: process.platform !== "darwin" }, () => {
  // An add without a default keychain raises a GUI dialog instead of failing, so the CLI must
  // not get that far. The child sees a HOME of its own, as CI and sandboxed shells do.
  const home = tmp();
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { sealSecret } from ${JSON.stringify(new URL("../src/internal/keyring.ts", import.meta.url).href)}; process.stdout.write(sealSecret(${JSON.stringify(join(home, "cfg"))}, "x"))`],
    { env: { PATH: process.env["PATH"], HOME: home, MESHY_KEYRING_SERVICE: `meshy-cli-test-${randomBytes(4).toString("hex")}` }, encoding: "utf8" });
  assert.match(out, /^v1\.file\./);
});

test(
  "the OS key store seals and opens for real",
  { skip: process.env["MESHY_TEST_OS_KEYRING"] !== "1" && "set MESHY_TEST_OS_KEYRING=1 to use this machine's key store" },
  () => {
    const service = `meshy-cli-test-${randomBytes(4).toString("hex")}`;
    const env = { ...process.env, MESHY_KEYRING: undefined, MESHY_KEYRING_SERVICE: service };
    const dir = tmp();
    try {
      const sealed = sealSecret(dir, "msy_os_store", env);
      assert.match(sealed, new RegExp(`^v1\\.${platformKeyStore(env)}\\.`));
      assert.equal(openSecret(dir, sealed, env), "msy_os_store");
    } finally {
      if (process.platform === "darwin") {
        execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", "master-key"], { stdio: "ignore" });
      } else if (platformKeyStore(env) === "secret-service") {
        execFileSync("secret-tool", ["clear", "service", service, "account", "master-key"], { stdio: "ignore" });
      }
    }
  },
);
