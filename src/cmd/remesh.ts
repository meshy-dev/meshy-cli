/**
 * remesh — https://docs.meshy.ai/en/api/remesh
 *
 * Geometry only: topology and polycount. Format-only conversion is the
 * standalone `convert` command; size changes are `resize`.
 */

import { Option } from "commander";
import { parseCsv, parseInt10 } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "remesh",
  description:
    "Regenerate the geometry of a 3D model — change topology (quad/triangle) and polygon " +
    "count; textures and position are preserved. For format-only changes use `convert`; " +
    "for size changes use `resize`",
  create: {
    description: "Create a remesh task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "source Meshy task id (takes priority over --model-url)")
        .option("--model-url <src>", "3D model as http(s) URL or local file path (.glb/.gltf/.obj/.fbx/.stl)")
        .addOption(
          new Option(
            "--topology <kind>",
            "quad (rigging/CAD/subdivision-friendly) | triangle (default; native engine topology)",
          ).choices(["quad", "triangle"]),
        )
        .option(
          "--target-polycount <n>",
          "100-300000 (default: 30000). Rigging tip: ~10000 rigs well",
          parseInt10,
        )
        .addOption(
          new Option("--decimation-mode <level>", "adaptive 1|2|3|4; when set, overrides --target-polycount")
            .choices(["1", "2", "3", "4"]),
        )
        .option("--target-formats <csv>", "glb,fbx,obj,usdz,blend,stl,3mf (default: glb)", parseCsv);
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        topology: opts.topology,
        target_polycount: opts.targetPolycount,
        decimation_mode: opts.decimationMode == null ? undefined : Number(opts.decimationMode),
        target_formats: opts.targetFormats,
      };
    },
    toDefaults() {
      // GLB only unless asked otherwise.
      return { target_formats: ["glb"] };
    },
  },
  endpointOf: (c) => c.remesh,
};

export const remeshCommand = buildResourceCommand(spec);
