/**
 * convert — https://docs.meshy.ai/en/api/convert
 *
 * Standalone format conversion (extracted from remesh by Meshy in May 2026).
 * The task type is `convert`, so get/wait/delete live right here.
 */

import { parseCsv } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "convert",
  description:
    "Convert a 3D model to one or more target formats without altering its topology or " +
    "polycount",
  create: {
    description: "Create a convert task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "source SUCCEEDED task (takes priority over --model-url)")
        .option("--model-url <src>", "3D model as http(s) URL or local file path (.glb/.gltf/.obj/.fbx/.stl)")
        .option("--target-formats <csv>", "required — glb,fbx,obj,usdz,blend,stl,3mf", parseCsv);
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      const formats = opts.targetFormats as string[] | undefined;
      if ((!formats || formats.length === 0) && !opts.data) {
        throw new UsageError("--target-formats is required (e.g. --target-formats fbx,obj)");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        target_formats: formats,
      };
    },
  },
  endpointOf: (c) => c.convert,
};

export const convertCommand = buildResourceCommand(spec);
