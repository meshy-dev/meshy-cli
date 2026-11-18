/**
 * refreshSkewMs: how far ahead of expiry a stored OAuth token is refreshed.
 * A token shorter-lived than the 30-minute window must not be refreshed by
 * every command, and a long-lived one keeps the window it always had.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { REFRESH_SKEW_MS, refreshSkewMs } from "../src/internal/runtime.js";

const minute = 60_000;
const now = 1_800_000_000_000;

test("a 15-minute token refreshes with 10 minutes left", () => {
  assert.equal(refreshSkewMs({ issued_at: now, expires_at: now + 15 * minute }), 10 * minute);
});

test("a 60-minute token keeps the 30-minute window", () => {
  assert.equal(REFRESH_SKEW_MS, 30 * minute);
  assert.equal(refreshSkewMs({ issued_at: now, expires_at: now + 60 * minute }), 30 * minute);
});

test("a 45-minute token keeps the 30-minute window (two thirds is exactly 30)", () => {
  assert.equal(refreshSkewMs({ issued_at: now, expires_at: now + 45 * minute }), 30 * minute);
});

test("a profile without issued_at, or with a nonsensical one, keeps the 30-minute window", () => {
  assert.equal(refreshSkewMs({ expires_at: now + 15 * minute }), 30 * minute);
  assert.equal(refreshSkewMs({ issued_at: now, expires_at: now }), 30 * minute);
  assert.equal(refreshSkewMs({ issued_at: now + minute, expires_at: now }), 30 * minute);
  assert.equal(refreshSkewMs(undefined), 30 * minute);
});
