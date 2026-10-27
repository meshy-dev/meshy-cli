/**
 * Resource registry — the single source for what the CLI can call.
 *
 * Every task resource (the first-class endpoints plus the Creative Lab
 * stages) is described once: command path, API family, relative path,
 * supported verbs, billing class and the payload fields that carry media.
 * Commands, the `resources` index, payload normalisation and the transport
 * all read from here; nothing else hard-codes a path.
 */

export type ApiBase = "v1" | "v2" | "creative-lab";
export type MediaKind = "image" | "model";
export type Billing = "none" | "may-charge";
/** Two-stage products (prototype → build). */
export type CreativeLabProduct =
  | "figure"
  | "lamp"
  | "keychain"
  | "fridge-magnet"
  | "vinyl-figure"
  | "brick-figure"
  | "keycap"
  | "fidget-pixel";
/** Products with a single create, no stages. */
export type CreativeLabSingleProduct = "fidget-collapsible";
export type CreativeLabStage = "prototype" | "build";
export type Verb = "create" | "get" | "list" | "delete" | "stream";

export interface MediaField {
  /** snake_case payload field that carries the media reference. */
  path: string;
  kind: MediaKind;
  many: boolean;
  /** When set, only these file extensions/formats are accepted for local files. */
  formats?: readonly string[];
  /** Appended to the error when a local file or data: URI is not one of `formats`. */
  formatsHint?: string;
}

export interface VerbSupport {
  create: boolean;
  get: boolean;
  list: boolean;
  delete: boolean;
  stream: boolean;
}

export interface TaskResourceDescriptor {
  /** Stable id, dotted for Creative Lab: `creative-lab.figure.prototype`. */
  id: string;
  /** Command tokens after `meshy`. */
  commandPath: readonly string[];
  base: ApiBase;
  /** Appended to the base URL of the API family. */
  relativePath: string;
  /** Full API path (`/openapi/v1/image-to-3d`), reported in results and by `resources`. */
  endpoint: string;
  supports: VerbSupport;
  mediaFields: readonly MediaField[];
  /** `type` values the server reports for this resource. */
  taskTypes: readonly string[];
  billing: { create: Billing };
  /** Never true in S1: nothing billable is retried for the caller. */
  automaticRetry: false;
  creativeLab?: { product: CreativeLabProduct | CreativeLabSingleProduct; stage: CreativeLabStage | null };
  summary: string;
}

const ALL_VERBS: VerbSupport = { create: true, get: true, list: true, delete: true, stream: true };

const image = (path: string, many = false, formats?: readonly string[]): MediaField =>
  formats ? { path, kind: "image", many, formats } : { path, kind: "image", many };
const model = (path: string, formats?: readonly string[], formatsHint?: string): MediaField => ({
  path,
  kind: "model",
  many: false,
  ...(formats ? { formats } : {}),
  ...(formatsHint ? { formatsHint } : {}),
});

/**
 * The API takes an inline (data:) model only as glTF, and a local file is
 * always sent inline. Other formats need a URL the API can fetch itself.
 * multi-color-print takes GLB or FBX at all, so inline it is GLB only.
 */
const INLINE_MODEL_FORMATS = ["glb", "gltf"] as const;
const INLINE_MODEL_HINT =
  "the API takes an inline (local) model as glTF only — for .stl/.obj/.fbx pass a public http(s) URL, or --input-task-id";
const inlineModel = (path: string): MediaField => model(path, INLINE_MODEL_FORMATS, INLINE_MODEL_HINT);

function v1(id: string, relativePath: string, opts: {
  mediaFields?: readonly MediaField[];
  taskTypes: readonly string[];
  billing?: Billing;
  summary: string;
}): TaskResourceDescriptor {
  return {
    id,
    commandPath: [id],
    base: "v1",
    relativePath,
    endpoint: `/openapi/v1${relativePath}`,
    supports: ALL_VERBS,
    mediaFields: opts.mediaFields ?? [],
    taskTypes: opts.taskTypes,
    billing: { create: opts.billing ?? "may-charge" },
    automaticRetry: false,
    summary: opts.summary,
  };
}

export const CREATIVE_LAB_PRODUCTS: readonly CreativeLabProduct[] = [
  "figure",
  "lamp",
  "keychain",
  "fridge-magnet",
  "vinyl-figure",
  "brick-figure",
  "keycap",
  "fidget-pixel",
];
export const CREATIVE_LAB_STAGES: readonly CreativeLabStage[] = ["prototype", "build"];
const CREATIVE_LAB_IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp"] as const;

function creativeLab(product: CreativeLabProduct, stage: CreativeLabStage, summary: string): TaskResourceDescriptor {
  const relativePath = `/${product}/v1/${stage}`;
  return {
    id: `creative-lab.${product}.${stage}`,
    commandPath: ["creative-lab", product, stage],
    base: "creative-lab",
    relativePath,
    endpoint: `/openapi/creative-lab${relativePath}`,
    supports: ALL_VERBS,
    mediaFields: stage === "prototype" ? [image("image_url", false, CREATIVE_LAB_IMAGE_FORMATS)] : [],
    taskTypes: [`creative-lab-${product}-${stage}`],
    billing: { create: "may-charge" },
    automaticRetry: false,
    creativeLab: { product, stage },
    summary,
  };
}

/** A single-stage product: one create on the product root, no prototype/build. */
function creativeLabSingle(product: CreativeLabSingleProduct, summary: string): TaskResourceDescriptor {
  const relativePath = `/${product}/v1`;
  return {
    id: `creative-lab.${product}`,
    commandPath: ["creative-lab", product],
    base: "creative-lab",
    relativePath,
    endpoint: `/openapi/creative-lab${relativePath}`,
    supports: ALL_VERBS,
    mediaFields: [image("image_url", false, CREATIVE_LAB_IMAGE_FORMATS)],
    taskTypes: [`creative-lab-${product}`],
    billing: { create: "may-charge" },
    automaticRetry: false,
    creativeLab: { product, stage: null },
    summary,
  };
}

export const TASK_RESOURCES: readonly TaskResourceDescriptor[] = [
  {
    id: "text-to-3d",
    commandPath: ["text-to-3d"],
    base: "v2",
    relativePath: "/text-to-3d",
    endpoint: "/openapi/v2/text-to-3d",
    supports: ALL_VERBS,
    mediaFields: [image("texture_image_url")],
    taskTypes: ["text-to-3d-preview", "text-to-3d-refine"],
    billing: { create: "may-charge" },
    automaticRetry: false,
    summary: "two-stage 3D generation from text (preview → refine)",
  },
  v1("image-to-3d", "/image-to-3d", { mediaFields: [image("image_url")], taskTypes: ["image-to-3d"], summary: "3D from a single image (standard or smart-topology low-poly)" }),
  v1("multi-image-to-3d", "/multi-image-to-3d", { mediaFields: [image("image_urls", true), image("texture_image_urls", true)], taskTypes: ["multi-image-to-3d"], summary: "3D from 1-4 views of one object (prefer image-to-3d for a single image)" }),
  v1("remesh", "/remesh", { mediaFields: [inlineModel("model_url")], taskTypes: ["remesh"], summary: "retopologize / change polycount" }),
  v1("convert", "/convert", { mediaFields: [inlineModel("model_url")], taskTypes: ["convert"], summary: "change file format only" }),
  v1("resize", "/resize", { mediaFields: [inlineModel("model_url")], taskTypes: ["resize"], summary: "resize to real-world dimensions" }),
  v1("rigging", "/rigging", { mediaFields: [model("model_url", ["glb"]), image("texture_image_url")], taskTypes: ["rig"], summary: "rig a humanoid mesh (+ bundled walk/run animations)" }),
  v1("animate", "/animations", { taskTypes: ["animate"], summary: "apply an animation clip to a rigged mesh" }),
  v1("retexture", "/retexture", { mediaFields: [inlineModel("model_url"), image("image_style_url"), image("multiview_image_urls", true)], taskTypes: ["retexture"], summary: "regenerate textures" }),
  v1("text-to-image", "/text-to-image", { taskTypes: ["text-to-image"], summary: "2D image generation" }),
  v1("text-to-motion", "/text-to-motion", { taskTypes: ["text-to-motion"], summary: "generate a standalone skeletal motion clip from text" }),
  v1("image-to-image", "/image-to-image", { mediaFields: [image("reference_image_urls", true)], taskTypes: ["image-to-image"], summary: "2D image editing" }),
  v1("multi-color-print", "/print/multi-color", { mediaFields: [model("model_url", ["glb"], "the API takes an inline (local) model as GLB only here — for .fbx pass a public http(s) URL, or --input-task-id")], taskTypes: ["print-multi-color"], summary: "color-separated 3D print output" }),
  v1("analyze-printability", "/print/analyze", { mediaFields: [inlineModel("model_url")], taskTypes: ["print-analyze"], billing: "none", summary: "inspect a model for 3D-printing issues (free)" }),
  v1("repair-printability", "/print/repair", { mediaFields: [inlineModel("model_url")], taskTypes: ["print-repair"], summary: "fix non-watertight / non-manifold geometry" }),
  v1("auto-split", "/print/split", { taskTypes: ["print-split"], summary: "split a model into printable parts (auto / by named parts / by colour; optional connectors)" }),
  v1("uv-unwrap", "/uv-unwrap", { mediaFields: [model("model_url", ["glb"])], taskTypes: ["uv-unwrap"], summary: "generate fresh UVs for a GLB (≤40k faces) — a UV white model for external texturing" }),
  creativeLab("figure", "prototype", "Creative Lab figure: photo → styled concept image"),
  creativeLab("figure", "build", "Creative Lab figure: prototype → textured GLB/OBJ/MTL"),
  creativeLab("lamp", "prototype", "Creative Lab lamp: photo → concept image + lampshade GLB"),
  creativeLab("lamp", "build", "Creative Lab lamp: prototype → lamp_stl/base_stl or bundle_zip"),
  creativeLab("keychain", "prototype", "Creative Lab keychain: photo → styled concept image"),
  creativeLab("keychain", "build", "Creative Lab keychain: prototype → relief GLB / OBJ bundle (zip) / zip"),
  creativeLab("fridge-magnet", "prototype", "Creative Lab fridge magnet: photo → styled concept image"),
  creativeLab("fridge-magnet", "build", "Creative Lab fridge magnet: prototype → relief GLB / OBJ bundle (zip) / zip"),
  creativeLab("vinyl-figure", "prototype", "Creative Lab vinyl figure: photo → big-head vinyl concept image"),
  creativeLab("vinyl-figure", "build", "Creative Lab vinyl figure: prototype → textured GLB/OBJ/MTL"),
  creativeLab("brick-figure", "prototype", "Creative Lab brick figure: photo → brick minifigure concept image"),
  creativeLab("brick-figure", "build", "Creative Lab brick figure: prototype → textured GLB/OBJ/MTL"),
  creativeLab("keycap", "prototype", "Creative Lab keycap: photo → keycap design (one candidate)"),
  creativeLab("keycap", "build", "Creative Lab keycap: prototype candidate → GLB + OBJ bundle (zip), real-world mm"),
  creativeLab("fidget-pixel", "prototype", "Creative Lab fidget pixel: photo → pixel-art image (person | other)"),
  creativeLab("fidget-pixel", "build", "Creative Lab fidget pixel: prototype → 3MF board, one object per piece"),
  creativeLabSingle("fidget-collapsible", "Creative Lab collapsible fidget: photo → printable STL (+ preview GLB), one stage"),
];

const BY_ID = new Map(TASK_RESOURCES.map((d) => [d.id, d] as const));

export function findTaskResource(id: string): TaskResourceDescriptor | undefined {
  return BY_ID.get(id);
}

export function requireTaskResource(id: string): TaskResourceDescriptor {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown task resource '${id}'`);
  return d;
}

/** Resolve a Creative Lab descriptor from user-supplied tokens without ever building a path from them. */
export function creativeLabResource(product: string, stage: string): TaskResourceDescriptor | undefined {
  if (!(CREATIVE_LAB_PRODUCTS as readonly string[]).includes(product)) return undefined;
  if (!(CREATIVE_LAB_STAGES as readonly string[]).includes(stage)) return undefined;
  return BY_ID.get(`creative-lab.${product}.${stage}`);
}

export interface QueryResourceDescriptor {
  id: string;
  commandPath: readonly string[];
  base: "v1";
  method: "GET";
  relativePath: string;
  auth: "bearer";
  billing: Billing;
  summary: string;
}

export const QUERY_RESOURCES: readonly QueryResourceDescriptor[] = [
  { id: "balance", commandPath: ["balance"], base: "v1", method: "GET", relativePath: "/balance", auth: "bearer", billing: "none", summary: "remaining credit balance" },
  { id: "animation-catalog", commandPath: ["animation-catalog", "list"], base: "v1", method: "GET", relativePath: "/animations/library", auth: "bearer", billing: "none", summary: "animation library (action ids for animate); free, server-side search" },
  { id: "usage", commandPath: ["usage", "tasks"], base: "v1", method: "GET", relativePath: "/usage/tasks", auth: "bearer", billing: "none", summary: "finished API tasks with the credits each consumed (Studio/Enterprise)" },
  { id: "showcases", commandPath: ["showcases", "list"], base: "v1", method: "GET", relativePath: "/showcases", auth: "bearer", billing: "may-charge", summary: "Enterprise community showcases (every request is billed)" },
];

export interface LocalToolDescriptor {
  id: string;
  commandPath: readonly string[];
  summary: string;
}

export const LOCAL_TOOLS: readonly LocalToolDescriptor[] = [
  { id: "download", commandPath: ["download"], summary: "download selected assets of a task (from a saved task JSON, a URL or the API)" },
  { id: "project", commandPath: ["project"], summary: "meshy_output project folders: init | record | show | list | rebuild-index" },
  { id: "inspect.faces", commandPath: ["inspect", "faces"], summary: "face-count gate: pass | fail | unknown" },
  { id: "mesh.prepare-print", commandPath: ["mesh", "prepare-print"], summary: "OBJ Y-up → Z-up, scale to a target height, centre, bottom at Z=0" },
  { id: "slicer", commandPath: ["slicer"], summary: "detect installed slicers | open a file in one" },
  { id: "doctor", commandPath: ["doctor"], summary: "local environment diagnosis (no network by default)" },
];

export type ResourceIndexKind = "task" | "query" | "action" | "local";

export interface ResourceIndexEntry {
  name: string;
  kind: ResourceIndexKind;
  command: string;
  summary: string;
  endpoint: string | null;
  verbs: Verb[] | null;
}

/** The v1 `resources` index: every task resource, query, action and local tool. */
export function resourceIndex(): ResourceIndexEntry[] {
  const verbsOf = (s: VerbSupport): Verb[] =>
    (["create", "get", "list", "wait", "stream", "delete"] as const)
      .filter((v) => (v === "wait" ? s.get : s[v]))
      .map((v) => v as Verb);
  const tasks: ResourceIndexEntry[] = TASK_RESOURCES.map((d) => ({
    name: d.id,
    kind: "task",
    command: `meshy ${d.commandPath.join(" ")}`,
    summary: d.summary,
    endpoint: d.endpoint,
    verbs: verbsOf(d.supports),
  }));
  const queries: ResourceIndexEntry[] = QUERY_RESOURCES.map((q) => ({
    name: q.id,
    kind: "query",
    command: `meshy ${q.commandPath.join(" ")}`,
    summary: q.summary,
    endpoint: `/openapi/v1${q.relativePath}`,
    verbs: null,
  }));
  const locals: ResourceIndexEntry[] = LOCAL_TOOLS.map((l) => ({
    name: l.id,
    kind: "local",
    command: `meshy ${l.commandPath.join(" ")}`,
    summary: l.summary,
    endpoint: null,
    verbs: null,
  }));
  // A one-off API call that changes state: not a task resource, not a read, not local.
  const actions: ResourceIndexEntry[] = [
    { name: "delete", kind: "action", command: "meshy delete", summary: "permanently delete a task of any resource except Creative Lab (whose own delete verb cancels)", endpoint: "/openapi/v2/text-to-3d", verbs: null },
  ];
  return [...tasks, ...queries, ...locals, ...actions];
}
