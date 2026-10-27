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
 * any MIME-driven extension change — is checked against the output root.
 *
 * Two entry points share the core:
 *   downloadAssets     — writes a list of enumerated assets (artifacts.ts):
 *                        `meshy download` selects them explicitly;
 *   downloadTaskAssets — `-o`: the task's default selection (or every asset
 *                        with --all-assets) plus the meta.json sidecar.
 * OBJ → MTL → texture references are relinked after the set has landed (see
 * material-links.ts), so a saved OBJ loads with the files beside it.
 */

import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { Transform } from "node:stream";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { TaskResourceDescriptor } from "../client/resource-registry.js";
import type { Task } from "../client/types.js";
import { publishTempFile, tempPathFor, writeJsonFile } from "./atomic-file.js";
import { CliError, UsageError, type ErrorRecovery } from "./errors.js";
import { isInside, looksLikeFile, realpathLenient, resolveWithinRoot, safeExtension } from "./paths.js";
import { USER_AGENT } from "./user-agent.js";
import { enumerateAssets, selectDefaultAssets, type Asset, type DefaultSelection, type SkipReason } from "./artifacts.js";
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
  status: "written" | "failed";
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
  /** Real paths an earlier `-o` of the same task saved: replaced like --overwrite would. */
  replace?: ReadonlySet<string>;
  /** Root every final path must stay inside: --workspace, or the output directory. */
  root: string;
  /** Validate magic/content-type for models (default on). */
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

function replaceable(opts: DownloadAssetsOptions, path: string): boolean {
  return Boolean(opts.overwrite) || Boolean(opts.replace?.has(path));
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
  // The directory and every planned leaf must be inside the root (and no
  // symlink) before anything at all is created — a refused target must not
  // leave a directory behind; the check repeats after any MIME-driven rename.
  const rootReal = resolveWithinRoot(dir, opts.root, { label: "output directory" }).root;
  for (const asset of assets) {
    resolveWithinRoot(join(dir, plannedName(asset, opts.targetFile)), opts.root, { label: "planned download path" });
  }
  mkdirSync(dir, { recursive: true });

  let refreshed: Map<string, string> | null | undefined;
  for (const asset of assets) {
    const planned = join(dir, plannedName(asset, opts.targetFile));
    let entry: DownloadedFile;
    try {
      if (asset.kind === "report") {
        const target = resolveWithinRoot(planned.endsWith(".json") ? planned : `${planned}.json`, opts.root, { label: "report path" }).path;
        const res = writeJsonFile(target, asset.report, { overwrite: replaceable(opts, target) });
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
        entry = await placeFetched(asset, fetched, planned, opts, warnings);
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

/** After the set landed: point the MTL's texture references at the saved names and re-take the digests of rewritten files. */
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
  let target: ReturnType<typeof resolveWithinRoot>;
  try {
    target = resolveWithinRoot(finalPath, opts.root, { label: "final download path" });
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  const resolved = target.path;
  const res = publishTempFile(tmp, resolved, { overwrite: replaceable(opts, resolved) });
  return {
    key: asset.key,
    path: resolved,
    relative_path: rel(target.root, resolved),
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
// `-o`: the default selection of a task, written by downloadAssets
// ---------------------------------------------------------------------------

/** Manifest entry for what `-o` left on the server (`result.downloads.skipped[]`, meta.json `skipped`). */
export interface SkippedAsset {
  key: string;
  reason: SkipReason;
}

export interface TaskDownloadOptions {
  /** --workspace: every directory and file must resolve inside it. Default: the output directory. */
  root?: string;
  /** Cooperative cancellation (SIGINT): aborts the in-flight transfer and everything after it. */
  signal?: AbortSignal;
  /** --all-assets: every asset of the task (directory only) instead of the default selection. */
  allAssets?: boolean;
}

export interface TaskDownloadResult {
  files: DownloadedFile[];
  skipped: SkippedAsset[];
  metadataPath: string;
  materialLinks: MaterialLinkReport | null;
  warnings: Array<{ code: string; message: string }>;
}

/**
 * Single-file `-o <file.ext>`: the asset whose format matches the extension
 * (`-o car.glb` → the model GLB), first among the selected assets, then among
 * the alternate formats (`-o hero.fbx` on rigging → the FBX rigged character).
 * A sole selected asset of unknown format, or an image the extension can
 * transcode to, is taken as well. Null when nothing or several match.
 */
function pickSingleFile(selection: DefaultSelection, outputPath: string): Asset | null {
  const ext = safeExtension(extname(outputPath));
  const matches = (a: Asset): boolean => a.format !== null && (a.format === ext || extEquivalent(a.format, ext));
  const direct = selection.selected.filter(matches);
  if (direct.length > 0) return direct.length === 1 ? direct[0]! : null;
  const alternates = selection.skipped.filter((s) => s.reason === "alternate_format" && matches(s.asset));
  if (alternates.length === 1) return alternates[0]!.asset;
  const sole = selection.selected.length === 1 ? selection.selected[0]! : null;
  const transcodable = (a: Asset): boolean => a.format === null || (CONVERTIBLE_IMAGE_EXTS.has(a.format) && CONVERTIBLE_IMAGE_EXTS.has(ext));
  return sole && transcodable(sole) ? sole : null;
}

/**
 * `-o`: save a SUCCEEDED task's default selection (or every asset with
 * `allAssets`) into a directory with a `meta.json` sidecar, or one asset into
 * a file path with a `<stem>_meta.json` sidecar. Every planned path is checked
 * before any request: inside the workspace, and not already there — unless the
 * sidecar there says an earlier `-o` of this task saved it, in which case the
 * rerun replaces it. A transfer that fails part-way still writes the sidecar
 * for what landed, so the same command (the error's recovery) picks up from there.
 */
export async function downloadTaskAssets(task: Task, outputPath: string, descriptor: TaskResourceDescriptor, opts: TaskDownloadOptions = {}): Promise<TaskDownloadResult> {
  const all = enumerateAssets(task as unknown as Record<string, unknown>, descriptor).assets;
  if (all.length === 0) throw new Error(`task ${task.id} has no downloadable assets`);

  const singleFile = looksLikeFile(outputPath);
  if (singleFile && opts.allAssets && all.length > 1) {
    throw new UsageError(`--all-assets saves all ${all.length} files of task ${task.id} and needs a directory — '${outputPath}' looks like a file (e.g. '${stripExt(outputPath)}')`);
  }
  let selection: DefaultSelection = opts.allAssets ? { selected: [...all], skipped: [] } : selectDefaultAssets(all);
  if (singleFile) {
    const chosen = pickSingleFile(selection, outputPath);
    if (!chosen) {
      throw new UsageError(
        `'${outputPath}' does not name exactly one file of task ${task.id} (it has ${selection.selected.map((a) => a.filename).join(", ")}): ` +
          `use one of those extensions, or pass a directory path for --output (e.g. '${stripExt(outputPath)}').`,
      );
    }
    const reasons = new Map(selection.skipped.map((s) => [s.asset, s.reason]));
    selection = { selected: [chosen], skipped: all.filter((a) => a !== chosen).map((asset) => ({ asset, reason: reasons.get(asset) ?? "not_selected" })) };
  }

  const targetDir = singleFile ? dirname(resolvePath(outputPath)) : resolvePath(outputPath);
  const metadataPath = sidecarPath(outputPath);
  const planned = singleFile ? [resolvePath(outputPath)] : selection.selected.map((a) => join(targetDir, a.filename));
  const earlier = earlierRunFiles(metadataPath, task.id, descriptor.id);
  const foreign = [...planned, metadataPath].filter((p) => existsSync(p) && !(earlier && (p === metadataPath || earlier.has(realpathLenient(p)))));
  if (foreign.length > 0) {
    throw new CliError({
      code: "local_io",
      message: `refusing to overwrite file(s) no earlier -o of task ${task.id} saved:\n  ${foreign.join("\n  ")}\n(delete them or choose another --output path)`,
      recovery: { action: "choose_path", automatic: false },
    });
  }
  const root = opts.root ?? targetDir;
  resolveWithinRoot(targetDir, root, { label: "output directory" });
  for (const p of [...planned, metadataPath]) resolveWithinRoot(p, root, { label: "planned download path" });
  mkdirSync(targetDir, { recursive: true });

  const skipped = selection.skipped.map((s) => ({ key: s.asset.key, reason: s.reason }));
  const rerun: ErrorRecovery = { action: "download", automatic: false, command: rerunCommand(descriptor, task.id, outputPath, opts) };
  // The sidecar lists this run's files and every file an earlier run of the task left here.
  const writeSidecar = (files: DownloadedFile[]): void => {
    const saved = files.filter((f) => f.status === "written").map((f) => f.path);
    const kept = [...(earlier ?? [])].filter((p) => !saved.includes(p) && existsSync(p));
    writeMeta(task, descriptor.id, metadataPath, [...saved, ...kept], skipped, root, earlier !== null);
  };

  let result: DownloadAssetsResult;
  try {
    result = await downloadAssets(selection.selected, {
      ...(singleFile ? { targetFile: resolvePath(outputPath) } : { targetDir }),
      root,
      ...(earlier ? { replace: earlier } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw transferFailure(err, writeSidecar, metadataPath, rerun);
  }
  try {
    if (opts.signal?.aborted) throw new CliError({ code: "interrupted", message: "interrupted before the sidecar was written; nothing further was written" });
    writeSidecar(result.files);
  } catch (err) {
    throw sidecarFailure(err, result.files, opts.signal, rerun);
  }
  return { files: result.files, skipped, metadataPath, materialLinks: result.materialLinks, warnings: result.warnings };
}

/** Where `-o` writes its sidecar: `<dir>/meta.json`, or `<stem>_meta.json` beside a single file. */
export function sidecarPath(outputPath: string): string {
  return looksLikeFile(outputPath) ? `${stripExt(resolvePath(outputPath))}_meta.json` : join(resolvePath(outputPath), "meta.json");
}

/** The files a sidecar of this same task lists (real paths), or null when there is none or it belongs to something else. */
function earlierRunFiles(metadataPath: string, taskId: string, resource: string): Set<string> | null {
  let meta: { resource?: unknown; task?: { id?: unknown }; saved_files?: unknown };
  try {
    meta = JSON.parse(readFileSync(metadataPath, "utf8")) as typeof meta;
  } catch {
    return null;
  }
  if (meta?.resource !== resource || meta.task?.id !== taskId || !Array.isArray(meta.saved_files)) return null;
  return new Set(meta.saved_files.filter((f): f is string => typeof f === "string"));
}

/** The same `-o` again, runnable from anywhere: absolute paths, the original --all-assets and --workspace. */
function rerunCommand(descriptor: TaskResourceDescriptor, taskId: string, outputPath: string, opts: TaskDownloadOptions): string {
  const words = ["meshy", ...descriptor.commandPath, "get", taskId, "-o", shellWord(resolvePath(outputPath))];
  if (opts.allAssets) words.push("--all-assets");
  if (opts.root) words.push("--workspace", shellWord(resolvePath(opts.root)));
  return words.join(" ");
}

function shellWord(s: string): string {
  return /^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The transfer failed part-way (an asset error, Ctrl-C, the relink): the files
 * that landed are recorded in the sidecar, so rerunning the same command
 * replaces them and fetches the rest. A refusal before any transfer carries no
 * manifest and is passed on as it is.
 */
function transferFailure(err: unknown, writeSidecar: (files: DownloadedFile[]) => void, metadataPath: string, rerun: ErrorRecovery): unknown {
  const downloads = err instanceof CliError ? (err.result?.["downloads"] as { files: DownloadedFile[] } | undefined) : undefined;
  if (!(err instanceof CliError) || !downloads) return err;
  let recorded: string | null = null;
  if (downloads.files.some((f) => f.status === "written")) {
    try {
      writeSidecar(downloads.files);
      recorded = metadataPath;
    } catch {
      // The transfer failure is the outcome; without a sidecar a rerun names the files to delete.
    }
  }
  return new CliError({
    code: err.code,
    message: err.message,
    exitCode: err.exitCode,
    httpStatus: err.httpStatus,
    retryable: err.retryable,
    recovery: rerun,
    hint: err.hint,
    details: err.details,
    warnings: err.warnings,
    result: { ...err.result, downloads: { ...downloads, metadata_path: recorded } },
    cause: err.cause ?? err,
  });
}

/**
 * The sidecar failed (or was interrupted) after every asset landed: the
 * manifest keeps each committed file with the bytes on disk; an interrupt is
 * `interrupted` (130), everything else keeps its class.
 */
function sidecarFailure(err: unknown, files: DownloadedFile[], signal: AbortSignal | undefined, rerun: ErrorRecovery): CliError {
  redigest(files);
  const downloads = { state: "partial", files, metadata_path: null, failed_step: "sidecar" };
  const interrupted = (err instanceof CliError && err.code === "interrupted") || Boolean(signal?.aborted);
  const message = `${files.length} file(s) were written but the sidecar step ${interrupted ? "was interrupted" : "failed"}: ${err instanceof Error ? err.message : String(err)}`;
  if (err instanceof CliError) {
    return new CliError({ code: interrupted ? "interrupted" : err.code, message, httpStatus: err.httpStatus, retryable: err.retryable, recovery: err.recovery ?? rerun, hint: err.hint, details: err.details, warnings: err.warnings, result: { ...(err.result ?? {}), downloads }, cause: err });
  }
  return new CliError({ code: interrupted ? "interrupted" : "local_io", message, recovery: rerun, result: { downloads }, cause: err });
}

/**
 * The sidecar (`meta.json` / `<stem>_meta.json`): the full task — every URL,
 * so `meshy download --task-json` can fetch a skipped asset later — the saved
 * paths and what was skipped. The write is atomic and replaces only a sidecar
 * of the same task; a symlink at the sidecar path is refused, never followed.
 */
function writeMeta(task: Task, resource: string, path: string, savedFiles: string[], skipped: SkippedAsset[], root: string, overwrite: boolean): void {
  const meta = { resource, task, saved_files: savedFiles, skipped, downloaded_at: new Date().toISOString() };
  const resolved = resolveWithinRoot(path, root, { label: "sidecar path" }).path;
  writeJsonFile(resolved, meta, { overwrite, mode: 0o644 });
}
