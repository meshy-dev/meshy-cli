/**
 * Headless environment detection and login mode resolution.
 *
 * detectHeadless() returns true when the process is running in an environment
 * where a browser cannot be opened (CI, SSH, container, no display server).
 *
 * resolveLoginMode() maps explicit flags + environment signals to one of the
 * four login modes: "loopback", "manual", "device", or "no-wait".
 */

import { existsSync } from "node:fs";

export type LoginMode = "loopback" | "manual" | "device" | "no-wait" | "resume";

export interface HeadlessEnv {
  CI?: string;
  SSH_CONNECTION?: string;
  SSH_TTY?: string;
  KUBERNETES_SERVICE_HOST?: string;
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  MESHY_CLI_NO_BROWSER?: string;
  [key: string]: string | undefined;
}

export interface TtyState {
  stderrIsTTY: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  platform: string;
}

/**
 * Detect whether the current environment is headless (no browser available).
 *
 * Strong signals (any one → headless):
 *   - CI env var set
 *   - SSH_CONNECTION or SSH_TTY set
 *   - /.dockerenv or /run/.containerenv exists
 *   - KUBERNETES_SERVICE_HOST set
 *   - Linux with no DISPLAY and no WAYLAND_DISPLAY
 *   - MESHY_CLI_NO_BROWSER=1 (explicit opt-out)
 *
 * Weak signal (both must be absent for headless):
 *   - !stderr.isTTY && !stdin.isTTY → probably headless
 *
 * NOTE: !stdout.isTTY alone is NOT used — piping JSON to jq on a desktop
 * must stay loopback.
 *
 * MESHY_CLI_FORCE_GUI=1 overrides all signals and forces GUI (non-headless)
 * mode. Used in tests that need to simulate a GUI environment.
 */
export function detectHeadless(
  env: HeadlessEnv = process.env,
  tty: TtyState = {
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    platform: process.platform,
  },
): boolean {
  // Force GUI mode (test escape hatch).
  if (env["MESHY_CLI_FORCE_GUI"]) return false;

  // Explicit opt-out.
  if (env["MESHY_CLI_NO_BROWSER"]) return true;

  // CI environment.
  if (env["CI"]) return true;

  // SSH session.
  if (env["SSH_CONNECTION"] || env["SSH_TTY"]) return true;

  // Container environments.
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;

  // Kubernetes.
  if (env["KUBERNETES_SERVICE_HOST"]) return true;

  // Linux with no display server.
  if (
    tty.platform === "linux" &&
    !env["DISPLAY"] &&
    !env["WAYLAND_DISPLAY"]
  ) {
    return true;
  }

  // Weak signal: no stderr TTY and no stdin TTY → probably headless.
  // (stdout piped to jq on a desktop must NOT trigger this.)
  if (!tty.stderrIsTTY && !tty.stdinIsTTY) return true;

  return false;
}

export interface ResolveModeOpts {
  manual?: boolean;
  device?: boolean;
  noWait?: boolean;
  deviceFlow?: string;
  deviceCode?: string;
  env?: HeadlessEnv;
  tty?: TtyState;
}

/**
 * Resolve the login mode from explicit flags and environment signals.
 *
 * Priority (highest to lowest):
 *   1. --device-flow <id> or --device-code <code> → "resume"
 *   2. --no-wait → "no-wait"
 *   3. --device → "device"
 *   4. --manual → "manual"
 *   5. detectHeadless() → "device"
 *   6. default → "loopback"
 */
export function resolveLoginMode(opts: ResolveModeOpts): LoginMode {
  const env = opts.env ?? process.env;
  const tty = opts.tty ?? {
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    platform: process.platform,
  };

  // Explicit resume flags win first.
  if (opts.deviceFlow || opts.deviceCode) return "resume";

  // Explicit mode flags.
  if (opts.noWait) return "no-wait";
  if (opts.device) return "device";
  if (opts.manual) return "manual";

  // Auto-detect.
  if (detectHeadless(env, tty)) return "device";

  return "loopback";
}
