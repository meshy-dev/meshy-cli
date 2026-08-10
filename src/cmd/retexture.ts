/**
 * retexture — https://docs.meshy.ai/en/api/retexture
 */

import { Option } from "commander";
import { parseBool, parseCsv } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "retexture",
  description:
    "Regenerate the textures of a 3D model from a style prompt or a style image — prefer a " +
    "reference image showing the desired final look",
  create: {
    description: "Create a retexture task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "source Meshy task id (takes priority over --model-url)")
        .option("--model-url <src>", "3D model as http(s) URL or local file path (.glb/.gltf/.obj/.fbx/.stl)")
        .option("--text-style-prompt <text>", "text style description; mutually exclusive with --image-style-url")
        .option(
          "--image-style-url <src>",
          "style reference image (URL or local path); mutually exclusive with --text-style-prompt",
        )
        .option("--enable-original-uv <bool>", "reuse the model's original UVs (default: true)", parseBool)
        .option(
          "--enable-pbr <bool>",
          "generate normal/metallic/roughness/emission maps (default: true, so game-engine imports carry the full map set)",
          parseBool,
        )
        .addOption(
          new Option("--texture-resolution <res>", "base color texture size (default: 4k)").choices([
            "2k",
            "4k",
            "8k",
          ]),
        )
        .option(
          "--remove-lighting <bool>",
          "strip baked lighting from the base color (default: true)",
          parseBool,
        )
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,3mf (default: glb)", parseCsv);
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      if (!opts.textStylePrompt && !opts.imageStyleUrl && !opts.data) {
        throw new UsageError("provide --text-style-prompt or --image-style-url");
      }
      if (opts.textStylePrompt && opts.imageStyleUrl) {
        throw new UsageError("--text-style-prompt and --image-style-url are mutually exclusive");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        text_style_prompt: opts.textStylePrompt,
        image_style_url: opts.imageStyleUrl,
        enable_original_uv: opts.enableOriginalUv,
        enable_pbr: opts.enablePbr,
        texture_resolution: opts.textureResolution,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
      };
    },
    toDefaults() {
      // Game-ready defaults (agent-ts parity); see image-to-3d.
      return {
        enable_pbr: true,
        texture_resolution: "4k",
        target_formats: ["glb"],
      };
    },
  },
  endpointOf: (c) => c.retexture,
};

export const retextureCommand = buildResourceCommand(spec);
