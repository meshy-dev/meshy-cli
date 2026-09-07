/**
 * Async-task endpoint over one Transport:
 *   POST   /<resource>               → { result: <task_id> }
 *   GET    /<resource>/:id           → Task
 *   GET    /<resource>               → Task[]
 *   DELETE /<resource>/:id           → 200
 *   GET    /<resource>/:id/stream    → text/event-stream
 *
 * The `*Detailed` variants also return the raw JSON exactly as received, which
 * is what --save-json, --include-raw and the v1 TaskView are built from.
 */

import { MeshyApiError } from "../errors.js";
import type { Transport, StreamHandle } from "../transport.js";
import {
  TaskCreateResponseSchema,
  TaskSchema,
  type Task,
} from "../types.js";

/** Legacy fetch signature kept for the `api` passthrough and older call sites. */
export type HttpFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ListParams {
  page_num?: number;
  page_size?: number;
  sort_by?: string;
}

export interface CreateResult {
  taskId: string;
  raw: unknown;
  requestId: string | null;
}

export interface RetrieveResult {
  task: Task;
  raw: unknown;
}

export interface ListResult {
  tasks: Task[];
  raw: unknown;
}

export interface RequestExtras {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class TaskEndpoint {
  readonly resourcePath: string;
  protected readonly transport: Transport;

  constructor(transport: Transport, resourcePath: string) {
    if (!resourcePath.startsWith("/")) {
      throw new Error(`resourcePath must start with "/" (got ${resourcePath})`);
    }
    this.transport = transport;
    this.resourcePath = resourcePath;
  }

  /** Base URL of the API family this endpoint talks to (for journaling the origin). */
  get transportBaseUrl(): string {
    return this.transport.baseUrl;
  }

  async create(payload: Record<string, unknown>, extras: RequestExtras = {}): Promise<string> {
    return (await this.createDetailed(payload, extras)).taskId;
  }

  async createDetailed(payload: Record<string, unknown>, extras: RequestExtras = {}): Promise<CreateResult> {
    const resp = await this.transport.requestJson("POST", this.resourcePath, {
      body: payload ?? {},
      signal: extras.signal,
      timeoutMs: extras.timeoutMs,
    });
    const parsed = TaskCreateResponseSchema.safeParse(resp.json);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected response from POST ${this.resourcePath}: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path: this.resourcePath,
        body: resp.json,
      });
    }
    return { taskId: parsed.data.result, raw: resp.json, requestId: resp.requestId };
  }

  async retrieve(taskId: string, extras: RequestExtras = {}): Promise<Task> {
    return (await this.retrieveDetailed(taskId, extras)).task;
  }

  async retrieveDetailed(taskId: string, extras: RequestExtras = {}): Promise<RetrieveResult> {
    if (!taskId) throw new Error("task_id is required");
    const path = `${this.resourcePath}/${encodeURIComponent(taskId)}`;
    const resp = await this.transport.requestJson("GET", path, { signal: extras.signal, timeoutMs: extras.timeoutMs });
    const parsed = TaskSchema.safeParse(resp.json);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected task shape from GET ${path}: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path,
        body: resp.json,
      });
    }
    return { task: parsed.data, raw: resp.json };
  }

  async list(params: ListParams = {}, extras: RequestExtras = {}): Promise<Task[]> {
    return (await this.listDetailed(params, extras)).tasks;
  }

  async listDetailed(params: ListParams = {}, extras: RequestExtras = {}): Promise<ListResult> {
    const resp = await this.transport.requestJson("GET", this.resourcePath, {
      query: {
        page_num: params.page_num ?? 1,
        page_size: params.page_size ?? 10,
        sort_by: params.sort_by ?? "-created_at",
      },
      signal: extras.signal,
      timeoutMs: extras.timeoutMs,
    });
    const raw = resp.json;
    if (!Array.isArray(raw)) return { tasks: [], raw };
    const tasks = raw.map((t) => {
      const parsed = TaskSchema.safeParse(t);
      return parsed.success ? parsed.data : (t as Task);
    });
    return { tasks, raw };
  }

  async delete(taskId: string, extras: RequestExtras = {}): Promise<unknown> {
    if (!taskId) throw new Error("task_id is required");
    const path = `${this.resourcePath}/${encodeURIComponent(taskId)}`;
    const resp = await this.transport.requestJson("DELETE", path, { signal: extras.signal, timeoutMs: extras.timeoutMs });
    return resp.json;
  }

  streamPath(taskId: string): string {
    if (!taskId) throw new Error("task_id is required");
    return `${this.resourcePath}/${encodeURIComponent(taskId)}/stream`;
  }

  /** Open the SSE connection; the caller parses events and owns the deadlines. */
  async openStream(taskId: string, opts: { signal?: AbortSignal; connectTimeoutMs?: number } = {}): Promise<StreamHandle> {
    return this.transport.openStream(this.streamPath(taskId), opts);
  }
}
