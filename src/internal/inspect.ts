/**
 * Face-count gate — the verdict logic behind `meshy inspect faces`.
 *
 * Nothing here fabricates a number: a missing face_count is never 0, and a
 * model that was never measured never passes. Only a finite, non-negative
 * integer that the task actually carries is "known"; everything else is
 * `unknown`, which the command turns into exit 13 rather than a pass (D-009). Strings are never parsed into numbers — a
 * `"1234"` that the server never meant as a count must not become one here.
 *
 * The gate answers exactly one question — is face_count <= the caller's limit?
 * It knows nothing about rigging eligibility (mesh shape, textures, humanoid
 * proportions), so nothing in this module says "rig-ready". When it fails it
 * can describe a remesh that would help; it never runs one.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isTerminalStatus } from "../client/types.js";
import { UsageError } from "./errors.js";

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

/** Task ids and paths are echoed into a shell command only when they are plain tokens. */
const SAFE_TOKEN = /^[A-Za-z0-9._:/-]+$/;

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

/** What a failing count was measured on: a task (by id) or a local model file. */
export type InspectedSubject = { taskId: string | null } | { modelPath: string };

/**
 * Describe — never execute — the remesh that would bring a model under `limit`.
 * The target is clamped to the range the remesh endpoint accepts.
 */
export function remeshSuggestion(subject: InspectedSubject, limit: number): RemeshSuggestion {
  const target = Math.min(Math.max(Math.trunc(limit), REMESH_POLYCOUNT_RANGE.min), REMESH_POLYCOUNT_RANGE.max);
  const flags = `--target-polycount ${target}`;
  const [input, value] = "modelPath" in subject ? ["--model-url", subject.modelPath] : ["--input-task-id", subject.taskId];
  if (value && SAFE_TOKEN.test(value)) {
    const command = `meshy remesh create ${input} ${value} ${flags}`;
    return {
      description: `Reduce the polycount with a remesh task targeting ${target} faces (billable; not executed by inspect — run it yourself): ${command}`,
      command,
      executed: false,
    };
  }
  const why = value ? `the ${"modelPath" in subject ? "path" : "task id"} contains characters that are not safe to echo into a command` : "the source task id is unknown";
  return {
    description: `Reduce the polycount with a remesh task targeting ${target} faces (billable; not executed by inspect). ${why}; run: meshy remesh create --model-url <file-or-url> ${flags}`,
    command: null,
    executed: false,
  };
}

// ---------------------------------------------------------------------------
// Counting a local model: the face count the API does not report
// ---------------------------------------------------------------------------

/** Engineering limit for the glTF JSON read from a local model (D-018). */
export const MODEL_JSON_MAX_BYTES = 64 * 1024 * 1024;

export interface ModelFaceCount {
  path: string;
  format: "glb" | "gltf";
  /** Triangles of every mesh instance in the default scene. */
  triangles: number;
  mesh_instances: number;
}

interface GltfJson {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{ mesh?: number; children?: number[] }>;
  meshes?: Array<{ primitives?: Array<{ mode?: number; indices?: number; attributes?: Record<string, number> }> }>;
  accessors?: Array<{ count?: number }>;
}

/**
 * Count the triangles of a local .glb / .gltf from its JSON alone — accessor
 * counts, no geometry decoded, so Draco/meshopt-compressed files count too.
 * Every mesh instance of the default scene counts (a mesh used by two nodes
 * is drawn twice); triangle strips and fans count `n - 2`; points and lines
 * have no faces. Every problem with the file is a usage error naming it.
 */
export function countModelFaces(path: string, opts: { cwd?: string; maxJsonBytes?: number } = {}): ModelFaceCount {
  const abs = resolvePath(opts.cwd ?? process.cwd(), path);
  const maxJson = opts.maxJsonBytes ?? MODEL_JSON_MAX_BYTES;
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch (err) {
    throw new UsageError(`--model: cannot open ${path} (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
  }
  let format: ModelFaceCount["format"];
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) throw new UsageError(`--model: not a regular file: ${path}`);
    const header = Buffer.alloc(20);
    const got = readSync(fd, header, 0, 20, 0);
    if (got >= 4 && header.toString("ascii", 0, 4) === "glTF") {
      format = "glb";
      if (got < 20 || header.readUInt32LE(4) !== 2 || header.toString("ascii", 16, 20) !== "JSON") {
        throw new UsageError(`--model: ${path} is not a glTF 2.0 binary (bad header or first chunk)`);
      }
      const jsonLength = header.readUInt32LE(12);
      if (jsonLength > maxJson) throw new UsageError(`--model: ${path} has a ${jsonLength}-byte JSON chunk, above the ${maxJson}-byte limit`);
      const json = Buffer.alloc(jsonLength);
      if (readSync(fd, json, 0, jsonLength, 20) !== jsonLength) throw new UsageError(`--model: ${path} is truncated (JSON chunk)`);
      text = json.toString("utf8");
    } else {
      format = "gltf";
      const size = fstatSync(fd).size;
      if (size > maxJson) throw new UsageError(`--model: ${path} is ${size} bytes, above the ${maxJson}-byte limit for a .gltf (use the .glb)`);
      const all = Buffer.alloc(size);
      readSync(fd, all, 0, size, 0);
      text = all.toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
  let json: GltfJson;
  try {
    json = JSON.parse(text) as GltfJson;
  } catch {
    throw new UsageError(`--model: ${path} is not a .glb or .gltf model`);
  }
  const malformed = (what: string): UsageError => new UsageError(`--model: ${path} is malformed (${what})`);
  const meshTriangles = (meshIndex: number): number => {
    const mesh = json.meshes?.[meshIndex];
    if (!mesh) throw malformed(`node references mesh ${meshIndex}, which does not exist`);
    let total = 0;
    for (const prim of mesh.primitives ?? []) {
      const accessorIndex = prim.indices ?? prim.attributes?.["POSITION"];
      const count = accessorIndex === undefined ? undefined : json.accessors?.[accessorIndex]?.count;
      if (typeof count !== "number") throw malformed(`mesh ${meshIndex} has a primitive without a counted accessor`);
      const mode = prim.mode ?? 4;
      if (mode === 4) total += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) total += Math.max(0, count - 2);
    }
    return total;
  };
  let triangles = 0;
  let instances = 0;
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) {
    const visited = new Set<number>();
    const stack = [...(scene.nodes ?? [])];
    while (stack.length > 0) {
      const index = stack.pop()!;
      if (visited.has(index)) throw malformed(`node ${index} is reached twice`);
      visited.add(index);
      const node = json.nodes?.[index];
      if (!node) throw malformed(`scene references node ${index}, which does not exist`);
      if (node.mesh !== undefined) {
        triangles += meshTriangles(node.mesh);
        instances += 1;
      }
      stack.push(...(node.children ?? []));
    }
  } else {
    // No scene: every mesh once.
    for (let i = 0; i < (json.meshes?.length ?? 0); i++) triangles += meshTriangles(i);
    instances = json.meshes?.length ?? 0;
  }
  return { path: abs, format, triangles, mesh_instances: instances };
}
