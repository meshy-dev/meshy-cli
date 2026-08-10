/**
 * Tests for the update notifier module.
 *
 * Covers: compareVersions, shouldSkip, buildNotice, checkCached,
 * isCacheStale, writeState, fetchLatestVersion, runRefreshCommand,
 * attachUpdateNotice, printHumanUpdateHint, refreshCache, emit-level
 * injection, and formatReport with _notice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  shouldSkip,
  buildNotice,
  checkCached,
  isCacheStale,
  writeState,
  fetchLatestVersion,
  runRefreshCommand,
  attachUpdateNotice,
  printHumanUpdateHint,
  refreshCache,
  CACHE_TTL_MS,
  REFRESH_COMMAND,
  UPDATE_COMMAND,
} from "../src/internal/update-notifier.js";
import { emit } from "../src/internal/output.js";
import { formatReport } from "../src/internal/report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "meshy-update-test-"));
}

function saveEnv(keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const NOTIFIER_ENV_KEYS = [
  "MESHY_CLI_NO_UPDATE_NOTIFIER",
  "CI",
  "GITHUB_ACTIONS",
  "BUILD_NUMBER",
  "RUN_ID",
];

function clearNotifierEnv(): void {
  for (const k of NOTIFIER_ENV_KEYS) delete process.env[k];
}

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Headers;
}

function installFetch(
  handler: (req: Call) => Response | Promise<Response>,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  globalThis.fetch = (async (input: FetchInput, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : undefined;
    const headers = new Headers(init.headers ?? {});
    const call: Call = { url, method, headers };
    if (body !== undefined) call.body = body;
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
    return chunks.join("");
  } finally {
    process.stdout.write = original;
  }
}

// ---------------------------------------------------------------------------
// 1. compareVersions matrix
// ---------------------------------------------------------------------------

test("compareVersions — 0.1.0 vs 0.2.0 → -1", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
});

test("compareVersions — 1.0.0 vs 0.9.9 → 1", () => {
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("compareVersions — equal → 0", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("compareVersions — 0.2.0 vs 0.2.0-beta → 1 (release > prerelease)", () => {
  assert.equal(compareVersions("0.2.0", "0.2.0-beta"), 1);
});

test("compareVersions — v0.2.0 vs 0.2.0 → 0 (leading v stripped)", () => {
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
});

test("compareVersions — 0.2 vs 0.2.0 → 0 (missing patch padded)", () => {
  assert.equal(compareVersions("0.2", "0.2.0"), 0);
});

test("compareVersions — 1.0.0-beta.10 > 1.0.0-beta.2 (numeric prerelease identifier)", () => {
  assert.equal(compareVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
});

test("compareVersions — 1.0.0-alpha.1 < 1.0.0-beta.1 (lexical alphanumeric identifier)", () => {
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-beta.1"), -1);
});

test("compareVersions — 1.0.0-alpha < 1.0.0-alpha.1 (shorter set has lower precedence)", () => {
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
});

test("compareVersions — 1.0.0+build.5 == 1.0.0 (build metadata ignored)", () => {
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
});

// ---------------------------------------------------------------------------
// 2. shouldSkip
// ---------------------------------------------------------------------------

test("shouldSkip — opt-out var set → true", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";
    assert.equal(shouldSkip(process.env, "0.1.0"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — CI=true → true", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["CI"] = "true";
    assert.equal(shouldSkip(process.env, "0.1.0"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — GITHUB_ACTIONS=true → true", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["GITHUB_ACTIONS"] = "true";
    assert.equal(shouldSkip(process.env, "0.1.0"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — BUILD_NUMBER=42 → true", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["BUILD_NUMBER"] = "42";
    assert.equal(shouldSkip(process.env, "0.1.0"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — RUN_ID=123 → true", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["RUN_ID"] = "123";
    assert.equal(shouldSkip(process.env, "0.1.0"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — empty-string values → false", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "";
    process.env["CI"] = "";
    process.env["GITHUB_ACTIONS"] = "";
    process.env["BUILD_NUMBER"] = "";
    process.env["RUN_ID"] = "";
    assert.equal(shouldSkip(process.env, "0.1.0"), false);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — version 0.2.0-dev → true", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    assert.equal(shouldSkip(process.env, "0.2.0-dev"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — version 0.1.0-5-gdeadbee → true (git-describe suffix)", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    assert.equal(shouldSkip(process.env, "0.1.0-5-gdeadbee"), true);
  } finally {
    restoreEnv(saved);
  }
});

test("shouldSkip — clean env + 0.1.0 → false", () => {
  const saved = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    assert.equal(shouldSkip(process.env, "0.1.0"), false);
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// 3. buildNotice
// ---------------------------------------------------------------------------

test("buildNotice — 0.2.0 > 0.1.0 → notice with exact message", () => {
  const notice = buildNotice("0.2.0", "0.1.0");
  assert.ok(notice !== null);
  assert.equal(notice.latest, "0.2.0");
  assert.equal(notice.current, "0.1.0");
  assert.equal(
    notice.message,
    `meshy-cli 0.2.0 available (current 0.1.0), run: ${UPDATE_COMMAND}`,
  );
  assert.equal(notice.command, UPDATE_COMMAND);
});

test("buildNotice — 0.1.0 < 0.2.0 → null", () => {
  assert.equal(buildNotice("0.1.0", "0.2.0"), null);
});

test("buildNotice — equal → null", () => {
  assert.equal(buildNotice("0.1.0", "0.1.0"), null);
});

// ---------------------------------------------------------------------------
// 4. checkCached
// ---------------------------------------------------------------------------

test("checkCached — file with newer version → notice", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  writeFileSync(file, JSON.stringify({ latest_version: "9.9.9", checked_at: Date.now() }));
  const notice = checkCached(file, "0.1.0");
  assert.ok(notice !== null);
  assert.equal(notice.latest, "9.9.9");
});

test("checkCached — older/equal latest → null", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  writeFileSync(file, JSON.stringify({ latest_version: "0.0.1", checked_at: Date.now() }));
  assert.equal(checkCached(file, "0.1.0"), null);
});

test("checkCached — missing file → null", () => {
  const dir = makeTmpDir();
  const file = join(dir, "nonexistent.json");
  assert.equal(checkCached(file, "0.1.0"), null);
});

test("checkCached — corrupt JSON → null", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  writeFileSync(file, "not json {{{");
  assert.equal(checkCached(file, "0.1.0"), null);
});

test("checkCached — missing latest_version → null", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  writeFileSync(file, JSON.stringify({ checked_at: Date.now() }));
  assert.equal(checkCached(file, "0.1.0"), null);
});

// ---------------------------------------------------------------------------
// 5. isCacheStale
// ---------------------------------------------------------------------------

test("isCacheStale — missing file → true", () => {
  const dir = makeTmpDir();
  const file = join(dir, "nonexistent.json");
  assert.equal(isCacheStale(file), true);
});

test("isCacheStale — corrupt JSON → true", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  writeFileSync(file, "not json");
  assert.equal(isCacheStale(file), true);
});

test("isCacheStale — fresh cache → false", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  writeFileSync(file, JSON.stringify({ latest_version: "0.2.0", checked_at: Date.now() }));
  assert.equal(isCacheStale(file), false);
});

test("isCacheStale — 25h old → true", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  const old = Date.now() - CACHE_TTL_MS - 60_000; // 25h ago
  writeFileSync(file, JSON.stringify({ latest_version: "0.2.0", checked_at: old }));
  assert.equal(isCacheStale(file), true);
});

test("isCacheStale — checked_at 1h in the future → stale (clock-skewed)", () => {
  const dir = makeTmpDir();
  const file = join(dir, "update-state.json");
  const future = Date.now() + 60 * 60 * 1000; // 1h in the future
  writeFileSync(file, JSON.stringify({ latest_version: "0.2.0", checked_at: future }));
  assert.equal(isCacheStale(file), true);
});

// ---------------------------------------------------------------------------
// 6. writeState → checkCached round-trip
// ---------------------------------------------------------------------------

test("writeState → checkCached round-trip in tmp dir", () => {
  const dir = makeTmpDir();
  const file = join(dir, "state.json");
  writeState({ latest_version: "1.2.3", checked_at: Date.now() }, file);
  const notice = checkCached(file, "0.1.0");
  assert.ok(notice !== null);
  assert.equal(notice.latest, "1.2.3");
});

test("writeState — file parses as JSON with checked_at number", () => {
  const dir = makeTmpDir();
  const file = join(dir, "state.json");
  const now = Date.now();
  writeState({ latest_version: "1.0.0", checked_at: now }, file);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { latest_version: string; checked_at: number };
  assert.equal(parsed.latest_version, "1.0.0");
  assert.equal(typeof parsed.checked_at, "number");
});

// ---------------------------------------------------------------------------
// 7. fetchLatestVersion with mocked fetch
// ---------------------------------------------------------------------------

test("fetchLatestVersion — 200 {version:'0.2.0'} → resolves '0.2.0'", async () => {
  const { restore } = installFetch(() =>
    new Response(JSON.stringify({ version: "0.2.0" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const v = await fetchLatestVersion("https://example.com/fake");
    assert.equal(v, "0.2.0");
  } finally {
    restore();
  }
});

test("fetchLatestVersion — 500 → rejects", async () => {
  const { restore } = installFetch(() => new Response("error", { status: 500 }));
  try {
    await assert.rejects(() => fetchLatestVersion("https://example.com/fake"), /registry responded 500/);
  } finally {
    restore();
  }
});

test("fetchLatestVersion — body > 256KB → rejects", async () => {
  const bigBody = "x".repeat(256 * 1024 + 1);
  const { restore } = installFetch(() =>
    new Response(bigBody, { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  try {
    await assert.rejects(() => fetchLatestVersion("https://example.com/fake"), /too large/);
  } finally {
    restore();
  }
});

test("fetchLatestVersion — {} (no version field) → rejects", async () => {
  const { restore } = installFetch(() =>
    new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  try {
    await assert.rejects(() => fetchLatestVersion("https://example.com/fake"));
  } finally {
    restore();
  }
});

test("fetchLatestVersion — timeout → rejects (AbortError)", { timeout: 10000 }, async () => {
  // Use a fetch mock that respects the abort signal
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
    // Wait until the signal fires, then throw AbortError
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        // AbortSignal.timeout()'s internal timer is unref'd, so it cannot hold
        // the event loop open by itself. Without a ref'd handle of our own the
        // loop drains while this promise is still pending, and the runner
        // cancels this test along with every subtest after it.
        const keepAlive = setTimeout(() => {}, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }
    });
  }) as typeof globalThis.fetch;
  try {
    // Use a very short timeout (100ms) to trigger abort quickly
    await assert.rejects(
      () => fetchLatestVersion("https://example.com/fake", 100),
      (err: unknown) => {
        assert.ok(
          err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"),
          `expected AbortError/TimeoutError, got ${err instanceof Error ? err.name : String(err)}`,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 8. runRefreshCommand
// ---------------------------------------------------------------------------

test("runRefreshCommand — network down → resolves without throwing, no state file", async () => {
  const dir = makeTmpDir();
  const savedHome = process.env["HOME"];
  const savedRegistry = process.env["MESHY_CLI_UPDATE_REGISTRY_URL"];
  const savedEnv = saveEnv(NOTIFIER_ENV_KEYS);
  // Mock fetch to reject immediately (simulates network failure)
  const { restore } = installFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  try {
    clearNotifierEnv();
    process.env["HOME"] = dir;
    process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] = "https://example.com/fake";
    await assert.doesNotReject(() => runRefreshCommand());
    // No state file should be written on failure
    const stateFile = join(dir, ".config", "meshy", "update-state.json");
    assert.equal(existsSync(stateFile), false);
  } finally {
    restore();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedRegistry === undefined) delete process.env["MESHY_CLI_UPDATE_REGISTRY_URL"];
    else process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] = savedRegistry;
    restoreEnv(savedEnv);
  }
});

test("runRefreshCommand — fetch 200 → state file created with latest_version + checked_at", async () => {
  const dir = makeTmpDir();
  const savedHome = process.env["HOME"];
  const savedRegistry = process.env["MESHY_CLI_UPDATE_REGISTRY_URL"];
  const savedEnv = saveEnv(NOTIFIER_ENV_KEYS);
  const { restore } = installFetch(() =>
    new Response(JSON.stringify({ version: "9.9.9" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    clearNotifierEnv();
    process.env["HOME"] = dir;
    process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] = "https://example.com/fake";
    await runRefreshCommand();
    const stateFile = join(dir, ".config", "meshy", "update-state.json");
    assert.ok(existsSync(stateFile), "state file should be created");
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as { latest_version: string; checked_at: number };
    assert.equal(parsed.latest_version, "9.9.9");
    assert.equal(typeof parsed.checked_at, "number");
  } finally {
    restore();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedRegistry === undefined) delete process.env["MESHY_CLI_UPDATE_REGISTRY_URL"];
    else process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] = savedRegistry;
    restoreEnv(savedEnv);
  }
});

test("runRefreshCommand — MESHY_CLI_NO_UPDATE_NOTIFIER=1 → no state file", async () => {
  const dir = makeTmpDir();
  const savedHome = process.env["HOME"];
  const savedRegistry = process.env["MESHY_CLI_UPDATE_REGISTRY_URL"];
  const savedEnv = saveEnv(NOTIFIER_ENV_KEYS);
  const { restore } = installFetch(() =>
    new Response(JSON.stringify({ version: "9.9.9" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    clearNotifierEnv();
    process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";
    process.env["HOME"] = dir;
    process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] = "https://example.com/fake";
    await runRefreshCommand();
    const stateFile = join(dir, ".config", "meshy", "update-state.json");
    assert.equal(existsSync(stateFile), false, "state file should NOT be created when opted out");
  } finally {
    restore();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedRegistry === undefined) delete process.env["MESHY_CLI_UPDATE_REGISTRY_URL"];
    else process.env["MESHY_CLI_UPDATE_REGISTRY_URL"] = savedRegistry;
    restoreEnv(savedEnv);
  }
});

// ---------------------------------------------------------------------------
// 9. attachUpdateNotice
// ---------------------------------------------------------------------------

const fakeNotice = buildNotice("9.9.9", "0.1.0")!;

test("attachUpdateNotice — object + json → has _notice.update", () => {
  const result = attachUpdateNotice({ a: 1 }, "json", fakeNotice) as Record<string, unknown>;
  assert.ok("_notice" in result);
  assert.deepEqual((result["_notice"] as Record<string, unknown>)["update"], fakeNotice);
});

test("attachUpdateNotice — object + pretty → unchanged", () => {
  const value = { a: 1 };
  const result = attachUpdateNotice(value, "pretty", fakeNotice);
  assert.deepEqual(result, value);
});

test("attachUpdateNotice — array [{a:1},{a:2}] + ndjson → first element has _notice, second does NOT", () => {
  const arr = [{ a: 1 }, { a: 2 }];
  const result = attachUpdateNotice(arr, "ndjson", fakeNotice) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.ok("_notice" in result[0]!);
  assert.ok(!("_notice" in result[1]!));
});

test("attachUpdateNotice — array + json → unchanged", () => {
  const arr = [{ a: 1 }];
  const result = attachUpdateNotice(arr, "json", fakeNotice);
  assert.deepEqual(result, arr);
});

test("attachUpdateNotice — null → unchanged", () => {
  assert.equal(attachUpdateNotice(null, "json", fakeNotice), null);
});

test("attachUpdateNotice — string → unchanged", () => {
  assert.equal(attachUpdateNotice("hello", "json", fakeNotice), "hello");
});

test("attachUpdateNotice — null notice → unchanged", () => {
  const value = { a: 1 };
  const result = attachUpdateNotice(value, "json", null);
  assert.deepEqual(result, value);
});

test("attachUpdateNotice — existing _notice plain object is merged, not clobbered", () => {
  const value = { a: 1, _notice: { other: true } };
  const result = attachUpdateNotice(value, "json", fakeNotice) as Record<string, unknown>;
  const notice = result["_notice"] as Record<string, unknown>;
  assert.equal(notice["other"], true, "_notice.other should be preserved");
  assert.deepEqual(notice["update"], fakeNotice, "_notice.update should be set");
});

// ---------------------------------------------------------------------------
// 10. printHumanUpdateHint
// ---------------------------------------------------------------------------

test("printHumanUpdateHint — all three isTTY true → writes message + newline, returns true", () => {
  const written: string[] = [];
  const io = {
    stdout: { isTTY: true as boolean | undefined },
    stderr: { isTTY: true as boolean | undefined, write: (s: string) => { written.push(s); return true; } },
    stdin: { isTTY: true as boolean | undefined },
  };
  const result = printHumanUpdateHint(fakeNotice, io);
  assert.equal(result, true);
  assert.equal(written.length, 1);
  assert.equal(written[0], `${fakeNotice.message}\n`);
});

test("printHumanUpdateHint — stdout not TTY → no write, false", () => {
  const written: string[] = [];
  const io = {
    stdout: { isTTY: false as boolean | undefined },
    stderr: { isTTY: true as boolean | undefined, write: (s: string) => { written.push(s); return true; } },
    stdin: { isTTY: true as boolean | undefined },
  };
  const result = printHumanUpdateHint(fakeNotice, io);
  assert.equal(result, false);
  assert.equal(written.length, 0);
});

test("printHumanUpdateHint — stderr not TTY → no write, false", () => {
  const written: string[] = [];
  const io = {
    stdout: { isTTY: true as boolean | undefined },
    stderr: { isTTY: false as boolean | undefined, write: (s: string) => { written.push(s); return true; } },
    stdin: { isTTY: true as boolean | undefined },
  };
  const result = printHumanUpdateHint(fakeNotice, io);
  assert.equal(result, false);
  assert.equal(written.length, 0);
});

test("printHumanUpdateHint — stdin not TTY → no write, false", () => {
  const written: string[] = [];
  const io = {
    stdout: { isTTY: true as boolean | undefined },
    stderr: { isTTY: true as boolean | undefined, write: (s: string) => { written.push(s); return true; } },
    stdin: { isTTY: false as boolean | undefined },
  };
  const result = printHumanUpdateHint(fakeNotice, io);
  assert.equal(result, false);
  assert.equal(written.length, 0);
});

test("printHumanUpdateHint — null notice → false", () => {
  const written: string[] = [];
  const io = {
    stdout: { isTTY: true as boolean | undefined },
    stderr: { isTTY: true as boolean | undefined, write: (s: string) => { written.push(s); return true; } },
    stdin: { isTTY: true as boolean | undefined },
  };
  const result = printHumanUpdateHint(null, io);
  assert.equal(result, false);
  assert.equal(written.length, 0);
});

// ---------------------------------------------------------------------------
// 11. refreshCache with injectable fakes
// ---------------------------------------------------------------------------

test("refreshCache — env opt-out → spawn not called", () => {
  let spawnCalled = false;
  const fakeSpawn = () => {
    spawnCalled = true;
    return { on: () => {}, unref: () => {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
  };
  const dir = makeTmpDir();
  refreshCache({
    env: { MESHY_CLI_NO_UPDATE_NOTIFIER: "1" },
    argv: ["node", "script.js"],
    scriptPath: "script.js",
    stateFile: join(dir, "state.json"),
    spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
  });
  assert.equal(spawnCalled, false);
});

test("refreshCache — argv contains REFRESH_COMMAND → spawn not called", () => {
  let spawnCalled = false;
  const fakeSpawn = () => {
    spawnCalled = true;
    return { on: () => {}, unref: () => {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
  };
  const dir = makeTmpDir();
  refreshCache({
    env: {},
    argv: ["node", "script.js", REFRESH_COMMAND],
    scriptPath: "script.js",
    stateFile: join(dir, "state.json"),
    spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
  });
  assert.equal(spawnCalled, false);
});

test("refreshCache — fresh cache → spawn not called", () => {
  let spawnCalled = false;
  const fakeSpawn = () => {
    spawnCalled = true;
    return { on: () => {}, unref: () => {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
  };
  const dir = makeTmpDir();
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ latest_version: "0.2.0", checked_at: Date.now() }));
  refreshCache({
    env: {},
    argv: ["node", "script.js"],
    scriptPath: "script.js",
    stateFile,
    spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
  });
  assert.equal(spawnCalled, false);
});

test("refreshCache — missing cache → spawn called once with correct args and .unref() called", () => {
  let spawnCalled = false;
  let unrefCalled = false;
  let spawnArgs: unknown[] = [];
  const fakeSpawn = (...args: unknown[]) => {
    spawnCalled = true;
    spawnArgs = args;
    return {
      on: () => {},
      unref: () => { unrefCalled = true; },
    } as unknown as ReturnType<typeof import("node:child_process").spawn>;
  };
  const dir = makeTmpDir();
  const stateFile = join(dir, "state.json");
  // No state file → stale
  refreshCache({
    env: {},
    argv: ["node", "script.js"],
    scriptPath: "/path/to/script.js",
    stateFile,
    spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
  });
  assert.equal(spawnCalled, true);
  assert.equal(unrefCalled, true);
  assert.equal(spawnArgs[0], process.execPath);
  assert.deepEqual(spawnArgs[1], ["/path/to/script.js", REFRESH_COMMAND]);
  assert.deepEqual((spawnArgs[2] as Record<string, unknown>)["detached"], true);
  assert.deepEqual((spawnArgs[2] as Record<string, unknown>)["stdio"], "ignore");
});

test("refreshCache — spawnImpl throws → does not propagate", () => {
  const fakeSpawn = () => {
    throw new Error("spawn failed");
  };
  const dir = makeTmpDir();
  const stateFile = join(dir, "state.json");
  assert.doesNotThrow(() => {
    refreshCache({
      env: {},
      argv: ["node", "script.js"],
      scriptPath: "/path/to/script.js",
      stateFile,
      spawnImpl: fakeSpawn as typeof import("node:child_process").spawn,
    });
  });
});

// ---------------------------------------------------------------------------
// 12. E2E subprocess tests
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);
const repoRoot = join(__dirname, "..");

test("E2E — MESHY_CLI_NO_UPDATE_NOTIFIER=1 + REFRESH_COMMAND → exit 0", { timeout: 35_000 }, () => {
  const dir = makeTmpDir();
  const result = spawnSync(
    process.execPath,
    ["dist/index.js", REFRESH_COMMAND],
    {
      env: {
        ...process.env,
        HOME: dir,
        MESHY_CLI_NO_UPDATE_NOTIFIER: "1",
      },
      cwd: repoRoot,
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `exit code should be 0, stderr: ${result.stderr?.toString()}`);
});

test("E2E — unreachable registry URL → exit 0 and no state file written", { timeout: 35_000 }, () => {
  const dir = makeTmpDir();
  const result = spawnSync(
    process.execPath,
    ["dist/index.js", REFRESH_COMMAND],
    {
      env: {
        ...process.env,
        HOME: dir,
        MESHY_CLI_UPDATE_REGISTRY_URL: "http://127.0.0.1:1/unreachable",
        // Clear CI/opt-out so the command actually runs
        MESHY_CLI_NO_UPDATE_NOTIFIER: "",
        CI: "",
        GITHUB_ACTIONS: "",
        BUILD_NUMBER: "",
        RUN_ID: "",
      },
      cwd: repoRoot,
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `exit code should be 0, stderr: ${result.stderr?.toString()}`);
  const stateFile = join(dir, ".config", "meshy", "update-state.json");
  assert.equal(existsSync(stateFile), false, "no state file should be written on network failure");
});

// ---------------------------------------------------------------------------
// 13. emit-level injection
// ---------------------------------------------------------------------------

test("emit — json with newer version in cache → stdout has _notice.update with 4 keys", () => {
  const dir = makeTmpDir();
  const savedHome = process.env["HOME"];
  const savedEnv = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["HOME"] = dir;
    // Write a state file with a newer version
    const stateDir = join(dir, ".config", "meshy");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "update-state.json"),
      JSON.stringify({ latest_version: "9.9.9", checked_at: Date.now() }),
    );
    const out = captureStdout(() => emit({ a: 1 }, { format: "json" }));
    const parsed = JSON.parse(out) as Record<string, unknown>;
    assert.ok("_notice" in parsed, "should have _notice");
    const notice = (parsed["_notice"] as Record<string, unknown>)["update"] as Record<string, unknown>;
    assert.ok(notice, "_notice.update should exist");
    assert.ok("current" in notice, "should have current");
    assert.ok("latest" in notice, "should have latest");
    assert.ok("message" in notice, "should have message");
    assert.ok("command" in notice, "should have command");
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    restoreEnv(savedEnv);
  }
});

test("emit — ndjson array with newer version → two lines, only line 1 has _notice", () => {
  const dir = makeTmpDir();
  const savedHome = process.env["HOME"];
  const savedEnv = saveEnv(NOTIFIER_ENV_KEYS);
  try {
    clearNotifierEnv();
    process.env["HOME"] = dir;
    const stateDir = join(dir, ".config", "meshy");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "update-state.json"),
      JSON.stringify({ latest_version: "9.9.9", checked_at: Date.now() }),
    );
    const out = captureStdout(() => emit([{ a: 1 }, { a: 2 }], { format: "ndjson" }));
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.ok("_notice" in first, "first line should have _notice");
    assert.ok(!("_notice" in second), "second line should NOT have _notice");
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    restoreEnv(savedEnv);
  }
});

// ---------------------------------------------------------------------------
// 14. formatReport with _notice
// ---------------------------------------------------------------------------

test("formatReport — with _notice → final line equals the message", () => {
  const notice = buildNotice("2.0.0", "1.0.0")!;
  const out = formatReport({
    status: "SUCCESS",
    taskId: "t1",
    type: "text-to-3d",
    savedFiles: ["out/model.glb"],
    metadataPath: "out/meta.json",
    _notice: notice,
  });
  const lines = out.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], notice.message);
});

test("formatReport — without _notice → unchanged behavior (no extra line)", () => {
  const out = formatReport({
    status: "SUCCESS",
    taskId: "t2",
    type: "text-to-3d",
    savedFiles: ["out/model.glb"],
    metadataPath: "out/meta.json",
  });
  // Should end with the metadata path line
  assert.match(out, /Metadata path: out\/meta\.json\n$/);
  assert.ok(!out.includes("available"), "should not contain update notice");
});
