/**
 * Terminal error presentation — routes a caught error to stderr with a
 * human-friendly line, emits the structured payload when --format=json, and
 * maps error classes to conventional exit codes for scripting.
 *
 * Two output schemas share this module:
 *   - legacy: the additive `{name,message,status,code,path,hint,docs}` payload
 *     that 0.2.0 consumers parse (toErrorPayload / reportError).
 *   - v1: `classifyError` yields the stable code/exit/http/recovery tuple that
 *     result.ts wraps into the `meshy.cli/v1` envelope.
 */

import { CommanderError } from "commander";
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
  SUBMISSION_UNKNOWN: 10,
  LOCAL_IO: 11,
  CHECK_FAILED: 12,
  CHECK_UNKNOWN: 13,
  INTERRUPTED: 130,
} as const;

/** Stable machine vocabulary for v1 `error.code`. */
export type CliErrorCode =
  | "usage"
  | "auth"
  | "validation"
  | "not_found"
  | "rate_limit"
  | "network"
  | "timed_out"
  | "credit"
  | "server"
  | "task_failed"
  | "submission_unknown"
  | "local_io"
  | "check_failed"
  | "check_unknown"
  | "interrupted"
  | "protocol"
  | "operation_conflict"
  | "internal";

export const EXIT_FOR_CODE: Record<CliErrorCode, number> = {
  usage: EXIT_CODES.USAGE,
  auth: EXIT_CODES.AUTH,
  validation: EXIT_CODES.VALIDATION,
  not_found: EXIT_CODES.NOT_FOUND,
  rate_limit: EXIT_CODES.RATE_LIMIT,
  network: EXIT_CODES.NETWORK,
  timed_out: EXIT_CODES.TIMED_OUT,
  credit: EXIT_CODES.CREDIT,
  server: EXIT_CODES.GENERIC,
  task_failed: EXIT_CODES.GENERIC,
  submission_unknown: EXIT_CODES.SUBMISSION_UNKNOWN,
  local_io: EXIT_CODES.LOCAL_IO,
  check_failed: EXIT_CODES.CHECK_FAILED,
  check_unknown: EXIT_CODES.CHECK_UNKNOWN,
  interrupted: EXIT_CODES.INTERRUPTED,
  protocol: EXIT_CODES.GENERIC,
  operation_conflict: EXIT_CODES.USAGE,
  internal: EXIT_CODES.GENERIC,
};

export interface ErrorRecovery {
  /** What the caller should do: reconcile | retry | wait | login | none … */
  action: string;
  /** Whether the CLI performed it. Always false in S1 — nothing is retried for the caller. */
  automatic: boolean;
  /** A command the caller can run verbatim, when one is known. */
  command?: string;
}

export interface Warning {
  code: string;
  message: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Structured failure with everything the v1 envelope needs. `result` carries
 * whatever partial state must survive the failure (a task id after a journal
 * write error, the files already downloaded, the last task seen by a stream).
 */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly recovery: ErrorRecovery | null;
  readonly result: Record<string, unknown> | null;
  readonly warnings: Warning[];
  readonly hint?: string;
  readonly details?: unknown;

  constructor(params: {
    code: CliErrorCode;
    message: string;
    exitCode?: number;
    httpStatus?: number | null;
    retryable?: boolean;
    recovery?: ErrorRecovery | null;
    result?: Record<string, unknown> | null;
    warnings?: Warning[];
    hint?: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "CliError";
    this.code = params.code;
    this.exitCode = params.exitCode ?? EXIT_FOR_CODE[params.code];
    this.httpStatus = params.httpStatus ?? null;
    this.retryable = params.retryable ?? false;
    this.recovery = params.recovery ?? null;
    this.result = params.result ?? null;
    this.warnings = params.warnings ?? [];
    this.hint = params.hint;
    this.details = params.details;
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

/** Commander error codes that mean "help/version was printed", not a failure. */
export function isCommanderInformational(err: unknown): err is CommanderError {
  return (
    err instanceof CommanderError &&
    (err.code === "commander.helpDisplayed" ||
      err.code === "commander.version" ||
      err.code === "commander.help" ||
      err.exitCode === 0)
  );
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof UsageError) return EXIT_CODES.USAGE;
  if (err instanceof CommanderError) {
    return isCommanderInformational(err) ? err.exitCode : EXIT_CODES.USAGE;
  }
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

export interface ClassifiedError {
  code: CliErrorCode;
  exitCode: number;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  recovery: ErrorRecovery | null;
  hint?: string;
  details?: unknown;
  result: Record<string, unknown> | null;
  warnings: Warning[];
}

/** Map any thrown value onto the stable v1 error tuple. Never throws. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof CliError) {
    return {
      code: err.code,
      exitCode: err.exitCode,
      message: err.message,
      httpStatus: err.httpStatus,
      retryable: err.retryable,
      recovery: err.recovery,
      hint: err.hint,
      details: err.details,
      result: err.result,
      warnings: err.warnings,
    };
  }
  if (err instanceof UsageError) {
    return base("usage", err.message);
  }
  if (err instanceof CommanderError) {
    return base("usage", err.message.replace(/^error:\s*/i, "").trim(), { details: { code: err.code } });
  }
  if (err instanceof MeshyApiError) {
    const code: CliErrorCode = err.code === "server" ? "server" : err.code;
    const hints = hintForApiError(err);
    const recovery: ErrorRecovery | null =
      err.code === "auth"
        ? { action: "login", automatic: false, command: "meshy auth login" }
        : err.code === "rate_limit"
          ? { action: "wait", automatic: false }
          : err.code === "credit"
            ? { action: "top_up", automatic: false, command: "meshy balance" }
            : null;
    return {
      ...base(code, err.message, { httpStatus: err.status || null, details: { path: err.path, body: err.body } }),
      recovery,
      hint: hints.hint,
    };
  }
  if (err instanceof HintedError) {
    let code: CliErrorCode = "internal";
    if (err.code === "unauthenticated") code = "auth";
    else if (err.code === "oauth_timeout" || err.code === "step_timeout") code = "timed_out";
    else if (err.code === "step_failed") code = "task_failed";
    const exitCode = err.exitCode ?? EXIT_FOR_CODE[code];
    return {
      ...base(code, err.message, { details: { code: err.code, docs: err.docs } }),
      exitCode,
      hint: err.hint,
      recovery: err.hint ? { action: "run_hint", automatic: false, command: err.hint } : null,
    };
  }
  if (err instanceof Error) {
    if (err.name === "CredentialsFileError") return base("local_io", err.message);
    if (err.name === "AbortError") return base("interrupted", err.message);
    return base("internal", err.message, { details: { name: err.name } });
  }
  return base("internal", String(err));
}

function base(
  code: CliErrorCode,
  message: string,
  extra: { httpStatus?: number | null; details?: unknown } = {},
): ClassifiedError {
  return {
    code,
    exitCode: EXIT_FOR_CODE[code],
    message,
    httpStatus: extra.httpStatus ?? null,
    retryable: false,
    recovery: null,
    details: extra.details,
    result: null,
    warnings: [],
  };
}

/** Legacy stderr + payload reporter (unchanged shape for 0.2.0 consumers). */
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
  if (err instanceof CliError) {
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      ...(err.httpStatus !== null ? { status: err.httpStatus } : {}),
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.result ? { result: err.result } : {}),
    };
  }
  if (err instanceof CommanderError) {
    return { name: "UsageError", message: err.message.replace(/^error:\s*/i, "").trim(), code: err.code };
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
