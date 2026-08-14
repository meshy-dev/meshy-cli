/**
 * Resolve user-supplied image and model inputs into something Meshy accepts.
 *
 * Accepted inputs (both images and 3D models):
 *   - http(s) URLs — preflighted with HEAD so unreachable sources fail fast.
 *   - Local file paths (absolute or relative to cwd) — read, MIME-sniffed,
 *     and inlined as data URIs. Users don't have to host files themselves.
 *
 * Base64 data URIs on the command line aren't accepted — the whole point of
 * local-path support is to spare the user from encoding them manually.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { UsageError } from "./errors.js";
import { logger } from "./logger.js";

/** camelCase option names that hold image inputs. */
export const IMAGE_FIELDS = {
  scalar: [
    "imageUrl",       // image-to-3d
    "imageStyleUrl",  // retexture
  ] as const,
  list: [
    "imageUrls",            // multi-image-to-3d
    "referenceImageUrls",   // image-to-image
    "multiviewImageUrls",   // retexture
  ] as const,
};

/** camelCase option names that hold 3D model inputs. */
export const MODEL_FIELDS = {
  scalar: ["modelUrl"] as const,  // remesh, retexture, rigging
  list: [] as const,
};

export async function resolveImageFields(opts: Record<string, unknown>): Promise<void> {
  await resolveGroup(opts, IMAGE_FIELDS, detectImageMime, "image");
}

export async function resolveModelFields(opts: Record<string, unknown>): Promise<void> {
  await resolveGroup(opts, MODEL_FIELDS, detectModelMime, "3d model");
}

type MimeDetector = (buffer: Buffer, path: string) => string;

async function resolveGroup(
  opts: Record<string, unknown>,
  fields: { scalar: readonly string[]; list: readonly string[] },
  detect: MimeDetector,
  kind: string,
): Promise<void> {
  for (const key of fields.scalar) {
    const v = opts[key];
    if (typeof v === "string" && v) {
      opts[key] = await resolveOne(v, `--${toFlag(key)}`, detect, kind);
    }
  }
  for (const key of fields.list) {
    const v = opts[key];
    if (Array.isArray(v) && v.length > 0) {
      const resolved: string[] = [];
      for (const entry of v) {
        if (typeof entry === "string" && entry) {
          resolved.push(await resolveOne(entry, `--${toFlag(key)}`, detect, kind));
        }
      }
      opts[key] = resolved;
    }
  }
}

function toFlag(camel: string): string {
  return camel.replace(/([A-Z])/g, "-$1").toLowerCase();
}

async function resolveOne(
  input: string,
  flagLabel: string,
  detect: MimeDetector,
  kind: string,
): Promise<string> {
  if (input.startsWith("data:")) {
    throw new UsageError(
      `${flagLabel}: data: URIs aren't accepted on the command line — pass a local file path instead`,
    );
  }
  if (/^https?:\/\//i.test(input)) {
    await preflightUrl(input, flagLabel);
    return input;
  }
  return loadLocalFile(input, flagLabel, detect, kind);
}

async function preflightUrl(url: string, flagLabel: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (resp.status === 405 || resp.status === 501) {
      const controller = new AbortController();
      resp = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
      controller.abort();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`${flagLabel}: cannot reach ${url} (${msg})`);
  }
  if (!resp.ok) {
    throw new UsageError(`${flagLabel}: ${url} returned ${resp.status} ${resp.statusText}`);
  }
  logger.debug(`${flagLabel} preflight OK: ${url} (${resp.status})`);
}

function loadLocalFile(
  input: string,
  flagLabel: string,
  detect: MimeDetector,
  kind: string,
): string {
  const absPath = isAbsolute(input) ? input : resolvePath(process.cwd(), input);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    throw new UsageError(`${flagLabel}: file not found: ${input}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`${flagLabel}: not a regular file: ${input}`);
  }
  const buffer = readFileSync(absPath);
  const mime = detect(buffer, absPath);
  if (!mime) {
    throw new UsageError(`${flagLabel}: could not detect ${kind} MIME type for ${absPath}`);
  }
  logger.debug(`${flagLabel} inlined ${absPath} as ${mime} data URI (${buffer.length} bytes)`);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function detectImageMime(buffer: Buffer, path: string): string {
  if (buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) return "image/png";
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
    if (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "image/webp";
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  }
  const ext = extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
  };
  return map[ext] ?? "";
}

function detectModelMime(buffer: Buffer, path: string): string {
  // GLB: magic "glTF" at offset 0
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x67 &&
    buffer[1] === 0x6c &&
    buffer[2] === 0x54 &&
    buffer[3] === 0x46
  ) {
    return "model/gltf-binary";
  }
  // FBX binary: "Kaydara FBX Binary" ASCII signature at offset 0
  if (buffer.length >= 18 && buffer.subarray(0, 18).toString("ascii") === "Kaydara FBX Binary") {
    return "application/octet-stream";
  }
  // Fall back to extension for text formats (obj, gltf, ascii stl) and usdz/3mf.
  const ext = extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    obj: "model/obj",
    fbx: "application/octet-stream",
    stl: "model/stl",
    usdz: "model/vnd.usdz+zip",
    "3mf": "model/3mf",
  };
  return map[ext] ?? "";
}
