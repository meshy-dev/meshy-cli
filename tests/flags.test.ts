/**
 * Unit tests for flag parsers (src/internal/flags.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBool,
  parseInt10,
  parseNumber,
  parseCsv,
  collect,
} from "../src/internal/flags.js";

test("parseBool — truthy variants", () => {
  for (const v of ["true", "TRUE", "1", "yes", "YES"]) {
    assert.equal(parseBool(v), true, `expected ${v} → true`);
  }
});

test("parseBool — falsy variants", () => {
  for (const v of ["false", "FALSE", "0", "no", "NO"]) {
    assert.equal(parseBool(v), false, `expected ${v} → false`);
  }
});

test("parseBool — rejects garbage", () => {
  assert.throws(() => parseBool("maybe"), /expected true\/false/);
  assert.throws(() => parseBool(""), /expected true\/false/);
});

test("parseInt10 — parses integers", () => {
  assert.equal(parseInt10("42"), 42);
  assert.equal(parseInt10("-5"), -5);
  assert.equal(parseInt10("0"), 0);
});

test("parseInt10 — rejects non-integers", () => {
  assert.throws(() => parseInt10("abc"), /expected integer/);
});

test("parseNumber — parses floats and integers", () => {
  assert.equal(parseNumber("3.14"), 3.14);
  assert.equal(parseNumber("0.5"), 0.5);
  assert.equal(parseNumber("42"), 42);
});

test("parseNumber — rejects garbage", () => {
  assert.throws(() => parseNumber("abc"), /expected number/);
});

test("parseCsv — splits and trims", () => {
  assert.deepEqual(parseCsv("glb,obj, fbx "), ["glb", "obj", "fbx"]);
});

test("parseCsv — drops empty entries", () => {
  assert.deepEqual(parseCsv("glb,,obj"), ["glb", "obj"]);
  assert.deepEqual(parseCsv(""), []);
});

test("collect — accumulates across repeated flags", () => {
  let acc: string[] = [];
  acc = collect("a", acc);
  acc = collect("b", acc);
  acc = collect("c", acc);
  assert.deepEqual(acc, ["a", "b", "c"]);
});
