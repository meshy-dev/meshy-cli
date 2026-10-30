/**
 * repair-printability — https://docs.meshy.ai/en/api/repair-printability
 * Fix non-watertight / non-manifold geometry. Existing textures are removed
 * (re-run retexture afterward if needed). With a printer type or print size,
 * walls too thin at that size are also thickened; the output keeps its scale.
 */

import { UsageError } from "../internal/errors.js";
import { parseBool } from "../internal/flags.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";
import { printSizeOptions, printSizePayload, validatePrintSize } from "./analyze-printability.js";

const spec: ResourceCommandSpec = {
  name: "repair-printability",
  description:
    "Repair geometric defects (non-manifold edges, holes, degenerate faces) so a model can " +
    "be 3D-printed; with a printer type or print size, also thicken walls too thin at that size. " +
    "Textures are dropped — re-run retexture afterwards if needed",
  create: {
    description: "Create a repair-printability task",
    configure(cmd) {
      cmd
        .option(
          "--input-task-id <id>",
          "source SUCCEEDED task: image-to-3d, multi-image-to-3d, text-to-3d, remesh, retexture or analyze-printability — takes priority over --model-url",
        )
        .option(
          "--model-url <src>",
          "3D model: an http(s) URL (.glb/.gltf/.obj/.fbx/.stl, max 400MB; the output keeps the input format) or a local .glb/.gltf file (max 50 MiB) — the API takes inline uploads as glTF only, so host .stl/.obj/.fbx at a URL",
        )
        .option("--alpha-thumbnail <bool>", "also render a transparent-background preview (alpha_thumbnail_url; default: false)", parseBool);
      return printSizeOptions(cmd, "thicken");
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        alpha_thumbnail: opts.alphaThumbnail,
        ...printSizePayload(opts),
      };
    },
    validatePayload: validatePrintSize,
  },
  endpointOf: (c) => c.repairPrintability,
};

export const repairPrintabilityCommand = buildResourceCommand(spec);
