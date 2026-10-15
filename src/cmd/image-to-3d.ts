/**
 * image-to-3d — https://docs.meshy.ai/en/api/image-to-3d
 *
 * The mode picks the model:
 *   - standard → meshy-7.1 (server default "latest") — full-detail
 *     generation; polycount is remesh's job afterwards.
 *   - smart-topology → meshy-t2.5 (CLI default), or meshy-t2 with
 *     --ai-model — component-aware low-poly with a native
 *     --target-polycount; the budget pick for game-ready geometry.
 *
 * The Ultra geometry pass (--geometry-resolution 2k|4k, or the deprecated
 * --ultra-mode) rides on standard only: it needs meshy-7.1, so pairing it with
 * smart-topology is rejected here rather than on the wire.
 */

import { Option } from "commander";
import { parseBool, parseCsv, parseInt10 } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";
import { prepareSmartTopologyPayload, SMART_TOPOLOGY_MODELS } from "../internal/smart-topology.js";

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
            "standard (default; meshy-7.1 full-detail generation) | smart-topology (component-aware low-poly: clean topology, separated parts; meshy-t2.5 by default)",
          ).choices(["standard", "smart-topology"]),
        )
        .addOption(
          new Option(
            "--ai-model <model>",
            "smart-topology only: meshy-t2.5 (default; polycount up to 30000) | meshy-t2",
          ).choices([...SMART_TOPOLOGY_MODELS]),
        )
        .option(
          "--target-polycount <n>",
          "smart-topology only: target triangle count — meshy-t2 100-15000 (default: 10000), meshy-t2.5 100-30000 (default: the API's 15000). For standard outputs use remesh",
          parseInt10,
        )
        .addOption(
          new Option(
            "--geometry-resolution <res>",
            "standard mode only: standard (default) | 2k | 4k — the Ultra geometry pass at 2048³ / 4096³ for finer surface detail (needs meshy-7.1 / latest, the default; billed on top of the mesh)",
          ).choices(["standard", "2k", "4k"]),
        )
        .option(
          "--ultra-mode <bool>",
          "deprecated: use --geometry-resolution 2k (true is the same pass)",
          parseBool,
        )
        .option(
          "--should-texture <bool>",
          "generate textures (default: false — draft white mesh, the preview stage; texture later with retexture)",
          parseBool,
        )
        .option(
          "--enable-pbr <bool>",
          "generate normal/metallic/roughness maps, plus an emission map on meshy-6 below 8k (default: true, so game-engine imports carry the full map set)",
          parseBool,
        )
        .option("--texture-prompt <text>", "text guidance for texturing (max 800 chars)")
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
          "strip baked lighting from the base color; the API applies it on meshy-6 only (--data '{\"ai_model\":\"meshy-6\"}') — the default Meshy 7.1 does not use it and smart-topology refuses it",
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
      // The Ultra pass needs meshy-7.1, which only standard mode resolves to.
      if (opts.ultraMode === true && smart) {
        throw new UsageError(
          "--ultra-mode applies to --model-type standard only (it needs meshy-7.1)",
        );
      }
      if (smart && opts.geometryResolution !== undefined && opts.geometryResolution !== "standard") {
        throw new UsageError("--geometry-resolution 2k/4k applies to --model-type standard only (it needs meshy-7.1)");
      }
      if (opts.ultraMode !== undefined && opts.geometryResolution !== undefined) {
        throw new UsageError("--ultra-mode is the deprecated spelling of --geometry-resolution 2k; pass only --geometry-resolution");
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
        ai_model: opts.aiModel,
        target_polycount: opts.targetPolycount,
        ultra_mode: opts.ultraMode,
        geometry_resolution: opts.geometryResolution,
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
      // standard follows the server's meshy-7.1 default. Smart Topology's
      // model and polycount defaults are applied after payload merging.
      // The Ultra pass stays off
      // unless asked for: it bills extra. GLB-only output — omitting target_formats
      // makes the API produce every format.
      const texturing = opts.shouldTexture === true;
      return {
        should_texture: false,
        enable_pbr: texturing ? true : undefined,
        texture_resolution: texturing ? "4k" : undefined,
        target_formats: ["glb"],
      };
    },
    validatePayload(payload) {
      prepareSmartTopologyPayload(payload);
      // Smart topology has neither knob; v1 answers 400 for either (it does not ignore them).
      if (payload.model_type === "smart-topology") {
        for (const [flag, key] of [["--remove-lighting", "remove_lighting"], ["--image-enhancement", "image_enhancement"]] as const) {
          if (payload[key] !== undefined) {
            throw new UsageError(`${flag} applies to --model-type standard only (the API refuses it for smart-topology)`);
          }
        }
      }
    },
  },
  endpointOf: (c) => c.imageTo3d,
};

export const imageTo3dCommand = buildResourceCommand(spec);
