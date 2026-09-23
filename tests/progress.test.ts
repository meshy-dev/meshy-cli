/**
 * stderr progress (src/internal/progress.ts). The mode follows the stream:
 * a terminal gets one line redrawn in place, everything else (agents, CI,
 * logs) gets plain lines, ndjson gets nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createProgress, progressMode } from "../src/internal/progress.js";
import { resolveFormat } from "../src/internal/runtime.js";

function fakeStream(isTTY: boolean, columns = 80): { isTTY: boolean; columns: number; out: string; write(s: string): boolean } {
  return { isTTY, columns, out: "", write(s: string) { this.out += s; return true; } };
}

const NO_CI = { TERM: "xterm-256color" };

test("mode: TTY is live, CI / dumb / pipe are lines, ndjson is off", () => {
  assert.equal(progressMode("pretty", { isTTY: true }, NO_CI), "live");
  assert.equal(progressMode("json", { isTTY: true }, NO_CI), "live", "stderr decides, not the stdout format");
  assert.equal(progressMode("pretty", { isTTY: true }, { ...NO_CI, CI: "true" }), "lines");
  assert.equal(progressMode("pretty", { isTTY: true }, { TERM: "dumb" }), "lines");
  assert.equal(progressMode("json", { isTTY: false }, NO_CI), "lines");
  assert.equal(progressMode("ndjson", { isTTY: true }, NO_CI), "off");
});

test("lines: the step and its id, one line per change (not per poll), the outcome", () => {
  const s = fakeStream(false);
  let t = 0;
  const p = createProgress("json", { stream: s, env: NO_CI, now: () => t });
  p.start({ label: "[1/2] text-to-3d preview (geometry)", resource: "text-to-3d", taskId: "t-1" });
  p.tick("PENDING");
  p.tick("IN_PROGRESS", 10);
  p.tick("IN_PROGRESS", 10);
  p.tick("IN_PROGRESS", 42);
  t = 87_000;
  p.finish("ok");
  assert.equal(
    s.out,
    "[1/2] text-to-3d preview (geometry)  t-1\n[text-to-3d] PENDING\n[text-to-3d] IN_PROGRESS 10%\n[text-to-3d] IN_PROGRESS 42%\n      ok in 87s\n",
  );
});

test("live: a bar, percentage and clock flush right; redrawn in place, never wider than the terminal", () => {
  const s = fakeStream(true, 100);
  let t = 0;
  const p = createProgress("pretty", { stream: s, env: { ...NO_CI, NO_COLOR: "1" }, now: () => t, intervalMs: 60_000 });
  p.start({ label: "[2/2] text-to-3d refine (textures)", resource: "text-to-3d", taskId: "t-2" });
  t = 72_000;
  p.tick("IN_PROGRESS", 42);
  const frames = s.out.split("\r\u001b[2K").filter(Boolean);
  assert.ok(frames.length >= 2, "each change redraws the same line");
  const last = frames.at(-1)!;
  assert.equal(last.length, 99, "exactly one column short of the terminal, so it never wraps");
  assert.match(last, /^⠋ \[2\/2\] text-to-3d refine \(textures\) +\[########------------\] {8}42% +1m 12s$/);
  t = 336_000;
  p.finish("ok");
  const frozen = s.out.split("\r\u001b[2K").at(-1)!;
  assert.match(frozen, /^✓ \[2\/2\] text-to-3d refine \(textures\) +t-2 +5m 36s\n$/);
  assert.equal(frozen.length - 1, 99, "the frozen time lines up with the live clock");
});

test("live: narrow terminals drop the bar and truncate the label; failures keep their status word", () => {
  const s = fakeStream(true, 40);
  const p = createProgress("pretty", { stream: s, env: { ...NO_CI, NO_COLOR: "1" }, now: () => 0, intervalMs: 60_000 });
  p.start({ label: "[1/2] text-to-3d preview (geometry) with a long label", resource: "text-to-3d" });
  p.tick("IN_PROGRESS", 42);
  for (const frame of s.out.split("\r\u001b[2K").filter(Boolean)) {
    assert.ok(frame.length <= 39, `fits in 40 columns: ${JSON.stringify(frame)}`);
    assert.doesNotMatch(frame, /\[#|-\]/, "no room for a bar");
  }
  p.finish("failed", "FAILED");
  assert.match(s.out, /✗ \[1\/2\] text-to-3d preview \(geometry\) with a long label {2}FAILED +0s\n$/);
});

test("live: a bare spinner (download, login) is just a clock, and stop erases without a trailing line", () => {
  const s = fakeStream(true, 60);
  const p = createProgress("pretty", { stream: s, env: { ...NO_CI, NO_COLOR: "1" }, now: () => 0, intervalMs: 60_000 });
  p.start({ label: "Downloading assets", resource: "" });
  assert.match(s.out, /^\r\u001b\[2K⠋ Downloading assets +0s$/);
  p.stop();
  assert.ok(s.out.endsWith("\r\u001b[2K"), "stop leaves an empty line for the next writer");
  p.finish("ok");
  assert.ok(s.out.endsWith("\r\u001b[2K"), "finish after stop is a no-op");
});

test("off and liveOnly write nothing", () => {
  const s = fakeStream(true);
  const off = createProgress("ndjson", { stream: s, env: NO_CI });
  off.start({ label: "x", resource: "x", taskId: "t" });
  off.tick("IN_PROGRESS", 1);
  off.finish("ok");
  const pipe = fakeStream(false);
  const liveOnly = createProgress("json", { stream: pipe, env: NO_CI, liveOnly: true });
  liveOnly.start({ label: "Downloading assets", resource: "" });
  liveOnly.finish("ok");
  assert.equal(s.out + pipe.out, "");
});

test("D-065: a typed --output-schema v1 means JSON even on a TTY; a typed --format still wins", () => {
  assert.equal(resolveFormat({}, true), "pretty");
  assert.equal(resolveFormat({}, false), "json");
  assert.equal(resolveFormat({ outputSchema: "v1" }, true), "json");
  assert.equal(resolveFormat({ outputSchema: "legacy" }, true), "pretty");
  assert.equal(resolveFormat({ outputSchema: "v1", format: "pretty" }, true), "pretty");
  assert.equal(resolveFormat({ format: "pretty", json: true }, true), "json");
});
