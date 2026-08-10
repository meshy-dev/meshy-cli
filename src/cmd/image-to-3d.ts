/**
 * image-to-3d — https://docs.meshy.ai/en/api/image-to-3d
 *
 * The mode IS the model — there is no model flag:
 *   - standard → meshy-6 (server default "latest") — full-detail generation;
 *     polycount is remesh's job afterwards.
 *   - smart-topology → meshy-t2 (server default) — component-aware low-poly
 *     with a native --target-polycount; the budget pick for game-ready
 *     geometry.
 */

import { Option } from "commander";
import { parseBool, parseCsv, parseInt10 } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "image-to-3d",
  description:
    "Generate a 3D model from a single reference image (clean backgrounds and clear edges " +
    "give the best results). Outputs an untextured draft mesh by default — texture the " +
    "confirmed mesh with `retexture`, or pass --should-texture true for one-shot. " +
    "Topology/polycount are not tunable in standard mode — chain `remesh` afterwards; " +
    "smart-topology mode has a native polycount and costs less",
  create: {
    description: "Create an image-to-3d task",
    configure(cmd) {
      return cmd
        .option("--image-url <src>", "reference image; http(s) URL or local file path")
        .option(
          "--input-task-id <id>",
          "alternative to --image-url: a SUCCEEDED text-to-image or image-to-image task whose output becomes the source image",
        )
        .addOption(
          new Option(
            "--model-type <kind>",
            "standard (default; meshy-6 full-detail generation) | smart-topology (meshy-t2 component-aware low-poly: clean topology, separated parts)",
          ).choices(["standard", "smart-topology"]),
        )
        .option(
          "--target-polycount <n>",
          "smart-topology only: target triangle count, 100-15000 (default: 10000). For standard outputs use remesh",
          parseInt10,
        )
        .option(
          "--should-texture <bool>",
          "generate textures (default: false — draft white mesh, the preview stage; texture later with retexture)",
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
        .addOption(
          new Option(
            "--pose-mode <pose>",
            "a-pose | t-pose pre-pose characters for rigging; auto (default) lets the model decide",
          ).choices(["a-pose", "t-pose", "auto"]),
        )
        .option(
          "--image-enhancement <bool>",
          "optimize the input image before processing (default: true)",
          parseBool,
        )
        .option(
          "--remove-lighting <bool>",
          "strip baked lighting from the base color (default: true)",
          parseBool,
        )
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,3mf (default: glb)", parseCsv);
    },
    toPayload(opts) {
      if (!opts.imageUrl && !opts.inputTaskId && !opts.data) {
        throw new UsageError("provide --image-url or --input-task-id");
      }
      const smart = opts.modelType === "smart-topology";
      if (opts.targetPolycount != null && !smart) {
        throw new UsageError(
          "--target-polycount applies to --model-type smart-topology only; for standard outputs chain `remesh` afterwards",
        );
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
        image_url: opts.imageUrl,
        input_task_id: opts.inputTaskId,
        model_type: opts.modelType,
        target_polycount: opts.targetPolycount,
        should_texture: opts.shouldTexture,
        enable_pbr: opts.enablePbr,
        texture_prompt: opts.texturePrompt,
        texture_resolution: opts.textureResolution,
        pose_mode: opts.poseMode === "auto" ? undefined : opts.poseMode,
        image_enhancement: opts.imageEnhancement,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
      };
    },
    toDefaults(opts) {
      // Draft-first: the default output is an untextured white mesh (the
      // preview stage of the prompt → image → mesh → texture pipeline);
      // texturing is its own step, and the API rejects texture knobs on
      // untextured runs, so they ride only when texturing is on — then the
      // game-ready defaults apply: full PBR map set, 4k base color. The
      // model is not a choice — it follows the mode (standard → meshy-6,
      // smart-topology → meshy-t2, both server defaults). Smart topology
      // gets the rigging-friendly 10k polycount. GLB-only output — omitting
      // target_formats makes the API produce every format.
      const texturing = opts.shouldTexture === true;
      return {
        should_texture: false,
        enable_pbr: texturing ? true : undefined,
        texture_resolution: texturing ? "4k" : undefined,
        target_polycount: opts.modelType === "smart-topology" ? 10_000 : undefined,
        target_formats: ["glb"],
      };
    },
  },
  endpointOf: (c) => c.imageTo3d,
};

export const imageTo3dCommand = buildResourceCommand(spec);
