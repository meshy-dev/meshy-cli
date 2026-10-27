/**
 * Tests for the output renderer. stdout is intercepted via a fake write.
 */

// Disable update notifier so existing renderer tests are hermetic regardless
// of the dev machine's cache state.
process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { defaultOutputFormat, emitEnvelope, parseOutputFormat, render, renderPretty } from "../src/internal/output.js";
import { emitResult, type OpenedCommand } from "../src/internal/command-helpers.js";
import { okEnvelope, SCHEMA_VERSION } from "../src/internal/result.js";
import type { GlobalFlags } from "../src/internal/runtime.js";

/** Capture stdout across an async body; the fake write honours the completion callback writeStdout waits on. */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = original;
  }
}

test("render — json prints 2-space indented JSON", () => {
  assert.equal(render({ balance: 10 }, "json"), '{\n  "balance": 10\n}');
});

test("render — ndjson of an array prints one line per entry; an object one compact line", () => {
  assert.equal(render([{ a: 1 }, { a: 2 }], "ndjson"), '{"a":1}\n{"a":2}');
  assert.equal(render({ a: 1 }, "ndjson"), '{"a":1}');
});

test("render — pretty collapses primitives and indents nested objects", () => {
  const out = render({ id: "x", nested: { a: 1 }, list: [1, 2] }, "pretty");
  assert.match(out, /^id: x$/m);
  assert.match(out, /^nested:\n {2}a: 1$/m);
  assert.match(out, /^list:\n {2}- 1\n {2}- 2$/m);
});

test("render — no painter means no colour, whatever the terminal would show", () => {
  const out = render({ status: "ok" }, "pretty");
  assert.equal(out, "status: ok");
  assert.doesNotMatch(out, /\u001b\[/);
});

test("emitEnvelope — json prints exactly one envelope object with a trailing newline", async () => {
  const out = await captureStdout(() => emitEnvelope(okEnvelope("balance", { balance: 10 }), "json"));
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["schema_version", "command", "ok", "result", "error", "warnings"]);
  assert.equal(parsed["schema_version"], SCHEMA_VERSION);
  assert.ok(out.endsWith("\n"));
});

test("emitEnvelope — ndjson prints the envelope on one line", async () => {
  const out = await captureStdout(() => emitEnvelope(okEnvelope("balance", { balance: 10 }), "ndjson"));
  assert.equal(out.split("\n").filter(Boolean).length, 1);
  assert.equal((JSON.parse(out) as { result: { balance: number } }).result.balance, 10);
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
// emitResult — one envelope per command, whatever the command
// ---------------------------------------------------------------------------

function opened(format: "json" | "pretty"): OpenedCommand {
  const flags = { format, formatExplicit: true, updateCheck: false, verbose: false } as GlobalFlags;
  return { command: "balance", format, flags };
}

test("emitResult — wraps the result in the envelope under the opened command", async () => {
  const out = await captureStdout(() => emitResult(opened("json"), { balance: 7 }));
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.equal(parsed["command"], "balance");
  assert.equal(parsed["ok"], true);
  assert.deepEqual(parsed["result"], { balance: 7 });
  assert.equal(parsed["error"], null);
  assert.deepEqual(parsed["warnings"], []);
});

test("emitResult — warnings ride in the envelope", async () => {
  const out = await captureStdout(() => emitResult(opened("json"), { balance: 7 }, { warnings: [{ code: "w", message: "careful" }] }));
  const parsed = JSON.parse(out) as { warnings: Array<{ code: string }> };
  assert.equal(parsed.warnings[0]?.code, "w");
});
