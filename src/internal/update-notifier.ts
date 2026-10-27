/**
 * Update notifier: one stderr line for a person at a terminal when npm has a
 * newer release. Never on stdout, never in the envelope, never in the way:
 * the command only reads a cache file, and the registry is asked at most
 * once a day by a detached child (`meshy __refresh-update-cache`), so a slow
 * or unreachable registry cannot delay the command's exit.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { painterFor } from "./color.js";
import { configDir } from "./credentials.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

/**
 * The lookup and the upgrade hint name the package this build was installed
 * from: `meshy-cli` and its alias `@meshy-ai/cli` ship the same bins, and npm
 * will not relink a bin owned by the other package.
 */
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hidden self-command the detached refresh child runs (a local command: it never spawns another). */
export const REFRESH_COMMAND = "__refresh-update-cache";
/** CI environment variables: any non-empty value means no person is watching. */
export const CI_VARS = ["CI", "GITHUB_ACTIONS", "BUILD_NUMBER", "RUN_ID"] as const;

interface UpdateState {
  latest_version?: unknown;
  checked_at?: unknown;
}

/** In the config directory, so MESHY_CONFIG_DIR isolates it like the credentials. */
export function stateFilePath(): string {
  return join(configDir(), "update-state.json");
}

/** Opted out (`--no-update-check` sets MESHY_CLI_NO_UPDATE_NOTIFIER) or running in CI. */
export function shouldSkip(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env["MESHY_CLI_NO_UPDATE_NOTIFIER"]) || CI_VARS.some((v) => env[v]);
}

function readState(file: string): UpdateState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

/** Releases are plain `x.y.z`; anything else (a prerelease, garbage) is never announced. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The line to show, read from the cache only; null when nothing newer is known. */
export function updateMessage(env: NodeJS.ProcessEnv = process.env, file: string = stateFilePath(), current: string = VERSION): string | null {
  if (shouldSkip(env)) return null;
  const latest = readState(file).latest_version;
  if (typeof latest !== "string" || !isNewer(latest, current)) return null;
  return `${PACKAGE_NAME} ${latest} available (current ${current}), run: npm i -g ${PACKAGE_NAME}@latest`;
}

type TerminalIo = {
  stdout: { isTTY?: boolean };
  stderr: { isTTY?: boolean; write(s: string): unknown };
  stdin: { isTTY?: boolean };
};

/** Stderr, and only when stdin, stdout and stderr are all a terminal. */
export function printHumanUpdateHint(message: string | null, io: TerminalIo = process): boolean {
  if (!message || !io.stdout.isTTY || !io.stderr.isTTY || !io.stdin.isTTY) return false;
  io.stderr.write(`${painterFor(io.stderr)(message, "dim")}\n`);
  return true;
}

/**
 * Whether this invocation may start a check: never for local work (a command
 * in `localCommands`, help, --version, `make --dry-run`), never when opted out
 * or in CI.
 */
export function shouldRunUpdateCheck(argv: string[], localCommands: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (shouldSkip(env) || argv.includes("--no-update-check")) return false;
  const rest = argv.slice(2);
  if (rest.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V")) return false;
  const first = rest.find((a) => !a.startsWith("-"));
  if (!first || localCommands.has(first)) return false;
  return !(first === "make" && rest.includes("--dry-run"));
}

/**
 * Start the daily refresh in a detached child when the cache is older than a
 * day (or missing, or dated in the future). Returns at once and never throws.
 */
export function refreshCache(file: string = stateFilePath(), now: number = Date.now(), spawnImpl: typeof spawn = spawn): void {
  try {
    const checked = readState(file).checked_at;
    if (typeof checked === "number" && checked <= now && now - checked < CACHE_TTL_MS) return;
    const script = process.argv[1];
    if (!script) return;
    const child = spawnImpl(process.execPath, [script, REFRESH_COMMAND], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // fire-and-forget
  }
}

/** The detached child: ask npm once and cache the answer; any failure leaves the cache as it was. */
export async function runRefreshCommand(
  registryUrl: string = process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] ?? REGISTRY_URL,
  file: string = stateFilePath(),
): Promise<void> {
  try {
    const res = await fetch(registryUrl, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!res.ok) return;
    const version = ((await res.json()) as { version?: unknown }).version;
    if (typeof version !== "string") return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ latest_version: version, checked_at: Date.now() }));
    renameSync(tmp, file);
  } catch {
    // offline, timeout, bad JSON: the next stale run tries again
  }
}
