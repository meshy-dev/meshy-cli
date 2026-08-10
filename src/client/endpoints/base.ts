/**
 * Base class for async-task Meshy endpoints:
 *   POST   /<resource>               → { result: <task_id> }
 *   GET    /<resource>/:id           → Task
 *   GET    /<resource>               → Task[]
 *   DELETE /<resource>/:id           → 200
 */

import { mapHttpError, MeshyApiError } from "../errors.js";
import {
  TaskCreateResponseSchema,
  TaskSchema,
  type Task,
} from "../types.js";

export type HttpFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ListParams {
  page_num?: number;
  page_size?: number;
  sort_by?: string;
}

export class TaskEndpoint {
  readonly resourcePath: string;
  protected readonly http: HttpFetch;

  constructor(http: HttpFetch, resourcePath: string) {
    if (!resourcePath.startsWith("/")) {
      throw new Error(`resourcePath must start with "/" (got ${resourcePath})`);
    }
    this.http = http;
    this.resourcePath = resourcePath;
  }

  async create(payload: Record<string, unknown>): Promise<string> {
    const resp = await this.http(this.resourcePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    if (!resp.ok) throw await mapHttpError(resp, this.resourcePath);
    const raw: unknown = await resp.json();
    const parsed = TaskCreateResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected response from POST ${this.resourcePath}: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path: this.resourcePath,
        body: raw,
      });
    }
    return parsed.data.result;
  }

  async retrieve(taskId: string): Promise<Task> {
    if (!taskId) throw new Error("task_id is required");
    const path = `${this.resourcePath}/${encodeURIComponent(taskId)}`;
    const resp = await this.http(path, { method: "GET" });
    if (!resp.ok) throw await mapHttpError(resp, path);
    const raw: unknown = await resp.json();
    const parsed = TaskSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MeshyApiError({
        message: `unexpected task shape from GET ${path}: ${parsed.error.message}`,
        status: resp.status,
        code: "server",
        path,
        body: raw,
      });
    }
    return parsed.data;
  }

  async list(params: ListParams = {}): Promise<Task[]> {
    const search = new URLSearchParams();
    search.set("page_num", String(params.page_num ?? 1));
    search.set("page_size", String(params.page_size ?? 10));
    search.set("sort_by", params.sort_by ?? "-created_at");
    const path = `${this.resourcePath}?${search.toString()}`;
    const resp = await this.http(path, { method: "GET" });
    if (!resp.ok) throw await mapHttpError(resp, this.resourcePath);
    const raw: unknown = await resp.json();
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => {
      const parsed = TaskSchema.safeParse(t);
      return parsed.success ? parsed.data : (t as Task);
    });
  }

  async delete(taskId: string): Promise<void> {
    if (!taskId) throw new Error("task_id is required");
    const path = `${this.resourcePath}/${encodeURIComponent(taskId)}`;
    const resp = await this.http(path, { method: "DELETE" });
    if (!resp.ok) throw await mapHttpError(resp, path);
  }
}
