/**
 * relief — https://docs.meshy.ai/en/api/relief
 *
 * Turns one photo into a bas-relief model and a 16-bit grayscale depth map,
 * for 3D printing, laser engraving and CNC carving. `--depth-only` asks for
 * the depth map alone: no model and no preview image, billed like a full task.
 *
 * Every range and rule the API documents is checked on the merged payload
 * (--data and flags alike) before the request: the numeric ranges, an integer
 * mesh resolution, the base-thickness rule with remove_base, target formats
 * from the documented set without repeats. Parameters the API documents as
 * unused in a combination are refused rather than sent (D-076):
 * removal_threshold without remove_base, the bend axis and angle without a
 * bend, and the model settings of a depth-only task. A zero carving depth
 * with remove_base is sent with a warning: the API builds an empty model and
 * still bills it.
 *
 * Nothing is pinned: a flag left out is left out of the request, so the API's
 * own defaults apply (low variant, 60 mm, GLB + STL).
 *
 * A relief task cannot be the input of another endpoint (remesh, convert,
 * resize, auto-split …); the API answers 403.
 */

import { Option } from "commander";
import { UsageError, type Warning } from "../internal/errors.js";
import { parseBool, parseCsv, parseNumber } from "../internal/flags.js";
import { warning } from "../internal/result.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

export const RELIEF_VARIANTS = ["low", "high"] as const;
export const RELIEF_CARVING_MODES = ["emboss", "engrave"] as const;
export const RELIEF_BEND_MODES = ["off", "convex", "concave"] as const;
export const RELIEF_BEND_AXES = ["xz", "yz"] as const;
export const RELIEF_TARGET_FORMATS = ["glb", "obj", "fbx", "stl", "usdz", "3mf"] as const;
/** Formats that carry the photo's color with color_mapping; STL and 3MF stay white. */
const COLOR_FORMATS = new Set(["glb", "obj", "fbx", "usdz"]);

/** Inclusive numeric ranges from the API reference. */
const RANGES = {
  size_mm: [20, 250],
  carving_depth_mm: [0, 60],
  removal_threshold: [0.01, 1],
  base_thickness_mm: [0.1, 10],
  bend_angle: [0, 360],
  mesh_resolution: [512, 2048],
} as const satisfies Record<string, readonly [number, number]>;

/** Settings that shape the model; a depth-only task has no model to shape. */
const MODEL_SETTINGS = [
  "size_mm",
  "carving_mode",
  "carving_depth_mm",
  "remove_base",
  "removal_threshold",
  "base_thickness_mm",
  "bend_mode",
  "bend_axis",
  "bend_angle",
  "mesh_resolution",
  "target_formats",
  "color_mapping",
] as const;

const flagOf = (key: string): string => `--${key.replace(/_/g, "-")}`;
const present = (payload: Record<string, unknown>, key: string): boolean => payload[key] !== undefined && payload[key] !== null;

function checkEnum(payload: Record<string, unknown>, key: string, values: readonly string[]): void {
  const v = payload[key];
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || !values.includes(v)) {
    throw new UsageError(`${flagOf(key)} must be one of ${values.join(" | ")} (got ${JSON.stringify(v)})`);
  }
}

function checkBool(payload: Record<string, unknown>, key: string, flag = flagOf(key)): void {
  if (present(payload, key) && typeof payload[key] !== "boolean") {
    throw new UsageError(`${flag} must be true or false (got ${JSON.stringify(payload[key])})`);
  }
}

function checkRange(payload: Record<string, unknown>, key: keyof typeof RANGES, opts: { integer?: boolean } = {}): void {
  if (!present(payload, key)) return;
  const [min, max] = RANGES[key];
  const v = payload[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (opts.integer && !Number.isInteger(v))) {
    throw new UsageError(`${flagOf(key)} must be ${opts.integer ? "an integer" : "a number"} from ${min} to ${max} (got ${JSON.stringify(v)})`);
  }
}

function checkTargetFormats(payload: Record<string, unknown>): void {
  if (!present(payload, "target_formats")) return;
  const formats = payload.target_formats;
  if (!Array.isArray(formats) || formats.length === 0) {
    throw new UsageError(`--target-formats must list at least one of ${RELIEF_TARGET_FORMATS.join(", ")}`);
  }
  const seen = new Set<string>();
  for (const f of formats) {
    if (typeof f !== "string" || !(RELIEF_TARGET_FORMATS as readonly string[]).includes(f)) {
      throw new UsageError(`--target-formats: unknown format ${JSON.stringify(f)}; choose from ${RELIEF_TARGET_FORMATS.join(", ")} (OBJ comes with its MTL)`);
    }
    if (seen.has(f)) throw new UsageError(`--target-formats lists '${f}' twice`);
    seen.add(f);
  }
}

export function validateReliefPayload(payload: Record<string, unknown>): void {
  if (typeof payload.image_url !== "string" || !payload.image_url) {
    throw new UsageError("provide --image-url (a photo as an http(s) URL, data: URI or local jpg/jpeg/png/webp file)");
  }
  // The API reads "" as "not sent", like an omitted variant.
  if (payload.variant !== "") checkEnum(payload, "variant", RELIEF_VARIANTS);
  checkBool(payload, "should_generate_model", "should_generate_model (--depth-only)");
  checkEnum(payload, "carving_mode", RELIEF_CARVING_MODES);
  checkEnum(payload, "bend_mode", RELIEF_BEND_MODES);
  checkEnum(payload, "bend_axis", RELIEF_BEND_AXES);
  checkBool(payload, "remove_base");
  checkBool(payload, "color_mapping");
  checkRange(payload, "size_mm");
  checkRange(payload, "carving_depth_mm");
  checkRange(payload, "removal_threshold");
  checkRange(payload, "bend_angle");
  checkRange(payload, "mesh_resolution", { integer: true });
  checkTargetFormats(payload);

  if (payload.should_generate_model === false) {
    const set = MODEL_SETTINGS.filter((k) => present(payload, k));
    if (set.length > 0) {
      throw new UsageError(
        `--depth-only returns the depth map alone, so ${set.map(flagOf).join(", ")} ${set.length === 1 ? "does" : "do"} not apply; drop ${set.length === 1 ? "it" : "them"} or leave out --depth-only`,
      );
    }
    return;
  }

  const removeBase = payload.remove_base === true;
  if (present(payload, "base_thickness_mm")) {
    const t = payload.base_thickness_mm;
    if (removeBase) {
      if (t !== 0) {
        throw new UsageError(`--remove-base true builds no base plate: leave out --base-thickness-mm or pass 0 (got ${JSON.stringify(t)})`);
      }
    } else {
      checkRange(payload, "base_thickness_mm");
    }
  }
  if (present(payload, "removal_threshold") && !removeBase) {
    throw new UsageError("--removal-threshold applies with --remove-base true only");
  }
  const bent = payload.bend_mode === "convex" || payload.bend_mode === "concave";
  const bendShape = (["bend_axis", "bend_angle"] as const).filter((k) => present(payload, k));
  if (bendShape.length > 0 && !bent) {
    throw new UsageError(`${bendShape.map(flagOf).join(" and ")} ${bendShape.length === 1 ? "applies" : "apply"} with --bend-mode convex or concave only`);
  }
}

/**
 * Requests the API runs but that likely miss what was meant: color mapping on
 * formats that cannot show it (the texture still comes back, the models stay
 * white), and a zero carving depth with the base removed (an empty model,
 * still billed).
 */
export function reliefWarnings(payload: Record<string, unknown>): Warning[] {
  const warnings: Warning[] = [];
  const formats = payload.target_formats;
  if (payload.color_mapping === true && Array.isArray(formats) && !formats.some((f) => typeof f === "string" && COLOR_FORMATS.has(f))) {
    warnings.push(
      warning(
        "color_not_in_formats",
        `--color-mapping true: ${formats.join(", ")} carr${formats.length === 1 ? "ies" : "y"} no color, so the model stays white; the texture is returned in texture_urls (add glb, obj, fbx or usdz for a colored model)`,
      ),
    );
  }
  if (payload.should_generate_model !== false && payload.remove_base === true && payload.carving_depth_mm === 0) {
    warnings.push(
      warning(
        "empty_model",
        "--carving-depth-mm 0 with --remove-base true builds a model with no geometry, and the task is still billed",
      ),
    );
  }
  return warnings;
}

export const reliefSpec: ResourceCommandSpec = {
  name: "relief",
  description:
    "Turn one photo into a bas-relief model and a 16-bit grayscale depth map, for 3D printing, laser engraving " +
    "and CNC carving (--depth-only: the depth map alone). Needs a paid plan. A relief task cannot be the input " +
    "of another command (remesh, convert, resize, auto-split …)",
  create: {
    description: "Create a relief task from a photo",
    configure(cmd) {
      return cmd
        .option("--image-url <src>", "photo: http(s) URL, data: URI or local jpg/jpeg/png/webp path, at most 20 MB and at least 32x32 px (required)")
        .addOption(
          new Option(
            "--variant <variant>",
            "low (default; shallow carving for laser engraving, CNC and thin plaques) | high (deeper carving for 3D-printed pieces)",
          ).choices([...RELIEF_VARIANTS]),
        )
        .option(
          "--depth-only",
          "return only the 16-bit depth map: no model, no preview image (sends should_generate_model false; billed like a full task)",
        )
        .option("--size-mm <mm>", "length of the photo's longer side on the model, measured flat before any bend: 20-250 (default: 60)", parseNumber)
        .addOption(
          new Option("--carving-mode <mode>", "emboss (default; nearer parts stand out) | engrave (depth inverted, nearer parts cut in)").choices([
            ...RELIEF_CARVING_MODES,
          ]),
        )
        .option("--carving-depth-mm <mm>", "how deep the relief is carved: 0-60 (default: 6 on high, 3 on low)", parseNumber)
        .option("--remove-base <bool>", "cut the background away and build no base plate (default: false)", parseBool)
        .option("--removal-threshold <n>", "with --remove-base true: depth below which the background is cut away, 0.01-1 on the depth map's 0-1 scale (default: 0.01)", parseNumber)
        .option("--base-thickness-mm <mm>", "base plate thickness: 0.1-10 (default: 1); with --remove-base true leave it out or pass 0", parseNumber)
        .addOption(
          new Option("--bend-mode <mode>", "off (default; flat) | convex (the front bulges outward) | concave (the front curves inward)").choices([
            ...RELIEF_BEND_MODES,
          ]),
        )
        .addOption(
          new Option("--bend-axis <axis>", "with --bend-mode convex|concave: xz (default; curls the left and right edges) | yz (the top and bottom edges)").choices([
            ...RELIEF_BEND_AXES,
          ]),
        )
        .option("--bend-angle <deg>", "with --bend-mode convex|concave: the arc the bend spans, 0-360 degrees (default: 60; below 1 stays flat)", parseNumber)
        .option(
          "--mesh-resolution <n>",
          "mesh points along the photo's longer side, an integer 512-2048 (default: 1024). Higher keeps finer detail and makes much larger files: " +
            "about 40-50 MB GLB and 80-105 MB STL at 1024, about 150 MB and 300 MB at 2048, more with a bend",
          parseNumber,
        )
        .option(
          "--target-formats <csv>",
          "glb,obj,fbx,stl,usdz,3mf (default: glb,stl); only the listed formats are generated. OBJ comes with its MTL; STL and 3MF keep the real size in millimetres",
          parseCsv,
        )
        .option(
          "--color-mapping <bool>",
          "color the model with the photo (default: false): GLB, OBJ, FBX and USDZ carry the color, STL and 3MF stay white; the texture comes back in texture_urls",
          parseBool,
        );
    },
    toPayload(opts) {
      return {
        image_url: opts.imageUrl,
        variant: opts.variant,
        should_generate_model: opts.depthOnly === true ? false : undefined,
        size_mm: opts.sizeMm,
        carving_mode: opts.carvingMode,
        carving_depth_mm: opts.carvingDepthMm,
        remove_base: opts.removeBase,
        removal_threshold: opts.removalThreshold,
        base_thickness_mm: opts.baseThicknessMm,
        bend_mode: opts.bendMode,
        bend_axis: opts.bendAxis,
        bend_angle: opts.bendAngle,
        mesh_resolution: opts.meshResolution,
        target_formats: opts.targetFormats,
        color_mapping: opts.colorMapping,
      };
    },
    validatePayload: (payload) => validateReliefPayload(payload),
    warnPayload: reliefWarnings,
  },
};

export const reliefCommand = buildResourceCommand(reliefSpec);
