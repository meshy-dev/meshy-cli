/**
 * Output rendering. Keep stdout machine-parseable by default; `pretty` is
 * opt-in for human eyes.
 *
 * Note: stdout JSON may carry `_notice.update` when a newer meshy-cli version
 * is available. See update-notifier.ts for the two-channel design.
 */

import { writeFileSync } from "node:fs";
import { attachUpdateNotice, getUpdateNotice, printHumanUpdateHint } from "./update-notifier.js";

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

function render(value: unknown, format: OutputFormat): string {
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

function renderPretty(value: unknown, indent = 0): string {
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
