/**
 * Face-count gate — the verdict logic behind `meshy inspect faces`.
 *
 * The legacy Skill's check-faces script defaulted a missing face_count to 0 and
 * printed a passing line for a model it never measured. Nothing here fabricates
 * a number: only a finite, non-negative integer that the task actually carries
 * is "known"; everything else is `unknown`, which the command turns into exit
 * 13 rather than a pass (D-009). Strings are never parsed into numbers — a
 * `"1234"` that the server never meant as a count must not become one here.
 *
 * The gate answers exactly one question — is face_count <= the caller's limit?
 * It knows nothing about rigging eligibility (mesh shape, textures, humanoid
 * proportions), so nothing in this module says "rig-ready". When it fails it
 * can describe a remesh that would help; it never runs one.
 */

import { isTerminalStatus } from "../client/types.js";

export type FaceVerdictKind = "pass" | "fail" | "unknown";

export interface FaceVerdict {
  /** The measured value when known, null for `unknown` (never a substituted 0). */
  face_count: number | null;
  limit: number;
  comparison: "lte";
  verdict: FaceVerdictKind;
  /** Why the verdict is `fail` or `unknown`; null for `pass`. */
  reason: string | null;
}

export interface FaceCountSource {
  /** The raw value exactly as the task carries it (undefined when absent). */
  value: unknown;
  /** Where the value came from; `none` when the task has no top-level face_count key. */
  source: "face_count" | "none";
  status: string | null;
}

export interface RemeshSuggestion {
  description: string;
  /** A command the caller may run; null when it cannot be built safely. */
  command: string | null;
  /** Always false: inspect never submits a billable task. */
  executed: false;
}

/** The remesh endpoint's accepted target_polycount range (see cmd/remesh.ts). */
export const REMESH_POLYCOUNT_RANGE = { min: 100, max: 300_000 } as const;

/** Task ids are echoed into a shell command only when they are plain tokens. */
const SAFE_TASK_ID = /^[A-Za-z0-9._:-]+$/;

function assertLimit(limit: number): void {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`face-count limit must be a positive integer (got ${String(limit)})`);
  }
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Judge a raw face_count against `limit`. Only a finite, non-negative integer is
 * a known count; `<= limit` passes, anything larger fails, everything else is
 * unknown with a reason that names what was wrong.
 */
export function judgeFaceCount(raw: unknown, limit: number): FaceVerdict {
  assertLimit(limit);
  const unknown = (reason: string): FaceVerdict => ({ face_count: null, limit, comparison: "lte", verdict: "unknown", reason });
  if (raw === undefined) return unknown("face_count missing");
  if (raw === null) return unknown("face_count is null");
  if (typeof raw === "string") {
    const shown = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
    return unknown(`face_count is a string, not a number (${JSON.stringify(shown)} is not parsed)`);
  }
  if (typeof raw !== "number") return unknown(`face_count is not a number (got ${describe(raw)})`);
  if (!Number.isFinite(raw)) return unknown(`face_count is not a finite number (got ${String(raw)})`);
  if (!Number.isInteger(raw) || raw < 0) return unknown(`face_count is not a non-negative integer (got ${raw})`);
  if (raw <= limit) return { face_count: raw, limit, comparison: "lte", verdict: "pass", reason: null };
  return {
    face_count: raw,
    limit,
    comparison: "lte",
    verdict: "fail",
    reason: `face_count ${raw} exceeds the limit ${limit} by ${raw - limit}`,
  };
}

/**
 * Read the top-level `face_count` of a task object. Nothing is derived from
 * other fields and nothing is defaulted: an absent key is reported as absent.
 */
export function faceCountFromTask(task: Record<string, unknown>): FaceCountSource {
  const status = typeof task["status"] === "string" ? (task["status"] as string) : null;
  if (Object.prototype.hasOwnProperty.call(task, "face_count")) {
    return { value: task["face_count"], source: "face_count", status };
  }
  return { value: undefined, source: "none", status };
}

/**
 * Judge a whole task: the top-level face_count against `limit`. A task that
 * has not finished and carries no count is unknown *because it is still
 * running* — the reason says so instead of implying the field will never come.
 */
export function judgeTask(task: Record<string, unknown>, limit: number): FaceVerdict {
  const { value, status } = faceCountFromTask(task);
  const verdict = judgeFaceCount(value, limit);
  if (verdict.verdict === "unknown" && (value === undefined || value === null) && status !== null && !isTerminalStatus(status)) {
    return { ...verdict, reason: `task is ${status}; no face count yet` };
  }
  return verdict;
}

/**
 * Describe — never execute — the remesh that would bring a model under `limit`.
 * The target is clamped to the range the remesh endpoint accepts.
 */
export function remeshSuggestion(taskId: string | null, limit: number): RemeshSuggestion {
  const target = Math.min(Math.max(Math.trunc(limit), REMESH_POLYCOUNT_RANGE.min), REMESH_POLYCOUNT_RANGE.max);
  const flags = `--target-polycount ${target} --output-schema v1`;
  if (taskId && SAFE_TASK_ID.test(taskId)) {
    const command = `meshy remesh create --input-task-id ${taskId} ${flags}`;
    return {
      description: `Reduce the polycount with a remesh task targeting ${target} faces (billable; not executed by inspect — run it yourself): ${command}`,
      command,
      executed: false,
    };
  }
  const why = taskId ? "the task id contains characters that are not safe to echo into a command" : "the source task id is unknown";
  return {
    description: `Reduce the polycount with a remesh task targeting ${target} faces (billable; not executed by inspect). ${why}; run: meshy remesh create --model-url <file-or-url> ${flags}`,
    command: null,
    executed: false,
  };
}
