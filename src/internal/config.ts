/**
 * Resolve config in this priority order:
 *   1. CLI flags (--api-key, --base-url-v1, --base-url-v2, --base-url-creative-lab, --verbose)
 *   2. Environment variables (MESHY_*)
 *   3. An explicit --api-key-file (only MESHY_API_KEY is read from it)
 *   4. The active profile in the credentials file (written by `meshy auth login`)
 *   5. Built-in defaults
 *
 * The env var keeps priority over the stored credential on purpose: CI and
 * containers export MESHY_API_KEY and must not be silently overridden by
 * whatever a developer once logged into on that machine.
 *
 * An empty or placeholder --api-key / MESHY_API_KEY counts as "unset": CI and
 * the runtime tests rely on `MESHY_API_KEY=""` meaning "fall through to the
 * stored profile". An explicit --api-key-file is different:
 * naming a file is an instruction, so an unreadable, malformed or key-less
 * file is an error, never a fall-through to another account.
 *
 * Fail-fast on a missing/placeholder credential — with the command that fixes
 * it attached, not just a complaint.
 */

import { credentialsPath, readCredentials, resolveStoredCredential, type CredentialKind } from "./credentials.js";
import { loadEnvFile } from "./env-file.js";
import { authRequiredError, CliError, UsageError } from "./errors.js";
import { setLogLevel, type LogLevel } from "./logger.js";

const PLACEHOLDER_KEYS = new Set(["", "YOUR_MESHY_API_KEY_HERE"]);

/** Meshy's two sites share accounts; only the API and sign-in hosts differ. */
export const REGIONS = {
  global: { api: "https://api.meshy.ai", web: "https://www.meshy.ai" },
  cn: { api: "https://api.meshy.cn", web: "https://meshy.cn" },
} as const;
export type Region = keyof typeof REGIONS;

export function parseRegion(raw: string, source: string): Region {
  if (raw === "global" || raw === "cn") return raw;
  throw new UsageError(`${source} must be global or cn, got '${raw}'`);
}

/**
 * MESHY_REGION, else the region the active stored profile logged in to, else
 * global. An unreadable credentials file is left for loadConfig to report.
 */
export function resolveRegion(env: NodeJS.ProcessEnv = process.env): Region {
  const raw = env["MESHY_REGION"]?.trim();
  if (raw) return parseRegion(raw, "MESHY_REGION");
  try {
    const state = readCredentials(credentialsPath(undefined, env));
    return state?.profiles[state.active_profile]?.region === "cn" ? "cn" : "global";
  } catch {
    return "global";
  }
}

/** The v1 / v2 API bases of a region, the defaults under every explicit base URL. */
export function regionBaseUrls(region: Region): { v1: string; v2: string } {
  return { v1: `${REGIONS[region].api}/openapi/v1`, v2: `${REGIONS[region].api}/openapi/v2` };
}

/** The region a v1 base URL is on: cn for the China API host, otherwise none. */
export function regionOf(baseUrlV1: string): "cn" | undefined {
  return originOf(baseUrlV1) === REGIONS.cn.api ? "cn" : undefined;
}

/** Where the credential in use came from — surfaced by `meshy auth status`. */
export type CredentialSource = "flag" | "env" | "env-file" | "file";

export interface MeshyConfig {
  apiKey: string;
  baseUrlV1: string;
  baseUrlV2: string;
  /**
   * Creative Lab base. Derived from the v1 origin when v1 uses the standard
   * `/openapi/v1` path; null when it cannot be derived and no explicit
   * override was given (commands that need it then ask for one).
   */
  baseUrlCreativeLab: string | null;
  /** Public, unauthenticated catalog base: `<v1 origin>/web/public`. */
  publicWebBase: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  pollIntervalMs: number;
  logLevel: LogLevel;
  credentialSource: CredentialSource;
  /** Set only when credentialSource === "file". */
  credentialProfile?: string;
  /** Set only when credentialSource === "env-file" (the --api-key-file path). */
  envFilePath?: string;
  /** The credentials file consulted for this invocation, whether or not it exists. */
  credentialsFile: string;
  /**
   * The kind of credential in use — "oauth" for browser-login tokens, "api_key" for static keys.
   * "api_key" when credentialSource is "flag", "env" or "env-file" (those paths only accept static keys).
   * Derived from the stored profile kind when credentialSource is "file".
   */
  credentialKind: CredentialKind;
  /**
   * Stable account subject for an OAuth profile (user id), used to bind the
   * operation journal to the account rather than to a rotating token. Unset for
   * API keys (the key itself is digested) and for profiles without a user id.
   */
  credentialSubject?: string;
  /** Per-login identifier of an OAuth profile (minted at `auth login`), the fallback identity when no user id exists. */
  credentialLoginId?: string;
}

export interface ConfigOverrides {
  apiKey?: string;
  baseUrlV1?: string;
  baseUrlV2?: string;
  baseUrlCreativeLab?: string;
  envFile?: string;
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

/** Origin (scheme://host[:port]) of a base URL, or null when it does not parse. */
export function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Derive the Creative Lab base from the v1 base. Only the standard
 * `<origin>/openapi/v1` layout is derivable; a custom proxy path makes the
 * derivation a guess, and a guessed base must never fall back to production.
 */
export function deriveCreativeLabBase(baseUrlV1: string): string | null {
  try {
    const u = new URL(baseUrlV1);
    if (u.pathname.replace(/\/+$/, "") !== "/openapi/v1") return null;
    return `${u.origin}/openapi/creative-lab`;
  } catch {
    return null;
  }
}

export function derivePublicWebBase(baseUrlV1: string): string {
  const origin = originOf(baseUrlV1) ?? "https://api.meshy.ai";
  return `${origin}/web/public`;
}

export function loadConfig(overrides: ConfigOverrides = {}): MeshyConfig {
  // Base URLs resolve first: they decide which credentials file applies
  // (production vs. a staging override).
  const regionBase = regionBaseUrls(resolveRegion());
  const baseUrlV1 = stripTrail(
    overrides.baseUrlV1 ?? process.env.MESHY_BASE_URL_V1 ?? regionBase.v1,
  );
  const baseUrlV2 = stripTrail(
    overrides.baseUrlV2 ?? process.env.MESHY_BASE_URL_V2 ?? regionBase.v2,
  );
  const explicitCreativeLab = overrides.baseUrlCreativeLab ?? process.env.MESHY_BASE_URL_CREATIVE_LAB;
  const baseUrlCreativeLab = explicitCreativeLab
    ? stripTrail(explicitCreativeLab)
    : deriveCreativeLabBase(baseUrlV1);
  const credFile = credentialsPath(baseUrlV1);

  const flagKey = overrides.apiKey?.trim() ?? "";
  const envKey = process.env.MESHY_API_KEY?.trim() ?? "";

  // An explicit env file is validated even when a higher-priority key wins:
  // the user named it, so a broken file is a mistake worth reporting now.
  let envFileKey = "";
  let envFilePath: string | undefined;
  if (overrides.envFile) {
    const loaded = loadEnvFile(overrides.envFile);
    envFilePath = loaded.path;
    envFileKey = loaded.apiKey?.trim() ?? "";
  }

  let apiKey = "";
  let credentialSource: CredentialSource = "flag";
  let credentialProfile: string | undefined;
  let credentialKind: CredentialKind = "api_key";
  let credentialSubject: string | undefined;
  let credentialLoginId: string | undefined;

  if (!PLACEHOLDER_KEYS.has(flagKey)) {
    apiKey = flagKey;
    credentialSource = "flag";
    credentialKind = "api_key";
  } else if (!PLACEHOLDER_KEYS.has(envKey)) {
    apiKey = envKey;
    credentialSource = "env";
    credentialKind = "api_key";
  } else if (overrides.envFile) {
    if (PLACEHOLDER_KEYS.has(envFileKey)) {
      throw new CliError({
        code: "auth",
        message: `--api-key-file ${overrides.envFile} does not define a usable MESHY_API_KEY (missing, empty or placeholder). Fix the file or drop --api-key-file to use another credential source.`,
      });
    }
    apiKey = envFileKey;
    credentialSource = "env-file";
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
      credentialSubject = stored.userId;
      credentialLoginId = stored.loginId;
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
    baseUrlCreativeLab,
    publicWebBase: derivePublicWebBase(baseUrlV1),
    connectTimeoutMs: readNumber("MESHY_CONNECT_TIMEOUT_MS", 10_000),
    readTimeoutMs: readNumber("MESHY_READ_TIMEOUT_MS", 120_000),
    pollIntervalMs: readNumber("MESHY_POLL_INTERVAL_MS", 3_000),
    logLevel: overrides.logLevel ?? readLogLevel("warn"),
    credentialSource,
    credentialProfile,
    envFilePath,
    credentialsFile: credFile,
    credentialKind,
    credentialSubject,
    credentialLoginId,
  };

  setLogLevel(cfg.logLevel);
  return cfg;
}

/**
 * Stored profiles were issued for the v1 origin they were resolved against.
 * A different Creative Lab origin only receives an explicitly supplied key.
 */
export function assertCredentialAllowedForOrigin(cfg: MeshyConfig, targetBase: string, label: string): void {
  if (cfg.credentialSource !== "file") return;
  const v1Origin = originOf(cfg.baseUrlV1);
  const targetOrigin = originOf(targetBase);
  if (v1Origin && targetOrigin && v1Origin === targetOrigin) return;
  throw new CliError({
    code: "auth",
    message:
      `${label} base ${targetBase} is on a different origin than the v1 API (${cfg.baseUrlV1}); ` +
      "the stored profile is not sent there. Pass --api-key, MESHY_API_KEY or --api-key-file for that origin.",
  });
}
