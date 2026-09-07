/**
 * Slicer registry, detection and launch — the legacy `slicers.py` helper.
 *
 * Seven slicers are registered with the install locations the skill used; the
 * `multicolor` flag is capability metadata only (the slicer can drive
 * multi-material prints — it says nothing about a particular printer).
 *
 * Detection is a pure function of an injectable DetectionEnv so every
 * platform's rules are testable on any host:
 *   macOS    — `/Applications/<app>.app` and `~/Applications/<app>.app`
 *   Windows  — `<ProgramFiles | ProgramFiles(x86)>\<dir>\<exe>`, where a `*`
 *              suffix on the registered directory matches versioned installs
 *              ("Creality Print 5.1", "UltiMaker Cura 5.7")
 *   Linux    — the three executables the skill knew about, on PATH; the other
 *              four are reported as unsupported instead of guessed
 *
 * Launching only ever runs the detected path (or `open -a <bundle>` on macOS)
 * with the model file as a single argv element: no shell, no string commands,
 * no default-application fallback. The legacy Windows bug — detecting an exe
 * under Program Files, then running a same-named exe from PATH — is exactly
 * what the detected absolute path avoids. A spawn that fails is an error; a
 * spawn that succeeds is `launch_requested`, never proof that the slicer
 * imported the file. On macOS the short-lived `open` helper is awaited (bounded)
 * for its exit status; GUI processes are never awaited.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, posix, resolve as resolvePath, win32 } from "node:path";
import { CliError, UsageError } from "./errors.js";

export interface SlicerDescriptor {
  /** Stable slug for scripts (`orca-slicer`). */
  id: string;
  /** Display name, as the legacy skill spelled it (`OrcaSlicer`). */
  name: string;
  /** macOS bundle name without `.app`. */
  macApp: string;
  /** Windows executable file name. */
  winExe: string;
  /** Windows directory under Program Files; a trailing `*` matches a version suffix. */
  winDir: string;
  /** Linux executable expected on PATH, or null when the skill registered none. */
  linuxExe: string | null;
  /** Capability metadata: the slicer supports multi-material / multi-colour prints. */
  multicolor: boolean;
}

export const SLICERS: readonly SlicerDescriptor[] = [
  { id: "orca-slicer", name: "OrcaSlicer", macApp: "OrcaSlicer", winExe: "orca-slicer.exe", winDir: "OrcaSlicer", linuxExe: "orca-slicer", multicolor: true },
  { id: "bambu-studio", name: "Bambu Studio", macApp: "BambuStudio", winExe: "bambu-studio.exe", winDir: "BambuStudio", linuxExe: "bambu-studio", multicolor: true },
  { id: "creality-print", name: "Creality Print", macApp: "Creality Print", winExe: "CrealityPrint.exe", winDir: "Creality Print*", linuxExe: null, multicolor: true },
  { id: "elegoo-slicer", name: "Elegoo Slicer", macApp: "ElegooSlicer", winExe: "elegoo-slicer.exe", winDir: "ElegooSlicer", linuxExe: null, multicolor: true },
  { id: "anycubic-slicer-next", name: "Anycubic Slicer Next", macApp: "AnycubicSlicerNext", winExe: "AnycubicSlicerNext.exe", winDir: "AnycubicSlicerNext", linuxExe: null, multicolor: true },
  { id: "prusa-slicer", name: "PrusaSlicer", macApp: "PrusaSlicer", winExe: "prusa-slicer.exe", winDir: "PrusaSlicer", linuxExe: "prusa-slicer", multicolor: false },
  { id: "ultimaker-cura", name: "UltiMaker Cura", macApp: "UltiMaker Cura", winExe: "UltiMaker-Cura.exe", winDir: "UltiMaker Cura*", linuxExe: null, multicolor: false },
];

/** File types a slicer can be asked to open. Anything else is a usage error. */
export const LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set(["obj", "stl", "3mf", "glb", "gltf", "step", "stp", "ply", "amf"]);

export const NO_LINUX_EXECUTABLE = "no registered Linux executable";

export interface DetectionEnv {
  platform: "darwin" | "win32" | "linux" | string;
  env: Record<string, string | undefined>;
  home: string;
  exists(path: string): boolean;
  readdir(dir: string): string[];
  which(name: string): string | null;
}

export interface DetectedSlicer {
  id: string;
  name: string;
  path: string;
  multicolor: boolean;
  platform: string;
}

export interface UnsupportedSlicer {
  id: string;
  name: string;
  reason: string;
}

export interface SlicerDetection {
  platform: string;
  slicers: DetectedSlicer[];
  unsupported: UnsupportedSlicer[];
}

/** Environment variables on Windows are case-insensitive; plain records in tests are not. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function isExecutableFile(path: string, platform: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH lookup using the simulated platform's delimiter and PATHEXT rules. */
function whichFromPath(env: Record<string, string | undefined>, platform: string): (name: string) => string | null {
  return (name) => {
    const isWin = platform === "win32";
    const p = isWin ? win32 : posix;
    const dirs = (envValue(env, "PATH") ?? "").split(isWin ? ";" : ":").filter(Boolean);
    const exts = isWin ? (envValue(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = p.join(dir, ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name);
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };
}

/** The real environment, with any field replaced by the caller (tests simulate other platforms). */
export function defaultDetectionEnv(overrides: Partial<DetectionEnv> = {}): DetectionEnv {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? (process.env as Record<string, string | undefined>);
  return {
    platform,
    env,
    home: overrides.home ?? homedir(),
    exists: overrides.exists ?? ((path) => existsSync(path)),
    readdir:
      overrides.readdir ??
      ((dir) => {
        try {
          return readdirSync(dir);
        } catch {
          return [];
        }
      }),
    which: overrides.which ?? whichFromPath(env, platform),
  };
}

interface Probe {
  path: string | null;
  checked: string[];
  unsupported: string | null;
}

function probeDarwin(s: SlicerDescriptor, env: DetectionEnv): Probe {
  const checked = [posix.join("/Applications", `${s.macApp}.app`), posix.join(env.home, "Applications", `${s.macApp}.app`)];
  for (const candidate of checked) {
    if (env.exists(candidate)) return { path: candidate, checked, unsupported: null };
  }
  return { path: null, checked, unsupported: null };
}

function probeWindows(s: SlicerDescriptor, env: DetectionEnv): Probe {
  const bases = [
    envValue(env.env, "ProgramFiles") ?? "C:\\Program Files",
    envValue(env.env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)",
  ];
  const checked: string[] = [];
  for (const base of bases) {
    let dirs: string[];
    if (s.winDir.endsWith("*")) {
      const prefix = s.winDir.slice(0, -1).toLowerCase();
      let entries: string[];
      try {
        entries = env.readdir(base);
      } catch {
        entries = [];
      }
      // Highest version last; the newest install that actually holds the exe wins.
      dirs = entries
        .filter((entry) => entry.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
        .reverse();
      if (dirs.length === 0) checked.push(win32.join(base, s.winDir, s.winExe));
    } else {
      dirs = [s.winDir];
    }
    for (const dir of dirs) {
      const candidate = win32.join(base, dir, s.winExe);
      checked.push(candidate);
      if (env.exists(candidate)) return { path: candidate, checked, unsupported: null };
    }
  }
  return { path: null, checked, unsupported: null };
}

function probeLinux(s: SlicerDescriptor, env: DetectionEnv): Probe {
  if (s.linuxExe === null) return { path: null, checked: [], unsupported: NO_LINUX_EXECUTABLE };
  const found = env.which(s.linuxExe);
  return { path: found, checked: [`${s.linuxExe} on PATH`], unsupported: null };
}

function probe(s: SlicerDescriptor, env: DetectionEnv): Probe {
  switch (env.platform) {
    case "darwin":
      return probeDarwin(s, env);
    case "win32":
      return probeWindows(s, env);
    case "linux":
      return probeLinux(s, env);
    default:
      return { path: null, checked: [], unsupported: `no detection rule for platform '${env.platform}'` };
  }
}

/** Detect installed slicers. An empty `slicers` list is a successful answer. */
export function detectSlicers(env: Partial<DetectionEnv> = {}): SlicerDetection {
  const resolved = defaultDetectionEnv(env);
  const detection: SlicerDetection = { platform: resolved.platform, slicers: [], unsupported: [] };
  for (const s of SLICERS) {
    const result = probe(s, resolved);
    if (result.path !== null) {
      detection.slicers.push({ id: s.id, name: s.name, path: result.path, multicolor: s.multicolor, platform: resolved.platform });
    } else if (result.unsupported !== null) {
      detection.unsupported.push({ id: s.id, name: s.name, reason: result.unsupported });
    }
  }
  return detection;
}

/** Registered descriptor by display name or id, case-insensitive. */
export function findSlicer(nameOrId: string): SlicerDescriptor | undefined {
  const q = nameOrId.trim().toLowerCase();
  return SLICERS.find((s) => s.id === q || s.name.toLowerCase() === q);
}

/** The subset of a child process the launcher relies on; node's ChildProcess satisfies it. */
export type SpawnedChild = EventEmitter & { pid?: number | undefined; unref(): void };

export interface LaunchSpawnOptions {
  detached: true;
  stdio: "ignore";
  shell: false;
}

export type SpawnFn = (command: string, args: readonly string[], options: LaunchSpawnOptions) => SpawnedChild;

export interface SlicerLaunch {
  launch_requested: true;
  slicer: DetectedSlicer;
  /** Absolute path handed to the slicer. */
  file: string;
  pid: number | null;
  argv: string[];
  platform: string;
  /** macOS only: the `open` helper's exit status (null when it was still running at the deadline). */
  launcher: { command: string; exit_code: number | null } | null;
}

export interface OpenInSlicerOptions {
  detection?: SlicerDetection;
  spawn?: SpawnFn;
  env?: Partial<DetectionEnv>;
  cwd?: string;
  /** How long to wait for macOS `open` to exit before reporting `exit_code: null` (default 5 s). */
  launcherTimeoutMs?: number;
}

const DEFAULT_LAUNCHER_TIMEOUT_MS = 5_000;

function awaitSpawned(child: SpawnedChild): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function awaitExitBounded(child: SpawnedChild, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(null);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

/**
 * Open `file` in a registered, detected slicer. Resolves as soon as the OS
 * confirms the process started (plus, on macOS, when `open` reports back);
 * it never waits for a GUI to close.
 */
export async function openInSlicer(file: string, slicerNameOrId: string, opts: OpenInSlicerOptions = {}): Promise<SlicerLaunch> {
  const descriptor = findSlicer(slicerNameOrId);
  if (!descriptor) {
    const registered = SLICERS.map((s) => `${s.name} (${s.id})`).join(", ");
    throw new UsageError(`unknown slicer '${slicerNameOrId}'. Registered slicers: ${registered}`);
  }

  const detection = opts.detection ?? detectSlicers(opts.env);
  const platform = detection.platform;
  const detected = detection.slicers.find((s) => s.id === descriptor.id);
  if (!detected) {
    const unsupported = detection.unsupported.find((s) => s.id === descriptor.id);
    const checked = probe(descriptor, defaultDetectionEnv({ ...opts.env, platform })).checked;
    throw new CliError({
      code: "not_found",
      message: unsupported
        ? `${descriptor.name} cannot be detected on ${platform}: ${unsupported.reason}`
        : `${descriptor.name} is not installed in a known location on ${platform}`,
      hint: "meshy slicer detect --output-schema v1",
      recovery: { action: "run_hint", automatic: false, command: "meshy slicer detect --output-schema v1" },
      details: { checked },
    });
  }

  const absFile = resolvePath(opts.cwd ?? process.cwd(), file);
  let fileStat;
  try {
    fileStat = statSync(absFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new CliError({ code: "not_found", message: `model file not found: ${absFile}` });
    }
    throw new CliError({ code: "local_io", message: `cannot access ${absFile}: ${(err as Error).message}`, cause: err });
  }
  if (!fileStat.isFile()) {
    throw new CliError({ code: "not_found", message: `model path is not a regular file: ${absFile}` });
  }
  const ext = extname(absFile).slice(1).toLowerCase();
  if (!LAUNCHABLE_EXTENSIONS.has(ext)) {
    throw new UsageError(
      `unsupported model file extension '${ext ? `.${ext}` : "(none)"}' for ${absFile}; expected one of ${[...LAUNCHABLE_EXTENSIONS].join(", ")}`,
    );
  }

  let command: string;
  let args: string[];
  if (platform === "darwin") {
    command = "open";
    args = ["-a", detected.path, absFile];
  } else {
    command = detected.path;
    args = [absFile];
  }
  const spawnOptions: LaunchSpawnOptions = { detached: true, stdio: "ignore", shell: false };
  const spawnImpl: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);

  let child: SpawnedChild;
  try {
    child = spawnImpl(command, args, spawnOptions);
    await awaitSpawned(child);
  } catch (err) {
    throw new CliError({
      code: "local_io",
      message: `failed to launch ${descriptor.name} (${command}): ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
  // Late errors on an already-running child must not crash the CLI.
  child.on("error", () => {});
  child.unref();

  let launcher: SlicerLaunch["launcher"] = null;
  if (platform === "darwin") {
    const exitCode = await awaitExitBounded(child, opts.launcherTimeoutMs ?? DEFAULT_LAUNCHER_TIMEOUT_MS);
    if (exitCode !== null && exitCode !== 0) {
      throw new CliError({
        code: "local_io",
        message: `open exited with code ${exitCode}: ${descriptor.name} at ${detected.path} did not accept ${absFile}`,
        details: { argv: [command, ...args], exit_code: exitCode },
      });
    }
    launcher = { command, exit_code: exitCode };
  }

  return {
    launch_requested: true,
    slicer: detected,
    file: absFile,
    pid: child.pid ?? null,
    argv: [command, ...args],
    platform,
    launcher,
  };
}
