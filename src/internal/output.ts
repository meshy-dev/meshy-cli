/**
 * Output rendering. Keep stdout machine-parseable by default; `pretty` is
 * opt-in for human eyes.
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
import type { StreamEventEnvelope, V1Envelope } from "./result.js";

export type OutputFormat = "json" | "pretty" | "ndjson";

export interface OutputOptions {
  format: OutputFormat;
  file?: string;
}

export function emit(value: unknown, opts: OutputOptions): void {
  const notice = getUpdateNotice();
  const decorated = attachUpdateNotice(value, opts.format, notice);
  const text = render(decorated, opts.format);
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
  const text = format === "pretty" ? renderPretty(envelope) : format === "ndjson" ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2);
  await writeStdout(`${text}\n`);
  printHumanUpdateHint(getUpdateNotice(), process);
}

/** Print one stream event (ndjson only; json/pretty callers print the final envelope instead). */
export async function emitStreamEvent(event: StreamEventEnvelope): Promise<void> {
  await writeStdout(`${JSON.stringify(event)}\n`);
}

export function render(value: unknown, format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2);
    case "ndjson":
      if (Array.isArray(value)) return value.map((v) => JSON.stringify(v)).join("\n");
      return JSON.stringify(value);
    case "pretty":
      return renderPretty(value);
  }
}

export function renderPretty(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}-`;
  if (typeof value !== "object") return `${pad}${String(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((v) => `${pad}- ${renderPretty(v, indent + 1).trimStart()}`).join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${pad}{}`;
  return entries
    .map(([k, v]) => {
      if (v !== null && typeof v === "object") {
        return `${pad}${k}:\n${renderPretty(v, indent + 1)}`;
      }
      return `${pad}${k}: ${v === null || v === undefined ? "-" : String(v)}`;
    })
    .join("\n");
}

export function parseOutputFormat(raw: string | undefined): OutputFormat {
  const v = (raw ?? "json").toLowerCase();
  if (v === "json" || v === "pretty" || v === "ndjson") return v;
  throw new Error(`invalid --format '${raw}'. Expected: json | pretty | ndjson`);
}
