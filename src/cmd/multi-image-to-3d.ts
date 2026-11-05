/**
 * multi-image-to-3d — https://docs.meshy.ai/en/api/multi-image-to-3d
 *
 * No model flag (the Smart Topology models are not offered here): the API
 * default "latest" is Meshy 7.1. geometry_resolution "2k" runs the Ultra pass (+5
 * credits; the same geometry setting as the web app's Ultra 2K) and needs
 * meshy-7.1 / latest. "4k" is single-image only — the API refuses it here.
 * ai_model stays reachable through --data.
 *
 * --texture-model picks the texture model apart from the geometry: meshy-7 or
 * meshy-n1, the multi-view ones (the API refuses meshy-6 and meshy-6-lite
 * here). The texture defaults follow it (texturing.ts).
 */

import { Option } from "commander";
import { parseBool, parseCsv } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";
import {
  MULTI_IMAGE_TO_3D_TEXTURE_MODELS,
  modelGuideHelp,
  refuseTextureModelConflicts,
  refuseTextureSettingsWithoutTexture,
  texturingDefaults,
} from "../internal/texturing.js";

/** How this command reaches its rows of the model guide. */
const HOW_HERE = [
  "In this command: the geometry is meshy-7.1 (the default) and --texture-model",
  "takes meshy-7 or meshy-n1; none is --should-texture false. Smart topology",
  "(meshy-t2.5, meshy-t2) and meshy-6-lite are image-to-3d only (one image).",
];

const spec: ResourceCommandSpec = {
  name: "multi-image-to-3d",
  description:
    "Generate a 3D model from 1-4 viewpoint images of a single object (Meshy 7.1 by default; " +
    "prefer image-to-3d unless multi-view input is explicitly required). Each input must be a " +
    "separate single-view image, never one grid/collage. --geometry-resolution 2k turns on " +
    "the Ultra pass (the web app's Ultra 2K geometry setting). Topology/polycount " +
    "are not tunable here — chain `remesh` afterwards",
  create: {
    description: "Create a multi-image-to-3d task",
    configure(cmd) {
      return cmd
        .option(
          "--image-urls <csv>",
          "1-4 reference images as CSV, ideally front/side/back; each entry is a URL or local file path",
          parseCsv,
        )
        .option(
          "--input-task-id <id>",
          "alternative to --image-urls: a SUCCEEDED text-to-image or image-to-image task (e.g. multi-view output) whose images become the source views",
        )
        .addOption(
          new Option(
            "--geometry-resolution <res>",
            "geometry pass: standard (default) | 2k (the Ultra pass at 2048³, the web app's Ultra 2K setting; billed on top of the mesh)",
          ).choices(["standard", "2k"]),
        )
        .option(
          "--should-texture <bool>",
          "generate textures (default: true; false gives an untextured draft mesh — texture it later with retexture)",
          parseBool,
        )
        .addOption(
          new Option(
            "--texture-model <model>",
            "texture model, apart from the geometry (default: the geometry's own, meshy-7 on meshy-7.1): " +
              "meshy-7 (PBR maps, up to 8k) | meshy-n1 (Meshy N1: a 2k base color from the views, or --texture-image-urls when given; no --texture-prompt, no PBR maps). " +
              "The texture defaults follow it: 2k and PBR off on meshy-n1",
          ).choices([...MULTI_IMAGE_TO_3D_TEXTURE_MODELS]),
        )
        .option(
          "--enable-pbr <bool>",
          "generate normal/metallic/roughness maps, plus an emission map on meshy-6 below 8k (default: true, so game-engine imports carry the full map set; false on meshy-n1, which makes a base color texture only)",
          parseBool,
        )
        .option("--texture-prompt <text>", "text guidance for texturing (max 800 chars); not with --texture-model meshy-n1")
        .option(
          "--texture-image-urls <csv>",
          "1-4 views of the same object to guide texturing, front first; URLs or local files; independent of --image-urls. Exclusive with --texture-prompt",
          parseCsv,
        )
        .addOption(
          new Option(
            "--texture-resolution <res>",
            "base color texture size (default: 4k; 2k on --texture-model meshy-n1, its only size)",
          ).choices(["2k", "4k", "8k"]),
        )
        .option(
          "--remove-lighting <bool>",
          "strip baked lighting from the base color (default: true); --texture-model meshy-n1 refuses true",
          parseBool,
        )
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,3mf (default: glb)", parseCsv)
        .addHelpText("after", modelGuideHelp(HOW_HERE));
    },
    toPayload(opts) {
      const urls = opts.imageUrls as string[] | undefined;
      if (!opts.inputTaskId && (!urls || urls.length < 1 || urls.length > 4) && !opts.data) {
        throw new UsageError("provide --image-urls (CSV of 1-4) or --input-task-id");
      }
      const textureViews = opts.textureImageUrls as string[] | undefined;
      if (textureViews && (textureViews.length < 1 || textureViews.length > 4)) {
        throw new UsageError("--texture-image-urls takes 1-4 images of the same object");
      }
      if (textureViews && opts.texturePrompt !== undefined) {
        throw new UsageError("--texture-image-urls and --texture-prompt are mutually exclusive");
      }
      return {
        image_urls: urls,
        texture_image_urls: textureViews,
        input_task_id: opts.inputTaskId,
        geometry_resolution: opts.geometryResolution,
        should_texture: opts.shouldTexture,
        texture_model: opts.textureModel,
        enable_pbr: opts.enablePbr,
        texture_prompt: opts.texturePrompt,
        texture_resolution: opts.textureResolution,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
      };
    },
    toDefaults(opts, data) {
      // Textured like the API, as image-to-3d; the texture settings follow the
      // texture model that runs (see texturing.ts). No geometry model choice
      // and no geometry default: the server's standard pass applies, and
      // Ultra (2k) rides only when asked for — it bills extra.
      return { ...texturingDefaults(opts, data), target_formats: ["glb"] };
    },
    validatePayload(payload) {
      refuseTextureSettingsWithoutTexture(payload, ["enable_pbr", "texture_resolution", "texture_prompt", "texture_image_urls"]);
      refuseTextureModelConflicts(payload, "multi-image-to-3d");
    },
  },
  endpointOf: (c) => c.multiImageTo3d,
};

export const multiImageTo3dCommand = buildResourceCommand(spec);
