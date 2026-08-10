/**
 * Update notifier — two-channel design.
 *
 * Channel 1 (agents / machines): JSON outputs carry `_notice.update` when a
 * newer version is available. Injected by attachUpdateNotice() in output.ts
 * and report.ts.
 *
 * Channel 2 (humans on TTY): a single stderr line printed by
 * printHumanUpdateHint() after emit() renders its output.
 *
 * Hard rule: this module MUST NEVER slow down, hang, or break the main
 * command. Network I/O runs in a detached child process (see refreshCache)
 * so a hung registry cannot delay process exit. All public functions are
 * synchronous and read only from the local cache file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "./version.js";
import type { OutputFormat } from "./output.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REGISTRY_URL = "https://registry.npmjs.org/meshy-cli/latest";
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_COMMAND = "npm i -g meshy-cli@latest";

/**
 * Hidden self-command used for the detached background refresh child.
 * CRITICAL: the child must check argv for this token and return immediately
 * to prevent an infinite spawn chain.
 */
export const REFRESH_COMMAND = "__refresh-update-cache";

/** Opt-out env var. Any non-empty value disables all update checks. */
const NO_UPDATE_VAR = "MESHY_CLI_NO_UPDATE_NOTIFIER";

/** CI environment variables — any non-empty value triggers skip. */
const CI_VARS = ["CI", "GITHUB_ACTIONS", "BUILD_NUMBER", "RUN_ID"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateNotice {
  current: string;
  latest: string;
  message: string;
  command: string;
}

interface UpdateState {
  latest_version?: string;
  checked_at?: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the path to the update-state cache file. */
export function stateFilePath(): string {
  return join(homedir(), ".config", "meshy", "update-state.json");
}

// ---------------------------------------------------------------------------
// shouldSkip
// ---------------------------------------------------------------------------

/**
 * Returns true when the update check should be skipped entirely.
 * Skips when:
 *   - MESHY_CLI_NO_UPDATE_NOTIFIER is a non-empty string
 *   - any CI env var (CI, GITHUB_ACTIONS, BUILD_NUMBER, RUN_ID) is non-empty
 *   - version contains "-dev"
 *   - version matches a git-describe suffix (e.g. 0.1.0-5-gdeadbee)
 */
export function shouldSkip(env: NodeJS.ProcessEnv = process.env, version: string = VERSION): boolean {
  if (env[NO_UPDATE_VAR]) return true;
  for (const v of CI_VARS) {
    if (env[v]) return true;
  }
  if (version.includes("-dev")) return true;
  if (/-\d+-g[0-9a-f]{7,}/.test(version)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

/**
 * Semver 2.0.0-compliant comparison. Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Rules:
 *   - strips leading "v"
 *   - strips "+build" metadata (build metadata is ignored per semver §10)
 *   - splits prerelease on first "-"
 *   - compares numeric major/minor/patch (missing segments → 0, non-numeric → 0)
 *   - equal numerics: release > prerelease (semver §11.3)
 *   - both prereleases: compare dot-separated identifiers left-to-right (semver §11.4):
 *       numeric identifiers compare numerically
 *       alphanumeric identifiers compare lexically (ASCII)
 *       numeric < alphanumeric
 *       if all shared identifiers equal, shorter set has LOWER precedence
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): { nums: number[]; pre: string[] | null } => {
    // strip leading v
    let s = v.startsWith("v") ? v.slice(1) : v;
    // strip build metadata (ignored per semver §10)
    const plusIdx = s.indexOf("+");
    if (plusIdx !== -1) s = s.slice(0, plusIdx);
    // split prerelease on first "-"
    const dashIdx = s.indexOf("-");
    let core: string;
    let pre: string[] | null;
    if (dashIdx !== -1) {
      core = s.slice(0, dashIdx);
      pre = s.slice(dashIdx + 1).split(".");
    } else {
      core = s;
      pre = null;
    }
    const parts = core.split(".");
    const nums = [0, 1, 2].map((i) => {
      const n = parseInt(parts[i] ?? "0", 10);
      return isNaN(n) ? 0 : n;
    });
    return { nums, pre };
  };

  const pa = parse(a);
  const pb = parse(b);

  // Compare major/minor/patch numerically
  for (let i = 0; i < 3; i++) {
    const na = pa.nums[i]!;
    const nb = pb.nums[i]!;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }

  // numeric parts equal — compare prerelease (semver §11.3 and §11.4)
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;  // release > prerelease
  if (pb.pre === null) return -1; // prerelease < release

  // Both have prerelease — compare dot-separated identifiers left-to-right
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    // Shorter set has lower precedence (semver §11.4.4)
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia) ? parseInt(ia, 10) : NaN;
    const nb = /^\d+$/.test(ib) ? parseInt(ib, 10) : NaN;
    if (!isNaN(na) && !isNaN(nb)) {
      // Both numeric — compare numerically
      if (na < nb) return -1;
      if (na > nb) return 1;
    } else if (!isNaN(na)) {
      // Numeric < alphanumeric (semver §11.4.1)
      return -1;
    } else if (!isNaN(nb)) {
      return 1;
    } else {
      // Both alphanumeric — compare lexically (ASCII)
      if (ia < ib) return -1;
      if (ia > ib) return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// buildNotice
// ---------------------------------------------------------------------------

/**
 * Returns an UpdateNotice if latest > current, otherwise null.
 */
export function buildNotice(latest: string, current: string = VERSION): UpdateNotice | null {
  if (compareVersions(latest, current) <= 0) return null;
  return {
    current,
    latest,
    message: `meshy-cli ${latest} available (current ${current}), run: ${UPDATE_COMMAND}`,
    command: UPDATE_COMMAND,
  };
}

// ---------------------------------------------------------------------------
// checkCached
// ---------------------------------------------------------------------------

/**
 * Pure read from the cache file — no network, no TTL check.
 *
 * Note: a newer-version fact does not expire. TTL gates only the network
 * refresh (isCacheStale). Once we know a newer version exists, we keep
 * surfacing the notice until the user upgrades.
 *
 * Returns null on missing/corrupt file, missing latest_version, or when
 * latest is not newer than current. Never throws.
 */
export function checkCached(stateFile: string = stateFilePath(), current: string = VERSION): UpdateNotice | null {
  try {
    const raw = readFileSync(stateFile, "utf8");
    const state = JSON.parse(raw) as UpdateState;
    if (typeof state.latest_version !== "string" || !state.latest_version) return null;
    return buildNotice(state.latest_version, current);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

/**
 * Returns true when the cache is missing, corrupt, has no checked_at, or
 * is older than CACHE_TTL_MS.
 */
export function isCacheStale(stateFile: string = stateFilePath(), now: number = Date.now()): boolean {
  try {
    const raw = readFileSync(stateFile, "utf8");
    const state = JSON.parse(raw) as UpdateState;
    if (typeof state.checked_at !== "number") return true;
    if (state.checked_at > now) return true; // clock-skewed or corrupt future timestamp
    return now - state.checked_at > CACHE_TTL_MS;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// getUpdateNotice
// ---------------------------------------------------------------------------

/**
 * Returns the cached update notice if applicable, or null.
 * This is what emit() and report paths call — synchronous, never throws.
 */
export function getUpdateNotice(): UpdateNotice | null {
  if (shouldSkip()) return null;
  return checkCached();
}

// ---------------------------------------------------------------------------
// attachUpdateNotice
// ---------------------------------------------------------------------------

/**
 * Merges the update notice into an existing `_notice` value.
 * If existing is a plain object, spreads it and adds `update`.
 * If existing is a non-object (string/number/array/null/undefined), replaces it.
 */
function mergeNotice(existing: unknown, notice: UpdateNotice): Record<string, unknown> {
  if (existing !== null && existing !== undefined && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...(existing as Record<string, unknown>), update: notice };
  }
  return { update: notice };
}

/**
 * Injects the update notice into a value before JSON serialization.
 *
 * Injection rules:
 *   - notice null → value unchanged
 *   - format "pretty" → unchanged (humans get the stderr line instead)
 *   - Array + format "ndjson": if non-empty and first element is a plain
 *     object, return new array with first element replaced by
 *     { ...first, _notice: { update: notice } }. Attaches ONCE on the first
 *     line only — never per-line.
 *   - Array + any other format (e.g. "json") → unchanged. A JSON array has
 *     no clean metadata slot without breaking the schema, so we leave it alone.
 *   - plain object → { ...value, _notice: { update: notice } }
 *   - anything else (string/number/null) → unchanged
 */
export function attachUpdateNotice(
  value: unknown,
  format: OutputFormat,
  notice: UpdateNotice | null,
): unknown {
  if (notice === null) return value;
  if (format === "pretty") return value;

  if (Array.isArray(value)) {
    if (format === "ndjson" && value.length > 0) {
      const first = value[0];
      if (first !== null && typeof first === "object" && !Array.isArray(first)) {
        const decorated = { ...(first as Record<string, unknown>), _notice: mergeNotice((first as Record<string, unknown>)["_notice"], notice) };
        return [decorated, ...value.slice(1)];
      }
    }
    return value;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return { ...obj, _notice: mergeNotice(obj["_notice"], notice) };
  }

  return value;
}

// ---------------------------------------------------------------------------
// printHumanUpdateHint
// ---------------------------------------------------------------------------

/**
 * Writes the update message to stderr ONLY when all three of
 * io.stdout/io.stderr/io.stdin have truthy isTTY (i.e. a fully interactive
 * terminal). NEVER writes to stdout — stdout must stay machine-parseable.
 *
 * Returns true if the hint was written, false otherwise.
 */
export function printHumanUpdateHint(
  notice: UpdateNotice | null,
  io: {
    stdout: { isTTY?: boolean };
    stderr: { isTTY?: boolean; write(s: string): unknown };
    stdin: { isTTY?: boolean };
  },
): boolean {
  if (!notice) return false;
  if (!io.stdout.isTTY || !io.stderr.isTTY || !io.stdin.isTTY) return false;
  io.stderr.write(`${notice.message}\n`);
  return true;
}

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

/**
 * Atomically writes the update state to disk.
 * Uses a tmp file + rename to avoid torn JSON from concurrent CLI runs.
 */
export function writeState(state: UpdateState, file: string = stateFilePath()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// fetchLatestVersion
// ---------------------------------------------------------------------------

/**
 * Fetches the latest version from the npm registry.
 * Throws on any failure — callers must swallow.
 */
export async function fetchLatestVersion(
  registryUrl: string = REGISTRY_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string> {
  const res = await fetch(registryUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`registry responded ${res.status}`);
  }

  // Read body with a hard 256KB cap
  let parsed: unknown;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("registry response too large");
        }
        chunks.push(value);
      }
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(combined);
    parsed = JSON.parse(text);
  } else {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error("registry response too large");
    }
    parsed = JSON.parse(text);
  }

  if (typeof (parsed as Record<string, unknown>).version !== "string" || !(parsed as Record<string, unknown>).version) {
    throw new Error("registry response missing version field");
  }

  return (parsed as Record<string, unknown>).version as string;
}

// ---------------------------------------------------------------------------
// runRefreshCommand
// ---------------------------------------------------------------------------

/**
 * Entry point for the hidden background child command.
 * Fetches the latest version and writes it to the cache.
 * Must never throw — the child always exits 0.
 */
export async function runRefreshCommand(): Promise<void> {
  if (shouldSkip()) return;
  try {
    // @internal: MESHY_CLI_UPDATE_REGISTRY_URL is a test hook — not documented
    const url = process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] ?? REGISTRY_URL;
    const latest = await fetchLatestVersion(url);
    writeState({ latest_version: latest, checked_at: Date.now() });
  } catch {
    // swallow: offline / 500 / timeout / corrupt must never surface
    // On failure write NOTHING — next stale invocation retries
  }
}

// ---------------------------------------------------------------------------
// refreshCache
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget spawner. Spawns a detached child process to refresh the
 * update cache in the background. NEVER throws, never awaits anything.
 *
 * Why a detached child instead of in-process fetch:
 *   An in-flight undici/fetch keeps the Node event loop alive, so an
 *   in-process fire-and-forget fetch would delay process exit by up to the
 *   15s timeout — violating "never slow down the main command". A detached
 *   child is fully independent and the parent can exit immediately.
 */
export function refreshCache(deps?: {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  scriptPath?: string;
  stateFile?: string;
  spawnImpl?: typeof spawn;
}): void {
  try {
    const env = deps?.env ?? process.env;
    const argv = deps?.argv ?? process.argv;
    const scriptPath = deps?.scriptPath ?? process.argv[1];
    const stateFile = deps?.stateFile ?? stateFilePath();
    const spawnImpl = deps?.spawnImpl ?? spawn;

    // 1. Skip if opted out or CI
    if (shouldSkip(env)) return;

    // 2. CRITICAL: prevent infinite spawn chain — if we ARE the child, return
    if (argv.includes(REFRESH_COMMAND)) return;

    // 3. Skip if cache is still fresh
    if (!isCacheStale(stateFile)) return;

    // 4. Need a script path to spawn
    if (!scriptPath) return;

    // 5. Spawn detached child
    const child = spawnImpl(process.execPath, [scriptPath, REFRESH_COMMAND], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Never propagate — this is fire-and-forget
  }
}
