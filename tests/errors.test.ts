/**
 * Unit tests for HTTP → MeshyApiError mapping.
 */

// Disable update notifier so error tests are hermetic regardless of the dev
// machine's cache state.
process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { MeshyApiError, mapHttpError } from "../src/client/errors.js";
import { exitCodeFor, EXIT_CODES, HintedError, SESSION_REVOKED_HINT, toErrorPayload, UsageError } from "../src/internal/errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("mapHttpError — 401 → auth", async () => {
  const err = await mapHttpError(jsonResponse(401, { message: "Unauthorized" }), "/balance");
  assert.equal(err.status, 401);
  assert.equal(err.code, "auth");
  assert.match(err.message, /Unauthorized/);
});

test("mapHttpError — 400 and 422 → validation", async () => {
  const a = await mapHttpError(jsonResponse(400, { message: "bad request" }), "/x");
  const b = await mapHttpError(jsonResponse(422, { message: "bad shape" }), "/x");
  assert.equal(a.code, "validation");
  assert.equal(b.code, "validation");
});

test("mapHttpError — 402 → credit", async () => {
  const err = await mapHttpError(jsonResponse(402, { message: "no credits" }), "/x");
  assert.equal(err.code, "credit");
});

test("mapHttpError — 404 → not_found", async () => {
  const err = await mapHttpError(jsonResponse(404, { message: "missing" }), "/x");
  assert.equal(err.code, "not_found");
});

test("mapHttpError — 429 → rate_limit", async () => {
  const err = await mapHttpError(jsonResponse(429, { message: "slow down" }), "/x");
  assert.equal(err.code, "rate_limit");
});

test("mapHttpError — 5xx → server", async () => {
  const err = await mapHttpError(jsonResponse(500, { message: "boom" }), "/x");
  assert.equal(err.code, "server");
});

test("mapHttpError — non-JSON body falls back to text snippet", async () => {
  const resp = new Response("<html>broken</html>", { status: 500 });
  const err = await mapHttpError(resp, "/x");
  assert.match(err.message, /broken/);
});

test("MeshyApiError — toJSON has expected shape", () => {
  const err = new MeshyApiError({
    message: "boom",
    status: 500,
    code: "server",
    path: "/x",
  });
  assert.deepEqual(err.toJSON(), {
    name: "MeshyApiError",
    message: "boom",
    status: 500,
    code: "server",
    path: "/x",
  });
});

test("exitCodeFor — maps MeshyApiError codes to stable exit codes", () => {
  const cases: Array<[string, number]> = [
    ["auth", EXIT_CODES.AUTH],
    ["validation", EXIT_CODES.VALIDATION],
    ["not_found", EXIT_CODES.NOT_FOUND],
    ["rate_limit", EXIT_CODES.RATE_LIMIT],
    ["credit", EXIT_CODES.CREDIT],
    ["network", EXIT_CODES.NETWORK],
    ["server", EXIT_CODES.GENERIC],
  ];
  for (const [code, expected] of cases) {
    const err = new MeshyApiError({ message: "x", status: 0, code: code as never });
    assert.equal(exitCodeFor(err), expected, `code=${code}`);
  }
});

test("exitCodeFor — UsageError → USAGE", () => {
  assert.equal(exitCodeFor(new UsageError("bad flag")), EXIT_CODES.USAGE);
});

test("exitCodeFor — oauth_timeout HintedError → TIMED_OUT(8)", () => {
  // Covers device expired_token, loopback waitForCallback timeout, and manual
  // prompt timeout — all use code "oauth_timeout".
  const err = new HintedError({ message: "timed out", code: "oauth_timeout" });
  assert.equal(exitCodeFor(err), EXIT_CODES.TIMED_OUT);
  assert.equal(EXIT_CODES.TIMED_OUT, 8);
});

test("exitCodeFor — unauthenticated HintedError → AUTH(3)", () => {
  const err = new HintedError({ message: "no creds", code: "unauthenticated" });
  assert.equal(exitCodeFor(err), EXIT_CODES.AUTH);
});

test("exitCodeFor — other HintedError codes → GENERIC(1)", () => {
  for (const code of ["oauth_no_code", "oauth_denied", "oauth_bad_response", "device_flow_not_supported"]) {
    const err = new HintedError({ message: "x", code });
    assert.equal(exitCodeFor(err), EXIT_CODES.GENERIC, `code=${code} should be GENERIC`);
  }
});

test("exitCodeFor — unknown → GENERIC", () => {
  assert.equal(exitCodeFor(new Error("x")), EXIT_CODES.GENERIC);
  assert.equal(exitCodeFor("string error"), EXIT_CODES.GENERIC);
});

test("toErrorPayload — 401/auth with credentialKind=oauth → SESSION_REVOKED_HINT", async () => {
  const err = await mapHttpError(
    new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
    "/balance",
    "oauth",
  );
  assert.equal(err.code, "auth");
  assert.equal(err.credentialKind, "oauth");
  const payload = toErrorPayload(err);
  assert.equal(payload["hint"], SESSION_REVOKED_HINT);
  assert.equal(payload["hint"], "Session revoked or expired. Run: meshy auth login");
});

test("toErrorPayload — 401/auth with credentialKind=api_key → old Credential rejected hint", async () => {
  const err = await mapHttpError(
    new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
    "/balance",
    "api_key",
  );
  assert.equal(err.code, "auth");
  assert.equal(err.credentialKind, "api_key");
  const payload = toErrorPayload(err);
  assert.match(String(payload["hint"]), /Credential rejected or revoked/);
  assert.match(String(payload["hint"]), /meshy auth login/);
  assert.notEqual(payload["hint"], SESSION_REVOKED_HINT);
});

test("toErrorPayload — 401/auth with no credentialKind → SESSION_REVOKED_HINT (unknown defaults to oauth path)", async () => {
  const err = await mapHttpError(
    new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
    "/balance",
    // no credentialKind
  );
  assert.equal(err.code, "auth");
  assert.equal(err.credentialKind, undefined);
  const payload = toErrorPayload(err);
  assert.equal(payload["hint"], SESSION_REVOKED_HINT);
});

test("MeshyApiError — toJSON includes credentialKind when set", () => {
  const err = new MeshyApiError({
    message: "boom",
    status: 401,
    code: "auth",
    path: "/balance",
    credentialKind: "oauth",
  });
  const json = err.toJSON();
  assert.equal(json["credentialKind"], "oauth");
});

test("MeshyApiError — toJSON omits credentialKind when not set", () => {
  const err = new MeshyApiError({
    message: "boom",
    status: 401,
    code: "auth",
    path: "/balance",
  });
  const json = err.toJSON();
  assert.ok(!Object.prototype.hasOwnProperty.call(json, "credentialKind"));
});
