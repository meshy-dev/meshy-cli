/**
 * The `meshy.cli/v1` machine contract.
 *
 * Every v1 command prints exactly one envelope on stdout (stream mode prints
 * one per event, see StreamEventEnvelope). The six top-level keys never
 * change; `result` is shaped per command. `ok` reports whether the CLI
 * operation completed — a `get` that returns a FAILED task is `ok:true`, a
 * `wait` that ends on a FAILED task is `ok:false` with the task preserved.
 */

import { classifyError, type ErrorRecovery, type Warning } from "./errors.js";

export type { Warning } from "./errors.js";

export const SCHEMA_VERSION = "meshy.cli/v1";

export type OutputSchema = "legacy" | "v1";

export interface V1Error {
  code: string;
  message: string;
  http_status: number | null;
  retryable: boolean;
  recovery: ErrorRecovery | null;
  hint?: string;
  details?: unknown;
}

export interface V1Envelope<R = unknown> {
  schema_version: typeof SCHEMA_VERSION;
  command: string;
  ok: boolean;
  result: R | null;
  error: V1Error | null;
  warnings: Warning[];
}

/** ndjson stream events add a local sequence and the event kind. */
export interface StreamEventEnvelope<R = unknown> extends V1Envelope<R> {
  event: "task" | "outcome" | "warning";
  sequence: number;
}

export function okEnvelope<R>(command: string, result: R, warnings: Warning[] = []): V1Envelope<R> {
  return { schema_version: SCHEMA_VERSION, command, ok: true, result, error: null, warnings };
}

/**
 * Build a failure envelope from any thrown value. A partial `result` supplied
 * by the caller wins over the error's own; both are kept when the caller passes
 * nothing (a CliError carries the state that must outlive the failure).
 */
export function errorEnvelope(
  command: string,
  err: unknown,
  opts: { result?: unknown; warnings?: Warning[] } = {},
): { envelope: V1Envelope; exitCode: number } {
  const c = classifyError(err);
  const error: V1Error = {
    code: c.code,
    message: c.message,
    http_status: c.httpStatus,
    retryable: c.retryable,
    recovery: c.recovery,
    ...(c.hint ? { hint: c.hint } : {}),
    ...(c.details !== undefined ? { details: c.details } : {}),
  };
  const result = opts.result !== undefined ? opts.result : c.result;
  const warnings = [...c.warnings, ...(opts.warnings ?? [])];
  return {
    envelope: { schema_version: SCHEMA_VERSION, command, ok: false, result: result ?? null, error, warnings },
    exitCode: c.exitCode,
  };
}

export function warning(code: string, message: string): Warning {
  return { code, message };
}
