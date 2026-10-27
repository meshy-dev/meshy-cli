/**
 * Material references of a downloaded OBJ set.
 *
 * Meshy's MTL names its textures the way the server stored them
 * (`map_Kd texture_0.png`, the last segment of the texture URL), while the CLI
 * saves textures under stable names (`texture_0_base_color.png`). Once the set
 * has landed, every map line whose file is the source name of exactly one
 * saved texture is rewritten to the saved name. Anything else stays as written
 * and is reported: the CLI never guesses which image a reference meant. The
 * OBJ is not rewritten; its `mtllib` must already name the saved MTL (Meshy
 * writes `mtllib model.mtl`), otherwise a warning says so.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { publishTempFile, tempPathFor } from "./atomic-file.js";
import { CliError, type Warning } from "./errors.js";
import { warning } from "./result.js";

export interface LinkableFile {
  /** Stable asset key (`model.obj`, `model.mtl`, `texture.0.base_color` …). */
  key: string;
  /** Absolute path as written. */
  path: string;
  /** The file name the server served the asset under (last URL path segment), when known. */
  sourceName?: string | null;
}

export interface ReferenceLink {
  /** 1-based line that carried the reference. */
  line: number;
  /** The reference as written. */
  reference: string;
  /** Saved file name it points at, or null when it stays as written. */
  resolved_to: string | null;
}

export interface MaterialLinkReport {
  obj: string;
  mtl: string | null;
  mtllib: ReferenceLink[];
  texture_maps: ReferenceLink[];
  /** Absolute paths whose content was rewritten. */
  rewritten: string[];
  /** `complete` when every reference points at a downloaded file; `incomplete` when any stayed as written. */
  status: "complete" | "incomplete";
  warnings: Warning[];
}

/** MTL keywords whose last token is a texture file. */
const TEXTURE_KEY_RE = /^(?:map_[A-Za-z0-9_]+|bump|disp|decal|refl|norm)$/i;
/** MTL files larger than this are not what Meshy produces; leave them alone. */
const MAX_MTL_BYTES = 16 * 1024 * 1024;

/** sha256 + size of a file, for manifests that must describe what is actually on disk. */
export function fileDigest(path: string): { bytes: number; sha256: string } {
  const data = readFileSync(path);
  return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

/** The `mtllib` references of an OBJ: they precede the geometry, so reading stops at the first vertex. */
async function mtllibReferences(objPath: string): Promise<ReferenceLink[]> {
  const refs: ReferenceLink[] = [];
  const lines = createInterface({ input: createReadStream(objPath, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    n++;
    const t = line.trim();
    if (t.startsWith("v ")) break;
    if (t.startsWith("mtllib ")) refs.push({ line: n, reference: t.slice("mtllib".length).trim(), resolved_to: null });
  }
  lines.close();
  return refs;
}

export async function relinkMaterials(files: readonly LinkableFile[], opts: { signal?: AbortSignal } = {}): Promise<MaterialLinkReport | null> {
  const obj = files.find((f) => f.key === "model.obj" && /\.obj$/i.test(f.path));
  if (!obj) return null;
  const interrupted = (before: string): CliError => new CliError({ code: "interrupted", message: `interrupted before ${before}` });
  if (opts.signal?.aborted) throw interrupted("the material references were checked");
  const mtl = files.find((f) => f.key === "model.mtl") ?? null;
  const textures = files.filter((f) => f.key.startsWith("texture."));
  const report: MaterialLinkReport = { obj: obj.path, mtl: mtl?.path ?? null, mtllib: [], texture_maps: [], rewritten: [], status: "complete", warnings: [] };

  // OBJ → MTL: reported, never rewritten.
  const mtlName = mtl ? basename(mtl.path) : null;
  for (const ref of await mtllibReferences(obj.path)) report.mtllib.push({ ...ref, resolved_to: ref.reference === mtlName ? mtlName : null });
  const missingMtl = report.mtllib.filter((l) => l.resolved_to === null);
  if (missingMtl.length > 0) {
    report.status = "incomplete";
    report.warnings.push(
      warning(
        "material_reference_unresolved",
        `${basename(obj.path)} references ${missingMtl.map((l) => `'${l.reference}'`).join(", ")} but ${mtlName ? `the MTL was saved as ${mtlName}` : "no MTL was downloaded with it"}; the geometry loads without those materials`,
      ),
    );
  }
  if (!mtl) return report;
  if (statSync(mtl.path).size > MAX_MTL_BYTES) {
    report.status = "incomplete";
    report.warnings.push(warning("material_reference_unresolved", `${basename(mtl.path)} is too large for an MTL; texture references were not checked`));
    return report;
  }

  // MTL → textures: a reference resolves to the one saved texture served under that name.
  let changed = false;
  const lines = readFileSync(mtl.path, "utf8").split(/(?<=\n)/);
  const out = lines.map((raw, i) => {
    const eol = /\r?\n$/.exec(raw)?.[0] ?? "";
    const line = raw.slice(0, raw.length - eol.length);
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2 || !TEXTURE_KEY_RE.test(tokens[0]!)) return raw;
    const reference = tokens.at(-1)!;
    const sources = textures.filter((t) => t.sourceName === basename(reference));
    const resolved = sources.length === 1 ? basename(sources[0]!.path) : null;
    report.texture_maps.push({ line: i + 1, reference, resolved_to: resolved });
    if (!resolved || resolved === reference) return raw;
    changed = true;
    return `${line.slice(0, line.lastIndexOf(reference))}${resolved}${eol}`;
  });
  const unresolved = report.texture_maps.filter((l) => l.resolved_to === null);
  if (unresolved.length > 0) {
    report.status = "incomplete";
    report.warnings.push(
      warning(
        "material_reference_unresolved",
        `${basename(mtl.path)} references ${[...new Set(unresolved.map((l) => `'${l.reference}'`))].join(", ")}, which no single downloaded texture was served as; those maps stay as written`,
      ),
    );
  }
  if (changed) {
    if (opts.signal?.aborted) throw interrupted(`${basename(mtl.path)} was relinked`);
    const tmp = tempPathFor(mtl.path);
    writeFileSync(tmp, out.join(""), { flag: "wx" });
    publishTempFile(tmp, mtl.path, { overwrite: true });
    report.rewritten.push(mtl.path);
  }
  return report;
}
