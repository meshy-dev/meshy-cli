/**
 * uv-unwrap — https://docs.meshy.ai/en/api/uv-unwrap
 *
 * Generates fresh UVs for a GLB (≤ 40,000 faces) and returns a "UV white
 * model" (grey placeholder material, no textures) for external texturing.
 *
 * Exactly one source is accepted — `--input-task-id` or `--model-url` — also
 * when supplied through --data. The server would prefer input_task_id if both
 * were sent; refusing the ambiguity here is cheaper than a surprise. Input
 * files must be GLB. A face count above 40k is the server's call (400); the
 * CLI never downloads a model just to pre-count faces — `meshy inspect faces`
 * answers that from a saved task when the field is available.
 */

import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

export const UV_UNWRAP_FACE_CEILING = 40_000;

const spec: ResourceCommandSpec = {
  name: "uv-unwrap",
  defaultSchema: "v1",
  description:
    "Generate fresh UVs for a GLB model (input task or GLB file, at most 40k faces) — outputs a UV " +
    "white model for external texturing. Remesh first if the mesh is denser",
  create: {
    description: "Create a uv-unwrap task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "SUCCEEDED source task with a GLB output (mutually exclusive with --model-url)")
        .option("--model-url <src>", "GLB model as http(s) URL, data: URI or local .glb path (mutually exclusive with --input-task-id)");
    },
    toPayload(opts) {
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
      };
    },
    validatePayload(payload) {
      const hasTask = payload.input_task_id !== undefined && payload.input_task_id !== null && payload.input_task_id !== "";
      const hasModel = payload.model_url !== undefined && payload.model_url !== null && payload.model_url !== "";
      if (hasTask && hasModel) {
        throw new UsageError("uv-unwrap takes exactly one source: --input-task-id or --model-url (also inside --data), not both");
      }
      if (!hasTask && !hasModel) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      if (hasTask && typeof payload.input_task_id !== "string") throw new UsageError("input_task_id must be a string");
      if (hasModel && typeof payload.model_url !== "string") throw new UsageError("model_url must be a string");
    },
  },
};

export const uvUnwrapCommand = buildResourceCommand(spec);
