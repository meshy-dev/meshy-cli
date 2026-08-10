/**
 * MeshyClient — two fetchers (v1 + v2), typed endpoint namespaces.
 */

import { AnalyzePrintabilityEndpoint } from "./endpoints/analyze-printability.js";
import { AnimateEndpoint } from "./endpoints/animate.js";
import { BalanceEndpoint } from "./endpoints/balance.js";
import { ConvertEndpoint } from "./endpoints/convert.js";
import { ResizeEndpoint } from "./endpoints/resize.js";
import { ImageTo3DEndpoint } from "./endpoints/image-to-3d.js";
import { ImageToImageEndpoint } from "./endpoints/image-to-image.js";
import { MultiColorPrintEndpoint } from "./endpoints/multi-color-print.js";
import { MultiImageTo3DEndpoint } from "./endpoints/multi-image-to-3d.js";
import { RemeshEndpoint } from "./endpoints/remesh.js";
import { RepairPrintabilityEndpoint } from "./endpoints/repair-printability.js";
import { RetextureEndpoint } from "./endpoints/retexture.js";
import { RiggingEndpoint } from "./endpoints/rigging.js";
import { TaskEndpoint, type HttpFetch } from "./endpoints/base.js";
import { TextTo3DEndpoint } from "./endpoints/text-to-3d.js";
import { TextToImageEndpoint } from "./endpoints/text-to-image.js";
import { mapHttpError, MeshyApiError } from "./errors.js";
import type { MeshyConfig } from "../internal/config.js";
import { logger } from "../internal/logger.js";
import { USER_AGENT } from "../internal/user-agent.js";

function makeFetcher(
  baseUrl: string,
  apiKey: string,
  readTimeoutMs: number,
  credentialKind: "oauth" | "api_key",
): HttpFetch {
  return async function (path: string, init?: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("User-Agent", USER_AGENT);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`read timeout after ${readTimeoutMs}ms`)),
      readTimeoutMs,
    );
    try {
      logger.debug(`HTTP ${init?.method ?? "GET"} ${url}`);
      const resp = await fetch(url, { ...init, headers, signal: controller.signal });
      logger.debug(`HTTP ${resp.status} ${url}`);
      if (!resp.ok) {
        throw await mapHttpError(resp, path, credentialKind);
      }
      return resp;
    } catch (err) {
      if (err instanceof MeshyApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new MeshyApiError({
          message: `request to ${url} timed out after ${readTimeoutMs}ms`,
          status: 0,
          code: "network",
          path,
          credentialKind,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new MeshyApiError({
        message: `network error calling ${url}: ${msg}`,
        status: 0,
        code: "network",
        path,
        credentialKind,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export class MeshyClient {
  readonly config: MeshyConfig;
  readonly balance: BalanceEndpoint;
  readonly textTo3d: TextTo3DEndpoint;
  readonly imageTo3d: ImageTo3DEndpoint;
  readonly multiImageTo3d: MultiImageTo3DEndpoint;
  readonly remesh: RemeshEndpoint;
  readonly convert: ConvertEndpoint;
  readonly resize: ResizeEndpoint;
  readonly rigging: RiggingEndpoint;
  readonly animate: AnimateEndpoint;
  readonly retexture: RetextureEndpoint;
  readonly textToImage: TextToImageEndpoint;
  readonly imageToImage: ImageToImageEndpoint;
  readonly multiColorPrint: MultiColorPrintEndpoint;
  readonly analyzePrintability: AnalyzePrintabilityEndpoint;
  readonly repairPrintability: RepairPrintabilityEndpoint;

  private readonly v1Fetch: HttpFetch;
  private readonly v2Fetch: HttpFetch;

  constructor(config: MeshyConfig) {
    this.config = config;
    this.v1Fetch = makeFetcher(config.baseUrlV1, config.apiKey, config.readTimeoutMs, config.credentialKind);
    this.v2Fetch = makeFetcher(config.baseUrlV2, config.apiKey, config.readTimeoutMs, config.credentialKind);

    this.balance = new BalanceEndpoint(this.v1Fetch);
    this.textTo3d = new TextTo3DEndpoint(this.v2Fetch);
    this.imageTo3d = new ImageTo3DEndpoint(this.v1Fetch);
    this.multiImageTo3d = new MultiImageTo3DEndpoint(this.v1Fetch);
    this.remesh = new RemeshEndpoint(this.v1Fetch);
    this.convert = new ConvertEndpoint(this.v1Fetch);
    this.resize = new ResizeEndpoint(this.v1Fetch);
    this.rigging = new RiggingEndpoint(this.v1Fetch);
    this.animate = new AnimateEndpoint(this.v1Fetch);
    this.retexture = new RetextureEndpoint(this.v1Fetch);
    this.textToImage = new TextToImageEndpoint(this.v1Fetch);
    this.imageToImage = new ImageToImageEndpoint(this.v1Fetch);
    this.multiColorPrint = new MultiColorPrintEndpoint(this.v1Fetch);
    this.analyzePrintability = new AnalyzePrintabilityEndpoint(this.v1Fetch);
    this.repairPrintability = new RepairPrintabilityEndpoint(this.v1Fetch);
  }

  endpointFor(resource: ResourceName): TaskEndpoint {
    switch (resource) {
      case "text-to-3d": return this.textTo3d;
      case "image-to-3d": return this.imageTo3d;
      case "multi-image-to-3d": return this.multiImageTo3d;
      case "remesh": return this.remesh;
      case "convert": return this.convert;
      case "resize": return this.resize;
      case "rigging": return this.rigging;
      case "animate": return this.animate;
      case "retexture": return this.retexture;
      case "text-to-image": return this.textToImage;
      case "image-to-image": return this.imageToImage;
      case "multi-color-print": return this.multiColorPrint;
      case "analyze-printability": return this.analyzePrintability;
      case "repair-printability": return this.repairPrintability;
    }
  }

  /** Raw HTTP passthrough for `meshy api …` — selects v1 or v2 by prefix. */
  async raw(
    apiVersion: "v1" | "v2",
    method: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const fetcher = apiVersion === "v2" ? this.v2Fetch : this.v1Fetch;
    return fetcher(path, { ...init, method });
  }
}

export const RESOURCE_NAMES = [
  "text-to-3d",
  "image-to-3d",
  "multi-image-to-3d",
  "remesh",
  "convert",
  "resize",
  "rigging",
  "animate",
  "retexture",
  "text-to-image",
  "image-to-image",
  "multi-color-print",
  "analyze-printability",
  "repair-printability",
] as const;

export type ResourceName = (typeof RESOURCE_NAMES)[number];

export { MeshyApiError } from "./errors.js";
