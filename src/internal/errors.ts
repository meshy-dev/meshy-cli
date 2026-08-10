/**
 * Terminal error presentation — routes a caught error to stderr with a
 * human-friendly line, emits the structured payload when --format=json, and
 * maps MeshyApiError codes to conventional exit codes for scripting.
 */

import { MeshyApiError } from "../client/errors.js";
import { emit, type OutputFormat } from "./output.js";

export const EXIT_CODES = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  VALIDATION: 4,
  NOT_FOUND: 5,
  RATE_LIMIT: 6,
  NETWORK: 7,
  TIMED_OUT: 8,
  CREDIT: 9,
} as const;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * An error that carries the command which fixes it.
 *
 * Agents parse stdout, not the prose on stderr, so a recoverable failure has to
 * say how to recover *in the payload*: `hint` is a command the caller can run
 * verbatim. Errors with no known remedy stay plain — a wrong guess is worse
 * than no hint.
 */
export class HintedError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly docs?: string;
  /**
   * Overrides the exit code this error maps to. Set it when the failure has a
   * conventional code that `code` alone doesn't imply — a chained step that
   * times out is still a timeout (8), not a generic failure.
   */
  readonly exitCode?: number;

  constructor(params: {
    message: string;
    code: string;
    hint?: string;
    docs?: string;
    exitCode?: number;
  }) {
    super(params.message);
    this.name = "HintedError";
    this.code = params.code;
    this.hint = params.hint;
    this.docs = params.docs;
    this.exitCode = params.exitCode;
  }
}

const DOCS_AUTH = "https://docs.meshy.ai/en/api/authentication";
const LOGIN_HINT = "Run: meshy auth login  (or: meshy auth login --with-key msy_...)";
export const SESSION_REVOKED_HINT = "Session revoked or expired. Run: meshy auth login";
export const CREDENTIAL_REJECTED_HINT = `Credential rejected or revoked. ${LOGIN_HINT}`;

/** No credential at all — the error every new user meets first. */
export function authRequiredError(detail?: string): HintedError {
  return new HintedError({
    message: detail ?? "No credentials found.",
    code: "unauthenticated",
    hint: LOGIN_HINT,
    docs: DOCS_AUTH,
  });
}

/**
 * Remedies for API failures, keyed by MeshyApiError.code so the mapping lives
 * in one place instead of at every call site.
 */
function hintForApiError(err: MeshyApiError): { hint?: string; docs?: string } {
  switch (err.code) {
    case "auth":
      if (err.credentialKind === "api_key") {
        return { hint: CREDENTIAL_REJECTED_HINT, docs: DOCS_AUTH };
      }
      // oauth or unknown → session-revoked hint
      return { hint: SESSION_REVOKED_HINT, docs: DOCS_AUTH };
    case "credit":
      return {
        hint: "Out of credits. Confirm with: meshy balance — then top up at https://www.meshy.ai/pricing",
      };
    case "rate_limit":
      return { hint: "Rate limited. Pause before retrying, or lower request concurrency." };
    default:
      return {};
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT_CODES.USAGE;
  if (err instanceof HintedError) {
    // An explicit exitCode wins — the raiser knew the conventional code for
    // its own failure (a chained `make` step that times out is a timeout).
    // Otherwise map by code: "unauthenticated" → AUTH(3); "oauth_timeout" →
    // TIMED_OUT(8) (device flow expired_token, loopback waitForCallback
    // timeout, manual prompt timeout all share it); everything else →
    // GENERIC(1).
    if (err.exitCode !== undefined) return err.exitCode;
    if (err.code === "unauthenticated") return EXIT_CODES.AUTH;
    if (err.code === "oauth_timeout") return EXIT_CODES.TIMED_OUT;
    return EXIT_CODES.GENERIC;
  }
  if (err instanceof MeshyApiError) {
    switch (err.code) {
      case "auth": return EXIT_CODES.AUTH;
      case "validation": return EXIT_CODES.VALIDATION;
      case "not_found": return EXIT_CODES.NOT_FOUND;
      case "rate_limit": return EXIT_CODES.RATE_LIMIT;
      case "network": return EXIT_CODES.NETWORK;
      case "credit": return EXIT_CODES.CREDIT;
      case "server": return EXIT_CODES.GENERIC;
    }
  }
  return EXIT_CODES.GENERIC;
}

export function reportError(err: unknown, format: OutputFormat): void {
  const payload = toErrorPayload(err);
  process.stderr.write(`error: ${payload.message}\n`);
  if (typeof payload["hint"] === "string") {
    process.stderr.write(`hint: ${payload["hint"] as string}\n`);
  }
  if (format !== "pretty") {
    try {
      emit(payload, { format });
    } catch {
      /* ignore: stderr already carries the human message */
    }
  }
}

/**
 * The payload shape stays additive: `hint` and `docs` join the existing
 * name/message/status/code/path fields rather than moving everything under an
 * `{ok:false, error:{…}}` envelope. Successful commands emit bare API payloads
 * with no `ok` field, so an envelope on failures only would force consumers to
 * probe for two different shapes.
 */
export function toErrorPayload(err: unknown): { name: string; message: string; [k: string]: unknown } {
  if (err instanceof MeshyApiError) {
    return { ...err.toJSON(), ...hintForApiError(err), name: err.name, message: err.message };
  }
  if (err instanceof HintedError) {
    // DeviceFlowError (a HintedError subclass) carries an oauthErrorCode field
    // that machine consumers need to distinguish access_denied / invalid_grant /
    // expired_token etc. Serialise it as `oauth_error` (snake_case, consistent
    // with the rest of the JSON error payload) without importing the subclass
    // (which would create a circular dependency through device.ts → errors.ts).
    const errAsUnknown = err as unknown as Record<string, unknown>;
    const oauthError =
      typeof errAsUnknown["oauthErrorCode"] === "string"
        ? errAsUnknown["oauthErrorCode"]
        : undefined;
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      ...(oauthError !== undefined ? { oauth_error: oauthError } : {}),
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.docs ? { docs: err.docs } : {}),
    };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "Error", message: String(err) };
}
