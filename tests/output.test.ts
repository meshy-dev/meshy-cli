/**
 * Tests for the output renderer. stdout is intercepted via a fake write.
 */

// Disable update notifier so existing renderer tests are hermetic regardless
// of the dev machine's cache state.
process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOutputFormat, emit, parseOutputFormat, renderPretty } from "../src/internal/output.js";
import { emitResult, type OpenedCommand } from "../src/internal/command-helpers.js";
import type { GlobalFlags } from "../src/internal/runtime.js";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
    return chunks.join("");
  } finally {
    process.stdout.write = original;
  }
}

test("emit — json prints 2-space indented JSON with trailing newline", () => {
  const out = captureStdout(() => emit({ balance: 10 }, { format: "json" }));
  assert.equal(out, '{\n  "balance": 10\n}\n');
});

test("emit — ndjson of an array prints one-line-per-entry", () => {
  const out = captureStdout(() =>
    emit([{ a: 1 }, { a: 2 }], { format: "ndjson" }),
  );
  assert.equal(out, '{"a":1}\n{"a":2}\n');
});

test("emit — ndjson of an object prints a single compact line", () => {
  const out = captureStdout(() => emit({ a: 1 }, { format: "ndjson" }));
  assert.equal(out, '{"a":1}\n');
});

test("emit — pretty collapses primitives and indents nested objects", () => {
  const out = captureStdout(() =>
    emit(
      { id: "x", nested: { a: 1 }, list: [1, 2] },
      { format: "pretty" },
    ),
  );
  assert.match(out, /^id: x$/m);
  assert.match(out, /^nested:\n {2}a: 1$/m);
  assert.match(out, /^list:\n {2}- 1\n {2}- 2$/m);
});

test("emit — writes to file when opts.file is set, stdout stays empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-cli-out-"));
  const file = join(dir, "out.json");
  const stdout = captureStdout(() =>
    emit({ balance: 7 }, { format: "json", file }),
  );
  assert.equal(stdout, "");
  const written = readFileSync(file, "utf8");
  assert.equal(written, '{\n  "balance": 7\n}\n');
});

test("parseOutputFormat — accepts the three canonical values", () => {
  assert.equal(parseOutputFormat("json"), "json");
  assert.equal(parseOutputFormat("pretty"), "pretty");
  assert.equal(parseOutputFormat("NDJSON"), "ndjson");
  // Untyped follows the TTY; this runner's stdout is a pipe.
  assert.equal(parseOutputFormat(undefined), "json");
});

/**
 * The machine contract is "a pipe gets JSON", not "the default is JSON". Every
 * agent, script and CI run reaches the CLI through a pipe or a subprocess, so
 * only a person at a terminal ever sees the other branch.
 */
test("defaultOutputFormat — pretty on a TTY, json everywhere else", () => {
  assert.equal(defaultOutputFormat(true), "pretty");
  assert.equal(defaultOutputFormat(false), "json");
  assert.equal(defaultOutputFormat(), "json", "the test runner's stdout is a pipe");
});

test("renderPretty — an empty collection stays on the key's line", () => {
  assert.equal(renderPretty({ warnings: [], meta: {} }), "warnings: []\nmeta: {}");
  assert.equal(renderPretty({ warnings: ["a"] }), "warnings:\n  - a");
});

test("parseOutputFormat — rejects garbage", () => {
  assert.throws(() => parseOutputFormat("yaml"), /invalid --format/);
});

// ---------------------------------------------------------------------------
// Legacy `-o <file>` under the TTY default
// ---------------------------------------------------------------------------

function opened(format: "json" | "pretty", formatExplicit: boolean): OpenedCommand {
  const flags = { format, formatExplicit, updateCheck: false, verbose: false } as GlobalFlags;
  return { command: "balance", schema: "legacy", format, flags };
}

/**
 * `-o <file>` writes the payload to disk instead of stdout. A TTY-derived
 * `pretty` describes the terminal, not the file, and callers have always read
 * that file back as JSON — so an untyped --format must not leak into it.
 */
test("emitResult — untyped --format on a TTY still writes JSON to -o", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "meshy-cli-ofile-")), "out.json");
  await emitResult(opened("pretty", false), { balance: 7 }, { balance: 7 }, { legacyFile: file });
  assert.equal(readFileSync(file, "utf8"), '{\n  "balance": 7\n}\n');
});

test("emitResult — an explicit --format pretty is honoured for -o", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "meshy-cli-ofile-")), "out.txt");
  await emitResult(opened("pretty", true), { balance: 7 }, { balance: 7 }, { legacyFile: file });
  assert.equal(readFileSync(file, "utf8"), "balance: 7\n");
});
