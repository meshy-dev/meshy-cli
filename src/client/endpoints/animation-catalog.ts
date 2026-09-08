/**
 * GET <origin>/web/public/animations/resources — the public Animation Library.
 *
 * No credential is ever attached: the endpoint is public and the transport
 * used here has none. `category` is the only server-side filter the frozen
 * Skill baseline relies on; the response is `{result:{total,list}}`.
 */

import { z } from "zod";
import { MeshyApiError } from "../errors.js";
import type { Transport } from "../transport.js";

export const AnimationCatalogEntrySchema = z
  .object({
    id: z.number(),
    key: z.string().optional(),
    name: z.string().optional(),
    category: z.string().optional(),
    subCategory: z.string().optional(),
    previewUrl: z.string().optional(),
    rigType: z.string().optional(),
    isDefault: z.boolean().optional(),
    isFree: z.boolean().optional(),
  })
  .passthrough();
export type AnimationCatalogEntry = z.infer<typeof AnimationCatalogEntrySchema>;

const ResponseSchema = z
  .object({
    result: z.object({ total: z.number().optional(), list: z.array(AnimationCatalogEntrySchema) }).passthrough(),
  })
  .passthrough();

export const ANIMATION_CATEGORIES = ["WalkAndRun", "BodyMovements", "DailyActions", "Fighting", "Dancing"] as const;

export class AnimationCatalogEndpoint {
  static readonly PATH = "/animations/resources";
  private readonly transport: Transport;

  constructor(transport: Transport) {
    if (transport.authenticated) throw new Error("the animation catalog must use an unauthenticated transport");
    this.transport = transport;
  }

  async list(params: { category?: string } = {}, extras: { signal?: AbortSignal } = {}): Promise<{ entries: AnimationCatalogEntry[]; total: number | null; raw: unknown }> {
    const resp = await this.transport.requestJson("GET", AnimationCatalogEndpoint.PATH, {
      query: { category: params.category },
      signal: extras.signal,
    });
    const parsed = ResponseSchema.safeParse(resp.json);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected catalog shape from ${AnimationCatalogEndpoint.PATH}: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path: AnimationCatalogEndpoint.PATH,
        body: resp.json,
      });
    }
    return { entries: parsed.data.result.list, total: parsed.data.result.total ?? null, raw: resp.json };
  }
}
