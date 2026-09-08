/**
 * Slicer registry, detection and launch (T-088..T-091) with simulated
 * platforms and a fake spawn. No real application is started.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectSlicers, findSlicer, openInSlicer, SLICERS, type DetectionEnv, type SpawnedChild, type SpawnFn } from "../src/internal/slicers.js";
import { CliError, UsageError } from "../src/internal/errors.js";
import { tmpDir } from "./helpers/cli.js";

const LEGACY_NAMES = ["OrcaSlicer", "Bambu Studio", "Creality Print", "Elegoo Slicer", "Anycubic Slicer Next", "PrusaSlicer", "UltiMaker Cura"];
const MULTICOLOR = new Set(["OrcaSlicer", "Bambu Studio", "Creality Print", "Elegoo Slicer", "Anycubic Slicer Next"]);

function fakeEnv(platform: string, existing: Set<string>, extra: Partial<DetectionEnv> = {}): Partial<DetectionEnv> {
  return {
    platform,
    env: {},
    home: platform === "win32" ? "C:\\Users\\me" : "/Users/me",
    exists: (p) => existing.has(p),
    readdir: (dir) => [...existing].filter((p) => p.startsWith(dir + (platform === "win32" ? "\\" : "/"))).map((p) => p.slice(dir.length + 1).split(/[\\/]/)[0]!),
    which: () => null,
    ...extra,
  };
}

test("T-088 registry: the seven legacy names, ids and multicolor flags", () => {
  assert.deepEqual(SLICERS.map((s) => s.name), LEGACY_NAMES);
  for (const s of SLICERS) assert.equal(s.multicolor, MULTICOLOR.has(s.name), s.name);
  assert.equal(findSlicer("orcaslicer")?.id, "orca-slicer");
  assert.equal(findSlicer("BAMBU-STUDIO")?.name, "Bambu Studio");
  assert.equal(findSlicer("Cura"), undefined);
});

test("T-088 macOS: /Applications and ~/Applications bundles", () => {
  const env = fakeEnv("darwin", new Set(["/Applications/OrcaSlicer.app", "/Users/me/Applications/PrusaSlicer.app"]));
  const d = detectSlicers(env);
  assert.equal(d.platform, "darwin");
  assert.deepEqual(d.slicers.map((s) => [s.name, s.path, s.multicolor]), [
    ["OrcaSlicer", "/Applications/OrcaSlicer.app", true],
    ["PrusaSlicer", "/Users/me/Applications/PrusaSlicer.app", false],
  ]);
  assert.deepEqual(d.unsupported, []);
  assert.deepEqual(detectSlicers(fakeEnv("darwin", new Set())).slicers, [], "empty is a valid answer");
});

test("T-088 Windows: Program Files bases, versioned glob directories and spaces", () => {
  const existing = new Set([
    "C:\\Program Files\\Creality Print 5.1\\CrealityPrint.exe",
    "C:\\Program Files\\UltiMaker Cura 5.7\\UltiMaker-Cura.exe",
    "C:\\Program Files (x86)\\BambuStudio\\bambu-studio.exe",
    "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe",
  ]);
  const env = fakeEnv("win32", existing, {
    env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    readdir: (dir) => (dir === "C:\\Program Files" ? ["Creality Print 5.1", "Creality Print 4.0", "UltiMaker Cura 5.7", "OrcaSlicer"] : dir === "C:\\Program Files (x86)" ? ["BambuStudio"] : []),
    exists: (p) => existing.has(p),
  });
  const d = detectSlicers(env);
  assert.deepEqual(d.slicers.map((s) => [s.name, s.path]), [
    ["OrcaSlicer", "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe"],
    ["Bambu Studio", "C:\\Program Files (x86)\\BambuStudio\\bambu-studio.exe"],
    ["Creality Print", "C:\\Program Files\\Creality Print 5.1\\CrealityPrint.exe"],
    ["UltiMaker Cura", "C:\\Program Files\\UltiMaker Cura 5.7\\UltiMaker-Cura.exe"],
  ]);
  assert.equal(d.slicers.find((s) => s.name === "Creality Print")?.multicolor, true);
});

test("T-088 Linux: PATH lookup for the three registered executables; the rest are explicitly unsupported", () => {
  const env = fakeEnv("linux", new Set(), { which: (name) => (name === "prusa-slicer" ? "/usr/bin/prusa-slicer" : name === "orca-slicer" ? "/opt/orca/orca-slicer" : null) });
  const d = detectSlicers(env);
  assert.deepEqual(d.slicers.map((s) => [s.name, s.path]), [
    ["OrcaSlicer", "/opt/orca/orca-slicer"],
    ["PrusaSlicer", "/usr/bin/prusa-slicer"],
  ]);
  assert.deepEqual(d.unsupported.map((u) => u.name).sort(), ["Anycubic Slicer Next", "Creality Print", "Elegoo Slicer", "UltiMaker Cura"]);
  for (const u of d.unsupported) assert.match(u.reason, /no registered Linux executable/);
});

interface FakeSpawn {
  spawn: SpawnFn;
  calls: Array<{ command: string; args: string[]; options: unknown }>;
}

function fakeSpawn(behaviour: { fail?: boolean; pid?: number; exitCode?: number | null } = {}): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as SpawnedChild & { unrefCalled?: boolean };
    child.pid = behaviour.pid ?? 4242;
    child.unref = () => {
      child.unrefCalled = true;
    };
    setImmediate(() => {
      if (behaviour.fail) child.emit("error", new Error("spawn ENOENT"));
      else {
        child.emit("spawn");
        if (behaviour.exitCode !== undefined) setImmediate(() => child.emit("exit", behaviour.exitCode));
      }
    });
    return child;
  };
  return { spawn, calls };
}

test("T-089 Windows launches the detected absolute exe even when PATH has none", async () => {
  const dir = tmpDir("slicer-");
  const file = join(dir, "model.obj");
  writeFileSync(file, "v 0 0 0\n");
  const exe = "C:\\Program Files\\Creality Print 5.1\\CrealityPrint.exe";
  const env = fakeEnv("win32", new Set([exe]), {
    env: { ProgramFiles: "C:\\Program Files" },
    readdir: (d) => (d === "C:\\Program Files" ? ["Creality Print 5.1"] : []),
    exists: (p) => p === exe,
    which: () => null,
  });
  const fs = fakeSpawn();
  const launch = await openInSlicer(file, "Creality Print", { env, spawn: fs.spawn });
  assert.equal(launch.launch_requested, true);
  assert.equal(fs.calls.length, 1);
  assert.equal(fs.calls[0]!.command, exe);
  assert.deepEqual(fs.calls[0]!.args, [file]);
  assert.equal(launch.pid, 4242);
  assert.equal(launch.launcher, null);
});

test("T-090 the file path is one argv element; shell is false; macOS uses open -a <bundle>", async () => {
  const dir = tmpDir("slicer-");
  const odd = join(dir, `$(rm -rf x); it's "odd" & weird.obj`);
  writeFileSync(odd, "v 0 0 0\n");
  const env = fakeEnv("darwin", new Set(["/Applications/OrcaSlicer.app"]));
  const fs = fakeSpawn({ exitCode: 0 });
  const launch = await openInSlicer(odd, "orca-slicer", { env, spawn: fs.spawn, launcherTimeoutMs: 500 });
  assert.equal(fs.calls.length, 1);
  assert.equal(fs.calls[0]!.command, "open");
  assert.deepEqual(fs.calls[0]!.args, ["-a", "/Applications/OrcaSlicer.app", odd]);
  assert.deepEqual(fs.calls[0]!.options, { detached: true, stdio: "ignore", shell: false });
  assert.deepEqual(launch.launcher, { command: "open", exit_code: 0 });
  assert.equal(launch.slicer.name, "OrcaSlicer");
  // Linux: detected path + file, no launcher wait.
  const lin = fakeEnv("linux", new Set(), { which: (n) => (n === "prusa-slicer" ? "/usr/bin/prusa-slicer" : null) });
  const fs2 = fakeSpawn();
  const l2 = await openInSlicer(odd, "PrusaSlicer", { env: lin, spawn: fs2.spawn });
  assert.deepEqual(fs2.calls[0]!.args, [odd]);
  assert.equal(fs2.calls[0]!.command, "/usr/bin/prusa-slicer");
  assert.equal(l2.launcher, null);
});

test("T-091 unknown / not detected / missing file / spawn failure / bad extension / open failure", async () => {
  const dir = tmpDir("slicer-");
  const file = join(dir, "m.stl");
  writeFileSync(file, "solid\nendsolid\n");
  const env = fakeEnv("darwin", new Set(["/Applications/OrcaSlicer.app"]));
  await assert.rejects(openInSlicer(file, "SuperSlicer", { env, spawn: fakeSpawn().spawn }), UsageError);
  await assert.rejects(openInSlicer(file, "PrusaSlicer", { env, spawn: fakeSpawn().spawn }), (e: unknown) => e instanceof CliError && e.code === "not_found" && /not installed/.test(e.message));
  const linux = fakeEnv("linux", new Set());
  await assert.rejects(openInSlicer(file, "Elegoo Slicer", { env: linux, spawn: fakeSpawn().spawn }), (e: unknown) => e instanceof CliError && e.code === "not_found" && /no registered Linux executable/.test(e.message));
  await assert.rejects(openInSlicer(join(dir, "missing.stl"), "OrcaSlicer", { env, spawn: fakeSpawn().spawn }), (e: unknown) => e instanceof CliError && e.code === "not_found");
  writeFileSync(join(dir, "notes.txt"), "x");
  await assert.rejects(openInSlicer(join(dir, "notes.txt"), "OrcaSlicer", { env, spawn: fakeSpawn().spawn }), UsageError);
  await assert.rejects(openInSlicer(file, "OrcaSlicer", { env, spawn: fakeSpawn({ fail: true }).spawn }), (e: unknown) => e instanceof CliError && e.code === "local_io");
  await assert.rejects(openInSlicer(file, "OrcaSlicer", { env, spawn: fakeSpawn({ exitCode: 1 }).spawn, launcherTimeoutMs: 500 }), (e: unknown) => e instanceof CliError && e.code === "local_io" && /exited with code 1/.test(e.message));
  // A GUI that never exits: resolves as soon as the launcher deadline passes with exit_code null (macOS) and never waits on other platforms.
  const started = Date.now();
  const l = await openInSlicer(file, "OrcaSlicer", { env, spawn: fakeSpawn().spawn, launcherTimeoutMs: 100 });
  assert.deepEqual(l.launcher, { command: "open", exit_code: null });
  assert.ok(Date.now() - started < 2000);
  const nothingRan = fakeSpawn();
  await assert.rejects(openInSlicer(file, "PrusaSlicer", { env, spawn: nothingRan.spawn }), CliError);
  assert.equal(nothingRan.calls.length, 0, "no process is started for an undetected slicer");
});
