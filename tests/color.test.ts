/**
 * Colour is a property of the destination. These tests pin the decision table,
 * because the failure mode is invisible in a terminal and only shows up when
 * someone greps a log or parses a file full of escape codes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { colorEnabled, painted, painterFor, plain } from "../src/internal/color.js";
import { render, renderPretty } from "../src/internal/output.js";

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

test("colorEnabled — a TTY with a plain environment is the only default yes", () => {
  assert.equal(colorEnabled(TTY, {}), true);
  assert.equal(colorEnabled(PIPE, {}), false);
});

test("colorEnabled — NO_COLOR vetoes a TTY, FORCE_COLOR overrides a pipe", () => {
  assert.equal(colorEnabled(TTY, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled(TTY, { NO_COLOR: "" }), true, "empty NO_COLOR is not set");
  assert.equal(colorEnabled(PIPE, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled(TTY, { FORCE_COLOR: "0" }), false, "FORCE_COLOR=0 means off");
  assert.equal(colorEnabled(TTY, { FORCE_COLOR: "0", NO_COLOR: "1" }), false);
});

test("colorEnabled — TERM=dumb cannot render escapes", () => {
  assert.equal(colorEnabled(TTY, { TERM: "dumb" }), false);
  assert.equal(colorEnabled(TTY, { TERM: "xterm-256color" }), true);
});

test("painterFor — returns the identity painter when colour is off", () => {
  assert.equal(painterFor(PIPE, {}), plain);
  assert.equal(painterFor(TTY, {}), painted);
  assert.equal(plain("ok", "green"), "ok");
  assert.equal(painted("ok", "green"), "\u001b[32mok\u001b[0m");
  assert.equal(painted("", "green"), "", "never wrap an empty string");
});

test("renderPretty — unpainted by default, so every existing caller stays plain", () => {
  assert.equal(renderPretty({ status: "ok" }), "status: ok");
  assert.match(renderPretty({ status: "ok" }, 0, painted), /\u001b\[/);
});

test("renderPretty — states are painted by meaning, whole-value and case-insensitive", () => {
  assert.equal(renderPretty({ s: "SUCCEEDED" }, 0, painted), "\u001b[2ms:\u001b[0m \u001b[32mSUCCEEDED\u001b[0m");
  assert.equal(renderPretty({ s: "FAILED" }, 0, painted), "\u001b[2ms:\u001b[0m \u001b[31mFAILED\u001b[0m");
  assert.equal(renderPretty({ s: "PENDING" }, 0, painted), "\u001b[2ms:\u001b[0m \u001b[33mPENDING\u001b[0m");
  // A value that merely contains a state word is left alone.
  assert.equal(renderPretty({ s: "a failed robot" }, 0, painted), "\u001b[2ms:\u001b[0m a failed robot");
});

/**
 * The machine formats must never carry an escape, whatever the painter says —
 * this is the one that would silently corrupt every agent reading stdout.
 */
test("render — json and ndjson ignore the painter entirely", () => {
  for (const format of ["json", "ndjson"] as const) {
    const out = render({ status: "ok", nested: { v: true } }, format, painted);
    assert.doesNotMatch(out, /\u001b\[/, `${format} must stay escape-free`);
    assert.deepEqual(JSON.parse(out), { status: "ok", nested: { v: true } });
  }
});
