/** GET /openapi/v1/balance */

import { mapHttpError, MeshyApiError } from "../errors.js";
import { BalanceSchema, type Balance } from "../types.js";
import type { HttpFetch } from "./base.js";

export class BalanceEndpoint {
  private readonly http: HttpFetch;

  constructor(http: HttpFetch) {
    this.http = http;
  }

  async get(): Promise<Balance> {
    return (await this.getWithRaw()).balance;
  }

  /** The parsed balance plus the untouched response body (for --save-json). */
  async getWithRaw(): Promise<{ balance: Balance; raw: unknown }> {
    const resp = await this.http("/balance", { method: "GET" });
    if (!resp.ok) throw await mapHttpError(resp, "/balance");
    const raw: unknown = await resp.json();
    const parsed = BalanceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected balance shape: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path: "/balance",
        body: raw,
      });
    }
    return { balance: parsed.data, raw };
  }
}
