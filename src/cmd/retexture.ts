/**
 * retexture — https://docs.meshy.ai/en/api/retexture
 *
 * Three mutually exclusive style inputs: a text prompt, one style image, or
 * --multiview-image-urls (1-4 views OF THE SAME OBJECT, element 0 being the
 * front reference).
 *
 * Multi-view pins a model. The endpoint's gate is literal: multiview_image_urls
 * takes an explicit meshy-7 or meshy-n1 and is refused even for ai_model
 * "latest" and for an omitted ai_model, so leaving the model to the server —
 * what every other 3D command here does — is a guaranteed 400. (image-to-3d's
 * comparable geometry_resolution gate accepts both, which is why only this
 * command pins a version.) The meshy-7 pin rides the defaults layer, so
 * --ai-model and `--data '{"ai_model":"..."}'` still win.
 *
 * --ai-model meshy-n1 (Meshy N1) makes a 2k base color texture from reference
 * images only: one style image (the front view) or 1-4 views. The API refuses
 * it a prompt alone, PBR maps, 4k/8k and remove_lighting, so the game-ready
 * defaults (PBR on, 4k) flip for it, and an explicit ask for any of those is
 * refused before the POST (decisions.md D-090).
 */

import { Option } from "commander";
import { parseBool, parseCsv } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

/**
 * The models --ai-model offers: the ones the CLI's defaults work with. The
 * retired meshy-5 is gone; meshy-6-lite (2k only) stays reachable through --data.
 */
export const RETEXTURE_MODELS = ["latest", "meshy-7", "meshy-6", "meshy-n1"] as const;
const MESHY_N1 = "meshy-n1";
/** The only models the API lets take multiview_image_urls. */
const MULTIVIEW_MODELS: readonly string[] = ["meshy-7", MESHY_N1];

const N1_NEEDS_IMAGE =
  "meshy-n1 needs a reference image: pass --image-style-url (read as the front view) or --multiview-image-urls (1-4 views, the front first) — it does not texture from a text prompt";

/** The model the request runs on: the flag beats --data, as in the merged payload. */
function requestedModel(opts: Record<string, unknown>, data: Record<string, unknown>): unknown {
  return opts.aiModel ?? data["ai_model"];
}

/**
 * Refuse what meshy-n1 cannot make, on the merged payload, so a field sent
 * through --data meets the same rule as its flag. Defaults never trip this:
 * for N1 they are enable_pbr false and 2k.
 */
function refuseMeshyN1Conflicts(payload: Record<string, unknown>): void {
  if (payload["ai_model"] !== MESHY_N1) return;
  const views = payload["multiview_image_urls"];
  if (!payload["image_style_url"] && !(Array.isArray(views) && views.length > 0)) {
    throw new UsageError(N1_NEEDS_IMAGE);
  }
  const conflicts: string[] = [];
  // v1 drops a prompt sent beside the image; refuse rather than let it vanish.
  if (payload["text_style_prompt"]) conflicts.push("--text-style-prompt (it textures from the reference images only)");
  if (payload["enable_pbr"] === true) conflicts.push("--enable-pbr true (it makes a base color texture only)");
  const resolution = payload["texture_resolution"];
  if (resolution === "4k" || resolution === "8k") conflicts.push(`--texture-resolution ${resolution} (it makes 2k only)`);
  // The API takes an explicit texture_resolution over hd_texture, so
  // hd_texture true beside "2k" would run at 2k there; refusing it is the
  // CLI's own rule, since the caller asked for an HD texture N1 cannot make.
  if (payload["hd_texture"] === true) conflicts.push("hd_texture true (that is 4k; it makes 2k only)");
  if (payload["remove_lighting"] !== undefined) conflicts.push("--remove-lighting (the API refuses it with meshy-n1)");
  if (conflicts.length > 0) {
    throw new UsageError(`meshy-n1 cannot be used with ${conflicts.join(", ")}; drop them or pick another --ai-model`);
  }
}

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
        .option("--model-url <src>", "3D model: an http(s) URL (.glb/.gltf/.obj/.fbx/.stl) or a local .glb/.gltf file — the API takes inline uploads as glTF only, so host .stl/.obj/.fbx at a URL")
        .option("--text-style-prompt <text>", "text style description; mutually exclusive with --image-style-url; not with meshy-n1")
        .option(
          "--image-style-url <src>",
          "style reference image (URL or local path); mutually exclusive with --text-style-prompt. meshy-n1 reads it as the front view",
        )
        .option(
          "--multiview-image-urls <csv>",
          "1-4 views of the SAME object as CSV, first entry is the front reference; each is a URL or local file path. Mutually exclusive with the two style flags. Runs on meshy-7 (pinned by default) or --ai-model meshy-n1",
          parseCsv,
        )
        .addOption(
          new Option(
            "--ai-model <model>",
            "latest (default; Meshy 7) | meshy-7 | meshy-6 | meshy-n1 — Meshy N1: a 2k base color texture from a reference image only (--image-style-url or --multiview-image-urls), no text prompt, no PBR maps, models within the face limit in the API docs",
          ).choices([...RETEXTURE_MODELS]),
        )
        .option("--enable-original-uv <bool>", "keep the model's existing UV layout — true suits Meshy outputs and models with good UVs (default: false, fresh UVs)", parseBool)
        .option(
          "--enable-pbr <bool>",
          "generate normal/metallic/roughness maps, plus an emission map on meshy-6 below 8k (default: true, so game-engine imports carry the full map set; false on meshy-n1, which makes a base color texture only)",
          parseBool,
        )
        .addOption(
          new Option("--texture-resolution <res>", "base color texture size (default: 4k; 2k on meshy-n1, its only size)").choices([
            "2k",
            "4k",
            "8k",
          ]),
        )
        .option(
          "--remove-lighting <bool>",
          "strip baked lighting from the base color (default: true); not with meshy-n1, which the API refuses it for",
          parseBool,
        )
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,3mf (default: glb)", parseCsv)
        .option("--alpha-thumbnail <bool>", "also render a transparent-background preview (alpha_thumbnail_url; default: false)", parseBool);
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      const multiview = opts.multiviewImageUrls as string[] | undefined;
      if (!opts.textStylePrompt && !opts.imageStyleUrl && !multiview?.length && !opts.data) {
        throw new UsageError(
          opts.aiModel === MESHY_N1 ? N1_NEEDS_IMAGE : "provide --text-style-prompt, --image-style-url or --multiview-image-urls",
        );
      }
      // Exactly one style flag. The API is looser: views beside a prompt or an
      // image are a 400 there, but v1 clears a prompt beside one image and
      // textures from the image alone. Picking for the caller would drop one
      // flag without a word, so the CLI refuses every combination.
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
      // The flag's own values are the CLI's to check; an ai_model in --data is
      // left to the server's gate, like the pin it overrides.
      const model = opts.aiModel as string | undefined;
      if (multiview?.length && model !== undefined && !MULTIVIEW_MODELS.includes(model)) {
        throw new UsageError(`--multiview-image-urls runs on meshy-7 (the default with it) or meshy-n1; the API refuses it with --ai-model ${model}`);
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        text_style_prompt: opts.textStylePrompt,
        image_style_url: opts.imageStyleUrl,
        multiview_image_urls: multiview,
        ai_model: model,
        enable_original_uv: opts.enableOriginalUv,
        enable_pbr: opts.enablePbr,
        texture_resolution: opts.textureResolution,
        remove_lighting: opts.removeLighting,
        target_formats: opts.targetFormats,
        alpha_thumbnail: opts.alphaThumbnail,
      };
    },
    toDefaults(opts, data) {
      // meshy-n1 makes a 2k base color only: the game-ready defaults below
      // would be a 400 on every N1 request, so they flip for it. The model is
      // read where the merged payload takes it from (flag, then --data), so
      // N1 picked either way gets these defaults.
      if (requestedModel(opts, data) === MESHY_N1) {
        return { enable_pbr: false, texture_resolution: "2k", target_formats: ["glb"] };
      }
      // Game-ready defaults (agent-ts parity); see image-to-3d. The one model
      // pin in the 3D surface rides here — see the header note on the
      // multi-view gate.
      const multiview = (opts.multiviewImageUrls as string[] | undefined)?.length;
      return {
        ai_model: multiview ? "meshy-7" : undefined,
        enable_pbr: true,
        texture_resolution: "4k",
        target_formats: ["glb"],
      };
    },
    validatePayload: refuseMeshyN1Conflicts,
  },
  endpointOf: (c) => c.retexture,
};

export const retextureCommand = buildResourceCommand(spec);

/** Exported for tests: the meshy-7 pin is a wire contract, not a preference. */
export const retextureSpec = spec;
