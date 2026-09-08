/**
 * Zod schemas for Meshy request/response shapes (permissive passthrough).
 *
 * `TaskSchema` fills a few defaults so 0.2.0 summaries keep their shape. The
 * v1 TaskView is built from the *raw* JSON (see task-view.ts), never from the
 * defaulted object, so a field the server did not send stays null there.
 */

import { z } from "zod";

export const BalanceSchema = z.object({
  balance: z.number(),
});
export type Balance = z.infer<typeof BalanceSchema>;

export const TaskErrorSchema = z
  .object({
    message: z.string().default(""),
  })
  .passthrough();
export type TaskError = z.infer<typeof TaskErrorSchema>;

export const TextureSetSchema = z
  .object({
    base_color: z.string().nullable().optional(),
    metallic: z.string().nullable().optional(),
    normal: z.string().nullable().optional(),
    roughness: z.string().nullable().optional(),
  })
  .passthrough();
export type TextureSet = z.infer<typeof TextureSetSchema>;

export const TaskStatusSchema = z.union([
  z.literal("PENDING"),
  z.literal("IN_PROGRESS"),
  z.literal("SUCCEEDED"),
  z.literal("FAILED"),
  z.literal("CANCELED"),
  z.string(),
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TERMINAL_STATUSES = new Set<string>(["SUCCEEDED", "FAILED", "CANCELED"]);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export const PrintabilitySchema = z
  .object({
    _version: z.string().optional(),
    status: z.string().optional(),
    issue_count: z.number().optional(),
    error_count: z.number().optional(),
    warning_count: z.number().optional(),
    metrics: z.record(z.string(), z.any()).optional(),
    evaluated_at: z.number().optional(),
  })
  .passthrough();
export type Printability = z.infer<typeof PrintabilitySchema>;

/** A count or epoch-millisecond field that a server may omit or send as null: absent and null both read as 0. */
const nullableNumberOr0 = z
  .number()
  .nullable()
  .optional()
  .transform((v) => v ?? 0);

export const TaskSchema = z
  .object({
    id: z.string(),
    type: z.string().default(""),
    name: z.string().nullable().optional(),
    status: z.string().default(""),
    // The v2 endpoints report 0 for a timestamp that has not happened yet; the
    // Creative Lab endpoints report null (observed live: finished_at: null while
    // IN_PROGRESS). Both mean "not yet" and normalise to 0.
    progress: nullableNumberOr0,
    preceding_tasks: nullableNumberOr0,

    created_at: nullableNumberOr0,
    started_at: nullableNumberOr0,
    finished_at: nullableNumberOr0,
    expires_at: nullableNumberOr0,

    task_error: TaskErrorSchema.nullable().optional(),

    model_urls: z.record(z.string(), z.string().nullable()).nullable().optional(),
    texture_urls: z.array(TextureSetSchema).nullable().optional(),
    thumbnail_url: z.string().nullable().optional(),
    thumbnail_urls: z.record(z.string(), z.string().nullable()).nullable().optional(),
    alpha_thumbnail_url: z.string().nullable().optional(),

    image_urls: z.array(z.string()).nullable().optional(),

    result: z.record(z.string(), z.any()).nullable().optional(),

    printability: PrintabilitySchema.nullable().optional(),

    face_count: z.number().nullable().optional(),
    consumed_credits: z.number().nullable().optional(),

    ai_model: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    texture_prompt: z.string().nullable().optional(),
    texture_image_url: z.string().nullable().optional(),
    text_style_prompt: z.string().nullable().optional(),
    image_style_url: z.string().nullable().optional(),
  })
  .passthrough();
export type Task = z.infer<typeof TaskSchema>;

export const TaskCreateResponseSchema = z.object({
  result: z.string(),
});
export type TaskCreateResponse = z.infer<typeof TaskCreateResponseSchema>;

export interface TaskSummary {
  id: string;
  status: string;
  type?: string;
  progress?: number;
  created_at?: number;
  finished_at?: number;
  model_urls?: Record<string, string | null> | null;
  texture_urls?: TextureSet[] | null;
  thumbnail_url?: string | null;
  image_urls?: string[] | null;
  result?: Record<string, unknown> | null;
  printability?: Printability | null;
  task_error?: TaskError | null;
  elapsed_seconds?: number;
}

/** Legacy (0.2.0) summary — shape preserved for existing consumers. */
export function summarizeTask(task: Task, elapsedSeconds?: number): TaskSummary {
  const summary: TaskSummary = {
    id: task.id,
    status: task.status,
    type: task.type,
    progress: task.progress,
    created_at: task.created_at,
    finished_at: task.finished_at,
  };
  if (task.model_urls != null) summary.model_urls = task.model_urls;
  if (task.texture_urls != null) summary.texture_urls = task.texture_urls;
  if (task.thumbnail_url != null) summary.thumbnail_url = task.thumbnail_url;
  if (task.image_urls != null) summary.image_urls = task.image_urls;
  if (task.result != null) summary.result = task.result as Record<string, unknown>;
  if (task.printability != null) summary.printability = task.printability;
  if (task.task_error != null) summary.task_error = task.task_error;
  if (elapsedSeconds !== undefined) summary.elapsed_seconds = Number(elapsedSeconds.toFixed(2));
  return summary;
}
