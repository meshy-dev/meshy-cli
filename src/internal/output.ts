/**
 * Output rendering.
 *
 * `--format` defaults to the shape the destination can actually use: `pretty`
 * when stdout is a TTY (a human typed the command), `json` otherwise — piped,
 * redirected, or spawned as a subprocess, which covers every agent, script and
 * CI run. This is the `gh` / `npm` / `kubectl` convention; printing raw JSON
 * braces at a person is the `aws` one. Nothing about the machine contract
 * moves: a pipe still gets exactly the same bytes as before, and `--format
 * json` / `--json` still force it.
 *
 * Legacy path (`emit`): bare payloads, optionally decorated with
 * `_notice.update` when a newer meshy-cli version is available. See
 * update-notifier.ts for the two-channel design.
 *
 * v1 path (`emitEnvelope`): exactly one envelope object, never decorated —
 * the six top-level keys are the contract. Humans on a TTY still get the
 * update hint on stderr.
 */

import { writeFileSync } from "node:fs";
import { attachUpdateNotice, getUpdateNotice, printHumanUpdateHint } from "./update-notifier.js";
import { painterFor, plain, type Painter } from "./color.js";
import { currentCommand } from "./context.js";
import { renderView } from "./views.js";
import type { StreamEventEnvelope, V1Envelope } from "./result.js";

export type OutputFormat = "json" | "pretty" | "ndjson";

export interface OutputOptions {
  format: OutputFormat;
  file?: string;
}

export function emit(value: unknown, opts: OutputOptions): void {
  const notice = getUpdateNotice();
  const decorated = attachUpdateNotice(value, opts.format, notice);
  const paint = opts.file ? plain : painterFor(process.stdout);
  const text = opts.format === "pretty" ? pretty(decorated, paint) : render(decorated, opts.format, paint);
  if (opts.file) {
    writeFileSync(opts.file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  } else {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  // After the output write in both branches: interactive users get the hint
  // even when JSON goes to a file; -o task flows don't double-print because
  // they bypass emit() via printReport.
  printHumanUpdateHint(notice, process);
}

/**
 * Write to stdout and resolve once the bytes are handed to the OS. Needed
 * before an explicit process.exit(), which does not wait for pending writes
 * on pipes — large JSON or a cancelled stream would otherwise be truncated.
 */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
    if (ok) {
      // Callback still fires; nothing else to do.
    }
  });
}

/** Print one v1 envelope in the requested rendering. */
export async function emitEnvelope(envelope: V1Envelope, format: OutputFormat): Promise<void> {
  const paint = painterFor(process.stdout);
  const text = format === "pretty" ? pretty(envelope, paint) : render(envelope, format, paint);
  await writeStdout(`${text}\n`);
  // A person reads warnings as prose; the envelope keeps them for machines.
  if (format === "pretty") printWarnings(envelope.warnings);
  printHumanUpdateHint(getUpdateNotice(), process);
}

/** `warning: …` lines on stderr, painted for stderr. */
export function printWarnings(warnings: ReadonlyArray<{ message: string }>): void {
  const paint = painterFor(process.stderr);
  for (const w of warnings) process.stderr.write(`${paint("warning:", "yellow")} ${w.message}\n`);
}

/** The per-command human view (views.ts) for the command that is running. */
function pretty(value: unknown, paint: Painter): string {
  const ctx = currentCommand();
  return renderView(ctx?.command, value, paint, ctx?.view);
}

/** Print one stream event (ndjson only; json/pretty callers print the final envelope instead). */
export async function emitStreamEvent(event: StreamEventEnvelope): Promise<void> {
  await writeStdout(`${JSON.stringify(event)}\n`);
}

/**
 * The raw renderings. `pretty` here is the generic dump; what a person sees
 * goes through the per-command views in views.ts (emit / emitEnvelope).
 *
 * `paint` defaults to plain: a caller that does not say where the text is going
 * gets no escapes. Only the stdout paths opt in — a file must never receive
 * them, or `--format pretty -o notes.txt` writes control codes to disk.
 */
export function render(value: unknown, format: OutputFormat, paint: Painter = plain): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2);
    case "ndjson":
      if (Array.isArray(value)) return value.map((v) => JSON.stringify(v)).join("\n");
      return JSON.stringify(value);
    case "pretty":
      return renderPretty(value, 0, paint);
  }
}

/**
 * Values whose meaning a reader scans for rather than reads: task and check
 * states. Matched case-insensitively on the whole value, so a prompt or a
 * model name containing the word is never repainted.
 */
const VALUE_STYLES: Record<string, "green" | "red" | "yellow"> = {
  ok: "green",
  pass: "green",
  passed: "green",
  succeeded: "green",
  success: "green",
  ready: "green",
  true: "green",
  fail: "red",
  failed: "red",
  error: "red",
  false: "red",
  skipped: "yellow",
  pending: "yellow",
  in_progress: "yellow",
  canceled: "yellow",
  cancelled: "yellow",
  warn: "yellow",
  warning: "yellow",
};

function paintScalar(v: unknown, paint: Painter): string {
  if (v === null || v === undefined) return paint("-", "dim");
  const text = String(v);
  const style = VALUE_STYLES[text.toLowerCase()];
  return style ? paint(text, style) : text;
}

export function renderPretty(value: unknown, indent = 0, paint: Painter = plain): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}${paint("-", "dim")}`;
  if (typeof value !== "object") return `${pad}${paintScalar(value, paint)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((v) => `${pad}${paint("-", "dim")} ${renderPretty(v, indent + 1, paint).trimStart()}`).join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${pad}{}`;
  return entries
    .map(([k, v]) => {
      const key = paint(`${k}:`, "dim");
      if (v !== null && typeof v === "object") {
        // An empty array/object reads as `warnings: []`, not a dangling key
        // with `[]` on the next line. Only matters now that pretty is what a
        // person sees by default.
        const nested = renderPretty(v, indent + 1, paint);
        if (nested.trim() === "[]" || nested.trim() === "{}") return `${pad}${key} ${nested.trim()}`;
        return `${pad}${key}\n${nested}`;
      }
      return `${pad}${key} ${paintScalar(v, paint)}`;
    })
    .join("\n");
}



/**
 * The format to use when `--format` was not given. A TTY means a person is
 * reading; anything else is a pipe, a file or a subprocess, and must keep
 * getting JSON.
 */
export function defaultOutputFormat(isTTY: boolean = Boolean(process.stdout.isTTY)): OutputFormat {
  return isTTY ? "pretty" : "json";
}

export function parseOutputFormat(raw: string | undefined): OutputFormat {
  if (raw === undefined) return defaultOutputFormat();
  const v = raw.toLowerCase();
  if (v === "json" || v === "pretty" || v === "ndjson") return v;
  throw new Error(`invalid --format '${raw}'. Expected: json | pretty | ndjson`);
}
