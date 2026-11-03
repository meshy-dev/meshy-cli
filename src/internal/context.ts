/**
 * Per-invocation command context. The CLI runs one command per process; the
 * action that owns the command registers its name and output format here so
 * the top-level error exit can render the failure the way the success path
 * would have. Parse errors happen before any action
 * runs, so the entry point falls back to argv heuristics when this is unset.
 *
 * The shared AbortController is what SIGINT, SIGTERM or SIGHUP trips; long
 * operations (wait, stream, download) observe `signal` and convert an abort
 * into exit 130.
 */

import type { ViewFacts } from "./views.js";
import type { OutputFormat } from "./output.js";

export interface CommandContext {
  command: string;
  format: OutputFormat;
  /** Facts only the `pretty` view shows; never part of json/ndjson. */
  view?: ViewFacts;
}

let current: CommandContext | null = null;
const controller = new AbortController();
let interrupted = false;
let interruptSignal = "SIGINT";

export function beginCommand(ctx: CommandContext): CommandContext {
  current = ctx;
  return ctx;
}

export function currentCommand(): CommandContext | null {
  return current;
}

/** Hand the human view something the payload does not carry (make: the prompt, the whole chain's time). */
export function noteForView(facts: ViewFacts): void {
  if (current) current.view = { ...current.view, ...facts };
}

export function abortSignal(): AbortSignal {
  return controller.signal;
}

export function markInterrupted(signal = "SIGINT"): void {
  if (interrupted) return;
  interrupted = true;
  interruptSignal = signal;
  controller.abort(new Error(`interrupted by ${signal}`));
}

export function wasInterrupted(): boolean {
  return interrupted;
}

/** The signal that tripped the abort (SIGINT, SIGTERM or SIGHUP). */
export function interruptedBy(): string {
  return interruptSignal;
}

let heldExits = 0;
let pendingExit: number | undefined;

/**
 * Runs `fn` with forced exits (a second Ctrl-C, the end of a terminate
 * signal's grace period) held until it settles. For the few steps that must
 * not stop half-way: once the API has answered an OAuth refresh, the old
 * refresh token is spent, and a process killed before saving the answer
 * would leave only that behind.
 */
export async function withExitHeld<T>(fn: () => Promise<T>): Promise<T> {
  heldExits += 1;
  try {
    return await fn();
  } finally {
    heldExits -= 1;
    if (heldExits === 0 && pendingExit !== undefined) process.exit(pendingExit);
  }
}

/** process.exit, unless withExitHeld is running: then once it settles. */
export function exitWhenSafe(code: number): void {
  if (heldExits > 0) pendingExit = code;
  else process.exit(code);
}

/** Test hook: reset module state between in-process runs. */
export function resetCommandContextForTests(): void {
  current = null;
}
