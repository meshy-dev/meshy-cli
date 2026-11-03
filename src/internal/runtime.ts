/**
 * Execution contexts.
 *
 *   buildRuntime      — authenticated API runtime: resolves config (flags →
 *                       env → env-file → stored profile), silently refreshes an
 *                       expiring OAuth token, constructs the client. Built per
 *                       call; nothing is cached across invocations so tests and
 *                       chained commands never see a stale key/URL/format.
 *   buildLocalRuntime — local runtime for commands that must work without a
 *                       credential or network: never touches the credential
 *                       store, never refreshes anything.
 */

import { dirname } from "node:path";
import { Command } from "commander";
import { looksLikeFile } from "./paths.js";
import { MeshyClient } from "../client/index.js";
import { loadConfig, type ConfigOverrides, type MeshyConfig } from "./config.js";
import { acquireCredentialsLock, credentialsPath, profileSecrets, readCredentials, storeWritable, updateCredentialsHeld } from "./credentials.js";
import { withExitHeld } from "./context.js";
import { authRequiredError, HintedError, UsageError } from "./errors.js";
import { logger, setLogLevel } from "./logger.js";
import { refreshTokens } from "./oauth.js";
import type { LogLevel } from "./logger.js";
import { defaultOutputFormat, parseOutputFormat, type OutputFormat } from "./output.js";

export interface GlobalFlags {
  apiKey?: string;
  baseUrlV1?: string;
  baseUrlV2?: string;
  baseUrlCreativeLab?: string;
  format: OutputFormat;
  /** true when --format/--json was actually typed; false when format came from the TTY default. */
  formatExplicit: boolean;
  json?: boolean;
  output?: string;
  /** --all-assets: `-o <dir>` saves every artifact of the task, not just the primary set. */
  allAssets: boolean;
  /** Path given to --api-key-file (only MESHY_API_KEY is read from it). */
  envFile?: string;
  /** --workspace: every file the command writes must resolve inside it. */
  workspace?: string;
  /** false when --no-update-check was given. */
  updateCheck: boolean;
  verbose: boolean;
  logLevel?: LogLevel;
}

export interface Runtime {
  readonly flags: GlobalFlags;
  readonly config: MeshyConfig;
  readonly client: MeshyClient;
}

export interface LocalRuntime {
  readonly flags: GlobalFlags;
}

/**
 * Refresh an OAuth credential this far ahead of expiry. Every command then
 * starts with at least this long left, so a long `wait` does not outlive its
 * token, and a host app that re-reads the token on a schedule shorter than
 * this always hands out one with time to spare.
 */
export const REFRESH_SKEW_MS = 30 * 60_000;

/**
 * Silently refresh an OAuth credential when it is near expiry or already
 * expired, then return the config to use (refreshed+reloaded, or original).
 *
 * No-ops unless:
 *   - credentialSource === "file"
 *   - the active profile is kind "oauth" with a refresh_token
 *   - the access_token expires within REFRESH_SKEW_MS (or is already past)
 *
 * When the store cannot be written here (a sandboxed agent shell), the
 * refresh is skipped: the API rotates the refresh token on use, so a refresh
 * whose result cannot be saved spends the stored token, and the next attempt
 * ends the login. A still-valid token is used as-is; an expired one is an
 * auth error that says where to refresh it instead.
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
  if (!profile || profile.kind !== "oauth") return config;

  const expiresAt = profile.expires_at ?? 0;
  const needsRefresh = expiresAt - Date.now() < REFRESH_SKEW_MS;
  if (!needsRefresh) return config;

  const secrets = profileSecrets(credFile, profile);
  if (!secrets.refresh_token || !secrets.access_token) return config;

  const alreadyExpired = expiresAt <= Date.now();
  if (!storeWritable(credFile)) {
    if (!alreadyExpired) return config;
    throw new HintedError({
      message: `The OAuth token expired, and ${dirname(credFile)} is not writable here, so it was not refreshed; the stored login is kept.`,
      code: "unauthenticated",
      hint: `Run any meshy command where ${dirname(credFile)} is writable (outside the sandbox) to refresh it, then retry.`,
    });
  }

  // Snapshot the access token we started with so we can detect a
  // concurrent rotation after a refresh failure (B3).
  const originalAccessToken = secrets.access_token;
  const profileName = config.credentialProfile;

  // The whole refresh runs under the store's lock, so concurrent CLI
  // processes refresh once between them: whoever waited re-reads the store
  // and finds the new token instead of spending the refresh token again.
  const release = acquireCredentialsLock(credFile);
  try {
    const current = readCredentials(credFile)?.profiles[profileName];
    const refreshToken = current?.kind === "oauth" ? profileSecrets(credFile, current).refresh_token : undefined;
    if (current && (current.expires_at ?? 0) - Date.now() >= REFRESH_SKEW_MS) {
      logger.debug("OAuth token already refreshed by another process");
    } else if (current && refreshToken) await withExitHeld(async () => {
      const tok = await refreshTokens({ baseUrlV1: config.baseUrlV1, refreshToken });
      // Write back: preserve profile name, created_at, region and account.
      updateCredentialsHeld(credFile, (state) => {
        state.profiles[profileName] = {
          kind: "oauth",
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: Date.now() + tok.expires_in * 1000,
          user_id: tok.user_id ?? current.user_id,
          ...(current.login_id ? { login_id: current.login_id } : {}),
          ...(current.region ? { region: current.region } : {}),
          ...(current.account ? { account: current.account } : {}),
          created_at: current.created_at ?? Date.now(),
        };
      });
    });
  } catch (err) {
    // B3: Read-after-write — a CLI before 0.8.1 refreshes outside the lock
    // and may already have rotated the token (server-side refresh-token
    // rotation). Re-read the file; if the active profile now holds a
    // DIFFERENT access token that is comfortably unexpired (>REFRESH_SKEW_MS),
    // adopt it and proceed rather than failing the command.
    const afterFailure = readCredentials(credFile);
    const afterProfile = profileName ? afterFailure?.profiles[profileName] : undefined;
    const afterToken = afterProfile?.kind === "oauth" ? profileSecrets(credFile, afterProfile).access_token : undefined;
    if (
      afterToken &&
      afterToken !== originalAccessToken &&
      (afterProfile?.expires_at ?? 0) - Date.now() > REFRESH_SKEW_MS
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
  } finally {
    release();
  }
  // Re-run loadConfig so the caller carries the token now in the store.
  return loadConfig(overrides);
}

export function configOverridesFrom(flags: GlobalFlags): ConfigOverrides {
  return {
    apiKey: flags.apiKey,
    baseUrlV1: flags.baseUrlV1,
    baseUrlV2: flags.baseUrlV2,
    baseUrlCreativeLab: flags.baseUrlCreativeLab,
    envFile: flags.envFile,
    logLevel: flags.verbose ? "debug" : flags.logLevel,
  };
}

/**
 * Build the authenticated runtime for this invocation.
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
  const overrides = configOverridesFrom(flags);
  const config = await refreshOAuthCredentialIfNeeded(loadConfig(overrides), overrides);
  const client = new MeshyClient(config);
  return { flags, config, client };
}

/** Runtime for commands that need neither a credential nor the API. */
export function buildLocalRuntime(flags: GlobalFlags): LocalRuntime {
  const envLevel = (process.env.MESHY_LOG_LEVEL || "").toLowerCase();
  const fallback: LogLevel =
    envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error" || envLevel === "silent"
      ? (envLevel as LogLevel)
      : "warn";
  setLogLevel(flags.verbose ? "debug" : flags.logLevel ?? fallback);
  return { flags };
}

/** Pull the resolved global flags from the top-level command. */
export function readGlobalFlags(cmd: Command): GlobalFlags {
  const opts = cmd.optsWithGlobals<{
    apiKey?: string;
    baseUrlV1?: string;
    baseUrlV2?: string;
    baseUrlCreativeLab?: string;
    format?: string;
    json?: boolean;
    output?: string;
    allAssets?: boolean;
    apiKeyFile?: string;
    envFile?: string;
    workspace?: string;
    updateCheck?: boolean;
    verbose?: boolean;
    logLevel?: string;
  }>();
  if (opts.envFile !== undefined) {
    throw new UsageError(
      "--env-file is intercepted by Node.js itself (it loads the whole file into the environment before meshy-cli starts and exits 9 when the file is missing). Use --api-key-file <path>; only MESHY_API_KEY is read from it.",
    );
  }
  // --all-assets only widens what -o saves into a directory; anywhere else it
  // would be silently ignored, so it is refused before any request.
  if (opts.allAssets && !opts.output) {
    throw new UsageError("--all-assets only changes what -o/--output <dir> saves; pass it together with -o (meshy download selects with --all)");
  }
  if (opts.allAssets && opts.output && looksLikeFile(opts.output)) {
    throw new UsageError(`--all-assets saves every file of the task and needs a directory — '${opts.output}' looks like a file`);
  }
  // --json is an alias for --format json; --json wins if both are set.
  // Untyped --format resolves against the TTY (see output.ts); remember that it
  // was untyped, because a file write must stay JSON no matter what the
  // terminal would have shown.
  const formatExplicit = opts.json === true || opts.format !== undefined;
  const format = resolveFormat(opts);
  return {
    apiKey: opts.apiKey,
    baseUrlV1: opts.baseUrlV1,
    baseUrlV2: opts.baseUrlV2,
    baseUrlCreativeLab: opts.baseUrlCreativeLab,
    format,
    formatExplicit,
    json: opts.json,
    output: opts.output,
    allAssets: opts.allAssets === true,
    envFile: opts.apiKeyFile,
    workspace: opts.workspace,
    updateCheck: opts.updateCheck !== false,
    verbose: Boolean(opts.verbose),
    logLevel: normalizeLogLevel(opts.logLevel),
  };
}

/** `--json` wins; a typed `--format` is honoured; untyped follows the TTY. */
export function resolveFormat(
  opts: { format?: string; json?: boolean },
  isTTY: boolean = Boolean(process.stdout.isTTY),
): OutputFormat {
  if (opts.json) return "json";
  if (opts.format === undefined) return defaultOutputFormat(isTTY);
  return parseOutputFormat(opts.format);
}

function normalizeLogLevel(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "silent") return v;
  throw new Error(`invalid --log-level '${raw}'. Expected: debug | info | warn | error | silent`);
}
