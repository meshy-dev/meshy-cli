/**
 * auth — inspect and manage stored credentials.
 *
 * These subcommands cannot go through buildRuntime(): it calls loadConfig(),
 * which throws when there is no credential yet, and "there is no credential
 * yet" is exactly the state `auth login` and `auth status` exist to handle.
 * They resolve config themselves instead.
 *
 * Login modes:
 *   - loopback (default on GUI): browser-based OAuth + PKCE callback server
 *   - manual (--manual): PKCE + OOB redirect_uri, user pastes code
 *   - device (--device or headless auto): RFC 8628 device authorization grant
 *   - no-wait (--no-wait): device flow stage 1 only, emits flow_id and exits
 *   - resume (--device-flow <id> / --device-code <code>): poll a saved flow
 *   - --with-key: store an existing API key
 */

import * as readline from "node:readline";
import { Command } from "commander";
import { MeshyClient, MeshyApiError } from "../client/index.js";
import { loadConfig } from "../internal/config.js";
import {
  credentialsPath,
  deleteCredentialsFile,
  maskSecret,
  readCredentials,
  removeProfile,
  saveProfile,
  setActiveProfile,
  DEFAULT_PROFILE,
} from "../internal/credentials.js";
import {
  deviceAuthorization,
  DeviceFlowNotSupportedError,
  ensureRequestedScopesGranted,
  pollDeviceToken,
} from "../internal/device.js";
import {
  deleteDeviceFlow,
  deviceFlowsPath,
  generateFlowId,
  loadDeviceFlowByDeviceCode,
  loadDeviceFlowByFlowId,
  saveDeviceFlow,
} from "../internal/device-state.js";
import { CREDENTIAL_REJECTED_HINT, EXIT_CODES, HintedError, SESSION_REVOKED_HINT, UsageError } from "../internal/errors.js";
import { detectHeadless, resolveLoginMode } from "../internal/headless.js";
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  openBrowser,
  startCallbackServer,
} from "../internal/oauth.js";
import { emit } from "../internal/output.js";
import { readGlobalFlags, refreshOAuthCredentialIfNeeded, type GlobalFlags } from "../internal/runtime.js";

/** OOB redirect URI for manual flow (RFC 8252 §4.5 / RFC 6749 §4.1.2). */
const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

/** Prompt timeout for manual code entry (5 minutes, matching server code TTL). */
const MANUAL_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/** Base URLs matter here only because they select the credentials file. */
function resolveFile(flags: GlobalFlags): string {
  const baseUrlV1 =
    flags.baseUrlV1 ?? process.env["MESHY_BASE_URL_V1"] ?? "https://api.meshy.ai/openapi/v1";
  return credentialsPath(baseUrlV1.replace(/\/+$/, ""));
}

function resolveBaseUrlV1(flags: GlobalFlags): string {
  return (
    flags.baseUrlV1 ??
    process.env["MESHY_BASE_URL_V1"] ??
    "https://api.meshy.ai/openapi/v1"
  ).replace(/\/+$/, "");
}

function clientForKey(flags: GlobalFlags, apiKey: string): MeshyClient {
  const config = loadConfig({
    apiKey,
    baseUrlV1: flags.baseUrlV1,
    baseUrlV2: flags.baseUrlV2,
    logLevel: flags.verbose ? "debug" : flags.logLevel,
  });
  return new MeshyClient(config);
}

/**
 * Validate --port: must be an integer in [1, 65535].
 * parseInt silently accepts "123abc"/"1.5"/"0x10" — use Number() + isInteger.
 */
function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(
      `--port must be an integer between 1 and 65535 (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

/**
 * Shared tail: save profile, optionally verify balance, emit logged_in.
 */
async function finishLogin(
  flags: GlobalFlags,
  opts: { profile: string; verify: boolean },
  tok: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user_id?: string;
  },
): Promise<void> {
  const file = resolveFile(flags);
  const profileData = {
    kind: "oauth" as const,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    ...(tok.user_id ? { user_id: tok.user_id } : {}),
  };
  const credState = saveProfile(file, opts.profile, profileData);

  let balance: unknown;
  let verifyOutcome: boolean = !opts.verify;
  let verifyHint: string | undefined;
  if (opts.verify) {
    try {
      balance = await clientForKey(flags, tok.access_token).balance.get();
      verifyOutcome = true;
    } catch {
      verifyOutcome = false;
      verifyHint =
        "Credential stored but balance check failed — re-check with: meshy auth status";
    }
  }

  emit(
    {
      status: "logged_in",
      kind: "oauth",
      profile: opts.profile,
      active_profile: credState.active_profile,
      credential: maskSecret(tok.access_token),
      credentials_file: file,
      verified: verifyOutcome,
      ...(balance === undefined ? {} : { balance }),
      ...(verifyHint !== undefined ? { hint: verifyHint } : {}),
    },
    { format: flags.format, file: flags.output },
  );
}

// ---------------------------------------------------------------------------
// auth login
// ---------------------------------------------------------------------------

const loginCommand = new Command("login")
  .description(
    "Log in to Meshy (default: browser-based OAuth; use --with-key to paste an API key)",
  )
  .option("--with-key <key>", "store an existing API key (msy_...)")
  .option("--port <n>", "loopback port for the OAuth callback (default 8765)", "8765")
  .option("--profile <name>", "profile to write", DEFAULT_PROFILE)
  .option("--no-verify", "skip the balance call that proves the credential works")
  .option("--manual", "manual PKCE flow: print URL, prompt for code (no loopback server)")
  .option("--device", "device authorization flow (RFC 8628)")
  .option("--no-wait", "start device flow, emit flow_id, exit without polling")
  .option("--device-flow <id>", "resume a device flow by flow_id")
  .option("--device-code <code>", "resume a device flow by device_code")
  .action(
    async (
      opts: {
        withKey?: string;
        port: string;
        profile: string;
        verify: boolean;
        manual?: boolean;
        device?: boolean;
        /** Commander maps --no-wait to opts.wait = false */
        wait: boolean;
        deviceFlow?: string;
        deviceCode?: string;
      },
      thisCmd: Command,
    ) => {
      const flags = readGlobalFlags(thisCmd);

      // --with-key path: validate and store an existing API key.
      if (opts.withKey !== undefined && opts.withKey.trim() === "") {
        throw new UsageError(
          "--with-key requires a non-empty API key (msy_...) — pass a key or omit the flag to use the browser flow",
        );
      }

      const key = opts.withKey?.trim();
      if (key) {
        let balance: unknown;
        if (opts.verify) {
          balance = await clientForKey(flags, key).balance.get();
        }

        const file = resolveFile(flags);
        const state = saveProfile(file, opts.profile, { kind: "api_key", api_key: key });

        emit(
          {
            status: "logged_in",
            profile: opts.profile,
            active_profile: state.active_profile,
            credential: maskSecret(key),
            credentials_file: file,
            verified: opts.verify,
            ...(balance === undefined ? {} : { balance }),
          },
          { format: flags.format, file: flags.output },
        );
        return;
      }

      // Validate --port early (before mode selection) so invalid values always
      // produce a UsageError (exit 2) regardless of which mode is selected.
      // The port value is only used in loopback mode, but the validation must
      // happen unconditionally so existing tests that pass --port with an
      // invalid value get exit 2 even in headless environments.
      const _validatedPort = parsePort(opts.port);
      void _validatedPort;

      const baseUrlV1 = resolveBaseUrlV1(flags);
      const authorizeBase =
        process.env["MESHY_OAUTH_AUTHORIZE_URL"] ?? "https://www.meshy.ai/oauth/authorize";

      // Resolve login mode.
      const mode = resolveLoginMode({
        manual: opts.manual,
        device: opts.device,
        noWait: !opts.wait,
        deviceFlow: opts.deviceFlow,
        deviceCode: opts.deviceCode,
      });

      // Notify when headless auto-selected device mode.
      if (!opts.manual && !opts.device && opts.wait && !opts.deviceFlow && !opts.deviceCode) {
        if (mode === "device" && detectHeadless()) {
          process.stderr.write(
            "Headless environment detected — using device login flow.\n",
          );
        }
      }

      // -----------------------------------------------------------------------
      // Resume mode: --device-flow <id> or --device-code <code>
      // -----------------------------------------------------------------------
      if (mode === "resume") {
        const flowsFile = deviceFlowsPath();
        let cachedEntry =
          opts.deviceFlow
            ? loadDeviceFlowByFlowId(opts.deviceFlow, flowsFile)
            : opts.deviceCode
              ? loadDeviceFlowByDeviceCode(opts.deviceCode, flowsFile)
              : null;

        let resumeBaseUrlV1: string;
        let resumeDeviceCode: string;
        let resumeInterval: number;
        let resumeDeadline: number | undefined;
        let resumeScope: string | undefined;
        let hasCachedFlow: boolean;

        if (cachedEntry) {
          hasCachedFlow = true;
          resumeBaseUrlV1 = cachedEntry.base_url_v1;
          resumeDeviceCode = cachedEntry.device_code;
          resumeInterval = cachedEntry.interval;
          resumeDeadline = cachedEntry.expires_at;
          resumeScope = cachedEntry.scope || undefined;
        } else if (opts.deviceFlow) {
          // --device-flow cache miss: the flow ID is opaque to the server —
          // we cannot poll without the underlying device_code. Fail clearly.
          throw new UsageError(
            `No cached device flow for id "${opts.deviceFlow}"; it may have expired or been consumed. ` +
              "Start a new flow with: meshy auth login --no-wait",
          );
        } else {
          // --device-code cache miss: the user supplied a raw device_code
          // directly, so we can attempt a degraded poll without cached metadata.
          hasCachedFlow = false;
          process.stderr.write(
            "No cached flow found; scope verification and saved settings unavailable.\n",
          );
          resumeBaseUrlV1 = baseUrlV1;
          resumeDeviceCode = opts.deviceCode ?? "";
          resumeInterval = 5;
          // Hard 15-minute poll cap for cache-miss resume.
          resumeDeadline = Date.now() + 15 * 60 * 1000;
          resumeScope = undefined;
        }

        const tok = await pollDeviceToken(resumeBaseUrlV1, resumeDeviceCode, {
          interval: resumeInterval,
          expiresIn: 600, // fallback; deadline overrides
          deadline: resumeDeadline,
        });

        if (hasCachedFlow && resumeScope !== undefined) {
          ensureRequestedScopesGranted(resumeScope, tok.scope);
        }

        // Delete the cached flow now that it's consumed.
        if (cachedEntry) {
          deleteDeviceFlow(cachedEntry.flow_id, flowsFile);
        }

        await finishLogin(flags, { profile: opts.profile, verify: opts.verify }, tok);
        return;
      }

      // -----------------------------------------------------------------------
      // Device flow (--device or headless auto)
      // -----------------------------------------------------------------------
      if (mode === "device" || mode === "no-wait") {
        let deviceResp;
        try {
          deviceResp = await deviceAuthorization(baseUrlV1);
        } catch (err) {
          if (err instanceof DeviceFlowNotSupportedError) {
            // --no-wait is a contract with agent harnesses: emit the
            // device_flow_started payload and exit immediately. Falling back
            // to the blocking loopback flow would hang the caller, so a 404
            // here is always a hard error in no-wait mode — even on GUI
            // hosts. (Explicit --device / headless auto still falls back.)
            if (mode !== "no-wait" && !detectHeadless()) {
              process.stderr.write(
                "Device flow not supported by this server — falling back to browser login.\n",
              );
              // Fall through to loopback below.
              await runLoopbackFlow(flags, opts, baseUrlV1, authorizeBase);
              return;
            }
            throw err;
          }
          throw err;
        }

        process.stderr.write(
          `Enter code ${deviceResp.user_code} at ${deviceResp.verification_uri}\n`,
        );
        if (!detectHeadless()) {
          await openBrowser(deviceResp.verification_uri_complete);
          process.stderr.write(
            `Prefer copy/paste? Use --manual.\n`,
          );
        }

        // no-wait: emit the flow_id and exit without polling.
        if (mode === "no-wait") {
          const flowId = generateFlowId();
          const flowsFile = deviceFlowsPath();
          saveDeviceFlow(
            {
              flow_id: flowId,
              device_code: deviceResp.device_code,
              base_url_v1: baseUrlV1,
              scope: "",
              interval: deviceResp.interval,
              expires_at: Date.now() + deviceResp.expires_in * 1000,
              created_at: Date.now(),
              user_code: deviceResp.user_code,
              verification_uri_complete: deviceResp.verification_uri_complete,
            },
            flowsFile,
          );

          // device_code is a bearer secret (valid until expires_in seconds).
          // It is included here per spec so callers can pass it to
          // --device-code for a degraded-poll resume. The poll_command
          // deliberately uses the local flow_id (not device_code) so the
          // CLI can look up cached metadata (base_url, scope, interval).
          emit(
            {
              status: "device_flow_started",
              verification_url: deviceResp.verification_uri_complete,
              user_code: deviceResp.user_code,
              flow_id: flowId,
              device_code: deviceResp.device_code,
              expires_in: deviceResp.expires_in,
              interval: deviceResp.interval,
              poll_command: `meshy auth login --device-flow ${flowId}`,
            },
            { format: flags.format, file: flags.output },
          );
          return;
        }

        // Poll until approved.
        const tok = await pollDeviceToken(baseUrlV1, deviceResp.device_code, {
          interval: deviceResp.interval,
          expiresIn: deviceResp.expires_in,
        });

        ensureRequestedScopesGranted("", tok.scope);
        await finishLogin(flags, { profile: opts.profile, verify: opts.verify }, tok);
        return;
      }

      // -----------------------------------------------------------------------
      // Manual flow (--manual)
      // -----------------------------------------------------------------------
      if (mode === "manual") {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = codeChallengeS256(codeVerifier);
        const oauthState = generateState();

        const authorizeUrl = buildAuthorizeUrl({
          base: authorizeBase,
          redirectUri: OOB_REDIRECT_URI,
          state: oauthState,
          codeChallenge,
        });

        process.stderr.write(`Open this URL in a browser:\n${authorizeUrl}\n`);

        if (!detectHeadless()) {
          await openBrowser(authorizeUrl);
        }

        // Prompt for the code with a 5-minute timeout.
        const code = await promptForCode(
          "Paste the code shown in your browser: ",
          MANUAL_PROMPT_TIMEOUT_MS,
        );

        const tok = await exchangeCode({
          baseUrlV1,
          code,
          codeVerifier,
          redirectUri: OOB_REDIRECT_URI,
        });

        await finishLogin(flags, { profile: opts.profile, verify: opts.verify }, tok);
        return;
      }

      // -----------------------------------------------------------------------
      // Loopback flow (default)
      // -----------------------------------------------------------------------
      await runLoopbackFlow(flags, opts, baseUrlV1, authorizeBase);
    },
  );

/**
 * Prompt the user for a code on stderr, with a timeout.
 * Works even with piped stdin (readline reads from stdin regardless).
 *
 * Settle-once: whichever of {line, close, timeout} fires first wins;
 * subsequent events are no-ops.
 */
function promptForCode(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new HintedError({
            message: "Timed out waiting for authorization code (5 minutes). Run: meshy auth login --manual",
            code: "oauth_timeout",
            hint: "Run: meshy auth login --manual",
          }),
        ),
      );
    }, timeoutMs);

    process.stderr.write(prompt);

    rl.once("line", (line) => {
      const code = line.trim();
      if (!code) {
        settle(() =>
          reject(
            new HintedError({
              message: "No authorization code entered. Run: meshy auth login --manual",
              code: "oauth_no_code",
              hint: "Run: meshy auth login --manual",
            }),
          ),
        );
      } else {
        settle(() => resolve(code));
      }
    });

    // stdin EOF (Ctrl+D or closed pipe) before any line was received.
    // Without this handler the timeout is cleared by the old close handler
    // and the promise hangs forever.
    rl.once("close", () => {
      settle(() =>
        reject(
          new UsageError(
            "No authorization code provided on stdin (EOF). Run: meshy auth login --manual",
          ),
        ),
      );
    });
  });
}

/**
 * Run the loopback (browser + callback server) OAuth flow.
 */
async function runLoopbackFlow(
  flags: GlobalFlags,
  opts: { profile: string; verify: boolean; port: string },
  baseUrlV1: string,
  authorizeBase: string,
): Promise<void> {
  const preferredPort = parsePort(opts.port);

  const oauthState = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeS256(codeVerifier);

  // Validate the authorize URL BEFORE starting the callback server.
  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl({
      base: authorizeBase,
      redirectUri: "http://127.0.0.1:0/callback",
      state: oauthState,
      codeChallenge,
    });
    const parsed = new URL(authorizeUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
  } catch (err) {
    throw new UsageError(
      `MESHY_OAUTH_AUTHORIZE_URL is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { server, port: actualPort, waitForCallback } =
    await startCallbackServer(preferredPort, oauthState);

  try {
    const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

    authorizeUrl = buildAuthorizeUrl({
      base: authorizeBase,
      redirectUri,
      state: oauthState,
      codeChallenge,
    });

    await openBrowser(authorizeUrl);
    process.stderr.write(
      `If the browser didn't open, visit this URL:\n${authorizeUrl}\n`,
    );

    const callbackResult = await waitForCallback;

    if (!callbackResult.code) {
      throw new HintedError({
        message: "No authorization code received from the callback.",
        code: "oauth_no_code",
        hint: "Run: meshy auth login",
      });
    }

    const tok = await exchangeCode({
      baseUrlV1,
      code: callbackResult.code,
      codeVerifier,
      redirectUri,
    });

    await finishLogin(flags, { profile: opts.profile, verify: opts.verify }, tok);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// auth status
// ---------------------------------------------------------------------------

const statusCommand = new Command("status")
  .description("Show which credential is in effect, where it came from, and whether it works")
  .option("--offline", "skip the balance call")
  .action(async (opts: { offline?: boolean }, thisCmd: Command) => {
    const flags = readGlobalFlags(thisCmd);
    const file = resolveFile(flags);
    const stored = safeReadProfiles(file);

    const configOverrides = {
      apiKey: flags.apiKey,
      baseUrlV1: flags.baseUrlV1,
      baseUrlV2: flags.baseUrlV2,
      logLevel: flags.verbose ? "debug" : flags.logLevel,
    };
    let config;
    try {
      config = await refreshOAuthCredentialIfNeeded(
        loadConfig(configOverrides),
        configOverrides,
      );
    } catch (err) {
      if (err instanceof HintedError && err.code === "unauthenticated") {
        emit(
          {
            authenticated: false,
            credentials_file: file,
            profiles: stored.names,
            active_profile: stored.active,
            hint: err.hint,
          },
          { format: flags.format, file: flags.output },
        );
        process.exitCode = EXIT_CODES.AUTH;
        return;
      }
      throw err;
    }

    let balance: unknown;
    let verified: boolean | undefined;
    let verifyHint: string | undefined;
    if (!opts.offline) {
      try {
        balance = await new MeshyClient(config).balance.get();
        verified = true;
      } catch (err) {
        verified = false;
        if (err instanceof MeshyApiError && err.code === "auth") {
          verifyHint = err.credentialKind === "api_key"
            ? CREDENTIAL_REJECTED_HINT
            : SESSION_REVOKED_HINT;
        } else {
          verifyHint = "Could not verify credential (network or server error). Check connectivity and retry.";
        }
      }
    }

    emit(
      {
        authenticated: true,
        source: config.credentialSource,
        profile: config.credentialProfile ?? null,
        credential: maskSecret(config.apiKey),
        credentials_file: file,
        base_url_v1: config.baseUrlV1,
        profiles: stored.names,
        active_profile: stored.active,
        ...(verified === undefined ? {} : { verified }),
        ...(balance === undefined ? {} : { balance }),
        ...(verifyHint !== undefined ? { hint: verifyHint } : {}),
      },
      { format: flags.format, file: flags.output },
    );
    if (verified === false) process.exitCode = EXIT_CODES.AUTH;
  });

// ---------------------------------------------------------------------------
// auth logout / use / list
// ---------------------------------------------------------------------------

const logoutCommand = new Command("logout")
  .description("Remove a stored credential (only for the current environment's file)")
  .option("--profile <name>", "profile to remove (default: the active one)")
  .option("--all", "delete the whole credentials file for this environment")
  .action((opts: { profile?: string; all?: boolean }, thisCmd: Command) => {
    const flags = readGlobalFlags(thisCmd);
    const file = resolveFile(flags);

    if (opts.all) {
      const deleted = deleteCredentialsFile(file);
      emit(
        { status: deleted ? "deleted" : "nothing_to_delete", credentials_file: file },
        { format: flags.format, file: flags.output },
      );
      return;
    }

    const state = readCredentials(file);
    const target = opts.profile ?? state?.active_profile ?? DEFAULT_PROFILE;
    const removed = removeProfile(file, target);
    const after = safeReadProfiles(file);
    emit(
      {
        status: removed ? "removed" : "nothing_to_remove",
        profile: target,
        credentials_file: file,
        profiles: after.names,
        active_profile: after.active,
      },
      { format: flags.format, file: flags.output },
    );
  });

const useCommand = new Command("use")
  .description("Switch the active profile")
  .argument("<profile>", "profile name")
  .action((profile: string, _opts: unknown, thisCmd: Command) => {
    const flags = readGlobalFlags(thisCmd);
    const file = resolveFile(flags);
    const known = safeReadProfiles(file);
    if (!known.names.includes(profile)) {
      throw new HintedError({
        message: `No profile named '${profile}'. Known: ${known.names.join(", ") || "(none)"}`,
        code: "unknown_profile",
        hint: "Run: meshy auth list",
      });
    }
    setActiveProfile(file, profile);
    emit(
      { status: "switched", active_profile: profile, credentials_file: file },
      { format: flags.format, file: flags.output },
    );
  });

const listCommand = new Command("list")
  .description("List stored profiles for this environment")
  .action((_opts: unknown, thisCmd: Command) => {
    const flags = readGlobalFlags(thisCmd);
    const file = resolveFile(flags);
    const state = readCredentials(file);
    const profiles = Object.entries(state?.profiles ?? {}).map(([name, profile]) => ({
      name,
      active: name === state?.active_profile,
      kind: profile.kind,
      credential: maskSecret(profile.api_key ?? profile.access_token ?? ""),
      created_at: profile.created_at ?? null,
    }));
    emit(
      { credentials_file: file, active_profile: state?.active_profile ?? null, profiles },
      { format: flags.format, file: flags.output },
    );
  });

/**
 * Profile names for reporting. A corrupt file must not stop `auth status` from
 * telling the user which file to look at — that is the one moment the path
 * matters most.
 */
function safeReadProfiles(file: string): { names: string[]; active: string | null } {
  try {
    const state = readCredentials(file);
    return { names: Object.keys(state?.profiles ?? {}), active: state?.active_profile ?? null };
  } catch {
    return { names: [], active: null };
  }
}

export const authCommand = new Command("auth")
  .description("Manage stored credentials (login, status, logout, profiles)")
  .addCommand(loginCommand)
  .addCommand(statusCommand)
  .addCommand(logoutCommand)
  .addCommand(useCommand)
  .addCommand(listCommand);
