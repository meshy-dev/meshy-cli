/**
 * Media inputs: turn what the user typed into what the API accepts.
 *
 * Accepted for every declared media field (see resource-registry mediaFields):
 *   - http(s) URLs — preflighted with an unauthenticated HEAD (GET fallback,
 *     aborted right after the headers) so unreachable sources fail before a
 *     billable POST. The API credential is never attached to a preflight.
 *   - data: URIs — validated (base64, sane MIME, size cap) and passed through.
 *   - Local file paths (absolute or relative to cwd) — must be regular files
 *     under the size cap and of an accepted format; read, MIME-sniffed and
 *     inlined as data URIs.
 *
 * Normalisation runs on the *final merged payload* (defaults < --data <
 * flags), so a path inside `--data '{"texture_image_url":"./tex.png"}'` is
 * handled exactly like the typed flag. Only fields the resource declares are
 * touched — no string that merely looks like a path is ever read.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import type { MediaField, MediaKind } from "../client/resource-registry.js";
import { UsageError } from "./errors.js";
import { logger } from "./logger.js";
import { USER_AGENT } from "./user-agent.js";

export const DEFAULT_MEDIA_LIMITS = {
  /** 50 MiB — an engineering default, not a Meshy product limit. */
  maxFileBytes: 50 * 1024 * 1024,
  preflightTimeoutMs: 10_000,
} as const;

export type MediaLimits = { maxFileBytes: number; preflightTimeoutMs: number };

export interface NormalizeOptions {
  cwd?: string;
  limits?: Partial<MediaLimits>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface NormalizedMedia {
  field: string;
  index: number | null;
  source: "url" | "data-uri" | "local-file";
  mime: string | null;
  bytes: number | null;
}

/** camelCase option names that hold image inputs (legacy flag-level API). */
export const IMAGE_FIELDS = {
  scalar: [
    "imageUrl",       // image-to-3d
    "imageStyleUrl",  // retexture
    "textureImageUrl", // text-to-3d refine / rigging
  ] as const,
  list: [
    "imageUrls",            // multi-image-to-3d
    "referenceImageUrls",   // image-to-image
    "multiviewImageUrls",   // retexture
  ] as const,
};

/** camelCase option names that hold 3D model inputs (legacy flag-level API). */
export const MODEL_FIELDS = {
  scalar: ["modelUrl"] as const,  // remesh, retexture, rigging, uv-unwrap …
  list: [] as const,
};

export async function resolveImageFields(opts: Record<string, unknown>, o: NormalizeOptions = {}): Promise<void> {
  await resolveGroup(opts, IMAGE_FIELDS, "image", o);
}

export async function resolveModelFields(opts: Record<string, unknown>, o: NormalizeOptions = {}): Promise<void> {
  await resolveGroup(opts, MODEL_FIELDS, "model", o);
}

async function resolveGroup(
  opts: Record<string, unknown>,
  fields: { scalar: readonly string[]; list: readonly string[] },
  kind: MediaKind,
  o: NormalizeOptions,
): Promise<void> {
  for (const key of fields.scalar) {
    const v = opts[key];
    if (typeof v === "string" && v) {
      opts[key] = (await resolveOne(v, `--${toFlag(key)}`, kind, undefined, o)).value;
    }
  }
  for (const key of fields.list) {
    const v = opts[key];
    if (Array.isArray(v) && v.length > 0) {
      const resolved: string[] = [];
      for (const entry of v) {
        if (typeof entry === "string" && entry) {
          resolved.push((await resolveOne(entry, `--${toFlag(key)}`, kind, undefined, o)).value);
        }
      }
      opts[key] = resolved;
    }
  }
}

function toFlag(camel: string): string {
  return camel.replace(/([A-Z])/g, "-$1").toLowerCase();
}

function flagForField(path: string): string {
  return `--${path.replace(/_/g, "-")}`;
}

/**
 * Normalise every declared media field of a final payload in place-free
 * fashion (a new object is returned). Non-string values are left untouched
 * and reported by the endpoint schema instead.
 */
export async function normalizeMediaPayload(
  payload: Record<string, unknown>,
  fields: readonly MediaField[],
  o: NormalizeOptions = {},
): Promise<{ payload: Record<string, unknown>; media: NormalizedMedia[] }> {
  const out: Record<string, unknown> = { ...payload };
  const media: NormalizedMedia[] = [];
  for (const field of fields) {
    const value = out[field.path];
    if (value === undefined || value === null) continue;
    const label = flagForField(field.path);
    if (field.many) {
      if (!Array.isArray(value)) continue;
      const resolved: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const entry = value[i];
        if (typeof entry !== "string" || !entry) {
          resolved.push(entry);
          continue;
        }
        const r = await resolveOne(entry, `${label}[${i}]`, field.kind, field.formats, o);
        resolved.push(r.value);
        media.push({ field: field.path, index: i, source: r.source, mime: r.mime, bytes: r.bytes });
      }
      out[field.path] = resolved;
    } else if (typeof value === "string" && value) {
      const r = await resolveOne(value, label, field.kind, field.formats, o);
      out[field.path] = r.value;
      media.push({ field: field.path, index: null, source: r.source, mime: r.mime, bytes: r.bytes });
    }
  }
  return { payload: out, media };
}

interface Resolved {
  value: string;
  source: NormalizedMedia["source"];
  mime: string | null;
  bytes: number | null;
}

async function resolveOne(
  input: string,
  flagLabel: string,
  kind: MediaKind,
  formats: readonly string[] | undefined,
  o: NormalizeOptions,
): Promise<Resolved> {
  const limits: MediaLimits = { ...DEFAULT_MEDIA_LIMITS, ...(o.limits ?? {}) };
  if (/^data:/i.test(input)) {
    return validateDataUri(input, flagLabel, kind, formats, limits);
  }
  if (/^https?:\/\//i.test(input)) {
    await preflightUrl(input, flagLabel, limits, o);
    return { value: input, source: "url", mime: null, bytes: null };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new UsageError(`${flagLabel}: only http(s) URLs, data: URIs and local file paths are accepted (got ${input.split(":")[0]}: URL)`);
  }
  return loadLocalFile(input, flagLabel, kind, formats, limits, o.cwd ?? process.cwd());
}

const DATA_URI_RE = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)((?:;[a-z0-9-]+=[^;,]*)*)(;base64)?,(.*)$/is;

function validateDataUri(
  input: string,
  flagLabel: string,
  kind: MediaKind,
  formats: readonly string[] | undefined,
  limits: MediaLimits,
): Resolved {
  const m = DATA_URI_RE.exec(input);
  if (!m) throw new UsageError(`${flagLabel}: malformed data: URI (expected data:<mime>;base64,<payload>)`);
  const mime = m[1]!.toLowerCase();
  const isBase64 = Boolean(m[3]);
  const body = m[4] ?? "";
  if (!isBase64) throw new UsageError(`${flagLabel}: data: URI must be base64-encoded`);
  if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) throw new UsageError(`${flagLabel}: data: URI payload is not valid base64`);
  const bytes = Math.floor((body.replace(/\s+/g, "").length * 3) / 4);
  if (bytes > limits.maxFileBytes) {
    throw new UsageError(`${flagLabel}: inline data is ${bytes} bytes, above the ${limits.maxFileBytes}-byte limit`);
  }
  if (kind === "image" && !mime.startsWith("image/")) {
    throw new UsageError(`${flagLabel}: expected an image data: URI, got ${mime}`);
  }
  if (kind === "model" && !(mime.startsWith("model/") || mime === "application/octet-stream")) {
    throw new UsageError(`${flagLabel}: expected a 3D-model data: URI (model/* or application/octet-stream), got ${mime}`);
  }
  if (formats && formats.length > 0) {
    const ext = extForMime(mime);
    if (!ext || !formats.includes(ext)) {
      throw new UsageError(`${flagLabel}: this field accepts ${formats.join("/")} only (data: URI is ${mime})`);
    }
  }
  return { value: input, source: "data-uri", mime, bytes };
}

async function preflightUrl(url: string, flagLabel: string, limits: MediaLimits, o: NormalizeOptions): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`${flagLabel}: invalid URL ${url}`);
  }
  if (parsed.username || parsed.password) throw new UsageError(`${flagLabel}: URLs with embedded credentials are not accepted`);
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const headers = { "User-Agent": USER_AGENT };
  const timeout = AbortSignal.timeout(limits.preflightTimeoutMs);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  let resp: Response;
  try {
    resp = await fetchImpl(url, { method: "HEAD", redirect: "follow", headers, signal });
    if (resp.status === 405 || resp.status === 501) {
      const controller = new AbortController();
      const getSignal = AbortSignal.any([controller.signal, signal]);
      resp = await fetchImpl(url, { method: "GET", redirect: "follow", headers, signal: getSignal });
      controller.abort();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (timeout.aborted) throw new UsageError(`${flagLabel}: preflight of ${url} timed out after ${limits.preflightTimeoutMs}ms`);
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
  kind: MediaKind,
  formats: readonly string[] | undefined,
  limits: MediaLimits,
  cwd: string,
): Resolved {
  const absPath = isAbsolute(input) ? input : resolvePath(cwd, input);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    throw new UsageError(`${flagLabel}: file not found: ${input}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`${flagLabel}: not a regular file: ${input}`);
  }
  if (stat.size > limits.maxFileBytes) {
    throw new UsageError(`${flagLabel}: ${input} is ${stat.size} bytes, above the ${limits.maxFileBytes}-byte limit`);
  }
  const buffer = readFileSync(absPath);
  const mime = kind === "image" ? detectImageMime(buffer, absPath) : detectModelMime(buffer, absPath);
  if (!mime) {
    throw new UsageError(`${flagLabel}: could not detect ${kind === "image" ? "image" : "3d model"} MIME type for ${absPath}`);
  }
  if (formats && formats.length > 0) {
    const ext = extForMime(mime) ?? extname(absPath).slice(1).toLowerCase();
    if (!formats.includes(ext)) {
      throw new UsageError(`${flagLabel}: this field accepts ${formats.join("/")} only (got ${ext || "unknown"})`);
    }
  }
  logger.debug(`${flagLabel} inlined ${absPath} as ${mime} data URI (${buffer.length} bytes)`);
  return { value: `data:${mime};base64,${buffer.toString("base64")}`, source: "local-file", mime, bytes: buffer.length };
}

function extForMime(mime: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/obj": "obj",
    "model/stl": "stl",
    "model/vnd.usdz+zip": "usdz",
    "model/3mf": "3mf",
    "application/octet-stream": "fbx",
  };
  return map[mime] ?? null;
}

export function detectImageMime(buffer: Buffer, path: string): string {
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

export function detectModelMime(buffer: Buffer, path: string): string {
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
