/**
 * Project store — the `meshy_output/` layout the Skills established.
 *
 *   <root>/history.json                    index of projects (rebuildable)
 *   <root>/<folder>/metadata.json          the facts about one project
 *   <root>/<folder>/task_<id>.json         task snapshots saved by --project
 *   <root>/<folder>/<asset files>
 *
 * metadata.json is the source of truth; history.json is an index derived
 * from it. They are two files, so no cross-file transaction is claimed:
 * `recordTask` commits metadata under the project lock, releases it, then
 * takes the root lock to refresh the index. When the second step fails the
 * caller gets `index: { updated: false }` and `rebuild-index` repairs it.
 * Locks are never nested in the other order.
 *
 * Legacy files written by the Python helper (no schema_version, tasks with
 * only task_id/task_type/stage/files/created_at) are read as v1 and migrated
 * on the first write with a `.bak-<timestamp>` copy; unknown fields survive.
 * The CLI's own download `meta.json` is a third format and never written here.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { writeJsonFile } from "./atomic-file.js";
import { CliError, UsageError } from "./errors.js";
import { withFileLock } from "./lock.js";
import { realpathLenient, resolveWithinRoot, safeSegment, type AuthorisedRoot } from "./paths.js";

export const METADATA_SCHEMA_VERSION = 2;
export const HISTORY_VERSION = 1;

export interface ProjectTaskEntry {
  task_id: string;
  task_type: string | null;
  resource: string | null;
  endpoint: string | null;
  stage: string;
  parent_task_id: string | null;
  status: string | null;
  files: string[];
  task_json: string | null;
  operation_id: string | null;
  created_at: string;
  updated_at: string;
  [extra: string]: unknown;
}

export interface ProjectMetadata {
  schema_version: number;
  project_name: string;
  folder: string;
  root_task_id: string | null;
  created_at: string;
  updated_at: string;
  tasks: ProjectTaskEntry[];
  [extra: string]: unknown;
}

export interface HistoryEntry {
  folder: string;
  prompt: string;
  task_type: string;
  root_task_id: string | null;
  created_at: string;
  updated_at: string;
  task_count: number;
  [extra: string]: unknown;
}

export interface HistoryFile {
  version: number;
  projects: HistoryEntry[];
  [extra: string]: unknown;
}

export interface RecordInput {
  taskId: string;
  stage: string;
  resource?: string | null;
  taskType?: string | null;
  endpoint?: string | null;
  parentTaskId?: string | null;
  status?: string | null;
  files?: string[];
  taskJson?: string | null;
  operationId?: string | null;
}

export interface StoreOptions {
  now?: () => Date;
  lockTimeoutMs?: number;
}

/**
 * Where a project's history index lives (its parent directory unless the
 * caller named a root) and whether this invocation may write there. With an
 * explicit --workspace the index root must resolve inside it; when it does not
 * (the workspace *is* the project directory), metadata is still recorded and
 * the index is left alone with an explicit reason — nothing is ever written,
 * locked or temp-filed outside the workspace.
 */
export function indexRootFor(projectDir: string, explicitRoot: string | undefined, workspace: string | AuthorisedRoot | undefined): { root: string; skipIndex?: string } {
  const root = explicitRoot !== undefined ? resolvePath(explicitRoot) : resolvePath(projectDir, "..");
  if (!workspace) return { root };
  const workspacePath = typeof workspace === "string" ? resolvePath(workspace) : workspace.given;
  try {
    resolveWithinRoot(root, workspace, { label: "history root" });
    return { root };
  } catch (err) {
    return { root, skipIndex: `history root ${root} resolves outside --workspace ${workspacePath}; metadata.json was recorded but history.json was not touched (${err instanceof Error ? err.message : String(err)}) — run \`meshy project rebuild-index --root ${root}\` from a workspace that contains it` };
  }
}

const ISO = (d: Date) => d.toISOString();

function projectLock(projectDir: string): string {
  return join(projectDir, ".meshy.lock");
}

function rootLock(root: string): string {
  return join(root, ".meshy-history.lock");
}

export function metadataPath(projectDir: string): string {
  return join(projectDir, "metadata.json");
}

export function historyPath(root: string): string {
  return join(root, "history.json");
}

/** Folder name: `YYYYMMDD_HHmmss_<slug>_<id-prefix|random>` (legacy shape, collision-safe). */
export function projectFolderName(name: string, taskId: string | null, now: Date, random: () => string = () => randomBytes(2).toString("hex")): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  if (!slug) slug = "project";
  const suffix = taskId ? safeSegment(taskId).slice(0, 8) : random();
  return safeSegment(`${stamp}_${slug}_${suffix}`, "project");
}

/** A metadata/history file path entry must be a plain relative path inside its base. */
export function assertSafeRelativeFile(rel: string, label: string): string {
  if (!rel || rel.includes("\0")) throw new UsageError(`${label}: empty or invalid path`);
  const normalized = rel.split(/[\\/]/);
  if (normalized.some((s) => s === ".." || s === "")) throw new UsageError(`${label}: '${rel}' must be a relative path inside the project (no '..', no absolute path)`);
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) throw new UsageError(`${label}: '${rel}' must be relative to the project directory`);
  return normalized.join("/");
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError({ code: "local_io", message: `cannot read ${path}: ${(err as Error).message}` });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError({ code: "local_io", message: `${path} is not valid JSON (${(err as Error).message}); refusing to overwrite a damaged file — repair or move it first` });
  }
}

/** Normalise any metadata.json (legacy v1 or v2) into the v2 view without touching disk. */
export function normalizeMetadata(raw: unknown, folder: string): { metadata: ProjectMetadata; legacy: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError({ code: "local_io", message: `metadata.json in ${folder} is not a JSON object` });
  }
  const o = raw as Record<string, unknown>;
  const legacy = typeof o["schema_version"] !== "number";
  const tasksRaw = Array.isArray(o["tasks"]) ? (o["tasks"] as unknown[]) : [];
  const tasks: ProjectTaskEntry[] = tasksRaw
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object" && !Array.isArray(t))
    .map((t) => {
      const created = typeof t["created_at"] === "string" ? (t["created_at"] as string) : "";
      return {
        ...t,
        task_id: String(t["task_id"] ?? ""),
        task_type: typeof t["task_type"] === "string" ? (t["task_type"] as string) : null,
        resource: typeof t["resource"] === "string" ? (t["resource"] as string) : null,
        endpoint: typeof t["endpoint"] === "string" ? (t["endpoint"] as string) : null,
        stage: typeof t["stage"] === "string" ? (t["stage"] as string) : "unknown",
        parent_task_id: typeof t["parent_task_id"] === "string" ? (t["parent_task_id"] as string) : null,
        status: typeof t["status"] === "string" ? (t["status"] as string) : null,
        files: Array.isArray(t["files"]) ? (t["files"] as unknown[]).filter((f): f is string => typeof f === "string") : [],
        task_json: typeof t["task_json"] === "string" ? (t["task_json"] as string) : null,
        operation_id: typeof t["operation_id"] === "string" ? (t["operation_id"] as string) : null,
        created_at: created,
        updated_at: typeof t["updated_at"] === "string" ? (t["updated_at"] as string) : created,
      };
    });
  const metadata: ProjectMetadata = {
    ...o,
    schema_version: legacy ? METADATA_SCHEMA_VERSION : (o["schema_version"] as number),
    project_name: typeof o["project_name"] === "string" ? (o["project_name"] as string) : folder,
    folder: typeof o["folder"] === "string" ? (o["folder"] as string) : folder,
    root_task_id: typeof o["root_task_id"] === "string" ? (o["root_task_id"] as string) : null,
    created_at: typeof o["created_at"] === "string" ? (o["created_at"] as string) : "",
    updated_at: typeof o["updated_at"] === "string" ? (o["updated_at"] as string) : "",
    tasks,
  };
  return { metadata, legacy };
}

export interface ProjectRead {
  path: string;
  metadata: ProjectMetadata;
  legacy: boolean;
  exists: boolean;
}

export function readProject(projectDir: string): ProjectRead {
  const dir = resolvePath(projectDir);
  const raw = readJsonFile(metadataPath(dir));
  if (raw === undefined) {
    throw new CliError({ code: "not_found", message: `${dir} has no metadata.json; run \`meshy project init\` or pass an existing project directory` });
  }
  const { metadata, legacy } = normalizeMetadata(raw, basename(dir));
  return { path: dir, metadata, legacy, exists: true };
}

function writeMetadata(dir: string, metadata: ProjectMetadata, wasLegacy: boolean, now: Date): void {
  const target = metadataPath(dir);
  if (wasLegacy && existsSync(target)) {
    const backup = `${target}.bak-${ISO(now).replace(/[:.]/g, "-")}`;
    copyFileSync(target, backup);
  }
  writeJsonFile(target, metadata, { overwrite: true, mode: 0o644 });
}

export interface InitResult {
  root: string;
  project_dir: string;
  folder: string;
  metadata: ProjectMetadata;
  index: { updated: boolean; error: string | null };
}

export function initProject(root: string, opts: { name?: string; taskId?: string | null; taskType?: string | null } & StoreOptions = {}): InitResult {
  const now = (opts.now ?? (() => new Date()))();
  const rootAbs = resolvePath(root);
  mkdirSync(rootAbs, { recursive: true });
  const name = (opts.name ?? opts.taskType ?? "model").trim() || "model";
  let folder = projectFolderName(name, opts.taskId ?? null, now);
  let dir = join(rootAbs, folder);
  while (existsSync(dir)) {
    folder = safeSegment(`${folder}-${randomBytes(2).toString("hex")}`);
    dir = join(rootAbs, folder);
  }
  resolveWithinRoot(dir, rootAbs, { label: "project directory" });
  mkdirSync(dir, { recursive: false });
  const metadata: ProjectMetadata = {
    schema_version: METADATA_SCHEMA_VERSION,
    project_name: name,
    folder,
    root_task_id: opts.taskId ?? null,
    created_at: ISO(now),
    updated_at: ISO(now),
    tasks: [],
  };
  withFileLock(projectLock(dir), () => writeMetadata(dir, metadata, false, now), { timeoutMs: opts.lockTimeoutMs });
  const index = refreshIndexEntry(rootAbs, dir, metadata, opts);
  return { root: rootAbs, project_dir: dir, folder, metadata, index };
}

export interface RecordResult {
  project_dir: string;
  metadata: ProjectMetadata;
  entry: ProjectTaskEntry;
  action: "added" | "merged";
  migrated_from_legacy: boolean;
  index: { updated: boolean; error: string | null };
}

/**
 * Add or merge a task record. The de-duplication key is (task_id, stage):
 * a repeat merges files (union) and refreshes status/task_json instead of
 * appending a duplicate entry.
 */
export function recordTask(projectDir: string, input: RecordInput, opts: StoreOptions & { root?: string; skipIndex?: string } = {}): RecordResult {
  const now = (opts.now ?? (() => new Date()))();
  const dir = resolvePath(projectDir);
  if (!input.taskId) throw new UsageError("--task-id is required");
  if (!input.stage) throw new UsageError("--stage is required");
  const files = (input.files ?? []).map((f) => assertSafeRelativeFile(f, "--file"));
  if (input.taskJson) assertSafeRelativeFile(input.taskJson, "task_json");

  const result = withFileLock(
    projectLock(dir),
    () => {
      const raw = readJsonFile(metadataPath(dir));
      if (raw === undefined) {
        throw new CliError({ code: "not_found", message: `${dir} has no metadata.json; run \`meshy project init\` first` });
      }
      const { metadata, legacy } = normalizeMetadata(raw, basename(dir));
      const existing = metadata.tasks.find((t) => t.task_id === input.taskId && t.stage === input.stage);
      let entry: ProjectTaskEntry;
      let action: "added" | "merged";
      if (existing) {
        action = "merged";
        existing.files = [...new Set([...existing.files, ...files])];
        if (input.status !== undefined && input.status !== null) existing.status = input.status;
        if (input.taskJson) existing.task_json = input.taskJson;
        if (input.resource) existing.resource = input.resource;
        if (input.taskType) existing.task_type = input.taskType;
        if (input.endpoint) existing.endpoint = input.endpoint;
        if (input.parentTaskId) existing.parent_task_id = input.parentTaskId;
        if (input.operationId) existing.operation_id = input.operationId;
        existing.updated_at = ISO(now);
        entry = existing;
      } else {
        action = "added";
        entry = {
          task_id: input.taskId,
          task_type: input.taskType ?? input.resource ?? null,
          resource: input.resource ?? null,
          endpoint: input.endpoint ?? null,
          stage: input.stage,
          parent_task_id: input.parentTaskId ?? null,
          status: input.status ?? null,
          files,
          task_json: input.taskJson ?? null,
          operation_id: input.operationId ?? null,
          created_at: ISO(now),
          updated_at: ISO(now),
        };
        metadata.tasks.push(entry);
      }
      if (!metadata.root_task_id) metadata.root_task_id = input.taskId;
      metadata.updated_at = ISO(now);
      writeMetadata(dir, metadata, legacy, now);
      return { metadata, entry, action, legacy };
    },
    { timeoutMs: opts.lockTimeoutMs },
  );

  const root = opts.root ? resolvePath(opts.root) : resolvePath(dir, "..");
  const index = opts.skipIndex ? { updated: false, error: opts.skipIndex } : refreshIndexEntry(root, dir, result.metadata, opts);
  return { project_dir: dir, metadata: result.metadata, entry: result.entry, action: result.action, migrated_from_legacy: result.legacy, index };
}

function historyEntryFor(metadata: ProjectMetadata, folder: string): HistoryEntry {
  const first = metadata.tasks[0];
  return {
    folder,
    prompt: metadata.project_name,
    task_type: first?.task_type ?? first?.resource ?? "",
    root_task_id: metadata.root_task_id,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    task_count: metadata.tasks.length,
  };
}

/** Second phase of a record: refresh this project's row in history.json under the root lock. Never throws. */
function refreshIndexEntry(root: string, projectDir: string, metadata: ProjectMetadata, opts: StoreOptions): { updated: boolean; error: string | null } {
  try {
    const folder = basename(projectDir);
    withFileLock(
      rootLock(root),
      () => {
        const raw = readJsonFile(historyPath(root));
        let history: HistoryFile;
        if (raw === undefined) history = { version: HISTORY_VERSION, projects: [] };
        else if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as HistoryFile).projects)) history = raw as HistoryFile;
        else throw new CliError({ code: "local_io", message: `${historyPath(root)} is not a history index ({version, projects[]}); refusing to overwrite it` });
        const entry = historyEntryFor(metadata, folder);
        const idx = history.projects.findIndex((p) => p.folder === folder);
        if (idx === -1) history.projects.push(entry);
        else history.projects[idx] = { ...history.projects[idx], ...entry };
        writeJsonFile(historyPath(root), history, { overwrite: true, mode: 0o644 });
      },
      { timeoutMs: opts.lockTimeoutMs },
    );
    return { updated: true, error: null };
  } catch (err) {
    return { updated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ListResult {
  root: string;
  history_path: string;
  history_present: boolean;
  projects: Array<HistoryEntry & { present: boolean }>;
  unindexed_folders: string[];
  index_dirty: boolean;
}

/** Read the index and compare it with the folders that actually carry a metadata.json. */
export function listProjects(root: string): ListResult {
  const rootAbs = resolvePath(root);
  const raw = readJsonFile(historyPath(rootAbs));
  let history: HistoryFile | null = null;
  if (raw !== undefined) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as HistoryFile).projects)) {
      throw new CliError({ code: "local_io", message: `${historyPath(rootAbs)} is not a history index; run \`meshy project rebuild-index\` after moving the damaged file aside` });
    }
    history = raw as HistoryFile;
  }
  const folders = existsSync(rootAbs)
    ? readdirSync(rootAbs).filter((f) => {
        try {
          return statSync(join(rootAbs, f)).isDirectory() && existsSync(metadataPath(join(rootAbs, f)));
        } catch {
          return false;
        }
      })
    : [];
  const indexed = new Set<string>();
  const projects = (history?.projects ?? []).map((p) => {
    const safe = typeof p.folder === "string" && !/[\\/]/.test(p.folder) && p.folder !== ".." && p.folder !== ".";
    const present = safe && existsSync(metadataPath(join(rootAbs, p.folder)));
    if (safe) indexed.add(p.folder);
    return { ...p, present };
  });
  const unindexed = folders.filter((f) => !indexed.has(f));
  return {
    root: rootAbs,
    history_path: historyPath(rootAbs),
    history_present: history !== null,
    projects,
    unindexed_folders: unindexed,
    index_dirty: unindexed.length > 0 || projects.some((p) => !p.present),
  };
}

export interface RebuildResult {
  root: string;
  history_path: string;
  indexed: number;
  skipped: Array<{ folder: string; reason: string }>;
  backup: string | null;
}

/** Regenerate history.json from the project folders; a damaged index is backed up, never silently replaced. */
export function rebuildIndex(root: string, opts: StoreOptions = {}): RebuildResult {
  const now = (opts.now ?? (() => new Date()))();
  const rootAbs = resolvePath(root);
  if (!existsSync(rootAbs)) throw new CliError({ code: "not_found", message: `${rootAbs} does not exist` });
  const skipped: Array<{ folder: string; reason: string }> = [];
  const entries: HistoryEntry[] = [];
  const rootReal = realpathLenient(rootAbs);
  for (const f of readdirSync(rootAbs).sort()) {
    const dir = join(rootAbs, f);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(metadataPath(dir))) continue;
    try {
      resolveWithinRoot(dir, rootReal, { label: "project folder", allowSymlinkLeaf: false });
    } catch (err) {
      skipped.push({ folder: f, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const raw = readJsonFile(metadataPath(dir));
      const { metadata } = normalizeMetadata(raw, f);
      entries.push(historyEntryFor(metadata, f));
    } catch (err) {
      skipped.push({ folder: f, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
  let backup: string | null = null;
  withFileLock(rootLock(rootAbs), () => {
    const hp = historyPath(rootAbs);
    if (existsSync(hp)) {
      backup = `${hp}.bak-${ISO(now).replace(/[:.]/g, "-")}`;
      copyFileSync(hp, backup);
    }
    writeJsonFile(hp, { version: HISTORY_VERSION, projects: entries }, { overwrite: true, mode: 0o644 });
  }, { timeoutMs: opts.lockTimeoutMs });
  return { root: rootAbs, history_path: historyPath(rootAbs), indexed: entries.length, skipped, backup };
}

/** Save a task snapshot as `task_<safe-id>.json` inside the project (overwrites an older snapshot of the same task). */
export function saveTaskSnapshot(projectDir: string, taskId: string, raw: unknown): { path: string; relative: string } {
  const dir = resolvePath(projectDir);
  const name = `task_${safeSegment(taskId, "task")}.json`;
  // Both sides of the relative path come from the same (real-path) frame, so a
  // symlinked temp dir (macOS /var → /private/var) cannot turn "task_x.json"
  // into a ../.. path that the metadata store then rightly refuses.
  const resolved = resolveWithinRoot(join(dir, name), dir, { label: "task snapshot" });
  writeJsonFile(resolved.path, raw, { overwrite: true, mode: 0o600 });
  return { path: resolved.path, relative: relative(resolved.root, resolved.path).split(sep).join("/") };
}

/** Quote one argument for a command a human can paste into a shell; plain tokens stay bare. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * A project that was initialised when a command started must still be one when
 * its record is written. metadata.json missing or replaced by something that is
 * not a regular file is a local condition of the project — reported as
 * `local_io`, never as an API "not found" — and the caller says how to redo the
 * record once the project is restored.
 */
export function assertProjectMetadataPresent(projectDir: string, flag: string): void {
  const target = metadataPath(projectDir);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new CliError({
        code: "local_io",
        message: `--project ${flag} has no metadata.json any more (it was an initialised project when this command started)`,
        cause: err,
      });
    }
    throw err;
  }
  if (!st.isFile()) {
    throw new CliError({
      code: "local_io",
      message: `--project ${flag}: metadata.json is not a regular file (${st.isSymbolicLink() ? "a symbolic link" : st.isDirectory() ? "a directory" : "special"}); refusing to write through it`,
    });
  }
}

/**
 * The `meshy project record` invocation that redoes exactly one thing: the
 * metadata entry a command could not write. Assets, task and journal are left
 * alone — the caller runs it once the project directory is repaired. The
 * original write boundary (`--workspace`, resolved to an absolute path) travels
 * with the command: a recovery never reaches further than the invocation that
 * failed, so a workspace equal to the project still leaves the parent's
 * history index alone (`index_dirty`), exactly as the original would have.
 */
export function projectRecordCommand(projectDir: string, input: RecordInput, opts: { root?: string; workspace?: string } = {}): string {
  const parts = ["meshy", "project", "record", "--project", shellArg(projectDir), "--task-id", shellArg(input.taskId), "--stage", shellArg(input.stage)];
  if (input.resource) parts.push("--resource", shellArg(input.resource));
  if (input.taskType) parts.push("--task-type", shellArg(input.taskType));
  if (input.parentTaskId) parts.push("--parent-task-id", shellArg(input.parentTaskId));
  if (input.status) parts.push("--status", shellArg(input.status));
  for (const f of input.files ?? []) parts.push("--file", shellArg(f));
  if (input.taskJson) parts.push("--task-json", shellArg(input.taskJson));
  if (input.operationId) parts.push("--operation-id", shellArg(input.operationId));
  if (opts.root) parts.push("--root", shellArg(opts.root));
  if (opts.workspace) parts.push("--workspace", shellArg(resolvePath(opts.workspace)));
  return parts.join(" ");
}

/** Derive a stage name from a task type (`text-to-3d-preview` → preview, `creative-lab-lamp-build` → build). */
export function stageFromTaskType(type: unknown, fallback: string): string {
  if (typeof type !== "string" || !type) return fallback;
  const m = /-(preview|refine|prototype|build)$/.exec(type);
  return m ? m[1]! : fallback;
}
