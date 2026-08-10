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
import { emit, parseOutputFormat } from "../src/internal/output.js";

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
  assert.equal(parseOutputFormat(undefined), "json");
});

test("parseOutputFormat — rejects garbage", () => {
  assert.throws(() => parseOutputFormat("yaml"), /invalid --format/);
});
