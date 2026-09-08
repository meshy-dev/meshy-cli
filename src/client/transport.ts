/**
 * HTTP transport with explicit boundaries.
 *
 *   createAuthenticatedTransport — one API family (v1 / v2 / creative-lab):
 *     the bearer credential is attached only to paths that resolve inside that
 *     family's base URL. Absolute URLs are accepted only when they are the
 *     same origin *and* under the base path; scheme-relative, userinfo,
 *     foreign schemes and `..` segments are refused before any request.
 *     Redirects are never followed with a credential.
 *   createPublicTransport — no credential ever (catalog, media preflight,
 *     asset downloads).
 *
 * `requestJson` keeps the deadline armed until the body is fully read — a slow
 * body counts against the timeout, unlike a fetcher that clears its timer as
 * soon as headers arrive. `openStream` hands back the response plus an
 * explicit `close()`; the caller owns idle/total deadlines from there.
 *
 * Failures carry a `phase` so callers can tell "the request never left"
 * (connect) from "it may have been processed" (request/response/body), which
 * is the whole difference between not_submitted and submission_unknown.
 */

import { mapHttpError, MeshyApiError } from "./errors.js";
import { logger } from "../internal/logger.js";
import { USER_AGENT } from "../internal/user-agent.js";

export type TransportPhase = "validate" | "connect" | "request" | "response" | "body" | "timeout" | "aborted";

export class TransportError extends MeshyApiError {
  readonly phase: TransportPhase;
  readonly errno?: string;

  constructor(params: { message: string; phase: TransportPhase; path?: string; errno?: string; credentialKind?: "oauth" | "api_key"; cause?: unknown }) {
    super({ message: params.message, status: 0, code: "network", path: params.path, credentialKind: params.credentialKind });
    this.name = "TransportError";
    this.phase = params.phase;
    this.errno = params.errno;
    if (params.cause !== undefined) (this as { cause?: unknown }).cause = params.cause;
  }

  /** True when there is transport-level evidence the request never reached a server. */
  get neverSent(): boolean {
    return this.phase === "validate" || this.phase === "connect";
  }
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  /** Parsed body, or null for an empty body. */
  json: unknown;
  /** Raw text as received. */
  text: string;
  requestId: string | null;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Overrides the transport default (covers headers + body). */
  timeoutMs?: number;
  /** Cap on the response body; exceeding it is a protocol failure, never a truncation. */
  maxBodyBytes?: number;
}

export interface StreamHandle {
  response: Response;
  /** Abort the underlying request and release the body reader. Idempotent. */
  close(): void;
  signal: AbortSignal;
}

export interface Transport {
  readonly baseUrl: string;
  readonly authenticated: boolean;
  requestJson(method: string, path: string, opts?: RequestOptions): Promise<JsonResponse>;
  /** Legacy-style fetch: validates the path, attaches auth, throws MeshyApiError on non-2xx. Body reading is the caller's. */
  fetchRaw(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  openStream(path: string, opts?: { signal?: AbortSignal; headers?: Record<string, string>; connectTimeoutMs?: number }): Promise<StreamHandle>;
}

export interface TransportConfig {
  baseUrl: string;
  apiKey?: string;
  credentialKind?: "oauth" | "api_key";
  readTimeoutMs: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  defaultMaxBodyBytes?: number;
}

export const DEFAULT_MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

function stripTrail(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Resolve a caller path against the base. Only two shapes are accepted:
 *   - a relative path starting with a single "/" (no `..` segments), or
 *   - an absolute http(s) URL with the same origin whose path starts with the
 *     base path (an explicitly same-family URL, e.g. one the API returned).
 */
export function resolveApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(`${stripTrail(baseUrl)}/`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    let target: URL;
    try {
      target = new URL(path);
    } catch {
      throw new TransportError({ message: `invalid URL: ${path}`, phase: "validate", path });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new TransportError({ message: `refusing ${target.protocol} URL for an API request`, phase: "validate", path });
    }
    if (target.username || target.password) {
      throw new TransportError({ message: "refusing URL with embedded credentials", phase: "validate", path });
    }
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, ""))) {
      throw new TransportError({
        message: `refusing to send this API family's credential to ${target.origin}${target.pathname}; it is outside ${stripTrail(baseUrl)}`,
        phase: "validate",
        path,
      });
    }
    return target;
  }
  if (!path.startsWith("/")) path = `/${path}`;
  const segments = path.split("?")[0]!.split("/");
  if (segments.some((s) => s === "..")) {
    throw new TransportError({ message: `refusing path with '..' segment: ${path}`, phase: "validate", path });
  }
  // URL() would treat a leading "//" as scheme-relative — already rejected above.
  const target = new URL(`.${path}`, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, ""))) {
    throw new TransportError({ message: `path ${path} escapes the API base`, phase: "validate", path });
  }
  return target;
}

function errnoOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

const CONNECT_ERRNOS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]);

function classifyFetchFailure(err: unknown, phase: TransportPhase): TransportPhase {
  const errno = errnoOf(err);
  if (errno && CONNECT_ERRNOS.has(errno)) return "connect";
  return phase;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

export function createTransport(cfg: TransportConfig): Transport {
  const baseUrl = stripTrail(cfg.baseUrl);
  const authenticated = Boolean(cfg.apiKey);
  const userAgent = cfg.userAgent ?? USER_AGENT;
  const maxBody = cfg.defaultMaxBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;

  function headersFor(extra?: ConstructorParameters<typeof Headers>[0]): Headers {
    const headers = new Headers(extra);
    if (cfg.apiKey) headers.set("Authorization", `Bearer ${cfg.apiKey}`);
    else headers.delete("Authorization");
    headers.delete("Cookie");
    headers.set("User-Agent", userAgent);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    return headers;
  }

  async function doFetch(url: URL, init: RequestInit, timeoutMs: number, externalSignal: AbortSignal | undefined, path: string): Promise<{ resp: Response; release: () => void; timeoutSignal: AbortSignal }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
    const signal = combineSignals(controller.signal, externalSignal)!;
    const release = () => clearTimeout(timer);
    const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    try {
      logger.debug(`HTTP ${init.method ?? "GET"} ${url.href}`);
      const resp = await fetchImpl(url, { ...init, signal, redirect: "manual" });
      logger.debug(`HTTP ${resp.status} ${url.href}`);
      return { resp, release, timeoutSignal: controller.signal };
    } catch (err) {
      release();
      throw wrapFetchError(err, "request", path, externalSignal, controller.signal, timeoutMs);
    }
  }

  function wrapFetchError(err: unknown, phase: TransportPhase, path: string, externalSignal: AbortSignal | undefined, timeoutSignal: AbortSignal, timeoutMs: number): TransportError {
    if (externalSignal?.aborted) {
      return new TransportError({ message: `request to ${path} aborted`, phase: "aborted", path, cause: err, credentialKind: cfg.credentialKind });
    }
    if (timeoutSignal.aborted) {
      return new TransportError({ message: `request to ${path} timed out after ${timeoutMs}ms`, phase: "timeout", path, cause: err, credentialKind: cfg.credentialKind });
    }
    const errno = errnoOf(err);
    const msg = err instanceof Error ? err.message : String(err);
    return new TransportError({
      message: `network error calling ${path}: ${msg}${errno ? ` (${errno})` : ""}`,
      phase: classifyFetchFailure(err, phase),
      path,
      errno,
      cause: err,
      credentialKind: cfg.credentialKind,
    });
  }

  function refuseRedirect(resp: Response, path: string): void {
    if (resp.status >= 300 && resp.status < 400) {
      throw new TransportError({
        message: `refusing to follow HTTP ${resp.status} redirect from ${path} (redirects are never followed with an API credential)`,
        phase: "response",
        path,
        credentialKind: cfg.credentialKind,
      });
    }
  }

  async function readBodyWithin(resp: Response, cap: number, path: string, externalSignal: AbortSignal | undefined, timeoutSignal: AbortSignal, timeoutMs: number): Promise<string> {
    if (!resp.body) return "";
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > cap) {
            await reader.cancel().catch(() => undefined);
            throw new MeshyApiError({ message: `response body from ${path} exceeds ${cap} bytes`, status: resp.status, code: "server", path });
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (err instanceof MeshyApiError) throw err;
      throw wrapFetchError(err, "body", path, externalSignal, timeoutSignal, timeoutMs);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
    return buf.toString("utf8");
  }

  const transport: Transport = {
    baseUrl,
    authenticated,

    async requestJson(method, path, opts = {}) {
      const url = resolveApiUrl(baseUrl, path);
      if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
          if (v === undefined || v === null) continue;
          url.searchParams.set(k, String(v));
        }
      }
      const headers = headersFor(opts.headers);
      const init: RequestInit = { method };
      if (opts.body !== undefined) {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(opts.body);
      }
      init.headers = headers;
      const timeoutMs = opts.timeoutMs ?? cfg.readTimeoutMs;
      const { resp, release, timeoutSignal } = await doFetch(url, init, timeoutMs, opts.signal, path);
      try {
        refuseRedirect(resp, path);
        if (!resp.ok) {
          // mapHttpError reads the body itself; it is small (an error message).
          throw await mapHttpError(resp, path, cfg.credentialKind);
        }
        const text = await readBodyWithin(resp, opts.maxBodyBytes ?? maxBody, path, opts.signal, timeoutSignal, timeoutMs);
        let json: unknown = null;
        if (text.trim().length > 0) {
          try {
            json = JSON.parse(text);
          } catch (err) {
            throw new MeshyApiError({
              message: `invalid JSON in response from ${path}: ${err instanceof Error ? err.message : String(err)}`,
              status: resp.status,
              code: "server",
              path,
              body: text.slice(0, 200),
            });
          }
        }
        return { status: resp.status, headers: resp.headers, json, text, requestId: resp.headers.get("x-request-id") };
      } finally {
        release();
      }
    },

    async fetchRaw(path, init = {}) {
      const url = resolveApiUrl(baseUrl, path);
      const headers = headersFor(init.headers);
      const timeoutMs = init.timeoutMs ?? cfg.readTimeoutMs;
      const { resp, release } = await doFetch(url, { ...init, headers }, timeoutMs, init.signal ?? undefined, path);
      try {
        refuseRedirect(resp, path);
        if (!resp.ok) throw await mapHttpError(resp, path, cfg.credentialKind);
        // The caller reads the body; give it the whole remaining budget by
        // leaving the timer armed until the body is consumed or GC'd.
        const body = resp.body;
        if (!body) {
          release();
          return resp;
        }
        const watched = new Response(
          body.pipeThrough(
            new TransformStream({
              flush() {
                release();
              },
            }),
          ),
          { status: resp.status, statusText: resp.statusText, headers: resp.headers },
        );
        return watched;
      } catch (err) {
        release();
        throw err;
      }
    },

    async openStream(path, opts = {}) {
      const url = resolveApiUrl(baseUrl, path);
      const headers = headersFor({ Accept: "text/event-stream", ...(opts.headers ?? {}) });
      const controller = new AbortController();
      const signal = combineSignals(controller.signal, opts.signal)!;
      const connectTimeoutMs = opts.connectTimeoutMs ?? cfg.readTimeoutMs;
      const connectTimer = setTimeout(() => controller.abort(new Error(`stream connect timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs);
      const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
      let resp: Response;
      try {
        logger.debug(`HTTP GET (stream) ${url.href}`);
        resp = await fetchImpl(url, { method: "GET", headers, signal, redirect: "manual" });
      } catch (err) {
        clearTimeout(connectTimer);
        throw wrapFetchError(err, "request", path, opts.signal, controller.signal, connectTimeoutMs);
      }
      clearTimeout(connectTimer);
      const close = () => {
        if (!controller.signal.aborted) controller.abort(new Error("stream closed by client"));
        resp.body?.cancel().catch(() => undefined);
      };
      try {
        refuseRedirect(resp, path);
        if (!resp.ok) throw await mapHttpError(resp, path, cfg.credentialKind);
      } catch (err) {
        close();
        throw err;
      }
      return { response: resp, close, signal };
    },
  };
  return transport;
}

export function createAuthenticatedTransport(cfg: TransportConfig & { apiKey: string }): Transport {
  return createTransport(cfg);
}

export function createPublicTransport(cfg: Omit<TransportConfig, "apiKey" | "credentialKind">): Transport {
  return createTransport({ ...cfg, apiKey: undefined, credentialKind: undefined });
}
