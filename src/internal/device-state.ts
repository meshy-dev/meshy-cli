/**
 * Device flow state persistence — stores in-flight device flows so they can
 * be resumed across process invocations (--no-wait → --device-flow <id>).
 *
 * Layout: ~/.config/meshy/device-flows.json, chmod 600.
 * Uses the SAME O_EXCL lock + temp-rename pattern as credentials.ts.
 *
 * Each entry is keyed by a random flow_id (b64url 12 bytes = 16 chars).
 * Expired entries are GC'd on every write.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { configDir } from "./credentials.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceFlowEntry {
  /** Random b64url 12-byte ID for this flow. */
  flow_id: string;
  device_code: string;
  base_url_v1: string;
  scope: string;
  /** Polling interval in seconds. */
  interval: number;
  /** Unix ms when the device code expires. */
  expires_at: number;
  /** Unix ms when this entry was created. */
  created_at: number;
  user_code: string;
  verification_uri_complete: string;
}

interface DeviceFlowsFile {
  flows: Record<string, DeviceFlowEntry>;
}

// ---------------------------------------------------------------------------
// Paths and locking
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;

export function deviceFlowsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "device-flows.json");
}

function lockPathFor(file: string): string {
  const parts = file.split(/[/\\]/);
  const base = parts[parts.length - 1] || "device-flows.json";
  return join(dirname(file), "locks", `${base}.lock`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withDeviceFlowsLock<T>(file: string, fn: () => T): T {
  const lock = lockPathFor(file);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${LOCK_TIMEOUT_MS}ms waiting for the device-flows lock at ${lock}. ` +
            `If no other meshy process is running, delete that file.`,
        );
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function readDeviceFlows(file: string): DeviceFlowsFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { flows: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as DeviceFlowsFile;
    if (!parsed || typeof parsed !== "object" || !parsed.flows) return { flows: {} };
    return parsed;
  } catch {
    return { flows: {} };
  }
}

function writeDeviceFlows(state: DeviceFlowsFile, file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  chmodSync(file, 0o600);
}

/** GC expired entries. Mutates the state in place. */
function gcExpired(state: DeviceFlowsFile): void {
  const now = Date.now();
  for (const [id, entry] of Object.entries(state.flows)) {
    if (entry.expires_at <= now) {
      delete state.flows[id];
    }
  }
}

function updateDeviceFlows<T>(
  file: string,
  mutate: (state: DeviceFlowsFile) => T,
): T {
  return withDeviceFlowsLock(file, () => {
    const current = readDeviceFlows(file);
    gcExpired(current);
    const result = mutate(current);
    writeDeviceFlows(current, file);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate a new random flow_id (b64url 12 bytes = 16 chars). */
export function generateFlowId(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * Save a device flow entry. GCs expired entries on write.
 */
export function saveDeviceFlow(
  entry: DeviceFlowEntry,
  file: string = deviceFlowsPath(),
): void {
  updateDeviceFlows(file, (state) => {
    state.flows[entry.flow_id] = entry;
  });
}

/**
 * Load a device flow by flow_id. Returns null if not found or expired.
 */
export function loadDeviceFlowByFlowId(
  flowId: string,
  file: string = deviceFlowsPath(),
): DeviceFlowEntry | null {
  const state = readDeviceFlows(file);
  const entry = state.flows[flowId];
  if (!entry) return null;
  if (entry.expires_at <= Date.now()) return null;
  return entry;
}

/**
 * Load a device flow by device_code (scans all values). Returns null if not found or expired.
 */
export function loadDeviceFlowByDeviceCode(
  deviceCode: string,
  file: string = deviceFlowsPath(),
): DeviceFlowEntry | null {
  const state = readDeviceFlows(file);
  const now = Date.now();
  for (const entry of Object.values(state.flows)) {
    if (entry.device_code === deviceCode && entry.expires_at > now) {
      return entry;
    }
  }
  return null;
}

/**
 * Delete a device flow by flow_id. No-op if not found.
 */
export function deleteDeviceFlow(
  flowId: string,
  file: string = deviceFlowsPath(),
): void {
  updateDeviceFlows(file, (state) => {
    delete state.flows[flowId];
  });
}
