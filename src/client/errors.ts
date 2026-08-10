/**
 * Single typed error class for all Meshy HTTP failures.
 */

export type MeshyErrorCode =
  | "validation"
  | "auth"
  | "credit"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network";

export class MeshyApiError extends Error {
  readonly status: number;
  readonly code: MeshyErrorCode;
  readonly path?: string;
  readonly body?: unknown;
  /** Set when the credential kind is known at the call site — used to tailor the 401 hint. */
  readonly credentialKind?: "oauth" | "api_key";

  constructor(params: {
    message: string;
    status: number;
    code: MeshyErrorCode;
    path?: string;
    body?: unknown;
    credentialKind?: "oauth" | "api_key";
  }) {
    super(params.message);
    this.name = "MeshyApiError";
    this.status = params.status;
    this.code = params.code;
    this.path = params.path;
    this.body = params.body;
    this.credentialKind = params.credentialKind;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      path: this.path,
      ...(this.credentialKind !== undefined ? { credentialKind: this.credentialKind } : {}),
    };
  }
}

function codeForStatus(status: number): MeshyErrorCode {
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "auth";
  if (status === 402) return "credit";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  return "server";
}

async function extractMessage(resp: Response): Promise<{ msg: string; body: unknown }> {
  let bodyText: string;
  try {
    bodyText = await resp.text();
  } catch {
    return { msg: "", body: undefined };
  }
  if (!bodyText) return { msg: "", body: undefined };
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const m = obj.message ?? obj.error;
      if (typeof m === "string" && m.length > 0) {
        return { msg: m, body: parsed };
      }
    }
    return { msg: bodyText.slice(0, 200), body: parsed };
  } catch {
    return { msg: bodyText.slice(0, 200), body: bodyText };
  }
}

export async function mapHttpError(
  resp: Response,
  path?: string,
  credentialKind?: "oauth" | "api_key",
): Promise<MeshyApiError> {
  const { msg, body } = await extractMessage(resp);
  const code = codeForStatus(resp.status);
  const where = path ?? new URL(resp.url).pathname;
  return new MeshyApiError({
    message: `meshy api ${resp.status} on ${where}: ${msg || resp.statusText}`,
    status: resp.status,
    code,
    path: where,
    body,
    credentialKind,
  });
}
