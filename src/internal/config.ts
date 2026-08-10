/**
 * Resolve config in this priority order:
 *   1. CLI flags (--api-key, --base-url-v1, --base-url-v2, --verbose)
 *   2. Environment variables (MESHY_*)
 *   3. The active profile in the credentials file (written by `meshy auth login`)
 *   4. Built-in defaults
 *
 * The env var keeps priority over the stored credential on purpose: CI and
 * containers export MESHY_API_KEY and must not be silently overridden by
 * whatever a developer once logged into on that machine.
 *
 * Fail-fast on a missing/placeholder credential — with the command that fixes
 * it attached, not just a complaint.
 */

import { credentialsPath, resolveStoredCredential, type CredentialKind } from "./credentials.js";
import { authRequiredError } from "./errors.js";
import { setLogLevel, type LogLevel } from "./logger.js";

const PLACEHOLDER_KEYS = new Set(["", "YOUR_MESHY_API_KEY_HERE"]);

/** Where the credential in use came from — surfaced by `meshy auth status`. */
export type CredentialSource = "flag" | "env" | "file";

export interface MeshyConfig {
  apiKey: string;
  baseUrlV1: string;
  baseUrlV2: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  pollIntervalMs: number;
  logLevel: LogLevel;
  credentialSource: CredentialSource;
  /** Set only when credentialSource === "file". */
  credentialProfile?: string;
  /** The credentials file consulted for this invocation, whether or not it exists. */
  credentialsFile: string;
  /**
   * The kind of credential in use — "oauth" for browser-login tokens, "api_key" for static keys.
   * "api_key" when credentialSource is "flag" or "env" (those paths only accept static keys).
   * Derived from the stored profile kind when credentialSource is "file".
   */
  credentialKind: CredentialKind;
}

export interface ConfigOverrides {
  apiKey?: string;
  baseUrlV1?: string;
  baseUrlV2?: string;
  logLevel?: LogLevel;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function readLogLevel(fallback: LogLevel): LogLevel {
  const raw = (process.env.MESHY_LOG_LEVEL || "").toLowerCase();
  if (!raw) return fallback;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  return fallback;
}

function stripTrail(s: string): string {
  return s.replace(/\/+$/, "");
}

export function loadConfig(overrides: ConfigOverrides = {}): MeshyConfig {
  // Base URLs resolve first: they decide which credentials file applies
  // (production vs. a staging override).
  const baseUrlV1 = stripTrail(
    overrides.baseUrlV1 ?? process.env.MESHY_BASE_URL_V1 ?? "https://api.meshy.ai/openapi/v1",
  );
  const baseUrlV2 = stripTrail(
    overrides.baseUrlV2 ?? process.env.MESHY_BASE_URL_V2 ?? "https://api.meshy.ai/openapi/v2",
  );
  const credFile = credentialsPath(baseUrlV1);

  const flagKey = overrides.apiKey?.trim() ?? "";
  const envKey = process.env.MESHY_API_KEY?.trim() ?? "";

  let apiKey = "";
  let credentialSource: CredentialSource = "flag";
  let credentialProfile: string | undefined;
  let credentialKind: CredentialKind = "api_key";

  if (!PLACEHOLDER_KEYS.has(flagKey)) {
    apiKey = flagKey;
    credentialSource = "flag";
    credentialKind = "api_key";
  } else if (!PLACEHOLDER_KEYS.has(envKey)) {
    apiKey = envKey;
    credentialSource = "env";
    credentialKind = "api_key";
  } else {
    // A corrupt credentials file throws out of resolveStoredCredential rather
    // than being swallowed into "not logged in" — see credentials.ts.
    const stored = resolveStoredCredential(credFile);
    const secret = stored?.apiKey ?? stored?.accessToken ?? "";
    if (stored && !PLACEHOLDER_KEYS.has(secret)) {
      apiKey = secret;
      credentialSource = "file";
      credentialProfile = stored.profile;
      credentialKind = stored.kind;
    } else {
      throw authRequiredError(
        "No credentials found. Pass --api-key, export MESHY_API_KEY, or log in.",
      );
    }
  }

  const cfg: MeshyConfig = {
    apiKey,
    baseUrlV1,
    baseUrlV2,
    connectTimeoutMs: readNumber("MESHY_CONNECT_TIMEOUT_MS", 10_000),
    readTimeoutMs: readNumber("MESHY_READ_TIMEOUT_MS", 120_000),
    pollIntervalMs: readNumber("MESHY_POLL_INTERVAL_MS", 3_000),
    logLevel: overrides.logLevel ?? readLogLevel("warn"),
    credentialSource,
    credentialProfile,
    credentialsFile: credFile,
    credentialKind,
  };

  setLogLevel(cfg.logLevel);
  return cfg;
}
