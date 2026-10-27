/**
 * Update notifier: the version comparison, the cache-only message, the
 * terminal-only stderr line, the once-a-day detached refresh and the child
 * that writes the cache. The envelope is never decorated.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEnvelope } from "../src/internal/output.js";
import { okEnvelope } from "../src/internal/result.js";
import {
  CACHE_TTL_MS,
  isNewer,
  printHumanUpdateHint,
  REFRESH_COMMAND,
  refreshCache,
  runRefreshCommand,
  shouldRunUpdateCheck,
  shouldSkip,
  updateMessage,
} from "../src/internal/update-notifier.js";
import { PACKAGE_NAME } from "../src/internal/version.js";
import { LOCAL_COMMANDS } from "../src/root.js";
import { DIST_ENTRY } from "./helpers/cli.js";

const stateFile = (state?: unknown): string => {
  const file = join(mkdtempSync(join(tmpdir(), "meshy-update-")), "update-state.json");
  if (state !== undefined) writeFileSync(file, typeof state === "string" ? state : JSON.stringify(state));
  return file;
};

test("isNewer compares x.y.z releases numerically; prereleases and garbage are never newer", () => {
  assert.equal(isNewer("0.6.1", "0.6.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("v0.7.0", "0.6.0"), true);
  assert.equal(isNewer("0.6.0", "0.6.0"), false);
  assert.equal(isNewer("0.5.9", "0.6.0"), false);
  assert.equal(isNewer("0.7.0-beta.1", "0.6.0"), false);
  assert.equal(isNewer("latest", "0.6.0"), false);
});

test("shouldSkip: the opt-out variable or any CI variable", () => {
  assert.equal(shouldSkip({}), false);
  assert.equal(shouldSkip({ MESHY_CLI_NO_UPDATE_NOTIFIER: "1" }), true);
  for (const v of ["CI", "GITHUB_ACTIONS", "BUILD_NUMBER", "RUN_ID"]) assert.equal(shouldSkip({ [v]: "1" }), true, v);
  assert.equal(shouldSkip({ CI: "" }), false, "an empty value is unset");
});

test("updateMessage reads the cache only: a newer release names the install command; anything else is null", () => {
  assert.equal(
    updateMessage({}, stateFile({ latest_version: "9.9.9", checked_at: 0 }), "0.6.0"),
    `${PACKAGE_NAME} 9.9.9 available (current 0.6.0), run: npm i -g ${PACKAGE_NAME}@latest`,
  );
  assert.equal(updateMessage({}, stateFile({ latest_version: "0.6.0" }), "0.6.0"), null);
  assert.equal(updateMessage({}, stateFile(), "0.6.0"), null, "no cache");
  assert.equal(updateMessage({}, stateFile("{not json"), "0.6.0"), null, "corrupt cache");
  assert.equal(updateMessage({ CI: "1" }, stateFile({ latest_version: "9.9.9" }), "0.6.0"), null, "CI");
});

test("printHumanUpdateHint writes one stderr line only when stdin, stdout and stderr are all terminals", () => {
  const io = (tty: [boolean, boolean, boolean]) => {
    const written: string[] = [];
    return { io: { stdout: { isTTY: tty[0] }, stderr: { isTTY: tty[1], write: (s: string) => written.push(s) }, stdin: { isTTY: tty[2] } }, written };
  };
  const all = io([true, true, true]);
  assert.equal(printHumanUpdateHint("newer", all.io), true);
  assert.equal(all.written.length, 1);
  assert.match(all.written[0]!, /newer/);
  for (const tty of [[false, true, true], [true, false, true], [true, true, false]] as Array<[boolean, boolean, boolean]>) {
    const some = io(tty);
    assert.equal(printHumanUpdateHint("newer", some.io), false, JSON.stringify(tty));
    assert.deepEqual(some.written, []);
  }
  assert.equal(printHumanUpdateHint(null, all.io), false);
});

test("refreshCache spawns one detached, unref'd child when the cache is missing, old or dated in the future — and never throws", () => {
  const now = 1_800_000_000_000;
  const spawned: Array<{ args: string[]; detached: boolean; unref: boolean }> = [];
  const fake = ((_cmd: string, args: string[], opts: { detached: boolean }) => {
    const entry = { args, detached: opts.detached, unref: false };
    spawned.push(entry);
    return { on: () => undefined, unref: () => { entry.unref = true; } };
  }) as unknown as typeof spawn;
  refreshCache(stateFile({ checked_at: now - 60_000 }), now, fake);
  assert.equal(spawned.length, 0, "fresh cache");
  for (const file of [stateFile(), stateFile({ checked_at: now - CACHE_TTL_MS - 1 }), stateFile({ checked_at: now + 3_600_000 })]) refreshCache(file, now, fake);
  assert.equal(spawned.length, 3);
  for (const s of spawned) {
    assert.equal(s.args.at(-1), REFRESH_COMMAND);
    assert.ok(s.detached && s.unref);
  }
  assert.doesNotThrow(() => refreshCache(stateFile(), now, (() => { throw new Error("spawn failed"); }) as unknown as typeof spawn));
});

test("runRefreshCommand caches the registry's version; a failing or malformed registry leaves the cache untouched", async () => {
  let reply = { status: 200, body: JSON.stringify({ version: "9.9.9" }) };
  const server = createServer((_req, res) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;
  try {
    const file = stateFile();
    await runRefreshCommand(url, file);
    const state = JSON.parse(readFileSync(file, "utf8")) as { latest_version: string; checked_at: number };
    assert.equal(state.latest_version, "9.9.9");
    assert.equal(typeof state.checked_at, "number");
    for (const bad of [{ status: 500, body: "{}" }, { status: 200, body: "not json" }, { status: 200, body: "{}" }]) {
      reply = bad;
      const untouched = stateFile();
      await runRefreshCommand(url, untouched);
      assert.equal(existsSync(untouched), false, JSON.stringify(bad));
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("shouldRunUpdateCheck: only API commands start a check — never local ones, help, --version, --no-update-check or CI", () => {
  const argv = (...rest: string[]) => ["node", "meshy", ...rest];
  assert.equal(shouldRunUpdateCheck(argv("balance"), LOCAL_COMMANDS, {}), true);
  assert.equal(shouldRunUpdateCheck(argv("image-to-3d", "get", "t"), LOCAL_COMMANDS, {}), true);
  for (const local of [argv(), argv("doctor"), argv("download", "--url", "x"), argv(REFRESH_COMMAND), argv("balance", "--help"), argv("--version"), argv("make", "x", "--dry-run"), argv("balance", "--no-update-check")]) {
    assert.equal(shouldRunUpdateCheck(local, LOCAL_COMMANDS, {}), false, local.slice(2).join(" "));
  }
  assert.equal(shouldRunUpdateCheck(argv("balance"), LOCAL_COMMANDS, { CI: "true" }), false);
});

test("the refresh child exits 0 with an unreachable registry and writes nothing", { timeout: 35_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), "meshy-update-home-"));
  const result = spawnSync(process.execPath, [DIST_ENTRY, REFRESH_COMMAND], {
    env: { PATH: process.env["PATH"], HOME: home, MESHY_CONFIG_DIR: join(home, "cfg"), MESHY_CLI_UPDATE_REGISTRY_URL: "http://127.0.0.1:1/unreachable" },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(existsSync(join(home, "cfg", "update-state.json")), false);
});

test("a newer version in the cache never adds a key to the envelope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-update-env-"));
  const saved = process.env["MESHY_CONFIG_DIR"];
  process.env["MESHY_CONFIG_DIR"] = dir;
  writeFileSync(join(dir, "update-state.json"), JSON.stringify({ latest_version: "9.9.9", checked_at: Date.now() }));
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    (rest.find((r) => typeof r === "function") as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    await emitEnvelope(okEnvelope("balance", { balance: 1 }), "json");
  } finally {
    process.stdout.write = original;
    if (saved === undefined) delete process.env["MESHY_CONFIG_DIR"];
    else process.env["MESHY_CONFIG_DIR"] = saved;
  }
  assert.deepEqual(Object.keys(JSON.parse(chunks.join("")) as object), ["schema_version", "command", "ok", "result", "error", "warnings"]);
});
