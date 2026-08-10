/**
 * Tests for src/internal/device-state.ts — device flow state persistence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteDeviceFlow,
  deviceFlowsPath,
  generateFlowId,
  loadDeviceFlowByDeviceCode,
  loadDeviceFlowByFlowId,
  saveDeviceFlow,
  type DeviceFlowEntry,
} from "../src/internal/device-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "meshy-device-state-test-"));
}

function makeEntry(overrides: Partial<DeviceFlowEntry> = {}): DeviceFlowEntry {
  return {
    flow_id: generateFlowId(),
    device_code: `dev-code-${Math.random()}`,
    base_url_v1: "https://api.meshy.ai/openapi/v1",
    scope: "",
    interval: 5,
    expires_at: Date.now() + 600_000, // 10 minutes from now
    created_at: Date.now(),
    user_code: "XXXX-YYYY",
    verification_uri_complete: "https://www.meshy.ai/activate?user_code=XXXX-YYYY",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateFlowId
// ---------------------------------------------------------------------------

test("generateFlowId — returns a non-empty string", () => {
  const id = generateFlowId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
});

test("generateFlowId — two calls produce different values", () => {
  assert.notEqual(generateFlowId(), generateFlowId());
});

test("generateFlowId — returns base64url characters only", () => {
  const id = generateFlowId();
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});

// ---------------------------------------------------------------------------
// deviceFlowsPath
// ---------------------------------------------------------------------------

test("deviceFlowsPath — uses MESHY_CONFIG_DIR when set", () => {
  const dir = makeTmpDir();
  const path = deviceFlowsPath({ MESHY_CONFIG_DIR: dir });
  assert.ok(path.startsWith(dir));
  assert.ok(path.endsWith("device-flows.json"));
});

// ---------------------------------------------------------------------------
// saveDeviceFlow / loadDeviceFlowByFlowId
// ---------------------------------------------------------------------------

test("saveDeviceFlow + loadDeviceFlowByFlowId — round-trip", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  const entry = makeEntry();

  saveDeviceFlow(entry, file);
  const loaded = loadDeviceFlowByFlowId(entry.flow_id, file);

  assert.ok(loaded !== null);
  assert.equal(loaded!.flow_id, entry.flow_id);
  assert.equal(loaded!.device_code, entry.device_code);
  assert.equal(loaded!.base_url_v1, entry.base_url_v1);
  assert.equal(loaded!.user_code, entry.user_code);
});

test("loadDeviceFlowByFlowId — returns null for unknown id", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  assert.equal(loadDeviceFlowByFlowId("nonexistent-id", file), null);
});

test("loadDeviceFlowByFlowId — returns null for expired entry", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  const entry = makeEntry({ expires_at: Date.now() - 1000 }); // already expired

  saveDeviceFlow(entry, file);
  assert.equal(loadDeviceFlowByFlowId(entry.flow_id, file), null);
});

// ---------------------------------------------------------------------------
// loadDeviceFlowByDeviceCode
// ---------------------------------------------------------------------------

test("loadDeviceFlowByDeviceCode — finds entry by device_code", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  const entry = makeEntry({ device_code: "specific-device-code" });

  saveDeviceFlow(entry, file);
  const loaded = loadDeviceFlowByDeviceCode("specific-device-code", file);

  assert.ok(loaded !== null);
  assert.equal(loaded!.device_code, "specific-device-code");
});

test("loadDeviceFlowByDeviceCode — returns null for unknown device_code", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  assert.equal(loadDeviceFlowByDeviceCode("unknown-code", file), null);
});

test("loadDeviceFlowByDeviceCode — returns null for expired entry", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  const entry = makeEntry({
    device_code: "expired-code",
    expires_at: Date.now() - 1000,
  });

  saveDeviceFlow(entry, file);
  assert.equal(loadDeviceFlowByDeviceCode("expired-code", file), null);
});

// ---------------------------------------------------------------------------
// deleteDeviceFlow
// ---------------------------------------------------------------------------

test("deleteDeviceFlow — removes the entry", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  const entry = makeEntry();

  saveDeviceFlow(entry, file);
  assert.ok(loadDeviceFlowByFlowId(entry.flow_id, file) !== null);

  deleteDeviceFlow(entry.flow_id, file);
  assert.equal(loadDeviceFlowByFlowId(entry.flow_id, file), null);
});

test("deleteDeviceFlow — no-op for unknown id", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  // Should not throw.
  assert.doesNotThrow(() => deleteDeviceFlow("nonexistent-id", file));
});

// ---------------------------------------------------------------------------
// GC — expired entries are removed on write
// ---------------------------------------------------------------------------

test("GC — expired entries are removed on next write", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");

  const expired = makeEntry({ expires_at: Date.now() - 1000 });
  const valid = makeEntry();

  // Save expired entry first.
  saveDeviceFlow(expired, file);
  // Save valid entry — this triggers GC.
  saveDeviceFlow(valid, file);

  // Expired entry should be gone.
  assert.equal(loadDeviceFlowByFlowId(expired.flow_id, file), null);
  // Valid entry should still be there.
  assert.ok(loadDeviceFlowByFlowId(valid.flow_id, file) !== null);
});

// ---------------------------------------------------------------------------
// Multiple entries
// ---------------------------------------------------------------------------

test("multiple entries can coexist", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");

  const entries = Array.from({ length: 5 }, () => makeEntry());
  for (const entry of entries) {
    saveDeviceFlow(entry, file);
  }

  for (const entry of entries) {
    const loaded = loadDeviceFlowByFlowId(entry.flow_id, file);
    assert.ok(loaded !== null, `entry ${entry.flow_id} should be found`);
    assert.equal(loaded!.device_code, entry.device_code);
  }
});

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

test("device-flows.json is created with 0600 permissions", () => {
  const dir = makeTmpDir();
  const file = join(dir, "device-flows.json");
  const entry = makeEntry();

  saveDeviceFlow(entry, file);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});
