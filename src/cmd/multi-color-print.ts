/**
 * multi-color-print — https://docs.meshy.ai/en/api/multi-color-print
 * Converts a SUCCEEDED 3D task into a multi-color 3MF print file.
 */

import { parseInt10 } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "multi-color-print",
  description:
    "Convert a 3D model into multi-color 3MF format for 3D printing, with a configurable " +
    "color palette of up to 16 colors",
  create: {
    description: "Create a multi-color-print task",
    configure(cmd) {
      return cmd
        .option(
          "--input-task-id <id>",
          "SUCCEEDED source task (image-to-3d, multi-image-to-3d, text-to-3d, remesh, or retexture) — takes priority over --model-url",
        )
        .option("--model-url <src>", "3D model as http(s) URL or local file path (.glb/.fbx)")
        .option("--max-colors <n>", "1-16 (default: 4)", parseInt10)
        .option("--max-depth <n>", "quadtree depth 3-6 (default: 4)", parseInt10);
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      const maxColors = opts.maxColors as number | undefined;
      if (maxColors !== undefined && (maxColors < 1 || maxColors > 16)) {
        throw new UsageError("--max-colors must be between 1 and 16");
      }
      const maxDepth = opts.maxDepth as number | undefined;
      if (maxDepth !== undefined && (maxDepth < 3 || maxDepth > 6)) {
        throw new UsageError("--max-depth must be between 3 and 6");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        max_colors: maxColors,
        max_depth: maxDepth,
      };
    },
  },
  endpointOf: (c) => c.multiColorPrint,
};

export const multiColorPrintCommand = buildResourceCommand(spec);
