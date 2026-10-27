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
  /** Credits that expire at `monthly_resets_at`; normally balance = monthly + permanent. */
  monthly_credits: z.number().optional(),
  permanent_credits: z.number().optional(),
  /** Epoch ms of the next monthly refresh; null when none is scheduled. */
  monthly_resets_at: z.number().nullable().optional(),
});
export type Balance = z.infer<typeof BalanceSchema>;

export const TaskErrorSchema = z
  .object({
    message: z.string().default(""),
  })
  .passthrough();

export const TextureSetSchema = z
  .object({
    base_color: z.string().nullable().optional(),
    metallic: z.string().nullable().optional(),
    normal: z.string().nullable().optional(),
    roughness: z.string().nullable().optional(),
  })
  .passthrough();

export const TaskStatusSchema = z.union([
  z.literal("PENDING"),
  z.literal("IN_PROGRESS"),
  z.literal("SUCCEEDED"),
  z.literal("FAILED"),
  z.literal("CANCELED"),
  z.string(),
]);

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

