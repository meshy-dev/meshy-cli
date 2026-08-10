/**
 * Tests for src/internal/headless.ts — detectHeadless() and resolveLoginMode().
 */

import test from "node:test";
import assert from "node:assert/strict";

import { detectHeadless, resolveLoginMode } from "../src/internal/headless.js";
import type { HeadlessEnv, TtyState } from "../src/internal/headless.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A "desktop GUI" TTY state — stderr + stdin are TTYs. */
const GUI_TTY: TtyState = {
  stderrIsTTY: true,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  platform: "linux",
};

/** A "piped stdout" state — stdout is NOT a TTY, but stderr + stdin are. */
const PIPED_STDOUT_TTY: TtyState = {
  stderrIsTTY: true,
  stdinIsTTY: true,
  stdoutIsTTY: false,
  platform: "linux",
};

/** A fully headless TTY state. */
const HEADLESS_TTY: TtyState = {
  stderrIsTTY: false,
  stdinIsTTY: false,
  stdoutIsTTY: false,
  platform: "linux",
};

const EMPTY_ENV: HeadlessEnv = {};

// ---------------------------------------------------------------------------
// detectHeadless — strong signals
// ---------------------------------------------------------------------------

test("detectHeadless — CI=1 → headless", () => {
  assert.equal(detectHeadless({ CI: "1" }, GUI_TTY), true);
});

test("detectHeadless — CI=true → headless", () => {
  assert.equal(detectHeadless({ CI: "true" }, GUI_TTY), true);
});

test("detectHeadless — SSH_CONNECTION set → headless", () => {
  assert.equal(detectHeadless({ SSH_CONNECTION: "10.0.0.1 12345 10.0.0.2 22" }, GUI_TTY), true);
});

test("detectHeadless — SSH_TTY set → headless", () => {
  assert.equal(detectHeadless({ SSH_TTY: "/dev/pts/0" }, GUI_TTY), true);
});

test("detectHeadless — KUBERNETES_SERVICE_HOST set → headless", () => {
  assert.equal(detectHeadless({ KUBERNETES_SERVICE_HOST: "10.96.0.1" }, GUI_TTY), true);
});

test("detectHeadless — MESHY_CLI_NO_BROWSER=1 → headless", () => {
  assert.equal(detectHeadless({ MESHY_CLI_NO_BROWSER: "1" }, GUI_TTY), true);
});

test("detectHeadless — MESHY_CLI_NO_BROWSER=true → headless", () => {
  assert.equal(detectHeadless({ MESHY_CLI_NO_BROWSER: "true" }, GUI_TTY), true);
});

// ---------------------------------------------------------------------------
// detectHeadless — Linux no-display signal
// ---------------------------------------------------------------------------

test("detectHeadless — Linux, no DISPLAY, no WAYLAND_DISPLAY → headless", () => {
  const linuxTty: TtyState = { ...GUI_TTY, platform: "linux" };
  assert.equal(detectHeadless(EMPTY_ENV, linuxTty), true);
});

test("detectHeadless — Linux with DISPLAY → NOT headless (GUI TTY)", () => {
  const linuxTty: TtyState = { ...GUI_TTY, platform: "linux" };
  assert.equal(detectHeadless({ DISPLAY: ":0" }, linuxTty), false);
});

test("detectHeadless — Linux with WAYLAND_DISPLAY → NOT headless (GUI TTY)", () => {
  const linuxTty: TtyState = { ...GUI_TTY, platform: "linux" };
  assert.equal(detectHeadless({ WAYLAND_DISPLAY: "wayland-0" }, linuxTty), false);
});

test("detectHeadless — macOS, no DISPLAY → NOT headless (platform not linux)", () => {
  const macTty: TtyState = { ...GUI_TTY, platform: "darwin" };
  assert.equal(detectHeadless(EMPTY_ENV, macTty), false);
});

test("detectHeadless — Windows, no DISPLAY → NOT headless (platform not linux)", () => {
  const winTty: TtyState = { ...GUI_TTY, platform: "win32" };
  assert.equal(detectHeadless(EMPTY_ENV, winTty), false);
});

// ---------------------------------------------------------------------------
// detectHeadless — weak signal (no TTY)
// ---------------------------------------------------------------------------

test("detectHeadless — no stderr TTY and no stdin TTY → headless (weak signal)", () => {
  // Even on macOS with DISPLAY, if both stderr and stdin are not TTYs → headless.
  const macTty: TtyState = {
    stderrIsTTY: false,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    platform: "darwin",
  };
  assert.equal(detectHeadless(EMPTY_ENV, macTty), true);
});

test("detectHeadless — stdout piped but stderr+stdin are TTYs → NOT headless", () => {
  // Piping JSON to jq on a desktop must stay loopback.
  assert.equal(detectHeadless({ DISPLAY: ":0" }, PIPED_STDOUT_TTY), false);
});

test("detectHeadless — stdout piped, stderr TTY, stdin NOT TTY → NOT headless (only stdin non-TTY, stderr still TTY)", () => {
  // Spec: weak signal requires BOTH stderr AND stdin to be non-TTY.
  const tty: TtyState = {
    stderrIsTTY: true,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    platform: "darwin",
  };
  assert.equal(detectHeadless(EMPTY_ENV, tty), false);
});

test("detectHeadless — stderr NOT TTY, stdin TTY → NOT headless (only stderr non-TTY, stdin still TTY)", () => {
  // Spec: weak signal requires BOTH stderr AND stdin to be non-TTY.
  const tty: TtyState = {
    stderrIsTTY: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: "darwin",
  };
  assert.equal(detectHeadless(EMPTY_ENV, tty), false);
});

// ---------------------------------------------------------------------------
// detectHeadless — NOT headless (GUI desktop)
// ---------------------------------------------------------------------------

test("detectHeadless — GUI desktop (macOS, all TTYs, no env signals) → NOT headless", () => {
  const macTty: TtyState = { ...GUI_TTY, platform: "darwin" };
  assert.equal(detectHeadless(EMPTY_ENV, macTty), false);
});

test("detectHeadless — GUI desktop (Windows, all TTYs, no env signals) → NOT headless", () => {
  const winTty: TtyState = { ...GUI_TTY, platform: "win32" };
  assert.equal(detectHeadless(EMPTY_ENV, winTty), false);
});

// ---------------------------------------------------------------------------
// resolveLoginMode — explicit flags win
// ---------------------------------------------------------------------------

test("resolveLoginMode — --device-flow wins over everything", () => {
  assert.equal(
    resolveLoginMode({
      deviceFlow: "abc123",
      manual: true,
      device: true,
      noWait: true,
      env: { CI: "1" },
      tty: HEADLESS_TTY,
    }),
    "resume",
  );
});

test("resolveLoginMode — --device-code wins over everything except --device-flow", () => {
  assert.equal(
    resolveLoginMode({
      deviceCode: "XXXX-XXXX",
      manual: true,
      device: true,
      noWait: true,
      env: { CI: "1" },
      tty: HEADLESS_TTY,
    }),
    "resume",
  );
});

test("resolveLoginMode — --no-wait wins over --device and --manual", () => {
  assert.equal(
    resolveLoginMode({
      noWait: true,
      device: true,
      manual: true,
      env: EMPTY_ENV,
      tty: GUI_TTY,
    }),
    "no-wait",
  );
});

test("resolveLoginMode — --device wins over --manual", () => {
  assert.equal(
    resolveLoginMode({
      device: true,
      manual: true,
      env: EMPTY_ENV,
      tty: GUI_TTY,
    }),
    "device",
  );
});

test("resolveLoginMode — --manual selects manual mode", () => {
  assert.equal(
    resolveLoginMode({
      manual: true,
      env: EMPTY_ENV,
      tty: GUI_TTY,
    }),
    "manual",
  );
});

// ---------------------------------------------------------------------------
// resolveLoginMode — auto-detect
// ---------------------------------------------------------------------------

test("resolveLoginMode — headless env → device (auto)", () => {
  assert.equal(
    resolveLoginMode({
      env: { CI: "1" },
      tty: GUI_TTY,
    }),
    "device",
  );
});

test("resolveLoginMode — GUI desktop → loopback (auto)", () => {
  const macTty: TtyState = { ...GUI_TTY, platform: "darwin" };
  assert.equal(
    resolveLoginMode({
      env: EMPTY_ENV,
      tty: macTty,
    }),
    "loopback",
  );
});

test("resolveLoginMode — SSH session → device (auto)", () => {
  assert.equal(
    resolveLoginMode({
      env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
      tty: GUI_TTY,
    }),
    "device",
  );
});
