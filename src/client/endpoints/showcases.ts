/**
 * GET /openapi/v1/showcases — Enterprise showcase search.
 *
 * Every call may be billed (1 credit per request per the official docs), so
 * the endpoint performs exactly one GET, never retries and never paginates on
 * its own. Items are passed through untouched.
 */

import { MeshyApiError } from "../errors.js";
import type { Transport } from "../transport.js";

export const SHOWCASE_SORT_BY = ["+created_at", "-created_at", "+updated_at", "-updated_at", "+downloads", "-downloads"] as const;
export const SHOWCASE_FORMATS = ["glb", "fbx", "obj", "usdz"] as const;
/** Server enum (checked read-only against the server binding); the docs spell the second value `animated`. */
export const SHOWCASE_TYPES = ["all", "animate", "static"] as const;

export interface ShowcaseListParams {
  page_size?: number;
  sort_by?: string;
  search?: string;
  format?: string;
  showcase_type?: string;
}

export class ShowcasesEndpoint {
  static readonly PATH = "/showcases";
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async list(params: ShowcaseListParams, extras: { signal?: AbortSignal } = {}): Promise<{ items: Record<string, unknown>[]; raw: unknown }> {
    const resp = await this.transport.requestJson("GET", ShowcasesEndpoint.PATH, {
      query: {
        page_size: params.page_size,
        sort_by: params.sort_by,
        search: params.search,
        format: params.format,
        showcase_type: params.showcase_type,
      },
      signal: extras.signal,
    });
    const raw = resp.json;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["result"])
        ? ((raw as Record<string, unknown>)["result"] as unknown[])
        : null;
    if (!list) {
      throw new MeshyApiError({
        message: `unexpected showcases shape from ${ShowcasesEndpoint.PATH}`,
        status: resp.status,
        code: "server",
        path: ShowcasesEndpoint.PATH,
        body: raw,
      });
    }
    const items = list.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
    return { items, raw };
  }
}
