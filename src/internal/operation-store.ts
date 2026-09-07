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
 * This is a local record only. It is not a server-side idempotency key and it
 * cannot guarantee the server did not bill a request whose response was lost.
 * Nothing secret is stored: no key material, no base64 media, no signed URLs.
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

/** `sha256(source|profile|origin)` — enough to detect a different identity, never reversible to a key. */
export function credentialFingerprint(parts: { source: string; profile?: string | null; origin: string; kind?: string }): string {
  return sha256(`${parts.source}|${parts.profile ?? ""}|${parts.kind ?? ""}|${parts.origin}`);
}

/**
 * Canonical JSON with data URIs reduced to their MIME and length so two
 * submissions of the same local file match while the journal never holds the
 * file content.
 */
export function payloadFingerprint(payload: unknown): string {
  return sha256(canonical(payload));
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "string" && v.startsWith("data:")) {
      const semi = v.indexOf(";");
      const comma = v.indexOf(",");
      const mime = v.slice(5, semi === -1 ? comma : Math.min(semi, comma === -1 ? v.length : comma));
      return JSON.stringify(`data:${mime};len=${v.length}`);
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
      if (
        existing.resource !== identity.resource ||
        existing.api_origin !== identity.apiOrigin ||
        existing.credential_fingerprint !== identity.credentialFingerprint ||
        existing.payload_fingerprint !== identity.payloadFingerprint
      ) {
        throw new CliError({
          code: "operation_conflict",
          message: `operation ${operationId} already exists for a different request (resource/origin/credential/payload differ); nothing was submitted`,
          result: { submission: { state: existing.state, operation_id: operationId, task_id: existing.task_id } },
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
