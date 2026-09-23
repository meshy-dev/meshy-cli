/**
 * Progress on stderr while a task runs.
 *
 * The mode follows where stderr goes, never a flag:
 *   - live:  stderr is a terminal (not CI, not TERM=dumb). One line is redrawn
 *            in place — spinner, status, clock — and frozen as a ✓ / ✗ line
 *            when the step ends, so finished steps stay on screen.
 *   - lines: anything else (agents, CI, `2> log`). One plain line per step
 *            start, per status or percentage change, and per step end. Same
 *            text 0.3.x printed, minus the repeat on every poll.
 *   - off:   `--format ndjson`: its consumers read events, and stderr stays quiet.
 *
 * Only stderr is ever written. Nothing here is a machine contract — the skill
 * docs tell agents never to scrape it.
 */

import { painterFor, type Painter, type Style } from "./color.js";
import { formatDuration } from "./views.js";
import type { OutputFormat } from "./output.js";
import { CI_VARS } from "./update-notifier.js";

export type ProgressMode = "live" | "lines" | "off";
export type ProgressOutcome = "ok" | "failed" | "timeout";

export interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

export interface ProgressStep {
  /** What the step is, e.g. `[1/2] text-to-3d preview (geometry)`. */
  label: string;
  /** Resource id for lines-mode status lines: `[text-to-3d] IN_PROGRESS 42%`. */
  resource: string;
  taskId?: string;
}

export interface Progress {
  readonly mode: ProgressMode;
  start(step: ProgressStep): void;
  tick(status: string | null | undefined, pct?: number | null): void;
  /** End the step. `detail` replaces the outcome word (e.g. the FAILED status). */
  finish(outcome: ProgressOutcome, detail?: string): void;
  /** Erase the live line without ending the step; the next frame redraws it. */
  clear(): void;
  /** Stop the clock and erase the live line; the step is abandoned. */
  stop(): void;
}

export interface ProgressOptions {
  stream?: ProgressStream;
  env?: NodeJS.ProcessEnv;
  /** Show nothing unless live (downloads: fast, and never announced before). */
  liveOnly?: boolean;
  /** Test hooks. */
  now?: () => number;
  intervalMs?: number;
}

export function progressMode(
  format: OutputFormat,
  stream: { isTTY?: boolean } = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): ProgressMode {
  if (format === "ndjson") return "off";
  if (!stream.isTTY || env["TERM"] === "dumb" || CI_VARS.some((v) => env[v])) return "lines";
  return "live";
}

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const ERASE = "\r\u001b[2K";

/** The progress that currently owns the live line, so other stderr writers can clear it first. */
let active: Progress | null = null;

export function clearActiveProgress(): void {
  active?.clear();
}

export function stopActiveProgress(): void {
  active?.stop();
}

export function createProgress(format: OutputFormat, opts: ProgressOptions = {}): Progress {
  const stream = opts.stream ?? process.stderr;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => performance.now());
  let mode = progressMode(format, stream, env);
  if (opts.liveOnly && mode === "lines") mode = "off";
  const paint: Painter = painterFor(stream, env);

  let step: ProgressStep | null = null;
  let startedAt = 0;
  let status: string | null = null;
  let pct: number | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const elapsed = (): number => (now() - startedAt) / 1000;

  // `||`: a pty with no size reports 0 columns. One column is kept free so
  // the cursor never wraps — a wrapped line cannot be redrawn with \r.
  const width = (): number => (stream.columns || 80) - 1;

  const draw = (): void => {
    if (!step) return;
    const cols = width();
    const clock = formatDuration(elapsed()).padStart(CLOCK_WIDTH);
    const right: Segment[] = [];
    // A step with a task behind it gets a bar; a bare spinner (download, login) only a clock.
    if (step.resource) {
      const barWidth = cols >= 70 ? 20 : cols >= 50 ? 10 : 0;
      if (barWidth) right.push(...bar(pct ?? 0, barWidth), ["  ", null]);
      right.push([statusText(status, pct).padStart(STATUS_WIDTH), null], ["  ", null]);
    }
    right.push([clock, "dim"]);
    stream.write(`${ERASE}${row(paint, [[FRAMES[frame % FRAMES.length]!, "brand"], [" ", null]], step.label, right, cols, true)}`);
  };

  const halt = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    if (active === self) active = null;
  };

  const self: Progress = {
    mode,
    start(next) {
      if (mode === "off") return;
      if (step) self.stop();
      step = next;
      startedAt = now();
      status = null;
      pct = null;
      if (mode === "lines") {
        stream.write(`${next.label}${next.taskId ? `  ${next.taskId}` : ""}\n`);
        return;
      }
      active = self;
      draw();
      timer = setInterval(() => {
        frame += 1;
        draw();
      }, opts.intervalMs ?? 100);
      timer.unref?.();
    },
    tick(nextStatus, nextPct) {
      if (!step) return;
      const s = nextStatus ?? null;
      const p = typeof nextPct === "number" ? nextPct : null;
      if (s === status && p === pct) return;
      status = s;
      pct = p;
      if (mode === "lines") {
        if (s) stream.write(`[${step.resource}] ${s}${p !== null ? ` ${p}%` : ""}\n`);
        return;
      }
      draw();
    },
    finish(outcome, detail) {
      if (!step) return;
      const took = elapsed();
      const done = step;
      step = null;
      halt();
      if (mode === "lines") {
        const word = outcome === "ok" ? "ok" : detail ?? (outcome === "timeout" ? "timed out" : "failed");
        stream.write(`      ${word} in ${took.toFixed(0)}s\n`);
        return;
      }
      const icon: Segment = outcome === "ok" ? ["✓", "green"] : outcome === "timeout" ? ["!", "yellow"] : ["✗", "red"];
      const right: Segment[] = [];
      if (done.taskId) right.push([done.taskId, "dim"], ["  ", null]);
      if (outcome !== "ok") right.push([detail ?? (outcome === "timeout" ? "timed out" : "failed"), outcome === "timeout" ? "yellow" : "red"], ["  ", null]);
      right.push([formatDuration(took).padStart(CLOCK_WIDTH), "dim"]);
      // The frozen line keeps the full label and id; it may wrap, it is never redrawn.
      stream.write(`${ERASE}${row(paint, [icon, [" ", null]], done.label, right, width(), false)}\n`);
    },
    clear() {
      if (step && mode === "live") stream.write(ERASE);
    },
    stop() {
      if (!step) return;
      self.clear();
      step = null;
      halt();
    },
  };
  return self;
}

/**
 * Run `fn` under a live-only spinner (downloads). The spinner is erased, not
 * frozen: the result view lists what was saved. Agents and logs see nothing new.
 */
export async function withSpinner<T>(format: OutputFormat, label: string, fn: () => Promise<T>): Promise<T> {
  const progress = createProgress(format, { liveOnly: true });
  progress.start({ label, resource: "" });
  try {
    return await fn();
  } finally {
    progress.stop();
  }
}

/** `[######--------]`, filled in proportion to the percentage. */
function bar(pct: number, width: number): Segment[] {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return [["[", "dim"], ["#".repeat(filled), "brand"], ["-".repeat(width - filled), "dim"], ["]", "dim"]];
}

type Segment = [text: string, style: Style | null];

/**
 * `prefix label ······ right`, with `right` flush against column `cols`.
 * Widths are measured on the plain text, then painted, so escapes never skew
 * them. `fit` truncates the label rather than let the row exceed `cols`.
 */
function row(paint: Painter, prefix: Segment[], label: string, right: Segment[], cols: number, fit: boolean): string {
  const len = (segs: Segment[]): number => segs.reduce((n, [t]) => n + t.length, 0);
  const fixed = len(prefix) + 2 + len(right);
  let text = label;
  if (fit && fixed + text.length > cols) text = `${text.slice(0, Math.max(1, cols - fixed - 1))}…`;
  const gap = " ".repeat(Math.max(2, cols - fixed - text.length + 2));
  const draw = (segs: Segment[]): string => segs.map(([t, style]) => (style ? paint(t, style) : t)).join("");
  return `${draw(prefix)}${text}${gap}${draw(right)}`;
}

/** Fixed widths so the columns do not jiggle as the numbers change. */
const STATUS_WIDTH = 9; // "succeeded", "running", "queued", "42%"
const CLOCK_WIDTH = 7; // "59m 59s"

function statusText(status: string | null, pct: number | null): string {
  if (status === null) return ""; // before the first status (and spinners that never get one): just the clock
  if (status === "PENDING") return "queued";
  if (status === "IN_PROGRESS") return pct !== null ? `${pct}%` : "running";
  return status.toLowerCase().replace(/_/g, " ");
}
