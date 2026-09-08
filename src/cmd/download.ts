/**
 * download — selective asset download for a task.
 *
 * Sources (exactly one): --task-json <file> (API task, legacy meta.json or a
 * v1 envelope/result), --url <asset-url>, or --resource <id> --task-id <id>
 * (one GET, then the assets). Selection (at most one): --asset <key>…,
 * --model-format <fmt>, --kind <kind>, --all; with several assets and no
 * selector the command lists the candidates and exits 2 instead of guessing.
 *
 * Output: --output <file> for exactly one asset, --output-dir <dir> otherwise.
 * Files are published exclusively; --overwrite replaces atomically. Nothing
 * is extracted, nothing is re-generated: an expired URL from a task JSON is
 * reported as such, an API-sourced task is refreshed once.
 */

import { Command, Option } from "commander";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { findTaskResource, TASK_RESOURCES, type TaskResourceDescriptor } from "../client/resource-registry.js";
import { enumerateAssets, selectAssets, SelectionError, type Asset, type AssetKind } from "../internal/artifacts.js";
import { emitResult, openCommand, saveRawJson, type OpenedCommand } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { downloadAssets, type DownloadedFile } from "../internal/download.js";
import { CliError, UsageError, type Warning } from "../internal/errors.js";
import { realpathLenient, resolveWithinRoot, safeSegment } from "../internal/paths.js";
import { warning } from "../internal/result.js";
import { assertProjectMetadataPresent, indexRootFor, projectRecordCommand, readProject, recordTask, stageFromTaskType, type RecordInput } from "../internal/project-store.js";
import { buildLocalRuntime, buildRuntime } from "../internal/runtime.js";
import { extractTaskObject } from "../internal/task-view.js";
import { relative } from "node:path";

const TASK_JSON_MAX_BYTES = 16 * 1024 * 1024;
const KINDS: readonly AssetKind[] = ["model", "image", "texture", "thumbnail", "rig", "animation", "motion", "report"];

interface DownloadOpts {
  taskJson?: string;
  url?: string;
  resource?: string;
  taskId?: string;
  asset?: string[];
  modelFormat?: string;
  kind?: string;
  all?: boolean;
  list?: boolean;
  outputDir?: string;
  overwrite?: boolean;
  withDependencies?: boolean;
  geometryOnly?: boolean;
  saveJson?: string;
  includeRaw?: boolean;
  project?: string;
  stage?: string;
}

function collect(v: string, prev: string[] = []): string[] {
  return [...prev, v];
}

function resourceForTask(task: Record<string, unknown>, hint: string | null): TaskResourceDescriptor | null {
  if (hint) {
    const d = findTaskResource(hint);
    if (d) return d;
  }
  const type = task["type"];
  if (typeof type !== "string") return null;
  return TASK_RESOURCES.find((d) => d.taskTypes.includes(type)) ?? null;
}

function readTaskJson(path: string): { task: Record<string, unknown>; resourceHint: string | null; shape: string } {
  const abs = resolvePath(path);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new UsageError(`--task-json: file not found: ${path}`);
  }
  if (!st.isFile()) throw new UsageError(`--task-json: not a regular file: ${path}`);
  if (st.size > TASK_JSON_MAX_BYTES) throw new UsageError(`--task-json: ${path} is larger than ${TASK_JSON_MAX_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new UsageError(`--task-json: ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const extracted = extractTaskObject(parsed);
  if (!extracted) throw new UsageError(`--task-json: ${path} does not contain a task (expected an API task, a meta.json, or a v1 envelope)`);
  const o = parsed as Record<string, unknown>;
  let hint: string | null = null;
  if (extracted.source === "meta.json" && typeof o["resource"] === "string") hint = o["resource"] as string;
  const view = (o["result"] as Record<string, unknown> | undefined)?.["task"] as Record<string, unknown> | undefined;
  if ((extracted.source === "v1-envelope" || extracted.source === "v1-result") && typeof view?.["resource"] === "string") hint = view["resource"] as string;
  return { task: extracted.task, resourceHint: hint, shape: extracted.source };
}

export const downloadCommand = new Command("download")
  .description("Download selected assets of a task (from a saved task JSON, a URL, or the API) with explicit selection and safe file placement")
  .option("--task-json <file>", "task JSON saved earlier (API task, meta.json or v1 envelope)")
  .option("--url <url>", "download exactly one asset URL (no task context)")
  .option("--resource <id>", "with --task-id: fetch the task from the API first (one GET)")
  .option("--task-id <id>", "with --resource: the task to fetch")
  .option("--asset <key>", "stable asset key to download (repeatable), e.g. model.glb, thumbnail.primary, result.basic_animations.walking_glb_url", collect)
  .option("--model-format <fmt>", "select the model of this format (glb, obj, fbx, usdz, stl, 3mf, …)")
  .addOption(new Option("--kind <kind>", "select every asset of one kind").choices([...KINDS]))
  .option("--all", "select every asset")
  .option("--list", "list the task's assets and exit without downloading")
  .option("--output-dir <dir>", "directory to write into (for several assets); mutually exclusive with --output/-o")
  .option("--overwrite", "replace existing files atomically (never directories or symlinks)")
  .option("--with-dependencies", "for OBJ selections also fetch the MTL and textures (default)")
  .option("--geometry-only", "for OBJ selections fetch the OBJ alone")
  .option("--save-json <file>", "save the raw task JSON (API source) alongside")
  .option("--include-raw", "v1: include the raw task under result.source.raw")
  .option("--project <dir>", "initialised meshy_output project: default output directory, and the files are recorded in metadata.json")
  .option("--stage <name>", "stage label for the project record (default: derived from the task type)")
  .action(async (opts: DownloadOpts, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "download", "v1");
    const sources = [opts.taskJson ? "task-json" : null, opts.url ? "url" : null, opts.resource || opts.taskId ? "api" : null].filter(Boolean);
    if (sources.length !== 1) throw new UsageError("provide exactly one source: --task-json <file>, --url <url>, or --resource <id> --task-id <id>");
    if ((opts.resource && !opts.taskId) || (!opts.resource && opts.taskId)) throw new UsageError("--resource and --task-id go together");
    const selectors = [opts.asset?.length ? "asset" : null, opts.modelFormat ? "model-format" : null, opts.kind ? "kind" : null, opts.all ? "all" : null].filter(Boolean);
    if (selectors.length > 1) throw new UsageError(`selectors are mutually exclusive (got ${selectors.map((s) => `--${s}`).join(", ")})`);
    if (opts.withDependencies && opts.geometryOnly) throw new UsageError("--with-dependencies and --geometry-only are mutually exclusive");
    if (opened.flags.output && opts.outputDir) throw new UsageError("--output/-o and --output-dir are mutually exclusive");
    const projectDir = opts.project
      ? opened.flags.workspace
        ? resolveWithinRoot(resolvePath(opts.project), opened.flags.workspace, { label: "--project" }).path
        : resolvePath(opts.project)
      : null;
    if (projectDir) preflightProject(projectDir, opts.project!, opts.stage);
    if (projectDir && opts.url) throw new UsageError("--project needs a task context; it cannot be combined with --url");
    const warnings: Warning[] = [];

    // ---- source ----
    let task: Record<string, unknown> | null = null;
    let raw: unknown = null;
    let descriptor: TaskResourceDescriptor | null = null;
    let sourceInfo: Record<string, unknown>;
    let refreshUrls: (() => Promise<Map<string, string> | null>) | undefined;

    if (opts.url) {
      buildLocalRuntime(opened.flags);
      sourceInfo = { kind: "url", url: opts.url.split("?")[0] };
      if (opts.list || selectors.length > 0) throw new UsageError("--url downloads exactly one URL; selectors and --list do not apply");
    } else if (opts.taskJson) {
      buildLocalRuntime(opened.flags);
      const read = readTaskJson(opts.taskJson);
      task = read.task;
      raw = read.task;
      descriptor = resourceForTask(task, read.resourceHint);
      sourceInfo = { kind: "task-json", path: resolvePath(opts.taskJson), shape: read.shape, resource: descriptor?.id ?? null, task_id: task["id"] ?? null };
    } else {
      const d = findTaskResource(opts.resource!);
      if (!d) throw new UsageError(`unknown resource '${opts.resource}'; run \`meshy resources\``);
      descriptor = d;
      const runtime = await buildRuntime(opened.flags);
      const endpoint = runtime.client.endpointFor(d);
      const got = await endpoint.retrieveDetailed(opts.taskId!, { signal: abortSignal() });
      task = got.raw as Record<string, unknown>;
      raw = got.raw;
      sourceInfo = { kind: "api", resource: d.id, task_id: opts.taskId, status: (task["status"] as string | undefined) ?? null };
      refreshUrls = async () => {
        const again = await endpoint.retrieveDetailed(opts.taskId!, { signal: abortSignal() });
        const fresh = enumerateAssets(again.raw as Record<string, unknown>, d);
        return new Map(fresh.assets.filter((a) => a.url).map((a) => [a.key, a.url!] as const));
      };
    }
    const savedJson = opts.saveJson && raw ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspace }) : null;

    // ---- enumerate + select ----
    let selected: Asset[];
    let dependencies: Asset[] = [];
    let enumeration: ReturnType<typeof enumerateAssets> | null = null;
    if (opts.url) {
      const name = safeSegment(basename(new URL(opts.url).pathname) || "asset", "asset");
      selected = [{ key: "url", kind: "model", url: opts.url, format: null, containerFormat: null, modelFormat: null, sourcePath: "url", filename: name, dependencies: [] }];
      // Kind is unknown for a bare URL: content validation only checks for HTML pages.
      selected[0]!.kind = "image";
    } else {
      enumeration = enumerateAssets(task!, descriptor);
      if (task!["status"] !== "SUCCEEDED" && enumeration.assets.length === 0) {
        await emitResult(opened, null, { source: sourceInfo, assets: [], downloads: { state: "not_ready", files: [], metadata_path: null }, saved_json: savedJson, unknown_urls: enumeration.unknown_urls }, {
          warnings: [warning("task_not_ready", `task status is ${String(task!["status"])}; no assets to download yet`)],
        });
        return;
      }
      if (opts.list) {
        await emitResult(opened, null, {
          source: sourceInfo,
          assets: enumeration.assets.map(describeAsset),
          unknown_urls: enumeration.unknown_urls,
          product: enumeration.product,
          saved_json: savedJson,
          ...(opts.includeRaw ? { raw } : {}),
        });
        return;
      }
      const withDeps = !opts.geometryOnly;
      try {
        const sel = selectors.length === 0
          ? (enumeration.assets.length === 1
              ? { keys: [enumeration.assets[0]!.key] }
              : (() => {
                  throw new SelectionError(`task exposes ${enumeration.assets.length} assets; choose with --asset, --model-format, --kind or --all`, enumeration.assets);
                })())
          : { keys: opts.asset, modelFormat: opts.modelFormat, kind: opts.kind as AssetKind | undefined, all: opts.all };
        const result = selectAssets(enumeration, sel, { withDependencies: withDeps });
        selected = result.selected;
        dependencies = result.dependencies;
        for (const m of result.missingDependencies) warnings.push(warning("material_dependency_missing", `${m} is not available in this task; the OBJ will be delivered without it`));
      } catch (err) {
        if (err instanceof SelectionError) {
          throw new CliError({ code: "usage", message: err.message, result: { source: sourceInfo, assets: err.candidates } });
        }
        throw err;
      }
      if (opts.geometryOnly && selected.some((a) => a.modelFormat === "obj" && a.containerFormat === null)) {
        warnings.push(warning("geometry_only", "OBJ delivered without its MTL/textures as requested"));
      }
    }

    const toDownload = [...selected, ...dependencies];
    // ---- output placement ----
    const outputFile = opened.flags.output;
    const outputDir = opts.outputDir ?? (projectDir && !outputFile ? projectDir : undefined);
    if (!outputFile && !outputDir) throw new UsageError("pass --output <file> (single asset) or --output-dir <dir>");
    if (outputFile && toDownload.length > 1) {
      throw new UsageError(`${toDownload.length} files would be written (${toDownload.map((a) => a.key).join(", ")}); --output names one file — use --output-dir <dir>`);
    }
    const dir = outputFile ? dirname(resolvePath(outputFile)) : resolvePath(outputDir!);
    const root = opened.flags.workspace ? resolvePath(opened.flags.workspace) : dir;

    const files: DownloadedFile[] = [];
    let result;
    try {
      result = await downloadAssets(toDownload, {
        targetFile: outputFile ? resolvePath(outputFile) : undefined,
        targetDir: outputFile ? undefined : dir,
        overwrite: Boolean(opts.overwrite),
        root,
        signal: abortSignal(),
        refreshUrls,
        onFile: (f) => files.push(f),
      });
    } catch (err) {
      if (err instanceof CliError) {
        const expired = err.httpStatus === 401 || err.httpStatus === 403 || err.httpStatus === 410;
        const hint = expired && !refreshUrls && descriptor && task
          ? `signed URL rejected and a task JSON cannot refresh it; re-fetch with \`meshy ${descriptor.commandPath.join(" ")} get ${String(task["id"])} --save-json <file> --output-schema v1\` (no new task is created)`
          : undefined;
        throw new CliError({
          code: err.code,
          message: hint ? `${err.message}. ${hint}` : err.message,
          httpStatus: err.httpStatus,
          recovery: hint && descriptor && task ? { action: "refresh_task", automatic: false, command: `meshy ${descriptor.commandPath.join(" ")} get ${String(task["id"])} --save-json <file> --output-schema v1` } : err.recovery,
          result: { source: sourceInfo, ...(err.result ?? {}), saved_json: savedJson },
          warnings: [...warnings, ...err.warnings],
          cause: err,
        });
      }
      throw err;
    }
    warnings.push(...result.warnings.map((w) => warning(w.code, w.message)));
    // Everything the caller must still learn if the project bookkeeping below
    // fails: what was asked for, what landed (with the digests on disk), where
    // the raw task went. The project phase never owns this state.
    const outcome = {
      source: sourceInfo,
      selection: { selected: selected.map((a) => a.key), dependencies: dependencies.map((a) => a.key) },
      downloads: { state: result.complete ? "completed" : "partial", files: result.files, metadata_path: null, material_links: result.materialLinks },
      unknown_urls: enumeration?.unknown_urls ?? [],
      saved_json: savedJson,
      ...(opts.includeRaw ? { raw } : {}),
    };
    let project: Record<string, unknown> | null = null;
    if (projectDir && task) {
      const written = result.files.filter((f) => f.status === "written");
      const input: RecordInput = {
        taskId: String(task["id"] ?? opts.taskId ?? ""),
        stage: opts.stage ?? stageFromTaskType(task["type"], descriptor?.id ?? "download"),
        resource: descriptor?.id ?? null,
        taskType: typeof task["type"] === "string" ? (task["type"] as string) : null,
        endpoint: descriptor?.legacyEndpoint ?? null,
        status: typeof task["status"] === "string" ? (task["status"] as string) : null,
        files: [],
      };
      const workspace = opened.flags.workspace ? resolvePath(opened.flags.workspace) : undefined;
      try {
        // Compare in one real-path frame: the project may be reached through an
        // alias (a symlinked parent, macOS /var → /private/var) while the
        // downloader reports real paths; the recorded name is relative to the real project.
        // The file list is known before the project is examined, so a recovery
        // command always names what landed inside the project.
        const projectReal = realpathLenient(projectDir);
        input.files = written
          .map((f) => relative(projectReal, realpathLenient(f.path)).split(/[\\/]/).join("/"))
          .filter((f) => f.length > 0 && !f.startsWith("..") && !f.startsWith("/"));
        // The project passed the preflight; it must still be one now.
        assertProjectMetadataPresent(projectDir, opts.project!);
        const indexRoot = indexRootFor(projectDir, undefined, opened.flags.workspace);
        const rec = recordTask(projectDir, input, { root: indexRoot.root, skipIndex: indexRoot.skipIndex });
        if (!rec.index.updated) warnings.push(warning("index_dirty", `metadata.json committed but history.json was not updated: ${rec.index.error}`));
        if (input.files.length !== written.length) warnings.push(warning("files_outside_project", "some files were written outside the project directory and were not recorded"));
        project = { project_dir: projectDir, action: rec.action, stage: rec.entry.stage, recorded_files: input.files };
      } catch (err) {
        throw projectRecordFailure(err, { projectDir, workspace, dir, input, written: written.length, outcome, warnings });
      }
    }
    await emitResult(opened, null, { ...outcome, project }, { warnings });
  });

/**
 * `--project` checks that can fail before any transfer, so that they do:
 * metadata.json must exist, be a regular file (never a symlink the record
 * step would refuse to replace) and parse as a project; `--stage` must not be
 * blank. Nothing is downloaded when one of these fails. What changes *after*
 * this check is caught by `projectRecordFailure`.
 */
function preflightProject(projectDir: string, flag: string, stage: string | undefined): void {
  const metaPath = join(projectDir, "metadata.json");
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(metaPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
  }
  if (!st) throw new UsageError(`--project ${flag} is not an initialised project (no metadata.json); run \`meshy project init\` first`);
  if (!st.isFile()) {
    throw new CliError({ code: "local_io", message: `--project ${flag}: metadata.json is not a regular file (${st.isSymbolicLink() ? "a symbolic link" : st.isDirectory() ? "a directory" : "special"}); nothing was downloaded` });
  }
  try {
    readProject(projectDir);
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError({ code: err.code, message: `--project ${flag}: ${err.message} (nothing was downloaded)`, recovery: err.recovery, cause: err });
    }
    throw err;
  }
  if (stage !== undefined && stage.trim() === "") throw new UsageError("--stage must not be blank");
}

/**
 * The transfers are done and the files are on disk; only the project entry
 * could not be written. The error keeps its own class (a refused symlink,
 * a damaged metadata.json, a lock timeout, a full disk are all local_io) and
 * carries the complete download result plus a `project` record that says what
 * failed and the one command that redoes just the bookkeeping. Nothing is
 * rolled back, re-downloaded or re-submitted.
 */
function projectRecordFailure(
  err: unknown,
  ctx: { projectDir: string; workspace: string | undefined; dir: string; input: RecordInput; written: number; outcome: Record<string, unknown>; warnings: Warning[] },
): CliError {
  const base = err instanceof CliError ? err : null;
  const code = base?.code ?? "local_io";
  const reason = err instanceof Error ? err.message : String(err);
  const command = projectRecordCommand(ctx.projectDir, ctx.input, { workspace: ctx.workspace });
  const recovery = { action: "record_project", automatic: false, command };
  return new CliError({
    code,
    message: `${ctx.written} file(s) were downloaded to ${ctx.dir} but recording task ${ctx.input.taskId} in project ${ctx.projectDir} failed: ${reason}`,
    exitCode: base?.exitCode,
    httpStatus: base?.httpStatus ?? null,
    retryable: base?.retryable ?? false,
    recovery,
    hint: command,
    details: base?.details,
    warnings: [...ctx.warnings, ...(base?.warnings ?? [])],
    result: {
      ...ctx.outcome,
      project: {
        project_dir: ctx.projectDir,
        action: "failed",
        stage: ctx.input.stage,
        recorded_files: [],
        error: { code, message: reason },
        recovery,
      },
    },
    cause: err,
  });
}

function describeAsset(a: Asset): Record<string, unknown> {
  return {
    key: a.key,
    kind: a.kind,
    format: a.format,
    model_format: a.modelFormat,
    container_format: a.containerFormat,
    filename: a.filename,
    dependencies: a.dependencies,
    has_url: a.url !== null,
    ...(a.notes ?? {}),
  };
}
