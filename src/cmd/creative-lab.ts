/**
 * creative-lab — https://docs.meshy.ai/en/api/creative-lab-{figure,lamp,keychain,fridge-magnet}
 *
 * Four products × two stages, each its own registered resource with the same
 * create/get/list/wait/stream/delete verbs. Nothing here builds a path from a
 * user string: product and stage are resolved through the registry.
 *
 * Stage meanings differ by product and are not generalised:
 *   figure / keychain / fridge-magnet prototype → a styled concept image
 *   lamp prototype                              → concept image + lampshade GLB
 *   figure build                                → GLB, OBJ, MTL, base-color texture
 *   lamp build                                  → lamp_stl (+ base_stl) or bundle_zip
 *   keychain / fridge-magnet build              → glb, obj (a ZIP bundle) or bundle_zip
 *
 * Build options are validated per product with the ranges the API documents
 * so a bad value fails before a billable POST; unknown option keys are passed
 * through (the server is the final validator). `options` and `output` are
 * declared as nested-merge keys, so `--data '{"options":{…}}'`, `--options`
 * and the typed flags compose field by field (typed flags win) instead of the
 * later layer deleting the earlier one's settings.
 */

import { Command, Option } from "commander";
import { z } from "zod";
import { CREATIVE_LAB_PRODUCTS, type CreativeLabProduct, type CreativeLabStage } from "../client/resource-registry.js";
import { UsageError } from "../internal/errors.js";
import { parseJsonFlag } from "../internal/payload.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const NAME_MAX = 100;

const lampOptionsSchema = z
  .object({
    diameter_mm: z.number().min(50).max(400).optional(),
    thickness_mm: z.number().gt(0).max(10).optional(),
    cut_amount_percent: z.number().min(1).max(100).optional(),
    light_source_preset: z.enum(["bambu_mh001_60mm", "none"]).optional(),
    fixture_offset_x_mm: z.number().min(-80).max(80).optional(),
    fixture_offset_z_mm: z.number().min(-80).max(80).optional(),
    rotate_x_deg: z.number().min(-360).max(360).optional(),
    rotate_y_deg: z.number().min(-360).max(360).optional(),
    rotate_z_deg: z.number().min(-360).max(360).optional(),
    include_result_json: z.boolean().optional(),
  })
  .passthrough();

const reliefOptionsSchema = z
  .object({
    badge_shape: z.enum(["circle", "rounded-rect", "hexagon", "shield", "star"]).optional(),
    size_mm: z.number().gt(0).max(400).optional(),
    relief_height_mm: z.number().min(0).max(20).optional(),
    relief_offset_mm: z.number().min(0).max(20).optional(),
    base_thickness_mm: z.number().min(0).max(20).optional(),
    has_closed_back: z.boolean().optional(),
    relief_curve: z.enum(["linear", "gamma", "s-curve"]).optional(),
    curve_param: z.number().gt(0).max(10).optional(),
    invert_depth: z.boolean().optional(),
    smoothing: z.number().min(0).max(10).optional(),
    relief_scale: z.number().gt(0).max(10).optional(),
    depth_threshold: z.number().min(0).max(1).optional(),
    remove_background: z.boolean().optional(),
    export_resolution: z.number().int().min(64).max(2048).optional(),
  })
  .passthrough();

interface ProductDescriptor {
  product: CreativeLabProduct;
  label: string;
  prototypeMeaning: string;
  buildMeaning: string;
  /** Extra prototype flags beyond image/name/remove-background. */
  prototypeExtra?: (cmd: Command) => Command;
  prototypeExtraPayload?: (opts: Record<string, unknown>) => Record<string, unknown>;
  validatePrototype?: (payload: Record<string, unknown>) => void;
  /** Build output formats (`output.format`); undefined when the product has none. */
  buildFormats?: readonly string[];
  optionsSchema?: z.ZodTypeAny;
  /** Whether the product accepts `options`/`output` at all. */
  hasBuildOptions: boolean;
  validateBuild?: (payload: Record<string, unknown>) => void;
}

const PRODUCTS: Record<CreativeLabProduct, ProductDescriptor> = {
  figure: {
    product: "figure",
    label: "figure",
    prototypeMeaning: "styled concept image of the figure",
    buildMeaning: "textured figure: GLB, OBJ + MTL and a base-color texture",
    hasBuildOptions: false,
  },
  lamp: {
    product: "lamp",
    label: "lamp",
    prototypeMeaning: "concept image plus a hollow matte-white lampshade GLB",
    buildMeaning: "printable lamp parts: lamp_stl (+ base_stl with a light-source preset) or bundle_zip",
    prototypeExtra: (cmd) =>
      cmd.addOption(new Option("--image-subject <kind>", "what the photo shows (default: character)").choices(["character", "landscape"])),
    prototypeExtraPayload: (opts) => ({ image_subject: opts.imageSubject }),
    validatePrototype: (payload) => {
      if ("text" in payload) {
        throw new UsageError("lamp prototype: the `text` input is deprecated and not accepted by this CLI; provide --image-url (a photo) instead");
      }
      if (payload.image_subject !== undefined && payload.image_subject !== "character" && payload.image_subject !== "landscape") {
        throw new UsageError("image_subject must be 'character' or 'landscape'");
      }
    },
    buildFormats: ["stl", "zip"],
    optionsSchema: lampOptionsSchema,
    hasBuildOptions: true,
    validateBuild: (payload) => {
      const options = (payload.options ?? {}) as Record<string, unknown>;
      const output = (payload.output ?? {}) as Record<string, unknown>;
      if (options.include_result_json === true && output.format !== "zip") {
        throw new UsageError("lamp build: include_result_json=true requires --model-format zip (the STL output has no place for result.json)");
      }
    },
  },
  keychain: {
    product: "keychain",
    label: "keychain",
    prototypeMeaning: "styled concept image of the keychain",
    buildMeaning: "relief keychain: glb, obj (a ZIP bundle with model.obj/model.mtl/texture.png) or bundle_zip",
    buildFormats: ["glb", "obj", "zip"],
    optionsSchema: reliefOptionsSchema,
    hasBuildOptions: true,
  },
  "fridge-magnet": {
    product: "fridge-magnet",
    label: "fridge magnet",
    prototypeMeaning: "styled concept image of the magnet",
    buildMeaning: "relief fridge magnet: glb, obj (a ZIP bundle with model.obj/model.mtl/texture.png) or bundle_zip",
    buildFormats: ["glb", "obj", "zip"],
    optionsSchema: reliefOptionsSchema,
    hasBuildOptions: true,
  },
};

function checkName(payload: Record<string, unknown>): void {
  if (payload.name === undefined || payload.name === null) return;
  if (typeof payload.name !== "string") throw new UsageError("name must be a string");
  if (payload.name.length > NAME_MAX) throw new UsageError(`name must be at most ${NAME_MAX} characters (got ${payload.name.length})`);
}

function prototypeSpec(p: ProductDescriptor): ResourceCommandSpec {
  return {
    name: `creative-lab.${p.product}.prototype`,
    commandName: "prototype",
    defaultSchema: "v1",
    description: `Creative Lab ${p.label} — prototype stage: photo → ${p.prototypeMeaning}`,
    create: {
      description: `Create a ${p.label} prototype from a photo`,
      configure(cmd) {
        const base = cmd
          .option("--image-url <src>", "photo as http(s) URL, data: URI or local jpg/jpeg/png/webp path (required)")
          .option("--name <text>", `optional name, at most ${NAME_MAX} characters`)
          .option("--remove-background", "return the concept image as a transparent RGBA PNG (default: false)");
        return p.prototypeExtra ? p.prototypeExtra(base) : base;
      },
      toPayload(opts) {
        return {
          image_url: opts.imageUrl,
          name: opts.name,
          remove_background: opts.removeBackground === true ? true : undefined,
          ...(p.prototypeExtraPayload ? p.prototypeExtraPayload(opts) : {}),
        };
      },
      validatePayload(payload) {
        if (payload.image_url === undefined || payload.image_url === null || payload.image_url === "") {
          throw new UsageError("provide --image-url (a photo URL, data: URI or local file)");
        }
        checkName(payload);
        if (payload.remove_background !== undefined && typeof payload.remove_background !== "boolean") {
          throw new UsageError("remove_background must be a boolean");
        }
        p.validatePrototype?.(payload);
      },
    },
  };
}

function buildSpec(p: ProductDescriptor): ResourceCommandSpec {
  return {
    name: `creative-lab.${p.product}.build`,
    commandName: "build",
    defaultSchema: "v1",
    description: `Creative Lab ${p.label} — build stage: SUCCEEDED prototype → ${p.buildMeaning}`,
    create: {
      description: `Create a ${p.label} build from a prototype task created through this API`,
      nestedObjectKeys: ["options", "output"],
      configure(cmd) {
        cmd
          .option("--input-task-id <id>", "SUCCEEDED prototype task of the same product created with the same API key (required)")
          .option("--name <text>", `optional name, at most ${NAME_MAX} characters`);
        if (p.hasBuildOptions) {
          cmd.option("--options <json>", "product-specific build options as JSON (or @file.json); merged into payload.options, typed flags win");
          if (p.buildFormats) {
            cmd.addOption(new Option("--model-format <fmt>", `output.format (default: ${p.buildFormats[0]})`).choices([...p.buildFormats]));
          }
          if (p.product === "lamp") {
            cmd.option("--include-result-json", "include result.json in the bundle (requires --model-format zip)");
          }
        }
        return cmd;
      },
      toPayload(opts) {
        const payload: Record<string, unknown> = {
          input_task_id: opts.inputTaskId,
          name: opts.name,
        };
        if (p.hasBuildOptions) {
          const optionsFlag = parseJsonFlag(opts.options as string | undefined, "--options");
          const options: Record<string, unknown> = { ...optionsFlag };
          if (p.product === "lamp" && opts.includeResultJson === true) options.include_result_json = true;
          if (Object.keys(options).length > 0) payload.options = options;
          if (opts.modelFormat) payload.output = { format: opts.modelFormat };
        }
        return payload;
      },
      validatePayload(payload) {
        if (payload.input_task_id === undefined || payload.input_task_id === null || payload.input_task_id === "") {
          throw new UsageError("provide --input-task-id (the SUCCEEDED prototype task)");
        }
        if (typeof payload.input_task_id !== "string") throw new UsageError("input_task_id must be a string");
        checkName(payload);
        if (!p.hasBuildOptions) {
          if (payload.options !== undefined || payload.output !== undefined) {
            throw new UsageError(`${p.label} build has no options/output parameters; remove them from --data`);
          }
          return;
        }
        if (payload.options !== undefined) {
          if (!payload.options || typeof payload.options !== "object" || Array.isArray(payload.options)) {
            throw new UsageError("options must be a JSON object");
          }
          const parsed = p.optionsSchema!.safeParse(payload.options);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new UsageError(`${p.label} build options invalid: ${issue ? `${issue.path.join(".")}: ${issue.message}` : parsed.error.message}`);
          }
        }
        if (payload.output !== undefined) {
          const out = payload.output as Record<string, unknown> | null;
          if (!out || typeof out !== "object" || Array.isArray(out)) throw new UsageError("output must be a JSON object");
          if (out.format !== undefined && !(p.buildFormats ?? []).includes(String(out.format))) {
            throw new UsageError(`${p.label} build output.format must be one of ${(p.buildFormats ?? []).join(" | ")}`);
          }
        }
        p.validateBuild?.(payload);
      },
    },
  };
}

function productCommand(product: CreativeLabProduct): Command {
  const p = PRODUCTS[product];
  const cmd = new Command(product).description(`Creative Lab ${p.label}: prototype (${p.prototypeMeaning}) then build (${p.buildMeaning})`);
  cmd.addCommand(buildResourceCommand(prototypeSpec(p)));
  cmd.addCommand(buildResourceCommand(buildSpec(p)));
  return cmd;
}

export const creativeLabCommand = new Command("creative-lab")
  .description("Creative Lab physical products from a photo: figure | lamp | keychain | fridge-magnet, each with prototype and build stages")
  .addHelpText(
    "after",
    `
Stages differ per product — prototype is a concept image (lamp also yields a lampshade GLB);
build consumes a SUCCEEDED prototype created through this API with the same key. Web-app
prototypes are rejected by the server (404). Build never re-runs a prototype.

    meshy creative-lab figure prototype create --image-url ./photo.png --name demo --async
    meshy creative-lab figure build create --input-task-id <prototype-id> --async
    meshy creative-lab lamp build create --input-task-id <id> --model-format zip --options '{"diameter_mm":180}'
`,
  );

for (const product of CREATIVE_LAB_PRODUCTS) creativeLabCommand.addCommand(productCommand(product));

export const CREATIVE_LAB_STAGE_NAMES: readonly CreativeLabStage[] = ["prototype", "build"];
