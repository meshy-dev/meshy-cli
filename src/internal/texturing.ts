/**
 * Texturing on the image-driven generators (image-to-3d, multi-image-to-3d).
 *
 * The API textures by default (`should_texture` defaults to true), and so
 * does the CLI: `should_texture: false` is the untextured draft mesh. The
 * game-ready texture settings ride only when texturing is on, because the
 * API refuses texture settings on an untextured run.
 *
 * The texture model (`texture_model`, PRO-4335) is picked apart from the
 * geometry: meshy-7 (PBR, 2k/4k/8k), meshy-n1 (Meshy N1: a 2k base color from
 * the input images, no prompt, no PBR) or meshy-6-lite (2k, single image
 * only). Omitted, nothing is sent and the geometry's own texture model runs:
 * Meshy 7 on Meshy 7.1 and Smart Topology, Meshy 6 Lite on meshy-6-lite. The
 * texture defaults follow the texture model that runs, and an ask it cannot
 * honour is refused before the POST (decisions.md D-091).
 */

import { UsageError } from "./errors.js";

const MESHY_7 = "meshy-7";
const MESHY_N1 = "meshy-n1";
const MESHY_6_LITE = "meshy-6-lite";

/** The `--texture-model` values on image-to-3d. */
export const IMAGE_TO_3D_TEXTURE_MODELS = [MESHY_7, MESHY_N1, MESHY_6_LITE] as const;
/** The `--texture-model` values on multi-image-to-3d: the API takes the multi-view texture models only. */
export const MULTI_IMAGE_TO_3D_TEXTURE_MODELS = [MESHY_7, MESHY_N1] as const;

/** Texture models that make a 2k base color only. */
const TWO_K_ONLY: readonly string[] = [MESHY_N1, MESHY_6_LITE];

/** A texture_model the API reads as sent: "" (or a JSON null) is the omitted field. */
const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/**
 * Each geometry's own texture model, the one that runs when texture_model is
 * omitted (meshyd APIImageTo3DDefaultTextureModel). An omitted or unlisted
 * ai_model is the API default's: Meshy 7.
 */
const GEOMETRY_TEXTURE_MODEL: Readonly<Record<string, string>> = {
  latest: MESHY_7,
  "meshy-7.1": MESHY_7,
  "meshy-7": MESHY_7,
  "meshy-t2.5": MESHY_7,
  "meshy-t2": MESHY_7,
  "meshy-6": "meshy-6",
  "meshy-6-lite": MESHY_6_LITE,
  "meshy-5": MESHY_6_LITE, // retired; textures with Meshy 6 Lite while the API still takes it
};

/**
 * The texture model a request runs: the picked `texture_model`, else the
 * geometry's own. `explicit` says which, for the refusal's wording.
 */
function textureModelFor(picked: unknown, geometry: unknown): { model: unknown; explicit: boolean } {
  if (isSet(picked)) return { model: picked, explicit: true };
  const own = typeof geometry === "string" && Object.hasOwn(GEOMETRY_TEXTURE_MODEL, geometry) ? GEOMETRY_TEXTURE_MODEL[geometry] : MESHY_7;
  return { model: own, explicit: false };
}

/**
 * The texture model the request runs, with texture_model and ai_model each
 * read where the merged payload takes it from (the flag, then --data), so
 * `--data '{"ai_model":"meshy-6-lite"}'` gets the 2k Meshy 6 Lite defaults.
 */
function runningTextureModel(opts: Record<string, unknown>, data: Record<string, unknown>): unknown {
  return textureModelFor(opts.textureModel ?? data["texture_model"], opts.aiModel ?? data["ai_model"]).model;
}

/**
 * ai_model values whose should_remesh defaults to false on the API (meshyd
 * ResolveShouldRemeshDefault); an omitted ai_model is latest. Every other
 * model (meshy-6-lite, meshy-5) remeshes by default.
 */
const REMESH_OFF_BY_DEFAULT: readonly string[] = ["latest", "meshy-6", "meshy-7", "meshy-7.1", "meshy-t1", "meshy-t2", "meshy-t2.5"];

/** Whether the API runs a remesh for this payload: should_remesh as sent, else the model's default. */
function remeshRuns(payload: Record<string, unknown>): boolean {
  const asked = payload["should_remesh"];
  if (typeof asked === "boolean") return asked;
  const model = typeof payload["ai_model"] === "string" ? payload["ai_model"] : "latest";
  return !REMESH_OFF_BY_DEFAULT.includes(model);
}

/**
 * Default texture settings — the full PBR map set and a 4k base color —
 * unless the flags or `--data` turn texturing off (the flag wins, as in the
 * merged payload). They follow the texture model that runs: meshy-n1 makes a
 * 2k base color only (PBR off), meshy-6-lite makes 2k with PBR maps.
 */
export function texturingDefaults(opts: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const shouldTexture = opts.shouldTexture ?? data["should_texture"];
  if (shouldTexture === false) return {};
  const model = runningTextureModel(opts, data);
  if (model === MESHY_N1) return { enable_pbr: false, texture_resolution: "2k" };
  if (model === MESHY_6_LITE) return { enable_pbr: true, texture_resolution: "2k" };
  return { enable_pbr: true, texture_resolution: "4k" };
}

/** Refuse texture settings on an untextured run, before the POST the API would answer with a 400. */
export function refuseTextureSettingsWithoutTexture(payload: Record<string, unknown>, keys: readonly string[]): void {
  if (payload["should_texture"] !== false) return;
  // The API ignores texture_model on an untextured run rather than refusing
  // it; the CLI refuses it too, so a texture model asked for never vanishes.
  if (isSet(payload["texture_model"])) {
    throw new UsageError("--texture-model cannot be used with --should-texture false: an untextured run has no texture model (texture it later with retexture)");
  }
  const set = keys.filter((k) => payload[k] !== undefined).map((k) => `--${k.replace(/_/g, "-")}`);
  if (set.length > 0) {
    throw new UsageError(`${set.join(", ")} cannot be used with --should-texture false: the API refuses texture settings on an untextured run`);
  }
}

/**
 * Refuse, on the merged payload (so `--data` meets the same rules as the
 * flags), what the texture model that runs cannot do — the API's 400s,
 * checked before the POST. That is the picked texture_model, else the
 * geometry's own (Meshy 6 Lite on ai_model meshy-6-lite). Nothing is
 * rewritten to what the model can make. The defaults never trip this: they
 * follow the same texture model.
 *
 *   - meshy-n1: a texture prompt, PBR, 4k/8k (or hd_texture), remove_lighting
 *     true, a quad remesh (one that runs: should_remesh as sent, else the
 *     geometry's default);
 *   - meshy-6-lite: 4k/8k (or hd_texture), remove_lighting true; and as a
 *     picked texture_model on multi-image-to-3d it is refused outright, as is
 *     meshy-6;
 *   - meshy-7: nothing.
 *
 * hd_texture true beside an explicit "2k" is the CLI's own refusal (the API
 * runs it at 2k), as on retexture: the caller asked for a texture the model
 * cannot make.
 */
export function refuseTextureModelConflicts(payload: Record<string, unknown>, endpoint: "image-to-3d" | "multi-image-to-3d"): void {
  if (payload["should_texture"] === false) return;
  const { model, explicit } = textureModelFor(payload["texture_model"], payload["ai_model"]);
  if (explicit && endpoint === "multi-image-to-3d" && (model === MESHY_6_LITE || model === "meshy-6")) {
    throw new UsageError(
      `multi-image-to-3d takes the multi-view texture models only: --texture-model ${MESHY_7} or ${MESHY_N1} (the API refuses ${String(model)} here)`,
    );
  }
  if (typeof model !== "string" || !TWO_K_ONLY.includes(model)) return;
  const conflicts: string[] = [];
  if (model === MESHY_N1) {
    if (typeof payload["texture_prompt"] === "string" && payload["texture_prompt"].trim() !== "") {
      conflicts.push("--texture-prompt (it textures from the reference images only)");
    }
    if (payload["enable_pbr"] === true) conflicts.push("--enable-pbr true (it makes a base color texture only)");
  }
  const resolution = payload["texture_resolution"];
  if (resolution === "4k" || resolution === "8k") conflicts.push(`--texture-resolution ${resolution} (it makes 2k only)`);
  if (payload["hd_texture"] === true) conflicts.push("hd_texture true (that is 4k; it makes 2k only)");
  if (payload["remove_lighting"] === true) conflicts.push("--remove-lighting true (the API refuses it)");
  if (model === MESHY_N1 && payload["topology"] === "quad" && remeshRuns(payload)) {
    conflicts.push("topology quad with a remesh (the API refuses a quad remesh with it)");
  }
  if (conflicts.length === 0) return;
  const subject = explicit
    ? `--texture-model ${model}`
    : `ai_model ${String(payload["ai_model"])}, which textures with ${model},`;
  throw new UsageError(`${subject} cannot be used with ${conflicts.join(", ")}; drop them or pick ${explicit ? "another" : "a"} --texture-model`);
}

/**
 * The "choose models by project" guide (PRO-4335 C2): the same content in
 * every Meshy integration, with the Models page for detail. Shown after the
 * flags in `create --help`, followed by how this command reaches each row.
 */
export const MODEL_GUIDE = [
  "Choose models by project (geometry ai_model + texture_model):",
  "  Detailed hero asset, product render, cinematic prop:  meshy-7.1 + meshy-7 (PBR, up to 8K)",
  "  Game character to rig and animate:  meshy-t2.5 (smart topology, set target_polycount) + meshy-n1",
  "  Many props for a game scene, or user-generated content:  meshy-t2 (smart topology) + meshy-n1",
  "  A real object from 2 to 4 photos:  meshy-7.1 on Multi-Image to 3D + meshy-7",
  "  A model to 3D print:  meshy-7.1 + none, or meshy-7 to print in color",
  "  Many drafts at a low cost:  meshy-6-lite + meshy-6-lite",
  "More: https://docs.meshy.ai/en/api/models",
].join("\n");

/** The guide plus how one command reaches its rows, for commander's addHelpText("after"). */
export function modelGuideHelp(howHere: readonly string[]): string {
  return `\n${MODEL_GUIDE}\n\n${howHere.join("\n")}\n`;
}
