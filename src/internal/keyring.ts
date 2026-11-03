/**
 * Sealing for the credential store: secrets on disk are AES-256-GCM
 * ciphertext under one 32-byte master key, and the master key lives in the
 * OS credential store:
 *
 *   - macOS: the login Keychain, through /usr/bin/security. Going through
 *     that binary (rather than a native module in this Node process) keeps the
 *     item's trusted application stable, so switching Node versions never
 *     raises a "node wants to use your keychain" prompt.
 *   - Windows: DPAPI (current user), through Windows PowerShell; the protected
 *     key sits next to the credentials file.
 *   - Linux: the Secret Service (GNOME Keyring, KWallet, …) through
 *     secret-tool, when a session bus is present.
 *
 * When the OS store is missing, locked or refuses the write (CI, containers,
 * SSH sessions, sandboxes), or MESHY_KEYRING=file, the key goes to a 0600
 * `master.key` file instead, and once that file exists every later seal uses
 * it. Each sealed value names the store that holds its key, so a profile
 * sealed under one store stays readable after another one takes over.
 *
 * Every function here is synchronous, like the store API that calls it.
 */

import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HintedError } from "./errors.js";
import { logger } from "./logger.js";

export type KeyStore = "keychain" | "dpapi" | "secret-service" | "file";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STORE_TIMEOUT_MS = 5_000;
const SEAL_PREFIX = "v1";
const STORES: readonly KeyStore[] = ["keychain", "dpapi", "secret-service", "file"];

/** Keychain service / Secret Service attribute; MESHY_KEYRING_SERVICE is a test hook. */
function serviceName(env: NodeJS.ProcessEnv): string {
  return env["MESHY_KEYRING_SERVICE"]?.trim() || "meshy-cli";
}
const ACCOUNT = "master-key";

const fileKeyPath = (dir: string): string => join(dir, "master.key");
const dpapiKeyPath = (dir: string): string => join(dir, "master.key.dpapi");

/** Thrown by a store that cannot be used on this machine at all (as opposed to one holding no key yet). */
class StoreUnavailable extends Error {}

interface Store {
  /** The key, or null when the store has none yet. Throws when the store cannot be read. */
  get(dir: string, env: NodeJS.ProcessEnv): Buffer | null;
  set(dir: string, key: Buffer, env: NodeJS.ProcessEnv): void;
}

function decodeKey(text: string, where: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`the master key in ${where} is corrupt`);
  return key;
}

function run(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    input,
    timeout: STORE_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

const SECURITY = "/usr/bin/security";
/** `security` exits 44 for "The specified item could not be found in the keychain". */
const SECURITY_NOT_FOUND = 44;

const keychain: Store = {
  get(_dir, env) {
    try {
      return decodeKey(run(SECURITY, ["find-generic-password", "-s", serviceName(env), "-a", ACCOUNT, "-w"]), "the keychain");
    } catch (err) {
      if ((err as { status?: number }).status === SECURITY_NOT_FOUND) return null;
      if (isMissingBinary(err)) throw new StoreUnavailable(SECURITY);
      throw err;
    }
  },
  set(_dir, key, env) {
    // Without a default keychain (a HOME that is not the user's own: CI,
    // sandboxes, test harnesses) macOS answers an add with a "A keychain
    // cannot be found" dialog rather than an error, so ask first; the query
    // itself never prompts.
    try {
      run(SECURITY, ["default-keychain"]);
    } catch {
      throw new StoreUnavailable("no default keychain");
    }
    // `security -i` reads the command from stdin, so the key never appears in
    // a process listing. It reports failures on stderr with exit 0, which is
    // why callers read the key back instead of trusting the exit code.
    run(SECURITY, ["-i"], `add-generic-password -U -s ${serviceName(env)} -a ${ACCOUNT} -w ${key.toString("base64")}\n`);
  },
};

/** Windows PowerShell 5.1 ships with every supported Windows and has ProtectedData built in. */
function dpapi(direction: "Protect" | "Unprotect", input: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$out = [Security.Cryptography.ProtectedData]::${direction}($bytes, $null, 'CurrentUser')`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], input);
  } catch (err) {
    if (isMissingBinary(err)) throw new StoreUnavailable("powershell.exe");
    throw err;
  }
}

const dpapiStore: Store = {
  get(dir) {
    let blob: string;
    try {
      blob = readFileSync(dpapiKeyPath(dir), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return decodeKey(dpapi("Unprotect", blob), dpapiKeyPath(dir));
  },
  set(dir, key) {
    writeNewFile(dpapiKeyPath(dir), dpapi("Protect", key.toString("base64")));
  },
};

const secretService: Store = {
  get(_dir, env) {
    try {
      const out = run("secret-tool", ["lookup", "service", serviceName(env), "account", ACCOUNT]);
      return out.trim() ? decodeKey(out, "the Secret Service") : null;
    } catch (err) {
      if (isMissingBinary(err)) throw new StoreUnavailable("secret-tool");
      // secret-tool exits 1 with nothing on stderr when the item is absent.
      const e = err as { status?: number; stderr?: string };
      if (e.status === 1 && !e.stderr?.trim()) return null;
      throw err;
    }
  },
  set(_dir, key, env) {
    try {
      run("secret-tool", ["store", "--label=Meshy CLI", "service", serviceName(env), "account", ACCOUNT], key.toString("base64"));
    } catch (err) {
      if (isMissingBinary(err)) throw new StoreUnavailable("secret-tool");
      throw err;
    }
  },
};

/** Creates `file` with 0600, failing with EEXIST rather than replacing one another process wrote first. */
function writeNewFile(file: string, content: string): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

const fileStore: Store = {
  get(dir) {
    try {
      return decodeKey(readFileSync(fileKeyPath(dir), "utf8"), fileKeyPath(dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  set(dir, key) {
    try {
      writeNewFile(fileKeyPath(dir), key.toString("base64"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  },
};

const BACKENDS: Record<KeyStore, Store> = {
  keychain,
  dpapi: dpapiStore,
  "secret-service": secretService,
  file: fileStore,
};

/** The OS store for this platform, or `file` when there is none or MESHY_KEYRING=file. */
export function platformKeyStore(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): KeyStore {
  if (env["MESHY_KEYRING"]?.trim().toLowerCase() === "file") return "file";
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  if (platform === "linux" && env["DBUS_SESSION_BUS_ADDRESS"]) return "secret-service";
  return "file";
}

const cache = new Map<string, Buffer>();

function readKey(store: KeyStore, dir: string, env: NodeJS.ProcessEnv): Buffer | null {
  const id = store === "file" || store === "dpapi" ? `${store}:${dir}` : `${store}:${serviceName(env)}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const key = BACKENDS[store].get(dir, env);
  if (key) cache.set(id, key);
  return key;
}

/**
 * The key a new seal uses, created on first use. Callers hold the credentials
 * lock, so two processes never mint competing keys for one directory; the key
 * is read back after creation so the value used is the value stored.
 */
function sealingKey(dir: string, env: NodeJS.ProcessEnv): { store: KeyStore; key: Buffer } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const preferred: KeyStore = existsSync(fileKeyPath(dir)) ? "file" : platformKeyStore(env);
  if (preferred !== "file") {
    try {
      const existing = readKey(preferred, dir, env);
      if (existing) return { store: preferred, key: existing };
      BACKENDS[preferred].set(dir, randomBytes(KEY_BYTES), env);
      const stored = readKey(preferred, dir, env);
      if (stored) return { store: preferred, key: stored };
      throw new Error("the key did not read back after it was stored");
    } catch (err) {
      logger.debug(`${preferred} is unavailable for the credentials key (${(err as Error).message}); using ${fileKeyPath(dir)}`);
    }
  }
  const existing = readKey("file", dir, env);
  if (existing) return { store: "file", key: existing };
  fileStore.set(dir, randomBytes(KEY_BYTES), env);
  const stored = readKey("file", dir, env);
  if (!stored) throw new Error(`could not create ${fileKeyPath(dir)}`);
  return { store: "file", key: stored };
}

/** Encrypts `plaintext` for the credentials file in `dir`: `v1.<store>.<base64 iv|ciphertext|tag>`. */
export function sealSecret(dir: string, plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const { store, key } = sealingKey(dir, env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${SEAL_PREFIX}.${store}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64")}`;
}

function unreadable(detail: string): HintedError {
  return new HintedError({
    message: `The stored login cannot be read: ${detail}.`,
    code: "unauthenticated",
    hint: "Unlock the OS keychain and retry, or sign in again: meshy auth login",
  });
}

/** Decrypts a value from sealSecret; a missing key or tampered value is an auth error, not a crash. */
export function openSecret(dir: string, sealed: string, env: NodeJS.ProcessEnv = process.env): string {
  const [prefix, store, payload] = sealed.split(".");
  if (prefix !== SEAL_PREFIX || !STORES.includes(store as KeyStore) || !payload) {
    throw unreadable("the sealed value has an unknown format");
  }
  let key: Buffer | null;
  try {
    key = readKey(store as KeyStore, dir, env);
  } catch (err) {
    throw unreadable(`the ${store} key could not be read (${(err as Error).message.split("\n")[0]})`);
  }
  if (!key) throw unreadable(`its ${store} key is gone`);
  const raw = Buffer.from(payload, "base64");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw unreadable(`it does not match the ${store} key`);
  }
}
