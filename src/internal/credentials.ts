/**
 * Credential store — the on-disk half of `meshy auth`.
 *
 * Layout: ~/.config/meshy/credentials.json, one file holding named profiles so
 * a user can keep several accounts side by side. `~/.config` is used on every
 * platform (including macOS, where the native spot would be Application
 * Support) because the file is meant to be scriptable and dotfile-friendly.
 *
 * Non-production hosts get their own file — credentials.dev.json — so pointing
 * MESHY_BASE_URL_V1 at staging cannot overwrite the production login, and
 * logging out of one leaves the other alone.
 *
 * Every mutation runs under a cross-process lock and lands via a temp file +
 * rename, because several agents driving this CLI in parallel is the normal
 * case, not the exception.
 *
 * This module deliberately knows nothing about config.ts — it takes the base
 * URL it needs as an argument, so config can depend on it and not vice versa.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTH_VERSION = 1;
export const DEFAULT_PROFILE = "default";
export const PROD_API_HOST = "api.meshy.ai";

const LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this is assumed to be a crashed process's leftover. */
const LOCK_STALE_MS = 60_000;

export type CredentialKind = "api_key" | "oauth";

export interface CredentialProfile {
  kind: CredentialKind;
  /** Present when kind === "api_key". */
  api_key?: string;
  /** Present when kind === "oauth" (CLI-4 writes these; nothing reads them yet). */
  access_token?: string;
  refresh_token?: string;
  /** Unix epoch millis. */
  expires_at?: number;
  user_id?: string;
  created_at?: number;
}

export interface CredentialsFile {
  auth_version: number;
  active_profile: string;
  profiles: Record<string, CredentialProfile>;
}

/** Thrown when the file exists but cannot be understood — never on a missing file. */
export class CredentialsFileError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`Invalid credentials file at ${path}: ${detail}`);
    this.name = "CredentialsFileError";
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root config directory. MESHY_CONFIG_DIR wins when set. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["MESHY_CONFIG_DIR"]?.trim();
  if (override) return override;
  return join(homedir(), ".config", "meshy");
}

/**
 * True when the given v1 base URL points somewhere other than production.
 * An unparseable URL counts as non-production: a typo should not be able to
 * touch the production credential file.
 */
export function isNonProdBaseUrl(baseUrlV1: string | undefined): boolean {
  if (!baseUrlV1) return false;
  try {
    return new URL(baseUrlV1).host !== PROD_API_HOST;
  } catch {
    return true;
  }
}

/**
 * Resolves the credentials file path.
 *
 * MESHY_CREDENTIALS_PATH is absolute and wins over everything, including the
 * prod/dev split — a caller that names a file gets that exact file.
 */
export function credentialsPath(
  baseUrlV1?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env["MESHY_CREDENTIALS_PATH"]?.trim();
  if (explicit) return explicit;
  const name = isNonProdBaseUrl(baseUrlV1) ? "credentials.dev.json" : "credentials.json";
  return join(configDir(env), name);
}

function lockPathFor(file: string): string {
  return join(dirname(file), "locks", `${basenameOf(file)}.lock`);
}

function basenameOf(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || "credentials.json";
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function sleepSync(ms: number): void {
  // Blocking sleep without a busy loop; the store API is synchronous by design.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` while holding an exclusive lock keyed to `file`.
 *
 * O_EXCL creation is the atomic primitive here — `flock` is not exposed by
 * Node's fs module. A lock whose mtime is older than LOCK_STALE_MS is treated
 * as abandoned and broken, so a killed process cannot wedge the CLI forever.
 */
export function withCredentialsLock<T>(file: string, fn: () => T): T {
  const lock = lockPathFor(file);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        // The holder released it between open and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${LOCK_TIMEOUT_MS}ms waiting for the credentials lock at ${lock}. ` +
            `If no other meshy process is running, delete that file.`,
        );
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function emptyFile(): CredentialsFile {
  return { auth_version: AUTH_VERSION, active_profile: DEFAULT_PROFILE, profiles: {} };
}

/**
 * Reads the credentials file. Returns null when it does not exist — that is
 * "not logged in", not an error. A file that exists but is unreadable throws
 * CredentialsFileError so the user hears about it instead of silently falling
 * back to "no credentials".
 */
export function readCredentials(file: string): CredentialsFile | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialsFileError(file, err instanceof Error ? err.message : "unparseable JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialsFileError(file, "expected a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const profiles = obj["profiles"];
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new CredentialsFileError(file, "missing a 'profiles' object");
  }
  const active = typeof obj["active_profile"] === "string" ? obj["active_profile"] : DEFAULT_PROFILE;
  const version = typeof obj["auth_version"] === "number" ? obj["auth_version"] : AUTH_VERSION;
  return {
    auth_version: version,
    active_profile: active,
    profiles: profiles as Record<string, CredentialProfile>,
  };
}

/**
 * Writes the file with 0600 via a temp file + rename, so a crash mid-write
 * cannot leave a half-written credentials file behind. Callers that mutate
 * existing state must hold the lock; see updateCredentials.
 */
export function writeCredentials(state: CredentialsFile, file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  // rename preserves the temp file's mode, but an existing file's mode wins on
  // some platforms — assert it either way.
  chmodSync(file, 0o600);
}

/** Read-modify-write under the lock. The mutator may return a new state or mutate in place. */
export function updateCredentials(
  file: string,
  mutate: (state: CredentialsFile) => CredentialsFile | void,
): CredentialsFile {
  return withCredentialsLock(file, () => {
    const current = readCredentials(file) ?? emptyFile();
    const next = mutate(current) ?? current;
    writeCredentials(next, file);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Profile operations
// ---------------------------------------------------------------------------

export function saveProfile(
  file: string,
  name: string,
  profile: CredentialProfile,
  opts: { makeActive?: boolean } = {},
): CredentialsFile {
  return updateCredentials(file, (state) => {
    state.profiles[name] = { ...profile, created_at: profile.created_at ?? Date.now() };
    if (opts.makeActive !== false) state.active_profile = name;
  });
}

/** Removes one profile. Returns false when it was not there to begin with. */
export function removeProfile(file: string, name: string): boolean {
  let existed = false;
  updateCredentials(file, (state) => {
    existed = Object.prototype.hasOwnProperty.call(state.profiles, name);
    delete state.profiles[name];
    if (state.active_profile === name) {
      // Fall back to any remaining profile so the store never points at a
      // profile that isn't there.
      state.active_profile = Object.keys(state.profiles)[0] ?? DEFAULT_PROFILE;
    }
  });
  return existed;
}

export function setActiveProfile(file: string, name: string): void {
  updateCredentials(file, (state) => {
    if (!Object.prototype.hasOwnProperty.call(state.profiles, name)) {
      throw new Error(`no such profile '${name}'. Run: meshy auth list`);
    }
    state.active_profile = name;
  });
}

/** Deletes the whole file. Returns false when there was nothing to delete. */
export function deleteCredentialsFile(file: string): boolean {
  return withCredentialsLock(file, () => {
    try {
      unlinkSync(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

export interface ResolvedStoredCredential {
  profile: string;
  kind: CredentialKind;
  apiKey?: string;
  accessToken?: string;
  expiresAt?: number;
}

/**
 * Returns the usable secret from the active profile, or null when there is no
 * file, no active profile, or the profile carries nothing usable.
 */
export function resolveStoredCredential(file: string): ResolvedStoredCredential | null {
  const state = readCredentials(file);
  if (!state) return null;
  const name = state.active_profile;
  const profile = state.profiles[name];
  if (!profile) return null;
  if (profile.kind === "api_key") {
    if (!profile.api_key) return null;
    return { profile: name, kind: "api_key", apiKey: profile.api_key };
  }
  if (!profile.access_token) return null;
  return {
    profile: name,
    kind: "oauth",
    accessToken: profile.access_token,
    expiresAt: profile.expires_at,
  };
}

/** `msy_abcd…wxyz` — enough to tell two keys apart, not enough to use one. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}
