/**
 * Asset downloads with explicit boundaries.
 *
 * Every byte that lands on disk goes through `fetchToTemp`: http(s) only, no
 * embedded credentials, no Authorization or Cookie ever attached (asset hosts
 * are not the API), redirects re-validated hop by hop (max 5), private
 * network literals refused (loopback is allowed for local test servers), a
 * hard size cap enforced while streaming, sha256 computed on the way. The
 * temp file lives in the target directory and is published exclusively
 * (`link`), or replaced atomically with --overwrite; the final path — after
 * any MIME-driven extension change — is checked against the authorised root.
 *
 * Two entry points share the core:
 *   downloadArtifacts — the 0.2.0 `-o` behaviour (all artifacts, role-based
 *                       names, meta.json sidecar); output shape unchanged. An
 *                       explicit `root` (the --workspace) confines every path.
 *   downloadAssets    — the selective downloader behind `meshy download` and
 *                       the v1 manifest.
 * Both relink OBJ → MTL → texture references after the set has landed (see
 * material-links.ts), so a saved OBJ loads with the files beside it.
 */

import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { Transform } from "node:stream";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { Task } from "../client/types.js";
import { publishTempFile, tempPathFor, writeJsonFile } from "./atomic-file.js";
import { CliError, UsageError } from "./errors.js";
import { logger } from "./logger.js";
import { isInside, realpathLenient, resolveWithinRoot, safeExtension, safeSegment } from "./paths.js";
import { USER_AGENT } from "./user-agent.js";
import type { Asset } from "./artifacts.js";
import { fileDigest, relinkMaterials, type MaterialLinkReport } from "./material-links.js";

/** Extensions sharp can transcode between. */
const CONVERTIBLE_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "tiff", "tif", "avif"]);

export const DEFAULT_DOWNLOAD_LIMITS = {
  /** 2 GiB — engineering default, not a Meshy limit. */
  maxBytes: 2 * 1024 * 1024 * 1024,
  timeoutMs: 300_000,
  maxRedirects: 5,
} as const;

export interface DownloadLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export interface DownloadPolicy {
  /** Plain http is accepted only for loopback hosts (local test servers). */
  allowHttpLoopback: boolean;
  /** Private-network literals (10/8, 172.16/12, 192.168/16, link-local) are refused unless set. */
  allowPrivateNetwork: boolean;
}

export const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = { allowHttpLoopback: true, allowPrivateNetwork: false };

export interface FetchOptions {
  limits?: Partial<DownloadLimits>;
  policy?: Partial<DownloadPolicy>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchedFile {
  tmpPath: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
  finalUrl: string;
  status: number;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function isPrivateLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (h.includes(":")) {
    if (/^f[cd]/.test(h)) return true; // fc00::/7
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10
    return false;
  }
  return false;
}

/** Validate an asset URL against the policy; throws CliError (local_io) with a clear reason. */
export function validateAssetUrl(raw: string, policy: DownloadPolicy, label = "asset URL"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError({ code: "validation", message: `${label} is not a valid URL: ${raw}` });
  }
  if (url.username || url.password) throw new CliError({ code: "validation", message: `${label} carries embedded credentials; refused` });
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError({ code: "validation", message: `${label} must be http(s), got ${url.protocol}` });
  }
  const loopback = isLoopbackHost(url.hostname);
  if (!loopback && isPrivateLiteral(url.hostname) && !policy.allowPrivateNetwork) {
    throw new CliError({ code: "validation", message: `${label} points at a private network address (${url.hostname}); refused` });
  }
  if (url.protocol === "http:" && !(loopback && policy.allowHttpLoopback)) {
    throw new CliError({ code: "validation", message: `${label} uses plain http to ${url.hostname}; only https (or http to a loopback test host) is accepted` });
  }
  return url;
}

/**
 * Stream a URL into a temp file next to `target`, following at most
 * `maxRedirects` re-validated redirects, without any credential header.
 */
export async function fetchToTemp(rawUrl: string, target: string, opts: FetchOptions = {}): Promise<FetchedFile> {
  const limits: DownloadLimits = { ...DEFAULT_DOWNLOAD_LIMITS, ...(opts.limits ?? {}) };
  const policy: DownloadPolicy = { ...DEFAULT_DOWNLOAD_POLICY, ...(opts.policy ?? {}) };
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  mkdirSync(dirname(target), { recursive: true });
  const tmpPath = tempPathFor(target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`download timed out after ${limits.timeoutMs}ms`)), limits.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;

  let url = validateAssetUrl(rawUrl, policy);
  try {
    let resp: Response | null = null;
    for (let hop = 0; ; hop++) {
      let r: Response;
      try {
        r = await fetchImpl(url, { method: "GET", redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, Accept: "*/*" } });
      } catch (err) {
        if (opts.signal?.aborted) throw new CliError({ code: "interrupted", message: `download of ${redact(url)} interrupted` });
        if (controller.signal.aborted) throw new CliError({ code: "network", message: `download of ${redact(url)} timed out after ${limits.timeoutMs}ms` });
        throw new CliError({ code: "network", message: `download of ${redact(url)} failed: ${err instanceof Error ? err.message : String(err)}`, cause: err });
      }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await r.body?.cancel().catch(() => undefined);
        if (!loc) throw new CliError({ code: "network", message: `redirect from ${redact(url)} without a Location header` });
        if (hop >= limits.maxRedirects) throw new CliError({ code: "network", message: `too many redirects downloading ${redact(url)}` });
        const next = new URL(loc, url);
        if (url.protocol === "https:" && next.protocol === "http:") {
          throw new CliError({ code: "validation", message: `refusing https → http downgrade redirect from ${redact(url)}` });
        }
        url = validateAssetUrl(next.href, policy, "redirect target");
        continue;
      }
      resp = r;
      break;
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      throw new CliError({
        code: resp.status === 404 ? "not_found" : resp.status === 401 || resp.status === 403 || resp.status === 410 ? "validation" : "network",
        message: `download failed for ${redact(url)} (HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""})`,
        httpStatus: resp.status,
        details: { expired_or_denied: resp.status === 401 || resp.status === 403 || resp.status === 410 },
      });
    }
    const declared = resp.headers.get("content-length");
    if (declared && Number(declared) > limits.maxBytes) {
      await resp.body?.cancel().catch(() => undefined);
      throw new CliError({ code: "local_io", message: `asset ${redact(url)} declares ${declared} bytes, above the ${limits.maxBytes}-byte limit` });
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const source = resp.body ? Readable.fromWeb(resp.body as unknown as import("node:stream/web").ReadableStream) : Readable.from([]);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > limits.maxBytes) {
          cb(new CliError({ code: "local_io", message: `asset ${redact(url)} exceeds the ${limits.maxBytes}-byte limit` }));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, counter, createWriteStream(tmpPath, { mode: 0o600 }));
    } catch (err) {
      removeQuietly(tmpPath);
      if (err instanceof CliError) throw err;
      if (opts.signal?.aborted) throw new CliError({ code: "interrupted", message: `download of ${redact(url)} interrupted` });
      if (controller.signal.aborted) throw new CliError({ code: "network", message: `download of ${redact(url)} timed out after ${limits.timeoutMs}ms` });
      throw new CliError({ code: "network", message: `download of ${redact(url)} failed mid-stream: ${err instanceof Error ? err.message : String(err)}`, cause: err });
    }
    return { tmpPath, bytes, sha256: hash.digest("hex"), contentType: resp.headers.get("content-type"), finalUrl: url.href, status: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

/** URL without its query string — signed parameters never reach logs or messages. */
export function redact(url: URL | string): string {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* gone */
  }
}

// ---------------------------------------------------------------------------
// Content checks
// ---------------------------------------------------------------------------

export function extFromContentType(ct: string | null): string {
  if (!ct) return "";
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
    "application/zip": "zip",
    "application/json": "json",
    "video/mp4": "mp4",
  };
  return map[base] ?? "";
}

function extEquivalent(a: string, b: string): boolean {
  const groups = [new Set(["jpg", "jpeg"]), new Set(["tif", "tiff"])];
  return groups.some((g) => g.has(a) && g.has(b));
}

function readHead(path: string, n = 16): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reject bodies that cannot be what the asset claims: an HTML error page
 * served as a model, a non-GLB under .glb, a non-ZIP under .zip.
 */
export function validateContent(tmpPath: string, expectedFormat: string | null, kind: Asset["kind"], contentType: string | null): void {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const head = readHead(tmpPath, 16);
  const text = head.toString("latin1").toLowerCase();
  if ((kind === "model" || kind === "rig" || kind === "animation" || kind === "motion") && (ct === "text/html" || text.startsWith("<!doctype") || text.startsWith("<html"))) {
    throw new CliError({ code: "validation", message: "asset body is an HTML page, not a model file (the download URL may have expired)" });
  }
  if (expectedFormat === "glb" && !(head.length >= 4 && head.subarray(0, 4).toString("ascii") === "glTF")) {
    throw new CliError({ code: "validation", message: "asset saved under .glb does not start with the glTF magic; refusing to keep an invalid GLB" });
  }
  if (expectedFormat === "zip" && !(head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b)) {
    throw new CliError({ code: "validation", message: "asset expected to be a ZIP container does not start with the PK magic" });
  }
}

// ---------------------------------------------------------------------------
// Selective downloader (meshy download, v1)
// ---------------------------------------------------------------------------

export interface DownloadedFile {
  key: string;
  path: string;
  relative_path: string | null;
  bytes: number;
  sha256: string;
  content_type: string | null;
  format: string | null;
  container_format: string | null;
  extracted: boolean | null;
  status: "written" | "failed" | "skipped";
  error: string | null;
  publish_method: string | null;
  /** True when the file's material references were rewritten to the saved names (OBJ/MTL only). */
  relinked: boolean;
}

export interface DownloadAssetsOptions extends FetchOptions {
  /** Directory mode. */
  targetDir?: string;
  /** Single-file mode (exactly one asset). */
  targetFile?: string;
  overwrite?: boolean;
  /** Authorised root every final path must stay inside. */
  root: string;
  /** Validate magic/content-type for models (the legacy wrapper turns this off). */
  validateContent?: boolean;
  /** Bounded URL refresh hook (API source): returns fresh URLs by key or null. */
  refreshUrls?: () => Promise<Map<string, string> | null>;
  onFile?: (file: DownloadedFile) => void;
}

export interface DownloadAssetsResult {
  files: DownloadedFile[];
  /** True when every requested asset was written. */
  complete: boolean;
  warnings: Array<{ code: string; message: string }>;
  /** OBJ/MTL/texture reference report when the set contained a text OBJ. */
  materialLinks: MaterialLinkReport | null;
}

function plannedName(asset: Asset, targetFile: string | undefined): string {
  if (targetFile) return basename(targetFile);
  return asset.filename;
}

/**
 * Download the given assets one by one. Each file is published on its own;
 * a failure stops the loop and the result lists what was written so far.
 * No rollback deletes anything the user already had.
 */
export async function downloadAssets(assets: readonly Asset[], opts: DownloadAssetsOptions): Promise<DownloadAssetsResult> {
  if (opts.targetFile && assets.length !== 1) {
    throw new UsageError(`--output names a single file but ${assets.length} assets were selected; pass --output-dir <dir> instead`);
  }
  if (!opts.targetFile && !opts.targetDir) throw new UsageError("an output file or directory is required");
  const files: DownloadedFile[] = [];
  const warnings: Array<{ code: string; message: string }> = [];
  const dir = opts.targetFile ? dirname(resolvePath(opts.targetFile)) : resolvePath(opts.targetDir!);
  const rootReal = realpathLenient(opts.root);
  // The directory and every planned leaf must be inside the root (and no
  // symlink) before anything at all is created — a refused target must not
  // leave a directory behind; the check repeats after any MIME-driven rename.
  resolveWithinRoot(dir, rootReal, { label: "output directory" });
  for (const asset of assets) {
    resolveWithinRoot(join(dir, plannedName(asset, opts.targetFile)), rootReal, { label: "planned download path" });
  }
  mkdirSync(dir, { recursive: true });

  let refreshed: Map<string, string> | null | undefined;
  for (const asset of assets) {
    const planned = join(dir, plannedName(asset, opts.targetFile));
    let entry: DownloadedFile;
    try {
      if (asset.kind === "report") {
        const target = resolveWithinRoot(planned.endsWith(".json") ? planned : `${planned}.json`, rootReal, { label: "report path" }).path;
        const res = writeJsonFile(target, asset.report, { overwrite: opts.overwrite ?? false });
        const bytes = statSync(target).size;
        entry = { key: asset.key, path: target, relative_path: rel(rootReal, target), bytes, sha256: createHash("sha256").update(readFileSync(target)).digest("hex"), content_type: "application/json", format: "json", container_format: null, extracted: null, status: "written", error: null, publish_method: res.method, relinked: false };
      } else {
        if (!asset.url) throw new CliError({ code: "validation", message: `asset ${asset.key} has no URL` });
        let url = asset.url;
        let fetched: FetchedFile;
        try {
          fetched = await fetchToTemp(url, planned, opts);
        } catch (err) {
          const expired = err instanceof CliError && (err.details as { expired_or_denied?: boolean } | undefined)?.expired_or_denied;
          if (expired && opts.refreshUrls) {
            if (refreshed === undefined) refreshed = await opts.refreshUrls();
            const fresh = refreshed?.get(asset.key);
            if (fresh && fresh !== url) {
              warnings.push({ code: "asset_url_refreshed", message: `${asset.key}: signed URL rejected; refreshed once from the task` });
              url = fresh;
              fetched = await fetchToTemp(url, planned, opts);
            } else throw err;
          } else throw err;
        }
        entry = await placeFetched(asset, fetched, planned, rootReal, opts, warnings);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: DownloadedFile = { key: asset.key, path: planned, relative_path: rel(rootReal, planned), bytes: 0, sha256: "", content_type: null, format: asset.format, container_format: asset.containerFormat, extracted: null, status: "failed", error: message, publish_method: null, relinked: false };
      files.push(failed);
      opts.onFile?.(failed);
      const code = err instanceof CliError ? err.code : "local_io";
      throw new CliError({
        code: code === "interrupted" ? "interrupted" : code === "network" || code === "not_found" || code === "validation" ? code : "local_io",
        message: `${asset.key}: ${message}`,
        httpStatus: err instanceof CliError ? err.httpStatus : null,
        result: { downloads: { state: files.some((f) => f.status === "written") ? "partial" : "failed", files, metadata_path: null } },
        warnings,
        cause: err,
      });
    }
    files.push(entry);
    opts.onFile?.(entry);
  }
  const sources = new Map(assets.map((a) => [a.key, a.url ? basenameOfUrl(a.url) : null] as const));
  let materialLinks: MaterialLinkReport | null = null;
  try {
    if (opts.signal?.aborted) throw new CliError({ code: "interrupted", message: "interrupted before the material references were relinked" });
    materialLinks = await relinkWritten(files, warnings, sources, opts.signal);
  } catch (err) {
    // Every file is on disk; say so, with the bytes actually there.
    redigest(files);
    const interrupted = (err instanceof CliError && err.code === "interrupted") || Boolean(opts.signal?.aborted);
    throw new CliError({
      code: interrupted ? "interrupted" : err instanceof CliError ? err.code : "local_io",
      message: `${files.length} file(s) were written but relinking the material references ${interrupted ? "was interrupted" : "failed"}: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: err instanceof CliError ? err.httpStatus : null,
      result: { downloads: { state: "partial", files, metadata_path: null, failed_step: "relink" } },
      warnings,
      cause: err,
    });
  }
  return { files, complete: files.every((f) => f.status === "written"), warnings, materialLinks };
}

/** Re-take each committed file's digest from disk (a relink may have rewritten it before a later step failed). */
function redigest(files: Array<{ status: string; path: string; bytes: number; sha256: string; relinked: boolean }>): void {
  for (const f of files) {
    if (f.status !== "written") continue;
    try {
      const d = fileDigest(f.path);
      if (d.sha256 !== f.sha256) f.relinked = true;
      f.bytes = d.bytes;
      f.sha256 = d.sha256;
    } catch {
      /* keep the recorded digest */
    }
  }
}

/** Last path segment of an asset URL (decoded), the name the server knew the file by; null when unparseable. */
export function basenameOfUrl(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let name = segment;
    try {
      name = decodeURIComponent(segment);
    } catch {
      /* keep the raw segment */
    }
    return name || null;
  } catch {
    return null;
  }
}

/** After the set landed: point OBJ → MTL → textures at the saved names and re-take the digests of rewritten files. */
async function relinkWritten(files: DownloadedFile[], warnings: Array<{ code: string; message: string }>, sources: Map<string, string | null>, signal: AbortSignal | undefined): Promise<MaterialLinkReport | null> {
  const written = files.filter((f) => f.status === "written" && f.container_format === null);
  const links = await relinkMaterials(written.map((f) => ({ key: f.key, path: f.path, sourceName: sources.get(f.key) ?? null })), { signal });
  if (!links) return null;
  for (const path of links.rewritten) {
    const entry = files.find((f) => f.path === path);
    if (!entry) continue;
    const digest = fileDigest(path);
    entry.bytes = digest.bytes;
    entry.sha256 = digest.sha256;
    entry.relinked = true;
  }
  warnings.push(...links.warnings);
  return links;
}

function rel(root: string, path: string): string | null {
  const r = relative(root, path);
  return isInside(root, path) ? r.split(/[\\/]/).join("/") : null;
}

/** Reconcile the extension with the real content type, validate, and publish exclusively. */
async function placeFetched(
  asset: Asset,
  fetched: FetchedFile,
  planned: string,
  rootReal: string,
  opts: DownloadAssetsOptions,
  warnings: Array<{ code: string; message: string }>,
): Promise<DownloadedFile> {
  const actualExt = extFromContentType(fetched.contentType);
  const requestedExt = safeExtension(extname(planned));
  let finalPath = planned;
  let tmp = fetched.tmpPath;
  let bytes = fetched.bytes;
  let sha = fetched.sha256;

  if (asset.containerFormat === "zip") {
    // Bundles are delivered as ZIP whatever the content-type says.
    if (requestedExt !== "zip") finalPath = `${stripExt(planned)}.zip`;
  } else if (!requestedExt && actualExt) {
    finalPath = `${planned}.${actualExt}`;
  } else if (requestedExt && actualExt && requestedExt !== actualExt && !extEquivalent(requestedExt, actualExt)) {
    if (CONVERTIBLE_IMAGE_EXTS.has(actualExt) && CONVERTIBLE_IMAGE_EXTS.has(requestedExt)) {
      const converted = `${tmp}.conv`;
      await convertImage(readFileSync(tmp), requestedExt, converted);
      removeQuietly(tmp);
      tmp = converted;
      bytes = statSync(converted).size;
      sha = createHash("sha256").update(readFileSync(converted)).digest("hex");
      warnings.push({ code: "image_transcoded", message: `${asset.key}: server sent ${actualExt}, transcoded to ${requestedExt} as requested` });
    } else {
      finalPath = `${stripExt(planned)}.${actualExt}`;
      warnings.push({ code: "extension_corrected", message: `${asset.key}: requested .${requestedExt} but the server sent ${fetched.contentType ?? "unknown"}; saved as ${basename(finalPath)}` });
    }
  }

  const expectedFormat = asset.containerFormat === "zip" ? "zip" : safeExtension(extname(finalPath)) || null;
  if (opts.validateContent !== false) {
    try {
      validateContent(tmp, expectedFormat, asset.kind, fetched.contentType);
    } catch (err) {
      removeQuietly(tmp);
      throw err;
    }
  }

  // The final path — possibly renamed — must still be inside the root, and
  // must not be a symlink or an existing file (unless --overwrite).
  let resolved: string;
  try {
    resolved = resolveWithinRoot(finalPath, rootReal, { label: "final download path" }).path;
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  const res = publishTempFile(tmp, resolved, { overwrite: opts.overwrite ?? false });
  return {
    key: asset.key,
    path: resolved,
    relative_path: rel(rootReal, resolved),
    bytes,
    sha256: sha,
    content_type: fetched.contentType,
    format: asset.containerFormat === "zip" ? "zip" : safeExtension(extname(resolved)) || asset.format,
    container_format: asset.containerFormat,
    extracted: asset.containerFormat ? false : null,
    status: "written",
    error: null,
    publish_method: res.method,
    relinked: false,
  };
}

function stripExt(path: string): string {
  const ext = extname(path);
  return ext ? path.slice(0, -ext.length) : path;
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

// ---------------------------------------------------------------------------
// Legacy `-o` wrapper (0.2.0 layout preserved)
// ---------------------------------------------------------------------------

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

  // Rigging / animate-style endpoints nest outputs under `result`; the
  // bundled walking/running clips live one level deeper.
  if (task.result && typeof task.result === "object") {
    const motionFormat = task.result["motion_format"];
    for (const [key, value] of Object.entries(task.result)) {
      if (key === "basic_animations" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [sub, url] of Object.entries(value as Record<string, unknown>)) {
          if (typeof url !== "string" || !/^https?:/.test(url)) continue;
          const extMatch = sub.match(/_(fbx|glb|usdz|obj|png|jpg|jpeg|webp)_url$/i);
          out.push({ key: `basic_animations_${sub}`, url, preferredExt: extMatch ? extMatch[1]!.toLowerCase() : "" });
        }
        continue;
      }
      if (typeof value !== "string" || !/^https?:/.test(value)) continue;
      const extMatch = key.match(/_(fbx|glb|usdz|obj|png|jpg|jpeg|webp)_url$/i);
      let preferredExt = extMatch ? extMatch[1]!.toLowerCase() : "";
      if (key === "motion_url" && (motionFormat === "fbx" || motionFormat === "bvh")) {
        preferredExt = motionFormat;
      }
      out.push({ key, url: value, preferredExt });
    }
  }

  return out;
}

/** Heuristic: does this look like a file path (has an extension) or a dir? */
export function looksLikeFile(path: string): boolean {
  return /\.[A-Za-z0-9]{2,6}$/.test(path);
}

export interface LegacyDownloadedFile {
  /** Legacy artifact slot ("model_glb", "thumbnail", "texture_0_base_color", …). */
  key: string;
  /** Final absolute path (after any content-type driven rename) — or the planned path for a failed entry. */
  path: string;
  bytes: number;
  sha256: string;
  content_type: string | null;
  status: "written" | "failed";
  error: string | null;
  /** True when the file's material references were rewritten to the saved names. */
  relinked: boolean;
}

export interface DownloadResult {
  savedFiles: string[];
  metadataPath: string;
  /** OBJ/MTL/texture reference report when the artifacts contained a text OBJ. */
  materialLinks: MaterialLinkReport | null;
  /**
   * Per-file manifest in download order. When the download stops early the
   * same list (written files + the failed one) travels on the thrown
   * CliError's `result.downloads`, so nothing already on disk is forgotten.
   */
  files: LegacyDownloadedFile[];
}

export interface DownloadArtifactsOptions {
  /** Authorised root (the --workspace); every directory and file must resolve inside it. Default: the output directory itself. */
  root?: string;
  /** Cooperative cancellation (SIGINT): aborts the in-flight transfer and stops every later download, relink and publish. */
  signal?: AbortSignal;
}

function interruptedBefore(what: string): CliError {
  return new CliError({ code: "interrupted", message: `interrupted before ${what}; nothing further was written` });
}

/**
 * A failure *after* every transfer landed (relink, digest refresh, sidecar).
 * The manifest keeps every committed file with the bytes actually on disk —
 * a relink may already have rewritten some — and names the step that failed;
 * a cooperative interrupt is `interrupted` (130), everything else keeps its class.
 */
function finalisationFailure(step: "relink" | "digest" | "sidecar", err: unknown, files: LegacyDownloadedFile[], signal: AbortSignal | undefined): CliError {
  redigest(files);
  const downloads = { state: "partial", files, metadata_path: null, failed_step: step };
  const written = files.filter((f) => f.status === "written").length;
  const interrupted = (err instanceof CliError && err.code === "interrupted") || Boolean(signal?.aborted);
  const message = `${written} file(s) were written but the ${step} step ${interrupted ? "was interrupted" : "failed"}: ${err instanceof Error ? err.message : String(err)}`;
  if (err instanceof CliError) {
    return new CliError({
      code: interrupted ? "interrupted" : err.code,
      message,
      httpStatus: err.httpStatus,
      retryable: err.retryable,
      recovery: err.recovery,
      hint: err.hint,
      details: err.details,
      warnings: err.warnings,
      result: { ...(err.result ?? {}), downloads },
      cause: err,
    });
  }
  return new CliError({ code: interrupted ? "interrupted" : "local_io", message, result: { downloads }, cause: err });
}

/**
 * Wrap a per-artifact failure so the caller sees what already landed. The
 * original classification (network / not_found / validation / interrupted /
 * local_io, HTTP status, recovery) is kept; only the message names the artifact.
 */
function downloadFailure(artifact: Artifact, err: unknown, files: LegacyDownloadedFile[]): CliError {
  const message = err instanceof Error ? err.message : String(err);
  const downloads = { state: files.some((f) => f.status === "written") ? "partial" : "failed", files, metadata_path: null };
  if (err instanceof CliError) {
    return new CliError({
      code: err.code,
      message: `download failed for ${artifact.key}: ${message}`,
      exitCode: err.exitCode,
      httpStatus: err.httpStatus,
      retryable: err.retryable,
      recovery: err.recovery,
      hint: err.hint,
      details: err.details,
      warnings: err.warnings,
      result: { ...(err.result ?? {}), downloads },
      cause: err,
    });
  }
  return new CliError({ code: "local_io", message: `download failed for ${artifact.key}: ${message}`, result: { downloads }, cause: err });
}

export async function downloadArtifacts(
  task: Task,
  outputPath: string,
  resource: string,
  opts: DownloadArtifactsOptions = {},
): Promise<DownloadResult> {
  const artifacts = enumerateArtifacts(task);
  // An explicit workspace is the root for everything written here — the
  // directory, every planned file and the sidecar — checked before mkdir.
  const workspaceReal = opts.root !== undefined ? realpathLenient(resolvePath(opts.root)) : null;
  if (artifacts.length === 0) {
    // Report-only tasks (analyze-printability) carry their result in a
    // structured field instead of downloadable files. Persist the full task
    // JSON so `-o` still means "give me the result on disk".
    if (task.printability != null) {
      return saveReportOnly(task, outputPath, resource, workspaceReal);
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
  const plan: Array<{ artifact: Artifact; target: string }> = [];
  if (singleFileMode) {
    targetDir = dirname(outputPath) || ".";
    plan.push({ artifact: artifacts[0]!, target: outputPath });
  } else {
    targetDir = outputPath;
    for (const artifact of artifacts) plan.push({ artifact, target: join(targetDir, deriveFilename(artifact)) });
  }
  // Per-file meta in single-file mode (`-o a.png` → `a_meta.json`) so two
  // outputs can share a directory without trampling each other. Directory
  // mode keeps the plain `meta.json` alongside the artifacts.
  const metadataPath = singleFileMode
    ? `${stripExt(outputPath)}_meta.json`
    : join(targetDir, "meta.json");

  const existing = [...plan.map((p) => p.target), metadataPath].filter((p) => existsSync(p));
  if (existing.length > 0) {
    throw new UsageError(
      `refusing to overwrite existing file(s):\n  ${existing.join("\n  ")}\n` +
        `(delete them or choose a different --output path to rerun)`,
    );
  }

  if (workspaceReal) {
    resolveWithinRoot(targetDir, workspaceReal, { label: "output directory" });
    for (const p of [...plan.map((x) => x.target), metadataPath]) resolveWithinRoot(p, workspaceReal, { label: "planned download path" });
  }

  mkdirSync(targetDir, { recursive: true });
  const root = workspaceReal ?? realpathLenient(targetDir);
  const files: LegacyDownloadedFile[] = [];
  const saved: string[] = [];
  for (const { artifact, target } of plan) {
    if (opts.signal?.aborted) throw downloadFailure(artifact, interruptedBefore(`${artifact.key} was downloaded`), files);
    try {
      const placed = await downloadArtifact(artifact, target, root, opts.signal);
      saved.push(placed.path);
      files.push({ key: artifact.key, path: placed.path, bytes: placed.bytes, sha256: placed.sha256, content_type: placed.contentType, status: "written", error: null, relinked: false });
    } catch (err) {
      files.push({ key: artifact.key, path: target, bytes: 0, sha256: "", content_type: null, status: "failed", error: err instanceof Error ? err.message : String(err), relinked: false });
      throw downloadFailure(artifact, err, files);
    }
  }
  // --- Finalisation: relink, refresh digests, publish the sidecar. Every step
  // runs under the same failure handling as the transfers: whatever fails or is
  // interrupted, the manifest still lists every committed file with the bytes
  // actually on disk, and the sidecar is published like an asset (root re-proven
  // at publication, symlink refused, exclusive — never truncating a file that
  // appeared since the preflight).
  const linkables = plan.map((p, i) => ({ key: p.artifact.key, path: resolvePath(saved[i]!), sourceName: basenameOfUrl(p.artifact.url) }));
  let step: "relink" | "digest" | "sidecar" = "relink";
  let materialLinks: MaterialLinkReport | null = null;
  try {
    if (opts.signal?.aborted) throw interruptedBefore("the material references were relinked");
    materialLinks = await relinkMaterials(linkables, { signal: opts.signal });
    step = "digest";
    if (materialLinks) {
      for (const path of materialLinks.rewritten) {
        const entry = files.find((f) => resolvePath(f.path) === path);
        if (!entry) continue;
        const digest = fileDigest(path);
        entry.bytes = digest.bytes;
        entry.sha256 = digest.sha256;
        entry.relinked = true;
      }
      for (const w of materialLinks.warnings) logger.warn(w.message);
    }
    step = "sidecar";
    if (opts.signal?.aborted) throw interruptedBefore("the sidecar was written");
    writeMeta(task, resource, metadataPath, saved, root);
  } catch (err) {
    throw finalisationFailure(step, err, files, opts.signal);
  }
  return { savedFiles: saved, metadataPath, materialLinks, files };
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

interface PlacedArtifact {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
}

/** Fetch one artifact into place. Errors keep their class: a CliError from the fetch/publish core is rethrown untouched. */
async function downloadArtifact(artifact: Artifact, targetPath: string, root: string, signal: AbortSignal | undefined): Promise<PlacedArtifact> {
  logger.debug(`GET ${redact(artifact.url)}`);
  const fetched = await fetchToTemp(artifact.url, targetPath, { signal });
  const actualExt = extFromContentType(fetched.contentType);
  const requestedExt = extname(targetPath).slice(1).toLowerCase();
  let finalPath = targetPath;
  let tmp = fetched.tmpPath;
  let bytes = fetched.bytes;
  let sha = fetched.sha256;

  try {
    if (!requestedExt && actualExt) {
      // No extension requested (e.g. unknown-format image artifact) — pick one
      // from the content-type so the file has a reasonable suffix.
      finalPath = `${targetPath}.${actualExt}`;
    } else if (actualExt && requestedExt && actualExt !== requestedExt && !extEquivalent(actualExt, requestedExt)) {
      if (CONVERTIBLE_IMAGE_EXTS.has(actualExt) && CONVERTIBLE_IMAGE_EXTS.has(requestedExt)) {
        // Both sides are image formats sharp understands — convert.
        logger.debug(`converting ${actualExt} → ${requestedExt} for ${artifact.key}`);
        const converted = `${tmp}.conv`;
        await convertImage(readFileSync(tmp), requestedExt, converted);
        removeQuietly(tmp);
        tmp = converted;
        const digest = fileDigest(converted);
        bytes = digest.bytes;
        sha = digest.sha256;
      } else {
        // Can't convert safely — save with the true extension so the file isn't a lie.
        finalPath = `${targetPath.slice(0, targetPath.length - (requestedExt.length + 1))}.${actualExt}`;
        logger.warn(
          `extension mismatch for ${artifact.key}: requested .${requestedExt}, got ${fetched.contentType || "?"}; ` +
            `cannot transcode ${actualExt} → ${requestedExt}, saving as ${finalPath}`,
        );
      }
    }
    if (signal?.aborted) throw new CliError({ code: "interrupted", message: `interrupted before ${artifact.key} was published` });
    // The final name may differ from the pre-checked one; it still may not
    // clobber anything and must stay under the output directory.
    const resolved = resolveWithinRoot(finalPath, root, { label: "download target" }).path;
    publishTempFile(tmp, resolved, { overwrite: false });
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  return { path: finalPath === targetPath ? targetPath : finalPath, bytes, sha256: sha, contentType: fetched.contentType };
}

/**
 * Save a no-artifact task (e.g. analyze-printability) to disk. Two layouts:
 *   - `-o report.json` (or any .json file): write the full task object there;
 *     no sidecar (the file IS the report).
 *   - `-o some/dir/` (or any non-file path): write `meta.json` inside,
 *     matching the directory-mode layout used elsewhere.
 * Other single-file extensions are rejected — the data is JSON, lying about
 * the extension would be worse than a clear error. Every path is proven inside
 * the workspace (when given) before any directory or file is created.
 */
function saveReportOnly(task: Task, outputPath: string, resource: string, workspaceReal: string | null): DownloadResult {
  const singleFileMode = looksLikeFile(outputPath);
  const abs = resolvePath(outputPath);
  if (singleFileMode) {
    const ext = extname(abs).slice(1).toLowerCase();
    if (ext !== "json") {
      throw new UsageError(
        `${resource} produces a JSON report — pass '-o <path>.json' or a directory path (got '${outputPath}').`,
      );
    }
    if (existsSync(abs)) {
      throw new UsageError(
        `refusing to overwrite existing file:\n  ${outputPath}\n` +
          `(delete it or choose a different --output path to rerun)`,
      );
    }
    if (workspaceReal) resolveWithinRoot(abs, workspaceReal, { label: "report path" });
    writeJsonFile(abs, { resource, task, downloaded_at: new Date().toISOString() }, { overwrite: false, mode: 0o644 });
    return { savedFiles: [], metadataPath: abs, materialLinks: null, files: [] };
  }
  const metadataPath = join(abs, "meta.json");
  if (existsSync(metadataPath)) {
    throw new UsageError(
      `refusing to overwrite existing file:\n  ${metadataPath}\n` +
        `(delete it or choose a different --output path to rerun)`,
    );
  }
  if (workspaceReal) {
    resolveWithinRoot(abs, workspaceReal, { label: "output directory" });
    resolveWithinRoot(metadataPath, workspaceReal, { label: "planned download path" });
  }
  mkdirSync(abs, { recursive: true });
  writeMeta(task, resource, metadataPath, [], workspaceReal ?? realpathLenient(abs));
  return { savedFiles: [], metadataPath, materialLinks: null, files: [] };
}

/**
 * The legacy sidecar (`meta.json` / `<stem>_meta.json`), published under the
 * same rules as an asset: the real path is re-proven inside `root` at
 * publication time (a symlink or file that appeared since the preflight is
 * refused, never followed or truncated) and the write is exclusive and atomic.
 */
function writeMeta(task: Task, resource: string, path: string, savedFiles: string[], root: string): void {
  const meta = {
    resource,
    task,
    saved_files: savedFiles,
    downloaded_at: new Date().toISOString(),
  };
  const resolved = resolveWithinRoot(path, root, { label: "sidecar path" }).path;
  writeJsonFile(resolved, meta, { overwrite: false, mode: 0o644 });
}

export { safeSegment as _safeSegmentForTests };
