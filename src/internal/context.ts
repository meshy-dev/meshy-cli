/**
 * Per-invocation command context. The CLI runs one command per process; the
 * action that owns the command registers its name, output schema and format
 * here so the top-level error exit can render the failure in the same shape
 * the success path would have used. Parse errors happen before any action
 * runs, so the entry point falls back to argv heuristics when this is unset.
 *
 * The shared AbortController is what SIGINT trips; long operations (wait,
 * stream, download) observe `signal` and convert an abort into exit 130.
 */

import type { OutputFormat } from "./output.js";
import type { OutputSchema } from "./result.js";

export interface CommandContext {
  command: string;
  schema: OutputSchema;
  format: OutputFormat;
}

let current: CommandContext | null = null;
const controller = new AbortController();
let interrupted = false;

export function beginCommand(ctx: CommandContext): CommandContext {
  current = ctx;
  return ctx;
}

export function currentCommand(): CommandContext | null {
  return current;
}

export function abortSignal(): AbortSignal {
  return controller.signal;
}

export function markInterrupted(): void {
  if (interrupted) return;
  interrupted = true;
  controller.abort(new Error("interrupted by SIGINT"));
}

export function wasInterrupted(): boolean {
  return interrupted;
}

/** Test hook: reset module state between in-process runs. */
export function resetCommandContextForTests(): void {
  current = null;
}
