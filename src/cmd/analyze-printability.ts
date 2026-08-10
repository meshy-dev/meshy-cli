/**
 * analyze-printability — https://docs.meshy.ai/en/api/analyze-printability
 * Inspect a 3D model for 3D-printing issues (watertight, manifold, holes…).
 * Produces a `printability` report on the task — no downloadable model files.
 * Free endpoint (consumes 0 credits).
 */

import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "analyze-printability",
  description:
    "Diagnose whether a 3D model is ready for 3D printing — overall status " +
    "(healthy/warning/error), issue counts, and geometry metrics (watertight, volume, " +
    "non-manifold edges, degenerate faces, holes). Produces a report, not files",
  create: {
    description: "Create an analyze-printability task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "source SUCCEEDED task (image-to-3d, multi-image-to-3d, text-to-3d, remesh, or retexture using Meshy 6+)")
        .option("--model-url <src>", "3D model as http(s) URL or local file path (.glb/.gltf/.obj/.fbx/.stl, max 100MB)");
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
      };
    },
  },
  endpointOf: (c) => c.analyzePrintability,
};

export const analyzePrintabilityCommand = buildResourceCommand(spec);
