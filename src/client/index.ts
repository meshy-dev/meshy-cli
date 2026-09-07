/**
 * MeshyClient — one transport per API family, endpoints resolved from the
 * resource registry.
 *
 *   v1 / v2       bearer credential, resolved by config
 *   creative-lab  bearer credential; base derived from the v1 origin or given
 *                 explicitly; a stored profile is never sent to another origin
 *   public-web    no credential (animation catalog)
 */

import { BalanceEndpoint } from "./endpoints/balance.js";
import { TaskEndpoint } from "./endpoints/base.js";
import { AnimationCatalogEndpoint } from "./endpoints/animation-catalog.js";
import { ShowcasesEndpoint } from "./endpoints/showcases.js";
import {
  creativeLabResource,
  requireTaskResource,
  TASK_RESOURCES,
  type ApiBase,
  type CreativeLabProduct,
  type CreativeLabStage,
  type TaskResourceDescriptor,
} from "./resource-registry.js";
import { createTransport, type Transport } from "./transport.js";
import { assertCredentialAllowedForOrigin, type MeshyConfig } from "../internal/config.js";
import { UsageError } from "../internal/errors.js";

export type { HttpFetch } from "./endpoints/base.js";

export class MeshyClient {
  readonly config: MeshyConfig;
  readonly balance: BalanceEndpoint;
  readonly showcases: ShowcasesEndpoint;
  /** Public catalog — built on a transport without any credential. */
  readonly catalog: AnimationCatalogEndpoint;

  private readonly v1: Transport;
  private readonly v2: Transport;
  private creativeLabTransport: Transport | null = null;
  private readonly endpoints = new Map<string, TaskEndpoint>();

  constructor(config: MeshyConfig, opts: { fetchImpl?: typeof fetch } = {}) {
    this.config = config;
    const common = { readTimeoutMs: config.readTimeoutMs, fetchImpl: opts.fetchImpl, credentialKind: config.credentialKind };
    this.v1 = createTransport({ ...common, baseUrl: config.baseUrlV1, apiKey: config.apiKey });
    this.v2 = createTransport({ ...common, baseUrl: config.baseUrlV2, apiKey: config.apiKey });
    const publicTransport = createTransport({ baseUrl: config.publicWebBase, readTimeoutMs: config.readTimeoutMs, fetchImpl: opts.fetchImpl });
    this.balance = new BalanceEndpoint((path, init) => this.v1.fetchRaw(path, init));
    this.showcases = new ShowcasesEndpoint(this.v1);
    this.catalog = new AnimationCatalogEndpoint(publicTransport);
  }

  private transportFor(base: ApiBase): Transport {
    switch (base) {
      case "v1":
        return this.v1;
      case "v2":
        return this.v2;
      case "creative-lab": {
        if (this.creativeLabTransport) return this.creativeLabTransport;
        const baseUrl = this.config.baseUrlCreativeLab;
        if (!baseUrl) {
          throw new UsageError(
            "the Creative Lab base URL cannot be derived from --base-url-v1; pass --base-url-creative-lab <url> (or MESHY_BASE_URL_CREATIVE_LAB)",
          );
        }
        assertCredentialAllowedForOrigin(this.config, baseUrl, "Creative Lab");
        this.creativeLabTransport = createTransport({
          baseUrl,
          apiKey: this.config.apiKey,
          credentialKind: this.config.credentialKind,
          readTimeoutMs: this.config.readTimeoutMs,
        });
        return this.creativeLabTransport;
      }
    }
  }

  /** Endpoint for any registered task resource (`text-to-3d`, `creative-lab.lamp.build`, …). */
  endpointFor(resource: string | TaskResourceDescriptor): TaskEndpoint {
    const d = typeof resource === "string" ? requireTaskResource(resource) : resource;
    const existing = this.endpoints.get(d.id);
    if (existing) return existing;
    const ep = new TaskEndpoint(this.transportFor(d.base), d.relativePath);
    this.endpoints.set(d.id, ep);
    return ep;
  }

  creativeLab(product: CreativeLabProduct | string, stage: CreativeLabStage | string): TaskEndpoint {
    const d = creativeLabResource(product, stage);
    if (!d) throw new UsageError(`unknown Creative Lab product/stage '${product}/${stage}'`);
    return this.endpointFor(d);
  }

  // Named accessors kept for existing call sites and tests.
  get textTo3d(): TaskEndpoint { return this.endpointFor("text-to-3d"); }
  get imageTo3d(): TaskEndpoint { return this.endpointFor("image-to-3d"); }
  get multiImageTo3d(): TaskEndpoint { return this.endpointFor("multi-image-to-3d"); }
  get remesh(): TaskEndpoint { return this.endpointFor("remesh"); }
  get convert(): TaskEndpoint { return this.endpointFor("convert"); }
  get resize(): TaskEndpoint { return this.endpointFor("resize"); }
  get rigging(): TaskEndpoint { return this.endpointFor("rigging"); }
  get animate(): TaskEndpoint { return this.endpointFor("animate"); }
  get retexture(): TaskEndpoint { return this.endpointFor("retexture"); }
  get textToImage(): TaskEndpoint { return this.endpointFor("text-to-image"); }
  get textToMotion(): TaskEndpoint { return this.endpointFor("text-to-motion"); }
  get imageToImage(): TaskEndpoint { return this.endpointFor("image-to-image"); }
  get multiColorPrint(): TaskEndpoint { return this.endpointFor("multi-color-print"); }
  get analyzePrintability(): TaskEndpoint { return this.endpointFor("analyze-printability"); }
  get repairPrintability(): TaskEndpoint { return this.endpointFor("repair-printability"); }
  get uvUnwrap(): TaskEndpoint { return this.endpointFor("uv-unwrap"); }

  /** Raw HTTP passthrough for `meshy api …` — selects the API family by flag. */
  async raw(
    apiVersion: "v1" | "v2" | "creative-lab",
    method: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    return this.transportFor(apiVersion).fetchRaw(path, { ...init, method });
  }
}

/** The 0.2.0 resource names, still valid ids in the registry. */
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
  "text-to-motion",
  "image-to-image",
  "multi-color-print",
  "analyze-printability",
  "repair-printability",
] as const;

export type ResourceName = (typeof RESOURCE_NAMES)[number];

/** Every registered task resource id (15 legacy + uv-unwrap + Creative Lab stages). */
export const TASK_RESOURCE_IDS: readonly string[] = TASK_RESOURCES.map((d) => d.id);

export { MeshyApiError } from "./errors.js";
