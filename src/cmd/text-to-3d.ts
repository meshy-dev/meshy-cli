/**
 * text-to-3d — https://docs.meshy.ai/en/api/text-to-3d
 *
 * Two-stage flow: `--mode preview` generates geometry, then
 * `--mode refine --preview-task-id <id>` textures it.
 *
 * The flag surface is deliberately minimal: topology and polycount are
 * remesh's job (except smart topology's native polycount), resizing is
 * resize's job, deprecated parameters (symmetry_mode, lowpoly, ultra_mode)
 * are gone, and the mode picks the model: standard runs the server default
 * "latest" (Meshy 7.1), smart-topology runs meshy-t2.5, or meshy-t2 with
 * --ai-model. The `--data` escape hatch still reaches anything the API accepts.
 */

import { Option } from "commander";
import { parseBool, parseCsv, parseInt10 } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";
import { prepareSmartTopologyPayload, SMART_TOPOLOGY_MODELS } from "../internal/smart-topology.js";

const spec: ResourceCommandSpec = {
  name: "text-to-3d",
  description:
    "Generate 3D models from text prompts (two-stage: preview → refine). " +
    "Topology/polycount are not tunable in standard mode — chain `remesh` afterwards; " +
    "smart-topology mode has a native polycount",
  create: {
    description: "Create a text-to-3d task",
    configure(cmd) {
      return cmd
        .addOption(new Option("--mode <mode>", "preview | refine").choices(["preview", "refine"]))
        .option("--prompt <text>", "required in preview mode; max 800 chars")
        .option(
          "--preview-task-id <id>",
          "required in refine mode. Must be a SUCCEEDED text-to-3d preview task — refine " +
            "consumes the preview's latents, so uploaded models or image-to-3d/remesh outputs " +
            "cannot be refined (use retexture for those)",
        )
        .addOption(
          new Option(
            "--pose-mode <pose>",
            "preview only. a-pose | t-pose pre-pose characters for rigging; auto (default) lets the model decide",
          ).choices(["a-pose", "t-pose", "auto"]),
        )
        .addOption(
          new Option(
            "--model-type <kind>",
            "preview only. standard (default; full-detail generation) | smart-topology (clean triangle topology, separated parts, native --target-polycount; meshy-t2.5 by default)",
          ).choices(["standard", "smart-topology"]),
        )
        .addOption(
          new Option(
            "--ai-model <model>",
            "preview, smart-topology only: meshy-t2.5 (default; polycount up to 30000) | meshy-t2",
          ).choices([...SMART_TOPOLOGY_MODELS]),
        )
        .option(
          "--target-polycount <n>",
          "preview, smart-topology only: target face count — meshy-t2 100-15000 (default: 10000), meshy-t2.5 100-30000 (default: the API's 15000)",
          parseInt10,
        )
        .addOption(
          new Option(
            "--geometry-resolution <res>",
            "preview, standard only: standard (default) | 2k | 4k — the Ultra geometry pass at 2048³ / 4096³ (needs meshy-7.1 / latest, the default; billed on top)",
          ).choices(["standard", "2k", "4k"]),
        )
        .option(
          "--enable-pbr <bool>",
          "refine only. Generate normal/metallic/roughness maps, plus an emission map on meshy-6 below 8k (default: true, so game-engine imports carry the full map set)",
          parseBool,
        )
        .option("--texture-prompt <text>", "refine only. Extra texture guidance (max 800 chars)")
        .addOption(
          new Option(
            "--texture-resolution <res>",
            "refine only. Base color texture size (default: the server's, 2k). 4k/8k need a meshy-6, meshy-7.1 or latest preview — a meshy-6-lite preview refuses them",
          ).choices(["2k", "4k", "8k"]),
        )
        .option(
          "--remove-lighting <bool>",
          "refine only. Strip baked lighting from the base color (default: the server's — on for meshy-6/7; a meshy-6-lite preview refuses the flag)",
          parseBool,
        )
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,3mf (default: glb)", parseCsv);
    },
    toPayload(opts) {
      const mode = opts.mode as string | undefined;
      if (mode === "preview" && !opts.prompt) {
        throw new UsageError("--mode preview requires --prompt");
      }
      if (mode === "refine" && !opts.previewTaskId) {
        throw new UsageError("--mode refine requires --preview-task-id");
      }
      if (mode === "refine") {
        for (const [flag, value] of [["--model-type", opts.modelType], ["--ai-model", opts.aiModel], ["--target-polycount", opts.targetPolycount], ["--geometry-resolution", opts.geometryResolution]] as const) {
          if (value !== undefined) throw new UsageError(`${flag} applies to --mode preview only (refine inherits the preview's geometry)`);
        }
      }
      const smart = opts.modelType === "smart-topology";
      if (opts.targetPolycount !== undefined && !smart) {
        throw new UsageError("--target-polycount applies to --model-type smart-topology only; for standard outputs chain `remesh` afterwards");
      }
      if (smart && opts.geometryResolution !== undefined && opts.geometryResolution !== "standard") {
        throw new UsageError("--geometry-resolution 2k/4k needs meshy-7.1 (standard), not smart-topology");
      }
      return {
        mode,
        prompt: opts.prompt,
        preview_task_id: opts.previewTaskId,
        // "auto" means "let the model decide" — the API's default, expressed by omission.
        pose_mode: opts.poseMode === "auto" ? undefined : opts.poseMode,
        model_type: opts.modelType,
        ai_model: opts.aiModel,
        target_polycount: opts.targetPolycount,
        geometry_resolution: opts.geometryResolution,
        enable_pbr: opts.enablePbr,
        texture_prompt: opts.texturePrompt,
        texture_resolution: opts.textureResolution,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
      };
    },
    toDefaults(opts) {
      // Refine inherits its model from the preview, and the task GET does not
      // say which model that was. So only what every refine target accepts is
      // pinned here: the full PBR map set. texture_resolution 4k and
      // remove_lighting are refused (400) for a meshy-6-lite preview, so they
      // ride only when asked for — the server's own defaults (2k; lighting
      // removed on meshy-6/7) apply otherwise. `make` still asks for 4k: it
      // made the preview itself, on latest.
      // GLB-only output — omitting target_formats makes the API produce
      // every format. Smart Topology's model and polycount defaults are
      // applied after payload merging, as on image-to-3d.
      const refine = opts.mode === "refine";
      return {
        enable_pbr: refine ? true : undefined,
        target_formats: ["glb"],
      };
    },
    validatePayload: prepareSmartTopologyPayload,
  },
  endpointOf: (c) => c.textTo3d,
};

export const textTo3dCommand = buildResourceCommand(spec);
