/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) helpers.
 *
 * Implements:
 *   - deviceAuthorization(): POST /oauth/device_authorization
 *   - pollDeviceToken(): polling loop for /oauth/token with device_code grant
 *   - ensureRequestedScopesGranted(): scope verification
 */

import { HintedError } from "./errors.js";
import { USER_AGENT } from "./user-agent.js";
import type { TokenResponse } from "./oauth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface PollDeviceTokenOpts {
  /** Initial polling interval in seconds (from server; clamped to ≥1 → 5). */
  interval: number;
  /** Token lifetime in seconds (from server). */
  expiresIn: number;
  /** Optional callback called on each authorization_pending response. */
  onPending?: () => void;
  /** Optional hard deadline override (unix ms). Defaults to now + expiresIn*1000. */
  deadline?: number;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the /oauth/device_authorization endpoint returns 404.
 * Indicates the meshyd deployment does not support device flow yet.
 */
export class DeviceFlowNotSupportedError extends HintedError {
  constructor() {
    super({
      // Do NOT suggest --manual here: a meshyd old enough to lack
      // device_authorization also lacks the OOB display branch that --manual
      // depends on, so that flag would fail too. Only safe options are to
      // wait for the backend deployment or use an API key.
      message:
        "This Meshy API host does not support device login yet — retry after backend deployment or use an API key (meshy auth login --with-key).",
      code: "device_flow_not_supported",
      hint: "Run: meshy auth login --with-key msy_...",
    });
    this.name = "DeviceFlowNotSupportedError";
  }
}

/**
 * An error from the device token polling endpoint that carries the machine
 * error code from the OAuth response body.
 */
export class DeviceFlowError extends HintedError {
  readonly oauthErrorCode: string;

  constructor(params: {
    message: string;
    code: string;
    oauthErrorCode: string;
    hint?: string;
  }) {
    super({ message: params.message, code: params.code, hint: params.hint });
    this.name = "DeviceFlowError";
    this.oauthErrorCode = params.oauthErrorCode;
  }
}

// ---------------------------------------------------------------------------
// Device authorization request
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * POST /oauth/device_authorization to start a device flow.
 *
 * @throws DeviceFlowNotSupportedError on 404
 * @throws HintedError on other non-200 responses
 */
export async function deviceAuthorization(
  baseUrlV1: string,
  scope?: string,
): Promise<DeviceAuthorizationResponse> {
  const url = `${baseUrlV1}/oauth/device_authorization`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: "meshy-cli",
        ...(scope ? { scope } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HintedError({
      message: `Network error contacting device authorization endpoint: ${err instanceof Error ? err.message : String(err)}`,
      code: "oauth_network",
      hint: "Run: meshy auth login --with-key msy_...",
    });
  }

  if (res.status === 404) {
    throw new DeviceFlowNotSupportedError();
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new HintedError({
      message: `Device authorization endpoint returned non-JSON (status ${res.status})`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  if (!res.ok) {
    const obj = parsed as Record<string, unknown>;
    const msg =
      (typeof obj["error_description"] === "string" ? obj["error_description"] : undefined) ??
      (typeof obj["message"] === "string" ? obj["message"] : undefined) ??
      (typeof obj["error"] === "string" ? obj["error"] : undefined) ??
      `Device authorization endpoint error (status ${res.status})`;
    throw new HintedError({
      message: msg,
      code: "oauth_device_error",
      hint: "Run: meshy auth login",
    });
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields.
  if (typeof obj["device_code"] !== "string" || !obj["device_code"]) {
    throw new HintedError({
      message: "Device authorization response missing device_code",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }
  if (typeof obj["user_code"] !== "string" || !obj["user_code"]) {
    throw new HintedError({
      message: "Device authorization response missing user_code",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }
  if (typeof obj["verification_uri"] !== "string" || !obj["verification_uri"]) {
    throw new HintedError({
      message: "Device authorization response missing verification_uri",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  const rawInterval = typeof obj["interval"] === "number" ? obj["interval"] : 5;
  const interval = rawInterval < 1 ? 5 : rawInterval;

  const expiresIn =
    typeof obj["expires_in"] === "number" && obj["expires_in"] > 0 ? obj["expires_in"] : 600;

  return {
    device_code: obj["device_code"] as string,
    user_code: obj["user_code"] as string,
    verification_uri: obj["verification_uri"] as string,
    verification_uri_complete:
      typeof obj["verification_uri_complete"] === "string"
        ? obj["verification_uri_complete"]
        : (obj["verification_uri"] as string),
    expires_in: expiresIn,
    interval,
  };
}

// ---------------------------------------------------------------------------
// Device token polling
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /oauth/token with grant_type=device_code once and return the result.
 * Returns the parsed body (success or error) and the HTTP status.
 */
async function deviceTokenOnce(
  baseUrlV1: string,
  deviceCode: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${baseUrlV1}/oauth/token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "meshy-cli",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HintedError({
      message: `Network error polling device token: ${err instanceof Error ? err.message : String(err)}`,
      code: "oauth_network",
      hint: "Run: meshy auth login",
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new HintedError({
      message: `Device token endpoint returned non-JSON (status ${res.status})`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }

  return { status: res.status, body };
}

/** Validate and extract a TokenResponse from a successful device token body. */
function extractTokenResponse(body: Record<string, unknown>): TokenResponse {
  if (typeof body["access_token"] !== "string" || !body["access_token"]) {
    throw new HintedError({
      message: "Device token response missing access_token",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }
  if (
    typeof body["token_type"] !== "string" ||
    body["token_type"].toLowerCase() !== "bearer"
  ) {
    throw new HintedError({
      message: `Device token response has unexpected token_type: ${JSON.stringify(body["token_type"])}`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }
  const expiresIn = body["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new HintedError({
      message: `Device token response has invalid expires_in: ${JSON.stringify(expiresIn)}`,
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }
  if (typeof body["refresh_token"] !== "string" || !body["refresh_token"]) {
    throw new HintedError({
      message: "Device token response missing refresh_token",
      code: "oauth_bad_response",
      hint: "Run: meshy auth login",
    });
  }
  return {
    access_token: body["access_token"] as string,
    token_type: body["token_type"] as string,
    expires_in: expiresIn,
    refresh_token: body["refresh_token"] as string,
    scope: typeof body["scope"] === "string" ? body["scope"] : undefined,
    user_id: typeof body["user_id"] === "string" ? body["user_id"] : undefined,
  };
}

const MAX_INTERVAL_S = 60;

/**
 * Poll the device token endpoint until the user approves, denies, or the
 * token expires.
 *
 * Implements RFC 8628 §3.5 polling semantics:
 *   - authorization_pending → wait current interval
 *   - slow_down or HTTP 429 → interval += 5s (capped at 60s), wait
 *   - expired_token or deadline exceeded → throw oauth_timeout
 *   - access_denied → throw AUTH error
 *   - invalid_grant → throw AUTH error (already consumed)
 *   - 5xx / network → retry up to 3 consecutive, then throw
 */
export async function pollDeviceToken(
  baseUrlV1: string,
  deviceCode: string,
  opts: PollDeviceTokenOpts,
): Promise<TokenResponse> {
  const deadline = opts.deadline ?? Date.now() + opts.expiresIn * 1000;
  let intervalMs = (opts.interval < 1 ? 5 : opts.interval) * 1000;
  /** Consecutive network-level errors (thrown by deviceTokenOnce). */
  let consecutiveNetworkErrors = 0;
  /** Consecutive 5xx HTTP errors. */
  let consecutive5xxErrors = 0;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new HintedError({
        message: "Device flow timed out waiting for authorization. Run: meshy auth login",
        code: "oauth_timeout",
        hint: "Run: meshy auth login",
      });
    }

    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await deviceTokenOnce(baseUrlV1, deviceCode);
      consecutiveNetworkErrors = 0;
    } catch (err) {
      consecutiveNetworkErrors++;
      if (consecutiveNetworkErrors >= 3) {
        throw err;
      }
      await sleep(intervalMs);
      continue;
    }

    const { status, body } = result;

    // Success.
    if (status === 200) {
      consecutive5xxErrors = 0;
      return extractTokenResponse(body);
    }

    // Parse the OAuth error code from the body.
    const oauthError =
      typeof body["error"] === "string" ? body["error"] : undefined;
    const humanMsg =
      (typeof body["error_description"] === "string" ? body["error_description"] : undefined) ??
      (typeof body["message"] === "string" ? body["message"] : undefined) ??
      oauthError ??
      `Device token error (status ${status})`;

    // Handle specific OAuth error codes.
    if (oauthError === "authorization_pending") {
      consecutive5xxErrors = 0;
      opts.onPending?.();
      await sleep(intervalMs);
      continue;
    }

    if (oauthError === "slow_down" || status === 429) {
      consecutive5xxErrors = 0;
      intervalMs = Math.min(intervalMs + 5000, MAX_INTERVAL_S * 1000);
      await sleep(intervalMs);
      continue;
    }

    if (oauthError === "expired_token") {
      // Use DeviceFlowError so oauthErrorCode:"expired_token" survives to
      // --json output, letting machine consumers distinguish this from
      // access_denied / invalid_grant. Exit code stays TIMED_OUT (the
      // "oauth_timeout" code maps there in exitCodeFor).
      throw new DeviceFlowError({
        message: "Device flow authorization code expired. Run: meshy auth login",
        code: "oauth_timeout",
        oauthErrorCode: "expired_token",
        hint: "Run: meshy auth login",
      });
    }

    if (oauthError === "access_denied") {
      throw new DeviceFlowError({
        message: "Device login was denied by the user.",
        code: "oauth_access_denied",
        oauthErrorCode: "access_denied",
        hint: "Run: meshy auth login",
      });
    }

    if (oauthError === "invalid_grant") {
      throw new DeviceFlowError({
        message: "Device flow already consumed or invalid; restart login.",
        code: "oauth_invalid_grant",
        oauthErrorCode: "invalid_grant",
        hint: "Run: meshy auth login",
      });
    }

    // 5xx errors: retry up to 3 consecutive, then surface.
    if (status >= 500) {
      consecutive5xxErrors++;
      if (consecutive5xxErrors >= 3) {
        throw new HintedError({
          message: `Device token server error (status ${status}): ${humanMsg}`,
          code: "oauth_server_error",
          hint: "Run: meshy auth login",
        });
      }
      await sleep(intervalMs);
      continue;
    }

    // Other 400-level errors.
    throw new HintedError({
      message: humanMsg,
      code: "oauth_device_error",
      hint: "Run: meshy auth login",
    });
  }
}

// ---------------------------------------------------------------------------
// Scope verification
// ---------------------------------------------------------------------------

/**
 * Verify that all requested scopes were granted.
 *
 * Both `requested` and `granted` are space-separated scope strings.
 * Today both are "" — this trivially passes. Implemented generically for
 * future use.
 *
 * @throws HintedError listing missing scopes if any requested scope is absent.
 */
export function ensureRequestedScopesGranted(
  requested: string,
  granted: string | undefined,
): void {
  const requestedScopes = requested.split(/\s+/).filter(Boolean);
  if (requestedScopes.length === 0) return;

  const grantedScopes = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  const missing = requestedScopes.filter((s) => !grantedScopes.has(s));

  if (missing.length > 0) {
    throw new HintedError({
      message: `The following requested scopes were not granted: ${missing.join(", ")}`,
      code: "oauth_scope_denied",
      hint: "Run: meshy auth login",
    });
  }
}
