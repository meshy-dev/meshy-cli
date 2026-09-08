/**
 * v1 envelope construction and the error classification behind it (T-002, T-011).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CommanderError } from "commander";
import { MeshyApiError } from "../src/client/errors.js";
import {
  CliError,
  classifyError,
  exitCodeFor,
  EXIT_CODES,
  HintedError,
  UsageError,
  authRequiredError,
} from "../src/internal/errors.js";
import { errorEnvelope, okEnvelope, SCHEMA_VERSION } from "../src/internal/result.js";

const SIX = ["schema_version", "command", "ok", "result", "error", "warnings"];

test("okEnvelope — exactly the six fixed keys", () => {
  const env = okEnvelope("balance", { balance: 1 });
  assert.deepEqual(Object.keys(env), SIX);
  assert.equal(env.schema_version, SCHEMA_VERSION);
  assert.equal(env.ok, true);
  assert.equal(env.error, null);
  assert.deepEqual(env.warnings, []);
});

test("errorEnvelope — CliError carries code, exit, http status, recovery and partial result", () => {
  const err = new CliError({
    code: "submission_unknown",
    message: "request sent, outcome unknown",
    recovery: { action: "reconcile", automatic: false },
    result: { submission: { state: "unknown", operation_id: "op-1" }, task: null },
  });
  const { envelope, exitCode } = errorEnvelope("text-to-3d.create", err);
  assert.deepEqual(Object.keys(envelope), SIX);
  assert.equal(exitCode, EXIT_CODES.SUBMISSION_UNKNOWN);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "submission_unknown");
  assert.equal(envelope.error?.http_status, null);
  assert.equal(envelope.error?.retryable, false);
  assert.deepEqual(envelope.error?.recovery, { action: "reconcile", automatic: false });
  assert.deepEqual(envelope.result, { submission: { state: "unknown", operation_id: "op-1" }, task: null });
});

test("classifyError — API errors map status to code/exit without leaking the credential", async () => {
  const cases: Array<[number, string, number]> = [
    [400, "validation", 4],
    [401, "auth", 3],
    [402, "credit", 9],
    [404, "not_found", 5],
    [429, "rate_limit", 6],
    [500, "server", 1],
  ];
  for (const [status, code, exit] of cases) {
    const err = new MeshyApiError({ message: `meshy api ${status} on /x: nope`, status, code: code === "server" ? "server" : (code as never), path: "/x" });
    const c = classifyError(err);
    assert.equal(c.code, code, String(status));
    assert.equal(c.exitCode, exit, String(status));
    assert.equal(c.httpStatus, status);
    assert.ok(!JSON.stringify(c).includes("Bearer"));
  }
  const net = classifyError(new MeshyApiError({ message: "network error", status: 0, code: "network", path: "/x" }));
  assert.equal(net.code, "network");
  assert.equal(net.exitCode, 7);
  assert.equal(net.httpStatus, null);
});

test("classifyError — usage, commander, hinted and unknown errors", () => {
  assert.equal(classifyError(new UsageError("bad")).exitCode, 2);
  const cmdErr = new CommanderError(1, "commander.unknownOption", "error: unknown option '--bogus'");
  const c = classifyError(cmdErr);
  assert.equal(c.code, "usage");
  assert.equal(c.exitCode, 2);
  assert.equal(c.message, "unknown option '--bogus'");
  assert.equal(classifyError(authRequiredError()).code, "auth");
  assert.equal(classifyError(authRequiredError()).exitCode, 3);
  const timeout = new HintedError({ message: "t", code: "step_timeout", exitCode: 8 });
  assert.equal(classifyError(timeout).code, "timed_out");
  assert.equal(classifyError(timeout).exitCode, 8);
  assert.equal(classifyError(new Error("boom")).code, "internal");
  assert.equal(classifyError("str").exitCode, 1);
});

test("exitCodeFor — legacy mapping keeps 0.2.0 codes and adds the new ones", () => {
  assert.equal(exitCodeFor(new CommanderError(1, "commander.unknownOption", "x")), 2);
  assert.equal(exitCodeFor(new CommanderError(0, "commander.helpDisplayed", "")), 0);
  assert.equal(exitCodeFor(new CliError({ code: "local_io", message: "x" })), 11);
  assert.equal(exitCodeFor(new CliError({ code: "check_failed", message: "x" })), 12);
  assert.equal(exitCodeFor(new CliError({ code: "check_unknown", message: "x" })), 13);
  assert.equal(exitCodeFor(new CliError({ code: "interrupted", message: "x" })), 130);
  assert.equal(exitCodeFor(new UsageError("x")), 2);
});
