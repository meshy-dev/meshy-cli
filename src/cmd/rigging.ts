/**
 * rigging — https://docs.meshy.ai/en/api/rigging
 * Note: Meshy does not expose a list endpoint for rigging.
 */

import { parseNumber } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "rigging",
  description:
    "Rig a 3D model with a bipedal humanoid skeleton (skinning included). Returns the rigged " +
    "character as GLB + FBX plus bundled walking and running animations at no extra cost. " +
    "Input must be GLB with under 300k faces — remesh to ~10000 first if denser. Not suitable " +
    "for non-humanoid assets or models with unclear limb structure",
  supportsList: false,
  create: {
    description: "Create a rigging task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "source Meshy task id (takes priority over --model-url)")
        .option("--model-url <src>", "textured humanoid .glb as http(s) URL or local file path")
        .option(
          "--height-meters <m>",
          "approximate character height in meters (default: 1.7) — drives bone proportions",
          parseNumber,
        );
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        height_meters: opts.heightMeters,
      };
    },
    toDefaults() {
      return { height_meters: 1.7 };
    },
  },
  endpointOf: (c) => c.rigging,
};

export const riggingCommand = buildResourceCommand(spec);
