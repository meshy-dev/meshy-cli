/**
 * Smart Topology models, shared by image-to-3d and text-to-3d preview so the
 * two commands cannot drift apart.
 *
 * The CLI pins meshy-t2.5 when Smart Topology has no explicit ai_model.
 * meshy-t2.5 takes a polycount up to 30,000 (meshy-t2: 15,000).
 * Both need model_type "smart-topology", and both output triangles only.
 */

import { UsageError } from "./errors.js";

export const SMART_TOPOLOGY_MODELS = ["meshy-t2", "meshy-t2.5"] as const;
export const DEFAULT_SMART_TOPOLOGY_MODEL = "meshy-t2.5";

const MAX_POLYCOUNT: Readonly<Record<string, number>> = { "meshy-t2": 15_000, "meshy-t2.5": 30_000 };

/** Applies conditional defaults and validates after --data and flags have merged. */
export function prepareSmartTopologyPayload(payload: Record<string, unknown>): void {
  const smart = payload.model_type === "smart-topology";
  if (smart) {
    payload.ai_model ??= DEFAULT_SMART_TOPOLOGY_MODEL;
    // Keep the explicit T2 option's rigging-friendly 10k default; T2.5 uses
    // the API's own 15k. Resolve this after merging so --data works like flags.
    if (payload.ai_model === "meshy-t2") payload.target_polycount ??= 10_000;
  }
  const model = typeof payload.ai_model === "string" ? payload.ai_model : undefined;
  if (model && model in MAX_POLYCOUNT && !smart) {
    throw new UsageError(`${model} is a Smart Topology model: pass --model-type smart-topology`);
  }
  if (!smart) return;
  if (payload.topology === "quad") {
    throw new UsageError("smart-topology output is triangle-only; for quads chain `remesh --topology quad` afterwards");
  }
  const n = payload.target_polycount;
  const max = MAX_POLYCOUNT[model ?? "meshy-t2"]; // another model sent through --data is left to the API
  if (max !== undefined && typeof n === "number" && (n < 100 || n > max)) {
    throw new UsageError(
      model === "meshy-t2.5"
        ? "--target-polycount must be between 100 and 30000 on meshy-t2.5"
        : "--target-polycount must be between 100 and 15000 on meshy-t2 (--ai-model meshy-t2.5 takes up to 30000)",
    );
  }
}
