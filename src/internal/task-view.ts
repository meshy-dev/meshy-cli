/**
 * TaskView — the canonical v1 task summary.
 *
 * Built from the raw JSON the server returned, not from the Zod-defaulted
 * object: a field the server omitted is `null` here (never 0 or ""), so a
 * missing face_count cannot masquerade as "zero faces". `raw` is attached only
 * when the caller asked for it (--include-raw).
 */

import type { TaskResourceDescriptor } from "../client/resource-registry.js";

export interface TaskView {
  task_id: string;
  resource: string | null;
  endpoint: string | null;
  type: string | null;
  name: string | null;
  status: string | null;
  progress: number | null;
  preceding_tasks: number | null;
  created_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number | null;
  face_count: number | null;
  consumed_credits: number | null;
  model_urls: Record<string, string | null>;
  image_urls: string[];
  texture_urls: Array<Record<string, string | null>>;
  thumbnail_url: string | null;
  thumbnail_urls: Record<string, string | null> | null;
  alpha_thumbnail_url: string | null;
  result: Record<string, unknown> | null;
  printability: Record<string, unknown> | null;
  task_error: { message: string | null; [k: string]: unknown } | null;
  /** Full response as received, only when --include-raw was given. */
  raw?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strRecord(v: unknown): Record<string, string | null> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | null> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === "string" ? val : null;
  }
  return out;
}

export interface TaskViewOptions {
  descriptor?: TaskResourceDescriptor | null;
  includeRaw?: boolean;
  /** Explicit endpoint when there is no descriptor (e.g. a saved task JSON without resource). */
  endpoint?: string | null;
}

/**
 * Normalise a raw task object. Throws only when there is no usable `id`; every
 * other field degrades to null so a partial server payload still yields a view.
 */
export function toTaskView(raw: unknown, opts: TaskViewOptions = {}): TaskView {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("task payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : typeof r["task_id"] === "string" ? (r["task_id"] as string) : "";
  if (!id) throw new Error("task payload has no id");
  const taskError = r["task_error"];
  const view: TaskView = {
    task_id: id,
    resource: opts.descriptor?.id ?? null,
    endpoint: opts.descriptor?.legacyEndpoint ?? opts.endpoint ?? null,
    type: str(r["type"]),
    name: str(r["name"]),
    status: str(r["status"]),
    progress: num(r["progress"]),
    preceding_tasks: num(r["preceding_tasks"]),
    created_at: num(r["created_at"]),
    started_at: num(r["started_at"]),
    finished_at: num(r["finished_at"]),
    expires_at: num(r["expires_at"]),
    face_count: num(r["face_count"]),
    consumed_credits: num(r["consumed_credits"]),
    model_urls: strRecord(r["model_urls"]) ?? {},
    image_urls: Array.isArray(r["image_urls"]) ? (r["image_urls"] as unknown[]).filter((u): u is string => typeof u === "string") : [],
    texture_urls: Array.isArray(r["texture_urls"])
      ? (r["texture_urls"] as unknown[]).map((set) => strRecord(set) ?? {})
      : [],
    thumbnail_url: str(r["thumbnail_url"]),
    thumbnail_urls: strRecord(r["thumbnail_urls"]),
    alpha_thumbnail_url: str(r["alpha_thumbnail_url"]),
    result: r["result"] && typeof r["result"] === "object" && !Array.isArray(r["result"]) ? (r["result"] as Record<string, unknown>) : null,
    printability: r["printability"] && typeof r["printability"] === "object" ? (r["printability"] as Record<string, unknown>) : null,
    task_error:
      taskError && typeof taskError === "object"
        ? { ...(taskError as Record<string, unknown>), message: str((taskError as Record<string, unknown>)["message"]) }
        : null,
  };
  if (opts.includeRaw) view.raw = raw;
  return view;
}

/** Accept a task JSON in any of the shapes the CLI has written or the API returns. */
export function extractTaskObject(input: unknown): { task: Record<string, unknown>; source: "api" | "meta.json" | "v1-envelope" | "v1-result" } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (typeof o["id"] === "string" && typeof o["status"] === "string") return { task: o, source: "api" };
  const meta = o["task"];
  if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>)["id"] === "string") {
    return { task: meta as Record<string, unknown>, source: "meta.json" };
  }
  const result = o["result"];
  if (result && typeof result === "object") {
    const rt = (result as Record<string, unknown>)["task"];
    if (rt && typeof rt === "object" && typeof (rt as Record<string, unknown>)["task_id"] === "string") {
      const view = rt as Record<string, unknown>;
      // A v1 TaskView carries the same fields under task_id; fold it back.
      const raw = view["raw"];
      if (raw && typeof raw === "object") return { task: raw as Record<string, unknown>, source: "v1-envelope" };
      return { task: { ...view, id: view["task_id"] }, source: "v1-result" };
    }
  }
  return null;
}
