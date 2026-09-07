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
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { findTaskResource, TASK_RESOURCES, type TaskResourceDescriptor } from "../client/resource-registry.js";
import { enumerateAssets, selectAssets, SelectionError, type Asset, type AssetKind } from "../internal/artifacts.js";
import { emitResult, openCommand, saveRawJson, type OpenedCommand } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { downloadAssets, type DownloadedFile } from "../internal/download.js";
import { CliError, UsageError, type Warning } from "../internal/errors.js";
import { safeSegment } from "../internal/paths.js";
import { warning } from "../internal/result.js";
import { buildLocalRuntime, buildRuntime } from "../internal/runtime.js";
import { extractTaskObject } from "../internal/task-view.js";

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
  .action(async (opts: DownloadOpts, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "download", "v1");
    const sources = [opts.taskJson ? "task-json" : null, opts.url ? "url" : null, opts.resource || opts.taskId ? "api" : null].filter(Boolean);
    if (sources.length !== 1) throw new UsageError("provide exactly one source: --task-json <file>, --url <url>, or --resource <id> --task-id <id>");
    if ((opts.resource && !opts.taskId) || (!opts.resource && opts.taskId)) throw new UsageError("--resource and --task-id go together");
    const selectors = [opts.asset?.length ? "asset" : null, opts.modelFormat ? "model-format" : null, opts.kind ? "kind" : null, opts.all ? "all" : null].filter(Boolean);
    if (selectors.length > 1) throw new UsageError(`selectors are mutually exclusive (got ${selectors.map((s) => `--${s}`).join(", ")})`);
    if (opts.withDependencies && opts.geometryOnly) throw new UsageError("--with-dependencies and --geometry-only are mutually exclusive");
    if (opened.flags.output && opts.outputDir) throw new UsageError("--output/-o and --output-dir are mutually exclusive");
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
    const outputDir = opts.outputDir;
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
    await emitResult(opened, null, {
      source: sourceInfo,
      selection: { selected: selected.map((a) => a.key), dependencies: dependencies.map((a) => a.key) },
      downloads: { state: result.complete ? "completed" : "partial", files: result.files, metadata_path: null },
      unknown_urls: enumeration?.unknown_urls ?? [],
      saved_json: savedJson,
      ...(opts.includeRaw ? { raw } : {}),
    }, { warnings });
  });

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
