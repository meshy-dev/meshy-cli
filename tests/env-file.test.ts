/**
 * --api-key-file parsing: only MESHY_API_KEY is read, nothing is evaluated, and a
 * broken explicit file is an error rather than a fall-through (T-100, T-101).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "../src/internal/env-file.js";
import { CliError } from "../src/internal/errors.js";

test("parseEnvFile — plain, quoted, export-prefixed and commented lines", () => {
  const text = [
    "# leading comment",
    "",
    "OTHER=ignored value",
    'export MESHY_API_KEY="msy_quoted_key"   # trailing comment',
    "NODE_OPTIONS=--require ./evil.js",
    "PATH=/tmp/evil:$PATH",
  ].join("\n");
  const out = parseEnvFile(text);
  assert.equal(out.apiKey, "msy_quoted_key");
  assert.deepEqual(out.otherKeys, ["OTHER", "NODE_OPTIONS", "PATH"]);
  // Nothing leaked into the process.
  assert.notEqual(process.env["NODE_OPTIONS"], "--require ./evil.js");
});

test("parseEnvFile — unquoted value stops at a comment, single quotes keep # and $", () => {
  assert.equal(parseEnvFile("MESHY_API_KEY=msy_a # c").apiKey, "msy_a");
  assert.equal(parseEnvFile("MESHY_API_KEY='msy_b#$'").apiKey, "msy_b#$");
  assert.equal(parseEnvFile("MESHY_API_KEY=\r\nOTHER=1\r\n").apiKey, "");
});

test("parseEnvFile — CRLF line endings and Windows-style files parse", () => {
  assert.equal(parseEnvFile("MESHY_API_KEY=msy_crlf\r\nX=1\r\n").apiKey, "msy_crlf");
});

test("parseEnvFile — duplicate MESHY_API_KEY is an error", () => {
  assert.throws(
    () => parseEnvFile("MESHY_API_KEY=a\nMESHY_API_KEY=b"),
    (err: unknown) => err instanceof CliError && err.code === "usage" && /more than once/.test(err.message),
  );
});

test("parseEnvFile — shell expansion syntax in the key is refused, not expanded", () => {
  for (const bad of ["MESHY_API_KEY=${HOME}", "MESHY_API_KEY=`whoami`", "MESHY_API_KEY=$(id)", "MESHY_API_KEY=$FOO"]) {
    assert.throws(() => parseEnvFile(bad), (err: unknown) => err instanceof CliError && err.code === "auth", bad);
  }
});

test("parseEnvFile — malformed lines are errors, not silently skipped", () => {
  assert.throws(() => parseEnvFile("this is not an assignment"), /not a KEY=value assignment/);
  assert.throws(() => parseEnvFile('MESHY_API_KEY="unterminated'), /unterminated/);
});

test("parseEnvFile — file without the key returns apiKey null", () => {
  const out = parseEnvFile("A=1\nB=2\n");
  assert.equal(out.apiKey, null);
  assert.deepEqual(out.otherKeys, ["A", "B"]);
});

test("loadEnvFile — missing file, directory and oversized file are usage errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-envfile-"));
  assert.throws(() => loadEnvFile(join(dir, "nope.env")), (e: unknown) => e instanceof CliError && e.code === "usage");
  const sub = join(dir, "adir");
  mkdirSync(sub);
  assert.throws(() => loadEnvFile(sub), /not a regular file/);
  const big = join(dir, "big.env");
  writeFileSync(big, `X=${"a".repeat(70 * 1024)}\n`);
  assert.throws(() => loadEnvFile(big), /larger than/);
});

test("loadEnvFile — relative paths resolve against the given cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-envfile-"));
  writeFileSync(join(dir, ".env"), "MESHY_API_KEY=msy_rel\n");
  const out = loadEnvFile(".env", dir);
  assert.equal(out.apiKey, "msy_rel");
  assert.equal(out.path, join(dir, ".env"));
});
