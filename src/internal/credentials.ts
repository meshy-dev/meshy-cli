/**
 * Credential store — the on-disk half of `meshy auth`.
 *
 * Layout: ~/.config/meshy/credentials.v2.json, one file holding named profiles
 * so a user can keep several accounts side by side. `~/.config` is used on
 * every platform (including macOS, where the native spot would be Application
 * Support) because the file is meant to be scriptable and dotfile-friendly.
 *
 * Secrets never reach the disk in the clear: a profile's API key or tokens are
 * sealed under a master key held by the OS credential store (keyring.ts), and
 * the file keeps only the ciphertext plus what can be shown without it — kind,
 * masked hint, expiry, region, account. Profiles are opened on demand, so
 * listing them or resolving the region never touches the key.
 *
 * Releases before 0.8 kept plaintext in credentials.json. That file is still
 * read while the v2 file does not exist, and the first write moves its
 * profiles over and deletes it — moves, never copies: two stores holding one
 * refresh token would each rotate it, and the API revokes a login whose
 * rotated-out refresh token is presented again. An older CLI that finds the
 * old file gone signs in separately and keeps its own login there.
 *
 * Non-production hosts get their own file — credentials.v2.dev.json — so
 * pointing MESHY_BASE_URL_V1 at staging cannot overwrite the production login,
 * and logging out of one leaves the other alone. The global and China API
 * hosts are both production: one Meshy account works on either.
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
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openSecret, sealSecret } from "./keyring.js";

export const AUTH_VERSION = 2;
export const DEFAULT_PROFILE = "default";
/** The global and China API hosts; they share accounts and this file. */
export const PROD_API_HOSTS = ["api.meshy.ai", "api.meshy.cn"];

const LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this is assumed to be a crashed process's leftover. */
const LOCK_STALE_MS = 60_000;

export type CredentialKind = "api_key" | "oauth";

/** Who a login belongs to, as the API's userinfo reports it. */
export interface CredentialAccount {
  name?: string;
  email?: string;
}

export interface CredentialProfile {
  kind: CredentialKind;
  /**
   * The secrets, in memory only: `writeCredentials` seals them into `secret`,
   * and `profileSecrets` opens them again. A pre-0.8 file carries them in the
   * clear, which reads the same way.
   */
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  /** On disk: the sealed secrets (keyring.ts). */
  secret?: string;
  /** Masked credential, so a profile can be listed without opening it. */
  hint?: string;
  /** Set at login when the API reports who signed in. */
  account?: CredentialAccount;
  /** Unix epoch millis. */
  expires_at?: number;
  user_id?: string;
  /**
   * Random identifier minted by `meshy auth login` for OAuth profiles. It
   * survives token refreshes and is replaced by a new login, so the operation
   * journal can bind a submission to *this* login even when the token endpoint
   * reports no user_id.
   */
  login_id?: string;
  /** Set by `meshy auth login --region cn`: later commands default to the China endpoint. */
  region?: "cn";
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
    return !PROD_API_HOSTS.includes(new URL(baseUrlV1).host);
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
  const name = isNonProdBaseUrl(baseUrlV1) ? "credentials.v2.dev.json" : "credentials.v2.json";
  return join(configDir(env), name);
}

/** The pre-0.8 plaintext file a default v2 path replaces, or null for any other path. */
export function legacyCredentialsPath(file: string): string | null {
  const legacy = ({ "credentials.v2.json": "credentials.json", "credentials.v2.dev.json": "credentials.dev.json" } as Record<string, string>)[basenameOf(file)];
  return legacy ? join(dirname(file), legacy) : null;
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
 * Takes the exclusive lock keyed to `file` and returns its release. Callers
 * that hold it across an await (an OAuth refresh) use this directly; the rest
 * use withCredentialsLock.
 *
 * O_EXCL creation is the atomic primitive here — `flock` is not exposed by
 * Node's fs module. A lock whose mtime is older than LOCK_STALE_MS is treated
 * as abandoned and broken, so a killed process cannot wedge the CLI forever.
 */
export function acquireCredentialsLock(file: string): () => void {
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
  return () => {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
}

/** Runs `fn` while holding the exclusive lock keyed to `file`. */
export function withCredentialsLock<T>(file: string, fn: () => T): T {
  const release = acquireCredentialsLock(file);
  try {
    return fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function emptyFile(): CredentialsFile {
  return { auth_version: AUTH_VERSION, active_profile: DEFAULT_PROFILE, profiles: {} };
}

/**
 * Reads the credentials file — or, while a default v2 file does not exist yet,
 * the pre-0.8 file it replaces. Returns null when neither exists: that is "not
 * logged in", not an error. A file that exists but is unreadable throws
 * CredentialsFileError so the user hears about it instead of silently falling
 * back to "no credentials". Profiles come back sealed; see profileSecrets.
 */
export function readCredentials(file: string): CredentialsFile | null {
  const legacy = legacyCredentialsPath(file);
  return readStateFile(file) ?? (legacy ? readStateFile(legacy) : null);
}

function readStateFile(file: string): CredentialsFile | null {
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

/** The on-disk form of a profile: any secret it carries in the clear is sealed. */
function sealProfile(dir: string, profile: CredentialProfile): CredentialProfile {
  const { api_key, access_token, refresh_token, ...rest } = profile;
  const secrets = Object.fromEntries(
    Object.entries({ api_key, access_token, refresh_token }).filter(([, v]) => v),
  );
  if (Object.keys(secrets).length === 0) return profile;
  return { ...rest, secret: sealSecret(dir, JSON.stringify(secrets)), hint: maskSecret(api_key ?? access_token ?? "") };
}

/**
 * The secrets of one profile, opened from its sealed form (or read as-is from
 * a pre-0.8 plaintext profile). Throws an auth error when they cannot be
 * opened here — a missing or locked key, or a value that does not decrypt.
 */
export function profileSecrets(
  file: string,
  profile: CredentialProfile,
): Pick<CredentialProfile, "api_key" | "access_token" | "refresh_token"> {
  const opened: Record<string, unknown> =
    profile.secret && !profile.api_key && !profile.access_token
      ? (JSON.parse(openSecret(dirname(file), profile.secret)) as Record<string, unknown>)
      : { api_key: profile.api_key, access_token: profile.access_token, refresh_token: profile.refresh_token };
  const pick = (k: string): string | undefined => (typeof opened[k] === "string" && opened[k] ? (opened[k] as string) : undefined);
  return {
    ...(pick("api_key") ? { api_key: pick("api_key") } : {}),
    ...(pick("access_token") ? { access_token: pick("access_token") } : {}),
    ...(pick("refresh_token") ? { refresh_token: pick("refresh_token") } : {}),
  };
}

/**
 * Writes the file with 0600 via a temp file + rename, so a crash mid-write
 * cannot leave a half-written credentials file behind. Secrets are sealed on
 * the way out; `state` itself is left as the caller passed it. Callers that
 * mutate existing state must hold the lock; see updateCredentials.
 */
export function writeCredentials(state: CredentialsFile, file: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const onDisk: CredentialsFile = {
    ...state,
    auth_version: AUTH_VERSION,
    profiles: Object.fromEntries(Object.entries(state.profiles).map(([name, p]) => [name, sealProfile(dir, p)])),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(onDisk, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

/**
 * Read-modify-write under the lock. The mutator may return a new state or
 * mutate in place. The first write to a default v2 path starts from the
 * pre-0.8 file and then deletes it, so its profiles move rather than copy.
 */
export function updateCredentials(
  file: string,
  mutate: (state: CredentialsFile) => CredentialsFile | void,
): CredentialsFile {
  return withCredentialsLock(file, () => updateCredentialsHeld(file, mutate));
}

/** updateCredentials for a caller that already holds the lock (acquireCredentialsLock). */
export function updateCredentialsHeld(
  file: string,
  mutate: (state: CredentialsFile) => CredentialsFile | void,
): CredentialsFile {
  const own = readStateFile(file);
  const legacy = own ? null : legacyCredentialsPath(file);
  const seeded = legacy ? readStateFile(legacy) : null;
  const current = own ?? seeded ?? emptyFile();
  const next = mutate(current) ?? current;
  writeCredentials(next, file);
  if (legacy && seeded) unlinkUnderLock(legacy);
  return next;
}

function unlinkUnderLock(file: string): boolean {
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

/**
 * Whether this process may write the store. A sandboxed agent shell often may
 * not, and an OAuth refresh it cannot save is worse than none: the API rotates
 * the refresh token on use, so the stored one would be spent and the next
 * attempt would end the login. Probed with a real file, because a sandbox or a
 * Windows ACL is not always visible to access(2).
 */
export function storeWritable(file: string): boolean {
  const probe = join(dirname(file), "locks", `.probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(dirname(probe), { recursive: true, mode: 0o700 });
    closeSync(openSync(probe, "wx", 0o600));
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
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

/** Deletes the whole file, and the pre-0.8 one it replaces. Returns false when there was nothing to delete. */
export function deleteCredentialsFile(file: string): boolean {
  const legacy = legacyCredentialsPath(file);
  const deleted = unlinkUnderLock(file);
  return (legacy ? unlinkUnderLock(legacy) : false) || deleted;
}

export interface ResolvedStoredCredential {
  profile: string;
  kind: CredentialKind;
  apiKey?: string;
  accessToken?: string;
  expiresAt?: number;
  /** Stable account subject of an OAuth profile, when the token endpoint reported one. */
  userId?: string;
  /** Per-login identifier of an OAuth profile (see CredentialProfile.login_id). */
  loginId?: string;
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
  const secrets = profileSecrets(file, profile);
  if (profile.kind === "api_key") {
    if (!secrets.api_key) return null;
    return { profile: name, kind: "api_key", apiKey: secrets.api_key };
  }
  if (!secrets.access_token) return null;
  return {
    profile: name,
    kind: "oauth",
    accessToken: secrets.access_token,
    expiresAt: profile.expires_at,
    ...(profile.user_id ? { userId: profile.user_id } : {}),
    ...(profile.login_id ? { loginId: profile.login_id } : {}),
  };
}

/** `msy_abcd…wxyz` — enough to tell two keys apart, not enough to use one. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}
