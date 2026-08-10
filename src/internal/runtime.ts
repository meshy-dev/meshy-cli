/**
 * Shared execution context bound to the root command — lazy-loads the client
 * so sub-commands that don't need credentials (e.g. --help) still work.
 *
 * buildRuntime is async so it can silently refresh an expiring OAuth token
 * before constructing the client. All callers are async command actions.
 */

import { Command } from "commander";
import { MeshyClient } from "../client/index.js";
import { loadConfig, type ConfigOverrides, type MeshyConfig } from "./config.js";
import { credentialsPath, readCredentials, saveProfile } from "./credentials.js";
import { authRequiredError } from "./errors.js";
import { logger } from "./logger.js";
import { refreshTokens } from "./oauth.js";
import type { LogLevel } from "./logger.js";
import type { OutputFormat } from "./output.js";

export interface GlobalFlags {
  apiKey?: string;
  baseUrlV1?: string;
  baseUrlV2?: string;
  format: OutputFormat;
  json?: boolean;
  output?: string;
  verbose: boolean;
  logLevel?: LogLevel;
}

export interface Runtime {
  readonly flags: GlobalFlags;
  readonly config: MeshyConfig;
  readonly client: MeshyClient;
}

let cached: Runtime | null = null;

/** 60-second skew window: refresh if token expires within this many ms. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Silently refresh an OAuth credential when it is near expiry or already
 * expired, then return the config to use (refreshed+reloaded, or original).
 *
 * No-ops unless:
 *   - credentialSource === "file"
 *   - the active profile is kind "oauth" with a refresh_token
 *   - the access_token expires within REFRESH_SKEW_MS (or is already past)
 *
 * On a successful refresh the new tokens are written back to the credentials
 * file and loadConfig is re-run so the returned config carries the fresh token.
 *
 * On refresh failure:
 *   - B3 concurrent-rotation check: if another process already rotated the
 *     token (different access_token in the file, comfortably unexpired), adopt
 *     it and proceed.
 *   - Token already expired and no rotation detected → throws authRequiredError.
 *   - Token still valid and no rotation detected → swallows, returns original.
 *
 * `overrides` must be the same ConfigOverrides used to produce `config` so
 * that loadConfig re-runs with identical flag/env inputs.
 */
export async function refreshOAuthCredentialIfNeeded(
  config: MeshyConfig,
  overrides: ConfigOverrides,
): Promise<MeshyConfig> {
  if (config.credentialSource !== "file" || !config.credentialProfile) {
    return config;
  }

  const credFile = credentialsPath(config.baseUrlV1);
  const stored = readCredentials(credFile);
  const profile = stored?.profiles[config.credentialProfile];

  if (
    !profile ||
    profile.kind !== "oauth" ||
    !profile.refresh_token ||
    !profile.access_token
  ) {
    return config;
  }

  const expiresAt = profile.expires_at ?? 0;
  const needsRefresh = expiresAt - Date.now() < REFRESH_SKEW_MS;
  if (!needsRefresh) return config;

  const alreadyExpired = expiresAt <= Date.now();
  // Snapshot the access token we started with so we can detect a
  // concurrent rotation after a refresh failure (B3).
  const originalAccessToken = profile.access_token;
  const profileName = config.credentialProfile;

  try {
    const tok = await refreshTokens({
      baseUrlV1: config.baseUrlV1,
      refreshToken: profile.refresh_token,
    });
    // Write back: preserve profile name and created_at, update tokens.
    saveProfile(
      credFile,
      profileName,
      {
        kind: "oauth",
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: Date.now() + tok.expires_in * 1000,
        user_id: tok.user_id ?? profile.user_id,
        created_at: profile.created_at,
      },
      { makeActive: false },
    );
    // Re-run loadConfig so the caller carries the fresh token.
    return loadConfig(overrides);
  } catch (err) {
    // B3: Read-after-write — another concurrent CLI process may have
    // already rotated the token (server-side refresh-token rotation).
    // Re-read the file; if the active profile now holds a DIFFERENT
    // access token that is comfortably unexpired (>REFRESH_SKEW_MS),
    // adopt it and proceed rather than failing the command.
    const afterFailure = readCredentials(credFile);
    const afterProfile = profileName ? afterFailure?.profiles[profileName] : undefined;
    if (
      afterProfile?.kind === "oauth" &&
      afterProfile.access_token &&
      afterProfile.access_token !== originalAccessToken &&
      (afterProfile.expires_at ?? 0) - Date.now() > REFRESH_SKEW_MS
    ) {
      // Another process already rotated — adopt the new token.
      logger.debug("OAuth refresh failed but concurrent rotation detected; adopting new token");
      return loadConfig(overrides);
    } else if (alreadyExpired) {
      throw authRequiredError(
        "OAuth token expired and refresh failed. Run: meshy auth login",
      );
    } else {
      // Unexpired token, no concurrent rotation: swallow and proceed.
      logger.debug("OAuth refresh failed (token still valid, proceeding)", err);
      return config;
    }
  }
}

/**
 * Build (or return the cached) runtime context.
 *
 * When the active credential is an OAuth profile with a refresh_token and the
 * access_token is within REFRESH_SKEW_MS of expiry (or already expired), this
 * silently refreshes the token, writes the new tokens back to the credentials
 * file, and re-runs loadConfig so the client carries the fresh token.
 *
 * Refresh network/5xx failures with an unexpired token are swallowed (debug-
 * logged only) so they never fail the command. If the token is already expired
 * and refresh fails, throws authRequiredError pointing at `meshy auth login`.
 */
export async function buildRuntime(flags: GlobalFlags): Promise<Runtime> {
  if (cached) return cached;

  const overrides: ConfigOverrides = {
    apiKey: flags.apiKey,
    baseUrlV1: flags.baseUrlV1,
    baseUrlV2: flags.baseUrlV2,
    logLevel: flags.verbose ? "debug" : flags.logLevel,
  };

  const config = await refreshOAuthCredentialIfNeeded(loadConfig(overrides), overrides);

  const client = new MeshyClient(config);
  cached = { flags, config, client };
  return cached;
}

/** Pull the resolved global flags from the top-level command. */
export function readGlobalFlags(cmd: Command): GlobalFlags {
  const opts = cmd.optsWithGlobals<{
    apiKey?: string;
    baseUrlV1?: string;
    baseUrlV2?: string;
    format?: string;
    json?: boolean;
    output?: string;
    verbose?: boolean;
    logLevel?: string;
  }>();
  // --json is an alias for --format json; --json wins if both are set.
  const format = opts.json ? "json" : normalizeFormat(opts.format);
  return {
    apiKey: opts.apiKey,
    baseUrlV1: opts.baseUrlV1,
    baseUrlV2: opts.baseUrlV2,
    format,
    json: opts.json,
    output: opts.output,
    verbose: Boolean(opts.verbose),
    logLevel: normalizeLogLevel(opts.logLevel),
  };
}

function normalizeFormat(raw: string | undefined): OutputFormat {
  const v = (raw ?? "json").toLowerCase();
  if (v === "json" || v === "pretty" || v === "ndjson") return v;
  throw new Error(`invalid --format '${raw}'. Expected: json | pretty | ndjson`);
}

function normalizeLogLevel(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "silent") return v;
  throw new Error(`invalid --log-level '${raw}'. Expected: debug | info | warn | error | silent`);
}
