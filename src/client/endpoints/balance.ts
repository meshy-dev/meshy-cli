/** GET /openapi/v1/balance */

import { MeshyApiError } from "../errors.js";
import type { Transport } from "../transport.js";
import { BalanceSchema, type Balance } from "../types.js";

export class BalanceEndpoint {
  static readonly PATH = "/balance";
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async get(): Promise<Balance> {
    return (await this.getWithRaw()).balance;
  }

  /** The parsed balance plus the untouched response body (for --save-json). */
  async getWithRaw(): Promise<{ balance: Balance; raw: unknown }> {
    const resp = await this.transport.requestJson("GET", BalanceEndpoint.PATH);
    const parsed = BalanceSchema.safeParse(resp.json);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected balance shape: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path: BalanceEndpoint.PATH,
        body: resp.json,
      });
    }
    return { balance: parsed.data, raw: resp.json };
  }
}
