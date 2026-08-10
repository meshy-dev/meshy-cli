/**
 * Download a completed task's artifacts to the local filesystem.
 *
 * Two target shapes:
 *   1. File path (e.g. `character/front.jpeg`) — used when the task has a
 *      single downloadable artifact (most 2D image tasks). The Content-Type
 *      of the HTTP response is authoritative; if the user-supplied extension
 *      disagrees, the file is saved with the correct extension instead.
 *   2. Directory path (anything without a recognized file extension) — used
 *      when the task emits multiple artifacts (3D models, thumbnails,
 *      textures, animation outputs). Each artifact is named after its role
 *      (model.glb, thumbnail.png, texture_0_base_color.png, ...).
 *
 * A `meta.json` alongside the artifacts records the full task response plus
 * the saved paths for later reference.
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { Task } from "../client/types.js";
import { UsageError } from "./errors.js";
import { logger } from "./logger.js";

/** Extensions sharp can transcode between. */
const CONVERTIBLE_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "tiff", "tif", "avif"]);

export interface Artifact {
  /** Stable slot name ("model_glb", "image_0", "texture_0_base_color", ...) */
  key: string;
  /** Source URL (presigned). */
  url: string;
  /** Expected extension inferred from the slot name (no dot, may be empty). */
  preferredExt: string;
}

export function enumerateArtifacts(task: Task): Artifact[] {
  const out: Artifact[] = [];

  if (task.model_urls) {
    for (const [ext, url] of Object.entries(task.model_urls)) {
      if (typeof url === "string" && url) {
        out.push({ key: `model_${ext}`, url, preferredExt: ext.toLowerCase() });
      }
    }
  }

  if (task.thumbnail_url) {
    out.push({ key: "thumbnail", url: task.thumbnail_url, preferredExt: "png" });
  }

  if (Array.isArray(task.texture_urls)) {
    task.texture_urls.forEach((set, i) => {
      for (const [name, url] of Object.entries(set)) {
        if (typeof url === "string" && url) {
          out.push({ key: `texture_${i}_${name}`, url, preferredExt: "png" });
        }
      }
    });
  }

  if (Array.isArray(task.image_urls)) {
    task.image_urls.forEach((url, i) => {
      if (typeof url === "string" && url) {
        out.push({ key: `image_${i}`, url, preferredExt: "" });
      }
    });
  }

  // Rigging / animate-style endpoints nest outputs under `result`.
  if (task.result && typeof task.result === "object") {
    for (const [key, value] of Object.entries(task.result)) {
      if (typeof value !== "string" || !/^https?:/.test(value)) continue;
      const extMatch = key.match(/_(fbx|glb|usdz|obj|png|jpg|jpeg|webp)_url$/i);
      const preferredExt = extMatch ? extMatch[1]!.toLowerCase() : "";
      out.push({ key, url: value, preferredExt });
    }
  }

  return out;
}

/** Heuristic: does this look like a file path (has an extension) or a dir? */
export function looksLikeFile(path: string): boolean {
  return /\.[A-Za-z0-9]{2,6}$/.test(path);
}

export interface DownloadResult {
  savedFiles: string[];
  metadataPath: string;
}

export async function downloadArtifacts(
  task: Task,
  outputPath: string,
  resource: string,
): Promise<DownloadResult> {
  const artifacts = enumerateArtifacts(task);
  if (artifacts.length === 0) {
    // Report-only tasks (analyze-printability) carry their result in a
    // structured field instead of downloadable files. Persist the full task
    // JSON so `-o` still means "give me the result on disk".
    if (task.printability != null) {
      return saveReportOnly(task, outputPath, resource);
    }
    throw new Error(`task ${task.id} has no downloadable artifacts`);
  }

  if (looksLikeFile(outputPath) && artifacts.length > 1) {
    throw new UsageError(
      `task ${task.id} produced ${artifacts.length} artifacts — '${outputPath}' looks like a file. ` +
        `Pass a directory path for --output instead (e.g. '${stripExt(outputPath)}').`,
    );
  }
  const singleFileMode = looksLikeFile(outputPath);

  // Plan every path we'd write up front so we can bail before any network
  // work when a destination already exists. This prevents silent overwrite
  // of prior runs.
  let targetDir: string;
  const plannedArtifactPaths: string[] = [];
  if (singleFileMode) {
    targetDir = dirname(outputPath) || ".";
    plannedArtifactPaths.push(outputPath);
  } else {
    targetDir = outputPath;
    for (const artifact of artifacts) {
      plannedArtifactPaths.push(join(targetDir, deriveFilename(artifact)));
    }
  }
  // Per-file meta in single-file mode (`-o a.png` → `a_meta.json`) so two
  // outputs can share a directory without trampling each other. Directory
  // mode keeps the plain `meta.json` alongside the artifacts.
  const metadataPath = singleFileMode
    ? `${stripExt(outputPath)}_meta.json`
    : join(targetDir, "meta.json");

  const existing = [...plannedArtifactPaths, metadataPath].filter((p) => existsSync(p));
  if (existing.length > 0) {
    throw new UsageError(
      `refusing to overwrite existing file(s):\n  ${existing.join("\n  ")}\n` +
        `(delete them or choose a different --output path to rerun)`,
    );
  }

  mkdirSync(targetDir, { recursive: true });
  const saved: string[] = [];
  if (singleFileMode) {
    saved.push(await downloadArtifact(artifacts[0]!, outputPath));
  } else {
    for (const artifact of artifacts) {
      const targetPath = join(targetDir, deriveFilename(artifact));
      saved.push(await downloadArtifact(artifact, targetPath));
    }
  }
  writeMeta(task, resource, metadataPath, saved);
  return { savedFiles: saved, metadataPath };
}

function deriveFilename(artifact: Artifact): string {
  if (artifact.key.startsWith("model_")) {
    const ext = artifact.key.slice("model_".length);
    return `model.${ext}`;
  }
  if (artifact.key === "thumbnail") {
    return `thumbnail.${artifact.preferredExt || "png"}`;
  }
  // Keys from `result.*_url` (animate / rigging) arrive like
  // "animation_glb_url". The trailing "_url" is structural; the real name
  // is what precedes it.
  const stem = artifact.key.replace(/_url$/, "");
  // Unknown extension → leave it off; downloadArtifact will append the
  // content-type-derived extension so we don't emit a bogus `.bin`.
  return artifact.preferredExt ? `${stem}.${artifact.preferredExt}` : stem;
}

function stripExt(path: string): string {
  const ext = extname(path);
  return ext ? path.slice(0, -ext.length) : path;
}

async function downloadArtifact(artifact: Artifact, targetPath: string): Promise<string> {
  logger.debug(`GET ${artifact.url}`);
  const resp = await fetch(artifact.url);
  if (!resp.ok) {
    throw new Error(`download failed for ${artifact.key} (${resp.status} ${resp.statusText})`);
  }
  if (!resp.body) throw new Error(`empty body for ${artifact.url}`);

  const contentType = resp.headers.get("content-type") ?? "";
  const actualExt = extFromContentType(contentType);
  const requestedExt = extname(targetPath).slice(1).toLowerCase();
  mkdirSync(dirname(targetPath), { recursive: true });

  // No extension requested (e.g. unknown-format image artifact) — pick one
  // from the content-type so the file has a reasonable suffix.
  if (!requestedExt && actualExt) {
    const finalPath = `${targetPath}.${actualExt}`;
    await pipeline(
      Readable.fromWeb(resp.body as unknown as import("node:stream/web").ReadableStream),
      createWriteStream(finalPath),
    );
    return finalPath;
  }

  // Fast path: extensions agree (or the server didn't specify one) — stream through.
  if (
    !actualExt ||
    !requestedExt ||
    actualExt === requestedExt ||
    extEquivalent(actualExt, requestedExt)
  ) {
    await pipeline(
      Readable.fromWeb(resp.body as unknown as import("node:stream/web").ReadableStream),
      createWriteStream(targetPath),
    );
    return targetPath;
  }

  // Extensions differ. Buffer the body so we can either transcode or rename.
  const buffer = Buffer.from(await resp.arrayBuffer());

  // Both sides are image formats sharp understands — convert.
  if (CONVERTIBLE_IMAGE_EXTS.has(actualExt) && CONVERTIBLE_IMAGE_EXTS.has(requestedExt)) {
    logger.debug(`converting ${actualExt} → ${requestedExt} for ${artifact.key}`);
    await convertImage(buffer, requestedExt, targetPath);
    return targetPath;
  }

  // Can't convert safely — save with the true extension so the file isn't a lie.
  const base = targetPath.slice(0, targetPath.length - (requestedExt.length + 1));
  const fallback = `${base}.${actualExt}`;
  logger.warn(
    `extension mismatch for ${artifact.key}: requested .${requestedExt}, got ${contentType || "?"}; ` +
      `cannot transcode ${actualExt} → ${requestedExt}, saving as ${fallback}`,
  );
  await pipeline(Readable.from(buffer), createWriteStream(fallback));
  return fallback;
}

async function convertImage(buffer: Buffer, targetExt: string, targetPath: string): Promise<void> {
  const pipe = sharp(buffer);
  switch (targetExt) {
    case "jpg":
    case "jpeg":
      await pipe.jpeg({ quality: 92 }).toFile(targetPath);
      return;
    case "png":
      await pipe.png().toFile(targetPath);
      return;
    case "webp":
      await pipe.webp({ quality: 92 }).toFile(targetPath);
      return;
    case "gif":
      await pipe.gif().toFile(targetPath);
      return;
    case "tiff":
    case "tif":
      await pipe.tiff().toFile(targetPath);
      return;
    case "avif":
      await pipe.avif({ quality: 60 }).toFile(targetPath);
      return;
    default:
      throw new Error(`unsupported image target extension: ${targetExt}`);
  }
}

function extFromContentType(ct: string): string {
  const base = ct.split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/tiff": "tiff",
    "image/bmp": "bmp",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/obj": "obj",
    "model/vnd.usdz+zip": "usdz",
    "model/stl": "stl",
    "model/3mf": "3mf",
    "application/json": "json",
    "video/mp4": "mp4",
  };
  return map[base] ?? "";
}

function extEquivalent(a: string, b: string): boolean {
  const groups = [new Set(["jpg", "jpeg"]), new Set(["tif", "tiff"])];
  return groups.some((g) => g.has(a) && g.has(b));
}

/**
 * Save a no-artifact task (e.g. analyze-printability) to disk. Two layouts:
 *   - `-o report.json` (or any .json file): write the full task object there;
 *     no sidecar (the file IS the report).
 *   - `-o some/dir/` (or any non-file path): write `meta.json` inside,
 *     matching the directory-mode layout used elsewhere.
 * Other single-file extensions are rejected — the data is JSON, lying about
 * the extension would be worse than a clear error.
 */
function saveReportOnly(task: Task, outputPath: string, resource: string): DownloadResult {
  const singleFileMode = looksLikeFile(outputPath);
  if (singleFileMode) {
    const ext = extname(outputPath).slice(1).toLowerCase();
    if (ext !== "json") {
      throw new UsageError(
        `${resource} produces a JSON report — pass '-o <path>.json' or a directory path (got '${outputPath}').`,
      );
    }
    if (existsSync(outputPath)) {
      throw new UsageError(
        `refusing to overwrite existing file:\n  ${outputPath}\n` +
          `(delete it or choose a different --output path to rerun)`,
      );
    }
    mkdirSync(dirname(outputPath) || ".", { recursive: true });
    writeFileSync(
      outputPath,
      `${JSON.stringify({ resource, task, downloaded_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return { savedFiles: [], metadataPath: outputPath };
  }
  const metadataPath = join(outputPath, "meta.json");
  if (existsSync(metadataPath)) {
    throw new UsageError(
      `refusing to overwrite existing file:\n  ${metadataPath}\n` +
        `(delete it or choose a different --output path to rerun)`,
    );
  }
  mkdirSync(outputPath, { recursive: true });
  writeMeta(task, resource, metadataPath, []);
  return { savedFiles: [], metadataPath };
}

function writeMeta(task: Task, resource: string, path: string, savedFiles: string[]): void {
  const meta = {
    resource,
    task,
    saved_files: savedFiles,
    downloaded_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
