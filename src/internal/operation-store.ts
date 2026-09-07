/**
 * Operation journal — a local, best-effort record of every billable create.
 *
 * It exists so a lost response can be reconciled instead of blindly re-sent:
 * the record is written *before* the POST (state `started`), then updated to
 * `accepted` (task id known), `rejected` (server said no), `not_submitted`
 * (transport proves the request never left) or `unknown` (anything else after
 * the request was sent). A repeated `--operation-id` returns the stored record
 * instead of submitting again when the request fingerprints match, and refuses
 * with `operation_conflict` when they do not.
 *
 * Identity of a request = resource + API origin + credential fingerprint +
 * payload fingerprint. The credential fingerprint binds to the actual account:
 * a keyed digest of the API key, or the stable OAuth subject (user id) — never
 * the rotating access token, so a routine refresh is still the same identity
 * while a different key under the same env variable is not. The payload
 * fingerprint hashes media *content* (decoded bytes of every data URI), so two
 * different images of the same size never collide.
 *
 * This is a local record only. It is not a server-side idempotency key and it
 * cannot guarantee the server did not bill a request whose response was lost.
 * Nothing secret is stored: no key material, no base64 media, no signed URLs —
 * only one-way digests.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "./atomic-file.js";
import { configDir } from "./credentials.js";
import { CliError } from "./errors.js";
import { withFileLock } from "./lock.js";
import { safeSegment } from "./paths.js";
import { VERSION } from "./version.js";

export type OperationState = "started" | "accepted" | "rejected" | "unknown" | "not_submitted";

export interface OperationRecord {
  schema_version: 1;
  operation_id: string;
  state: OperationState;
  resource: string;
  endpoint: string;
  api_origin: string;
  credential_fingerprint: string;
  payload_fingerprint: string;
  started_at: string;
  updated_at: string;
  task_id: string | null;
  request_id: string | null;
  http_status: number | null;
  error: string | null;
  pid: number;
  cli_version: string;
  /** Optional link to the project that owns the task (set by --project). */
  project: string | null;
}

export interface OperationIdentity {
  resource: string;
  endpoint: string;
  apiOrigin: string;
  credentialFingerprint: string;
  payloadFingerprint: string;
  project?: string | null;
}

export function operationsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "operations");
}

export function newOperationId(): string {
  return randomUUID();
}

export interface CredentialIdentityParts {
  /** Where the credential came from: flag | env | env-file | file. */
  source: string;
  /** Stored profile name (credentialSource === "file"). */
  profile?: string | null;
  /** API origin the credential is used against. */
  origin: string;
  /** api_key | oauth. */
  kind?: string;
  /** The static API key itself (api_key kinds). Digested with a domain prefix; never stored. */
  secret?: string | null;
  /** Stable account subject for OAuth profiles (user id). Tokens rotate; the subject does not. */
  subject?: string | null;
}

const CREDENTIAL_DIGEST_DOMAIN = "meshy-cli/credential-binding/v1";

/**
 * `sha256(source|profile|kind|origin|binding)` where the binding is a keyed
 * digest of the API key, or the OAuth subject. Two different keys from the same
 * source therefore have different fingerprints; a refreshed OAuth token keeps
 * its fingerprint as long as the account is the same. Never reversible to a key.
 */
export function credentialFingerprint(parts: CredentialIdentityParts): string {
  let binding: string;
  if (parts.kind === "oauth") {
    binding = parts.subject ? `subject:${parts.subject}` : "subject:unknown";
  } else if (parts.secret) {
    binding = `key:${sha256(`${CREDENTIAL_DIGEST_DOMAIN}|${parts.secret}`)}`;
  } else {
    binding = "key:none";
  }
  return sha256(`${parts.source}|${parts.profile ?? ""}|${parts.kind ?? ""}|${parts.origin}|${binding}`);
}

/**
 * Canonical JSON with every data URI replaced by `data:<mime>;sha256=<digest of
 * the decoded bytes>`: two submissions of the same file match (whatever the
 * base64 line wrapping), two different files of equal size do not, and the
 * journal never holds the content itself.
 */
export function payloadFingerprint(payload: unknown): string {
  return sha256(canonical(payload));
}

export function dataUriDigest(uri: string): string {
  const comma = uri.indexOf(",");
  const header = comma === -1 ? uri.slice(5) : uri.slice(5, comma);
  const payload = comma === -1 ? "" : uri.slice(comma + 1);
  const mime = (header.split(";")[0] ?? "").toLowerCase();
  const isBase64 = /(^|;)base64$/i.test(header) || /;base64(;|$)/i.test(header);
  let bytes: Buffer;
  if (isBase64) {
    bytes = Buffer.from(payload.replace(/\s+/g, ""), "base64");
  } else {
    let text = payload;
    try {
      text = decodeURIComponent(payload);
    } catch {
      /* keep the raw payload */
    }
    bytes = Buffer.from(text, "utf8");
  }
  return `data:${mime};sha256=${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "string" && /^data:/i.test(v)) {
      return JSON.stringify(dataUriDigest(v));
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function recordPath(root: string, id: string): string {
  return join(root, `${safeSegment(id, "op")}.json`);
}

function lockPath(root: string): string {
  return join(root, "locks", "operations.lock");
}

export function readOperation(root: string, id: string): OperationRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath(root, id), "utf8")) as OperationRecord;
    return raw && raw.schema_version === 1 ? raw : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError({ code: "local_io", message: `operation record ${recordPath(root, id)} is unreadable: ${(err as Error).message}` });
  }
}

export interface BeginResult {
  /** `created`: this process owns the submission. `existing`: an earlier run already has a record. */
  outcome: "created" | "existing";
  record: OperationRecord;
}

/**
 * Under the journal lock: return the existing record when one exists for
 * `operationId` with the same identity, throw `operation_conflict` when the
 * identity differs, or write a fresh `started` record and return it.
 */
export function beginOperation(root: string, operationId: string, identity: OperationIdentity, now: () => Date = () => new Date()): BeginResult {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return withFileLock(lockPath(root), () => {
    const existing = readOperation(root, operationId);
    if (existing) {
      const differs: string[] = [];
      if (existing.resource !== identity.resource) differs.push("resource");
      if (existing.api_origin !== identity.apiOrigin) differs.push("origin");
      if (existing.credential_fingerprint !== identity.credentialFingerprint) differs.push("credential");
      if (existing.payload_fingerprint !== identity.payloadFingerprint) differs.push("payload");
      if (differs.length > 0) {
        throw new CliError({
          code: "operation_conflict",
          message: `operation ${operationId} already exists for a different request (${differs.join(", ")} differ); nothing was submitted — use a new --operation-id for a new request`,
          result: { submission: { state: existing.state, operation_id: operationId, task_id: existing.task_id }, conflict: differs },
        });
      }
      return { outcome: "existing", record: existing };
    }
    const ts = now().toISOString();
    const record: OperationRecord = {
      schema_version: 1,
      operation_id: operationId,
      state: "started",
      resource: identity.resource,
      endpoint: identity.endpoint,
      api_origin: identity.apiOrigin,
      credential_fingerprint: identity.credentialFingerprint,
      payload_fingerprint: identity.payloadFingerprint,
      started_at: ts,
      updated_at: ts,
      task_id: null,
      request_id: null,
      http_status: null,
      error: null,
      pid: process.pid,
      cli_version: VERSION,
      project: identity.project ?? null,
    };
    writeJsonFile(recordPath(root, operationId), record, { overwrite: false, mode: 0o600 });
    return { outcome: "created", record };
  });
}

export function updateOperation(
  root: string,
  operationId: string,
  patch: Partial<Pick<OperationRecord, "state" | "task_id" | "request_id" | "http_status" | "error" | "project">>,
  now: () => Date = () => new Date(),
): OperationRecord {
  return withFileLock(lockPath(root), () => {
    const existing = readOperation(root, operationId);
    if (!existing) {
      throw new CliError({ code: "local_io", message: `operation record ${operationId} disappeared before it could be updated` });
    }
    const next: OperationRecord = { ...existing, ...patch, updated_at: now().toISOString() };
    writeJsonFile(recordPath(root, operationId), next, { overwrite: true, mode: 0o600 });
    return next;
  });
}

export function listOperations(root: string): OperationRecord[] {
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: OperationRecord[] = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(readFileSync(join(root, n), "utf8")) as OperationRecord;
      if (rec && rec.schema_version === 1) out.push(rec);
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}
