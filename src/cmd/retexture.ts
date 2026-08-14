/**
 * retexture — https://docs.meshy.ai/en/api/retexture
 *
 * Three mutually exclusive style inputs: a text prompt, one style image, or
 * --multiview-image-urls (1-4 views OF THE SAME OBJECT, element 0 being the
 * front reference).
 *
 * Multi-view is the one place this CLI names a model. The endpoint's gate is
 * literal: `multiview_image_urls requires ai_model meshy-7` is returned even
 * for ai_model "latest" and for an omitted ai_model, so leaving the model to
 * the server — what every other 3D command here does — is a guaranteed 400.
 * (image-to-3d's comparable ultra_mode gate accepts both, which is why only
 * this command pins a version.) It is pinned in the defaults layer, so
 * `--data '{"ai_model":"..."}'` still wins if the gate ever loosens.
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
        .option(
          "--multiview-image-urls <csv>",
          "1-4 views of the SAME object as CSV, first entry is the front reference; each is a URL or local file path. Mutually exclusive with the two style flags",
          parseCsv,
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
      const multiview = opts.multiviewImageUrls as string[] | undefined;
      if (!opts.textStylePrompt && !opts.imageStyleUrl && !multiview?.length && !opts.data) {
        throw new UsageError(
          "provide --text-style-prompt, --image-style-url or --multiview-image-urls",
        );
      }
      // The API takes exactly one style input; picking for the caller would
      // silently drop the other one, so refuse instead.
      const styleFlags = [
        ["--text-style-prompt", Boolean(opts.textStylePrompt)],
        ["--image-style-url", Boolean(opts.imageStyleUrl)],
        ["--multiview-image-urls", Boolean(multiview?.length)],
      ] as const;
      const given = styleFlags.filter(([, set]) => set).map(([flag]) => flag);
      if (given.length > 1) {
        throw new UsageError(`${given.join(" and ")} are mutually exclusive`);
      }
      if (multiview && (multiview.length < 1 || multiview.length > 4)) {
        throw new UsageError("--multiview-image-urls takes 1-4 images of the same object");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        text_style_prompt: opts.textStylePrompt,
        image_style_url: opts.imageStyleUrl,
        multiview_image_urls: multiview,
        enable_original_uv: opts.enableOriginalUv,
        enable_pbr: opts.enablePbr,
        texture_resolution: opts.textureResolution,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
      };
    },
    toDefaults(opts) {
      // Game-ready defaults (agent-ts parity); see image-to-3d. The one model
      // pin in the 3D surface rides here — see the header note on the literal
      // meshy-7 gate.
      const multiview = (opts.multiviewImageUrls as string[] | undefined)?.length;
      return {
        ai_model: multiview ? "meshy-7" : undefined,
        enable_pbr: true,
        texture_resolution: "4k",
        target_formats: ["glb"],
      };
    },
  },
  endpointOf: (c) => c.retexture,
};

export const retextureCommand = buildResourceCommand(spec);

/** Exported for tests: the meshy-7 pin is a wire contract, not a preference. */
export const retextureSpec = spec;
