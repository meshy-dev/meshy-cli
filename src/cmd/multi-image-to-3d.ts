/**
 * multi-image-to-3d — https://docs.meshy.ai/en/api/multi-image-to-3d
 *
 * No model flag, same as the other 3D generation commands. On this endpoint
 * ai_model alone does not pick the model: unless Ultra is on, the server runs a
 * two-stage multi-view model, even for "latest" or an explicit "meshy-7.1".
 * Ultra is on with geometry_resolution "2k" (+5 credits; the same geometry
 * setting as the web app's Ultra 2K), or with the legacy ultra_mode boolean
 * when the enum is absent; "standard" overrides that boolean. With Ultra on,
 * ai_model picks the Ultra model: "meshy-7.1" pins Meshy 7.1, "latest" follows
 * the server's current choice. "4k" is single-image only — the server refuses
 * it here. Only the enum is exposed, since it supersedes the boolean; ai_model
 * and ultra_mode stay reachable through --data.
 */

import { Option } from "commander";
import { parseBool, parseCsv } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "multi-image-to-3d",
  description:
    "Generate a 3D model from 1-4 viewpoint images of a single object. Beta and unstable — " +
    "prefer image-to-3d unless multi-view input is explicitly required. Each input must be a " +
    "separate single-view image, never one grid/collage. --geometry-resolution 2k turns on " +
    "the multi-view Ultra pass (the web app's Ultra 2K geometry setting). Topology/polycount " +
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
            "geometry pass: standard (default; two-stage multi-view model) | 2k (multi-view Ultra pass, the web app's Ultra 2K setting; billed on top of the mesh)",
          ).choices(["standard", "2k"]),
        )
        .option(
          "--should-texture <bool>",
          "generate textures (default: false — draft white mesh; texture later with retexture)",
          parseBool,
        )
        .option(
          "--enable-pbr <bool>",
          "generate normal/metallic/roughness/emission maps (default: true, so game-engine imports carry the full map set)",
          parseBool,
        )
        .option("--texture-prompt <text>", "text guidance for texturing (max 600 chars)")
        .addOption(
          new Option(
            "--texture-resolution <res>",
            "base color texture size (default: 4k)",
          ).choices(["2k", "4k", "8k"]),
        )
        .option(
          "--remove-lighting <bool>",
          "strip baked lighting from the base color (default: true)",
          parseBool,
        )
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,3mf (default: glb)", parseCsv);
    },
    toPayload(opts) {
      const urls = opts.imageUrls as string[] | undefined;
      if (!opts.inputTaskId && (!urls || urls.length < 1 || urls.length > 4) && !opts.data) {
        throw new UsageError("provide --image-urls (CSV of 1-4) or --input-task-id");
      }
      // The API rejects texture knobs on untextured runs; catch it before the wire.
      if (opts.shouldTexture !== true && !opts.data) {
        for (const [flag, value] of [
          ["--enable-pbr", opts.enablePbr],
          ["--texture-resolution", opts.textureResolution],
          ["--texture-prompt", opts.texturePrompt],
        ] as const) {
          if (value !== undefined) {
            throw new UsageError(
              `${flag} requires --should-texture true (the default output is an untextured draft mesh)`,
            );
          }
        }
      }
      return {
        image_urls: urls,
        input_task_id: opts.inputTaskId,
        geometry_resolution: opts.geometryResolution,
        should_texture: opts.shouldTexture,
        enable_pbr: opts.enablePbr,
        texture_prompt: opts.texturePrompt,
        texture_resolution: opts.textureResolution,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
      };
    },
    toDefaults(opts) {
      // Draft-first, matching image-to-3d: white mesh by default, texturing
      // is its own step; texture knobs ride only when texturing is on (the
      // API rejects them otherwise), then game-ready values apply. No model
      // choice and no geometry default: the server's standard pass applies,
      // and Ultra (2k) rides only when asked for — it bills extra.
      const texturing = opts.shouldTexture === true;
      return {
        should_texture: false,
        enable_pbr: texturing ? true : undefined,
        texture_resolution: texturing ? "4k" : undefined,
        target_formats: ["glb"],
      };
    },
  },
  endpointOf: (c) => c.multiImageTo3d,
};

export const multiImageTo3dCommand = buildResourceCommand(spec);
