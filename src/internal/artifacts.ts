/**
 * Asset enumeration — which files a task exposes, under stable keys.
 *
 * Only known response fields are walked; an unknown string URL anywhere in
 * `result` is reported under `unknown_urls` and never downloaded. Keys are
 * the stable selectors of `meshy download --asset` and of the v1 download
 * manifest; the file name is derived separately and never from the key or
 * the URL alone.
 *
 * Product knowledge that changes the delivery format lives here too:
 *   - lamp build: `lamp_stl` / `base_stl` are STL files, `bundle_zip` is a ZIP;
 *   - keychain / fridge-magnet build: `model_urls.obj` is a ZIP bundle
 *     (model.obj + model.mtl + texture.png), delivered as `.zip`, unextracted;
 *   - motion clips carry their format in `result.motion_format`.
 */

import type { TaskResourceDescriptor } from "../client/resource-registry.js";
import { safeExtension, safeSegment } from "./paths.js";

export type AssetKind = "model" | "image" | "texture" | "thumbnail" | "rig" | "animation" | "motion" | "report";

export interface Asset {
  /** Stable selector, e.g. `model.glb`, `thumbnail.primary`, `result.basic_animations.walking_glb_url`. */
  key: string;
  kind: AssetKind;
  url: string | null;
  /** File format the bytes are expected to be in (extension without dot), or null when unknown. */
  format: string | null;
  /** Set when the file is a container for the nominal format (keychain OBJ is a ZIP). */
  containerFormat: string | null;
  /** Nominal model format when it differs from the file (e.g. `obj` inside a ZIP). */
  modelFormat: string | null;
  /** Response path the asset came from. */
  sourcePath: string;
  /** Suggested safe file name (directory mode). */
  filename: string;
  /** Keys this asset needs to be usable (OBJ → MTL → textures). */
  dependencies: string[];
  /** Report assets carry their JSON here instead of a URL. */
  report?: unknown;
  /** Extra flags for the manifest (e.g. extracted:false for bundles). */
  notes?: Record<string, unknown>;
}

export interface AssetEnumeration {
  assets: Asset[];
  /** String URLs found in `result` that no rule recognised. */
  unknown_urls: Array<{ path: string; url: string }>;
  product: string | null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function isUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

/** Creative Lab product from a task type such as `creative-lab-keychain-build`. */
export function productFromTaskType(type: unknown): { product: string; stage: string } | null {
  if (typeof type !== "string") return null;
  const m = /^creative-lab-([a-z-]+?)-(prototype|build)$/.exec(type);
  return m ? { product: m[1]!, stage: m[2]! } : null;
}

function modelAsset(fmtKey: string, url: string, product: string | null): Asset {
  const key = `model.${fmtKey}`;
  const sourcePath = `model_urls.${fmtKey}`;
  switch (fmtKey) {
    case "lamp_stl":
      return { key, kind: "model", url, format: "stl", containerFormat: null, modelFormat: "stl", sourcePath, filename: "lamp.stl", dependencies: [], notes: { part: "lampshade" } };
    case "base_stl":
      return { key, kind: "model", url, format: "stl", containerFormat: null, modelFormat: "stl", sourcePath, filename: "base.stl", dependencies: [], notes: { part: "fixture_base" } };
    case "bundle_zip":
      return { key, kind: "model", url, format: "zip", containerFormat: "zip", modelFormat: null, sourcePath, filename: "bundle.zip", dependencies: [], notes: { extracted: false } };
    case "pre_remeshed_glb":
      return { key, kind: "model", url, format: "glb", containerFormat: null, modelFormat: "glb", sourcePath, filename: "model.pre_remeshed.glb", dependencies: [] };
    default: {
      const ext = safeExtension(fmtKey) || null;
      if (ext === "obj" && (product === "keychain" || product === "fridge-magnet")) {
        return { key, kind: "model", url, format: "zip", containerFormat: "zip", modelFormat: "obj", sourcePath, filename: "model.obj.zip", dependencies: [], notes: { extracted: false, bundle_contents: ["model.obj", "model.mtl", "texture.png"] } };
      }
      const deps: string[] = ext === "obj" ? ["model.mtl"] : [];
      return { key, kind: "model", url, format: ext, containerFormat: null, modelFormat: ext, sourcePath, filename: ext ? `model.${ext}` : `model.${safeSegment(fmtKey)}`, dependencies: deps };
    }
  }
}

/**
 * Enumerate every downloadable asset of a task object (raw API shape).
 * `descriptor` (when known) supplies the product for Creative Lab builds.
 */
export function enumerateAssets(task: Record<string, unknown>, descriptor?: TaskResourceDescriptor | null): AssetEnumeration {
  const assets: Asset[] = [];
  const unknown: Array<{ path: string; url: string }> = [];
  const product = descriptor?.creativeLab?.product ?? productFromTaskType(task["type"])?.product ?? null;

  const modelUrls = task["model_urls"];
  if (modelUrls && typeof modelUrls === "object" && !Array.isArray(modelUrls)) {
    for (const [fmt, url] of Object.entries(modelUrls as Record<string, unknown>)) {
      if (isUrl(url)) assets.push(modelAsset(fmt, url, product));
    }
  }
  // OBJ depends on MTL only when the MTL exists in this task.
  const hasMtl = assets.some((a) => a.key === "model.mtl");
  for (const a of assets) {
    if (a.key === "model.obj" && a.containerFormat === null) {
      a.dependencies = hasMtl ? ["model.mtl", ...textureKeys(task)] : [];
    }
  }

  if (isUrl(task["thumbnail_url"])) {
    assets.push({ key: "thumbnail.primary", kind: "thumbnail", url: task["thumbnail_url"], format: "png", containerFormat: null, modelFormat: null, sourcePath: "thumbnail_url", filename: "thumbnail.png", dependencies: [] });
  }
  const thumbs = task["thumbnail_urls"];
  if (thumbs && typeof thumbs === "object") {
    if (Array.isArray(thumbs)) {
      thumbs.forEach((url, i) => {
        if (isUrl(url)) assets.push({ key: `thumbnail.${i}`, kind: "thumbnail", url, format: "png", containerFormat: null, modelFormat: null, sourcePath: `thumbnail_urls[${i}]`, filename: `thumbnail_${i}.png`, dependencies: [] });
      });
    } else {
      for (const [view, url] of Object.entries(thumbs as Record<string, unknown>)) {
        if (isUrl(url)) assets.push({ key: `thumbnail.${safeSegment(view)}`, kind: "thumbnail", url, format: "png", containerFormat: null, modelFormat: null, sourcePath: `thumbnail_urls.${view}`, filename: `thumbnail_${safeSegment(view)}.png`, dependencies: [], notes: { view } });
      }
    }
  }
  if (isUrl(task["alpha_thumbnail_url"])) {
    assets.push({ key: "thumbnail.alpha", kind: "thumbnail", url: task["alpha_thumbnail_url"], format: "png", containerFormat: null, modelFormat: null, sourcePath: "alpha_thumbnail_url", filename: "thumbnail_alpha.png", dependencies: [] });
  }

  const textures = task["texture_urls"];
  if (Array.isArray(textures)) {
    textures.forEach((set, i) => {
      if (!set || typeof set !== "object") return;
      for (const [channel, url] of Object.entries(set as Record<string, unknown>)) {
        if (isUrl(url)) {
          assets.push({ key: `texture.${i}.${safeSegment(channel)}`, kind: "texture", url, format: "png", containerFormat: null, modelFormat: null, sourcePath: `texture_urls[${i}].${channel}`, filename: `texture_${i}_${safeSegment(channel)}.png`, dependencies: [] });
        }
      }
    });
  }

  const images = task["image_urls"];
  if (Array.isArray(images)) {
    images.forEach((url, i) => {
      if (isUrl(url)) assets.push({ key: `image.${i}`, kind: "image", url, format: null, containerFormat: null, modelFormat: null, sourcePath: `image_urls[${i}]`, filename: `image_${i}`, dependencies: [] });
    });
  }

  const result = task["result"];
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    const motionFormat = typeof r["motion_format"] === "string" ? safeExtension(r["motion_format"] as string) : "";
    for (const [field, value] of Object.entries(r)) {
      if (field === "basic_animations" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [sub, url] of Object.entries(value as Record<string, unknown>)) {
          if (!isUrl(url)) continue;
          const ext = extFromFieldName(sub);
          assets.push({ key: `result.basic_animations.${safeSegment(sub)}`, kind: "animation", url, format: ext, containerFormat: null, modelFormat: ext, sourcePath: `result.basic_animations.${sub}`, filename: `${safeSegment(sub.replace(/_url$/, ""))}${ext ? `.${ext}` : ""}`, dependencies: [] });
        }
        continue;
      }
      if (!isUrl(value)) {
        if (value && typeof value === "object") collectUnknownUrls(value, `result.${field}`, unknown);
        continue;
      }
      if (field === "motion_url") {
        const ext = motionFormat === "fbx" || motionFormat === "bvh" ? motionFormat : null;
        assets.push({ key: "result.motion_url", kind: "motion", url: value, format: ext, containerFormat: null, modelFormat: ext, sourcePath: "result.motion_url", filename: ext ? `motion.${ext}` : "motion", dependencies: [] });
        continue;
      }
      if (/^rigged_character_(glb|fbx)_url$/.test(field)) {
        const ext = extFromFieldName(field);
        assets.push({ key: `result.${field}`, kind: "rig", url: value, format: ext, containerFormat: null, modelFormat: ext, sourcePath: `result.${field}`, filename: `rigged_character.${ext}`, dependencies: [] });
        continue;
      }
      if (/^(animation_(glb|fbx)_url|processed_[a-z0-9_]+_url)$/.test(field)) {
        const ext = extFromFieldName(field);
        assets.push({ key: `result.${field}`, kind: "animation", url: value, format: ext, containerFormat: null, modelFormat: ext, sourcePath: `result.${field}`, filename: `${safeSegment(field.replace(/_url$/, ""))}${ext ? `.${ext}` : ""}`, dependencies: [] });
        continue;
      }
      unknown.push({ path: `result.${field}`, url: value });
    }
  }

  const printability = task["printability"];
  if (printability && typeof printability === "object") {
    assets.push({ key: "report.printability", kind: "report", url: null, format: "json", containerFormat: null, modelFormat: null, sourcePath: "printability", filename: "printability.json", dependencies: [], report: printability });
  }

  return { assets, unknown_urls: unknown, product };
}

function textureKeys(task: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const textures = task["texture_urls"];
  if (Array.isArray(textures)) {
    textures.forEach((set, i) => {
      if (!set || typeof set !== "object") return;
      for (const [channel, url] of Object.entries(set as Record<string, unknown>)) {
        if (isUrl(url)) keys.push(`texture.${i}.${safeSegment(channel)}`);
      }
    });
  }
  return keys;
}

function extFromFieldName(field: string): string | null {
  const m = /_(glb|fbx|usdz|obj|bvh|png|jpg|jpeg|webp|gltf|stl|3mf)_url$/i.exec(field);
  if (m) return m[1]!.toLowerCase();
  // processed_usdz_url → usdz ; processed_armature_fbx_url → fbx handled above ; processed_animation_fps_fbx_url → fbx
  return null;
}

function collectUnknownUrls(value: unknown, path: string, out: Array<{ path: string; url: string }>): void {
  if (isUrl(value)) {
    out.push({ path, url: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectUnknownUrls(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) collectUnknownUrls(v, `${path}.${k}`, out);
  }
}

/** 0.2.0 artifact keys → stable keys, so old scripts and internal tests keep resolving. */
export const LEGACY_KEY_ALIASES: Readonly<Record<string, string>> = {
  thumbnail: "thumbnail.primary",
  motion_url: "result.motion_url",
};

export function resolveAssetKey(requested: string, assets: readonly Asset[]): Asset | undefined {
  const direct = assets.find((a) => a.key === requested);
  if (direct) return direct;
  const alias = LEGACY_KEY_ALIASES[requested];
  if (alias) return assets.find((a) => a.key === alias);
  let m = /^model_([a-z0-9_]+)$/i.exec(requested);
  if (m) return assets.find((a) => a.key === `model.${m![1]}`);
  m = /^image_(\d+)$/.exec(requested);
  if (m) return assets.find((a) => a.key === `image.${m![1]}`);
  m = /^texture_(\d+)_([a-z0-9_]+)$/i.exec(requested);
  if (m) return assets.find((a) => a.key === `texture.${m![1]}.${m![2]}`);
  m = /^([a-z0-9_]+_url)$/i.exec(requested);
  if (m) return assets.find((a) => a.key === `result.${m![1]}` || a.key === `result.basic_animations.${m![1]}`);
  return undefined;
}

export interface Selection {
  keys?: string[];
  modelFormat?: string;
  kind?: AssetKind;
  all?: boolean;
}

export interface SelectionResult {
  selected: Asset[];
  /** Dependencies pulled in for selected OBJ files (empty when geometryOnly). */
  dependencies: Asset[];
  missingDependencies: string[];
}

/**
 * Apply a selector to the enumeration. Exactly one selector kind must be
 * given; contradictory combinations are rejected by the caller (usage).
 * With `withDependencies`, an OBJ selection pulls its MTL and textures.
 */
export function selectAssets(enumeration: AssetEnumeration, sel: Selection, opts: { withDependencies: boolean }): SelectionResult {
  const { assets } = enumeration;
  let selected: Asset[];
  if (sel.all) selected = assets.filter((a) => a.url !== null || a.kind === "report");
  else if (sel.keys && sel.keys.length > 0) {
    selected = [];
    for (const k of sel.keys) {
      const a = resolveAssetKey(k, assets);
      if (!a) throw new SelectionError(`no asset with key '${k}'`, assets);
      if (!selected.includes(a)) selected.push(a);
    }
  } else if (sel.modelFormat) {
    const fmt = sel.modelFormat.toLowerCase();
    selected = assets.filter((a) => a.kind === "model" && (a.key === `model.${fmt}` || a.modelFormat === fmt || a.format === fmt));
    if (selected.length === 0) throw new SelectionError(`no model asset in format '${sel.modelFormat}'`, assets);
  } else if (sel.kind) {
    selected = assets.filter((a) => a.kind === sel.kind);
    if (selected.length === 0) throw new SelectionError(`no asset of kind '${sel.kind}'`, assets);
  } else {
    throw new SelectionError("no selector given", assets);
  }
  const dependencies: Asset[] = [];
  const missing: string[] = [];
  if (opts.withDependencies) {
    for (const a of selected) {
      for (const dep of a.dependencies) {
        const d = assets.find((x) => x.key === dep);
        if (!d) missing.push(dep);
        else if (!selected.includes(d) && !dependencies.includes(d)) dependencies.push(d);
      }
    }
  }
  return { selected, dependencies, missingDependencies: missing };
}

export class SelectionError extends Error {
  readonly candidates: Array<{ key: string; kind: AssetKind; format: string | null }>;
  constructor(message: string, assets: readonly Asset[]) {
    super(message);
    this.name = "SelectionError";
    this.candidates = assets.map((a) => ({ key: a.key, kind: a.kind, format: a.format }));
  }
}
