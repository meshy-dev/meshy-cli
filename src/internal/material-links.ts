/**
 * Material relinking for downloaded OBJ sets.
 *
 * Meshy serves an OBJ, its MTL and the textures as separate URLs and the CLI
 * saves them under stable names (model.obj, model.mtl, texture_0_base_color.png
 * …). The OBJ, however, names its MTL the way the server knew it (`mtllib
 * box.mtl`) and the MTL names its textures the same way, so a faithfully
 * downloaded set can still be unloadable. Once every file of a set has landed,
 * this module rewrites those references to the names actually on disk and
 * reports every link it resolved — and every one it could not. Only the two
 * text files the CLI itself just wrote are touched; nothing is renamed, the
 * rewritten paths are listed, and their digests are re-taken by the caller.
 *
 * A texture reference is resolved only when exactly one downloaded texture
 * matches, in this order: the saved file name itself; the name the server
 * served the texture under (the URL's last segment — `body.png` for
 * `…/body.png`); the same name ignoring extension and directories; a channel
 * word inside the referenced name (…_normal.png); the channel implied by the
 * MTL key (map_Kd → base color); finally "the only texture there is" when the
 * MTL has exactly one distinct reference. Several candidates for the same rule
 * is an *ambiguity*: the reference stays as written, the candidates are listed
 * and the report is `incomplete` — the CLI never picks the first of several
 * material groups' textures. Unresolved references are reported the same way.
 */

import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { basename } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { publishTempFile, tempPathFor } from "./atomic-file.js";
import { CliError, type Warning } from "./errors.js";
import { warning } from "./result.js";

export interface LinkableFile {
  /** Stable asset key (`model.obj`, `model_mtl`, `texture.0.base_color`, `texture_0_normal` …). */
  key: string;
  /** Absolute path as written. */
  path: string;
  /** The file name the server served the asset under (last URL path segment), when known. */
  sourceName?: string | null;
}

export type LinkMethod =
  | "unchanged"
  | "exact"
  | "source_name"
  | "source_stem"
  | "channel_in_name"
  | "channel_of_key"
  | "only_texture"
  | "downloaded_mtl"
  | "ambiguous"
  | "unresolved";

export interface ReferenceLink {
  /** 1-based line in the file that carried the reference. */
  line: number;
  /** `newmtl` group the map belongs to (MTL only). */
  material: string | null;
  /** The reference as written before relinking. */
  reference: string;
  /** Saved file name the reference now points at, or null when it stays as written. */
  resolved_to: string | null;
  /** How the link was decided. */
  method: LinkMethod;
  /** Saved names that matched when the reference was ambiguous. */
  candidates?: string[];
}

export interface TextureDescriptor {
  key: string;
  /** Saved file name. */
  name: string;
  /** Name the server served it under, when known. */
  source_name: string | null;
  /** `texture_urls` set index (material group) the texture came from. */
  set: number | null;
  /** Canonical channel (basecolor, normal, …) from the asset key. */
  channel: string | null;
}

export interface MaterialLinkReport {
  obj: string;
  mtl: string | null;
  textures: TextureDescriptor[];
  mtllib: ReferenceLink[];
  texture_maps: ReferenceLink[];
  /** Absolute paths whose content was rewritten. */
  rewritten: string[];
  /** `complete` when every reference points at a downloaded file; `incomplete` when any stayed as written. */
  status: "complete" | "incomplete";
  warnings: Warning[];
}

const WS = /\s+/;
const TEXTURE_KEY_RE = /^(?:map_[A-Za-z0-9_]+|bump|disp|decal|refl|norm)$/i;
/** MTL files larger than this are not what Meshy produces; leave them alone. */
const MAX_MTL_BYTES = 16 * 1024 * 1024;

const CHANNEL_SYNONYMS: Record<string, string> = {
  basecolor: "basecolor",
  albedo: "basecolor",
  diffuse: "basecolor",
  color: "basecolor",
  colour: "basecolor",
  metallic: "metallic",
  metalness: "metallic",
  metal: "metallic",
  roughness: "roughness",
  rough: "roughness",
  normal: "normal",
  normals: "normal",
  nrm: "normal",
  bump: "normal",
  emissive: "emissive",
  emission: "emissive",
  emit: "emissive",
  occlusion: "occlusion",
  ao: "occlusion",
  ambientocclusion: "occlusion",
  opacity: "opacity",
  alpha: "opacity",
  transparency: "opacity",
  displacement: "displacement",
  height: "displacement",
  disp: "displacement",
  specular: "specular",
  spec: "specular",
};

const MAP_KEY_CHANNEL: Record<string, string> = {
  map_kd: "basecolor",
  map_ka: "basecolor",
  map_pm: "metallic",
  map_pr: "roughness",
  norm: "normal",
  map_bump: "normal",
  bump: "normal",
  map_kn: "normal",
  map_ke: "emissive",
  map_d: "opacity",
  disp: "displacement",
  map_ks: "specular",
  map_ao: "occlusion",
};

function canonicalChannel(raw: string): string | null {
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CHANNEL_SYNONYMS[compact] ?? null;
}

/** Set index and channel encoded in an asset key: `texture.0.base_color` / `texture_0_base_color`. */
export function describeTextureKey(key: string): { set: number | null; channel: string | null } {
  const m = /^texture[._](\d+)[._](.+)$/.exec(key);
  if (!m) return { set: null, channel: null };
  return { set: Number(m[1]), channel: canonicalChannel(m[2]!) };
}

/** @deprecated kept for callers of the round-1 API. */
export function channelOfTextureKey(key: string): string | null {
  return describeTextureKey(key).channel;
}

/** Channel word inside a referenced file name (`texture_normal.png`, `Body_BaseColor.jpg`). */
export function channelInFileName(name: string): string | null {
  const stem = basename(name).replace(/\.[A-Za-z0-9]+$/, "");
  const tokens = stem.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const pair = i + 1 < tokens.length ? canonicalChannel(`${tokens[i]}${tokens[i + 1]}`) : null;
    if (pair) return pair;
    const single = canonicalChannel(tokens[i]!);
    if (single) return single;
  }
  const compact = stem.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const word of Object.keys(CHANNEL_SYNONYMS).sort((a, b) => b.length - a.length)) {
    if (word.length >= 5 && compact.includes(word)) return CHANNEL_SYNONYMS[word]!;
  }
  return null;
}

function keywordOf(t: string): string {
  const m = WS.exec(t);
  return m ? t.slice(0, m.index) : t;
}

function stemOf(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, "").toLowerCase();
}

function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, n);
    if (n >= 2 && head[0] === 0x50 && head[1] === 0x4b) return true; // PK: a ZIP bundle, not a text OBJ
    return head.includes(0);
  } finally {
    closeSync(fd);
  }
}

/** sha256 + size of a file, for manifests that must describe what is actually on disk. */
export function fileDigest(path: string): { bytes: number; sha256: string } {
  const data = readFileSync(path);
  return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

/**
 * Rewrite `path` line by line through a temp file in the same directory. The
 * callback returns the replacement line (without its terminator) or null to
 * keep the line. Returns true when the file was actually replaced.
 */
async function rewriteLines(path: string, transform: (line: string, lineNo: number) => string | null): Promise<boolean> {
  const tmp = tempPathFor(path);
  const out = createWriteStream(tmp, { flags: "wx" });
  let writeError: Error | null = null;
  out.on("error", (err) => {
    writeError = err;
  });
  let changed = false;
  let buf = "";
  const flush = async (): Promise<void> => {
    if (writeError) throw writeError;
    if (buf.length === 0) return;
    const chunk = buf;
    buf = "";
    if (!out.write(chunk)) await once(out, "drain");
    if (writeError) throw writeError;
  };
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let lineNo = 0;
  const emitLine = (text: string, eol: string): void => {
    lineNo += 1;
    const next = transform(text, lineNo);
    if (next !== null && next !== text) {
      changed = true;
      buf += next + eol;
    } else {
      buf += text + eol;
    }
  };
  try {
    const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
    for await (const chunk of stream) {
      carry += decoder.write(chunk as Buffer);
      let start = 0;
      let nl: number;
      while ((nl = carry.indexOf("\n", start)) !== -1) {
        let end = nl;
        let eol = "\n";
        if (end > start && carry.charCodeAt(end - 1) === 13) {
          end -= 1;
          eol = "\r\n";
        }
        emitLine(carry.slice(start, end), eol);
        start = nl + 1;
      }
      carry = start > 0 ? carry.slice(start) : carry;
      await flush();
    }
    carry += decoder.end();
    if (carry.length > 0) emitLine(carry, "");
    await flush();
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    if (err instanceof CliError) throw err;
    throw new CliError({ code: "local_io", message: `failed to rewrite ${path}: ${err instanceof Error ? err.message : String(err)}`, cause: err });
  }
  if (!changed) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    return false;
  }
  publishTempFile(tmp, path, { overwrite: true });
  return true;
}

function isObjKey(key: string): boolean {
  return key === "model.obj" || key === "model_obj";
}

function isMtlKey(key: string): boolean {
  return key === "model.mtl" || key === "model_mtl";
}

function isTextureKey(key: string): boolean {
  return /^texture[._]\d+[._]/.test(key);
}

/** Split an MTL map line into indentation, key, options and the referenced file. */
function parseMapLine(line: string): { indent: string; key: string; options: string; ref: string } | null {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const key = keywordOf(t);
  if (!TEXTURE_KEY_RE.test(key)) return null;
  const rest = t.slice(key.length).trim();
  if (!rest) return null;
  if (rest.startsWith("-")) {
    const tokens = rest.split(WS);
    return { indent, key, options: tokens.slice(0, -1).join(" "), ref: tokens.at(-1)! };
  }
  return { indent, key, options: "", ref: rest };
}

type Resolution = { kind: "hit"; name: string; method: LinkMethod } | { kind: "ambiguous"; method: LinkMethod; candidates: string[] } | { kind: "none" };

/** Apply one rule: exactly one candidate resolves, several are an ambiguity, none falls through. */
function pick(candidates: TextureDescriptor[], method: LinkMethod): Resolution | null {
  if (candidates.length === 1) return { kind: "hit", name: candidates[0]!.name, method };
  if (candidates.length > 1) return { kind: "ambiguous", method, candidates: candidates.map((c) => c.name) };
  return null;
}

function resolveTextureReference(key: string, ref: string, textures: TextureDescriptor[], distinctRefs: number): Resolution {
  const refBase = basename(ref.replaceAll("\\", "/"));
  const lower = refBase.toLowerCase();
  const exact = textures.filter((t) => t.name === refBase) ;
  if (exact.length === 1) return { kind: "hit", name: exact[0]!.name, method: ref === refBase ? "unchanged" : "exact" };
  const exactCi = pick(textures.filter((t) => t.name.toLowerCase() === lower), "exact");
  if (exactCi) return exactCi;
  const bySource = pick(textures.filter((t) => t.source_name !== null && t.source_name.toLowerCase() === lower), "source_name");
  if (bySource) return bySource;
  const stem = stemOf(refBase);
  const byStem = pick(textures.filter((t) => t.source_name !== null && stemOf(t.source_name) === stem), "source_stem");
  if (byStem) return byStem;
  const inName = channelInFileName(refBase);
  if (inName) {
    const r = pick(textures.filter((t) => t.channel === inName), "channel_in_name");
    if (r) return r;
  }
  const ofKey = MAP_KEY_CHANNEL[key.toLowerCase()];
  if (ofKey) {
    const r = pick(textures.filter((t) => t.channel === ofKey), "channel_of_key");
    if (r) return r;
  }
  if (textures.length === 1 && distinctRefs === 1) return { kind: "hit", name: textures[0]!.name, method: "only_texture" };
  return { kind: "none" };
}

/**
 * Relink the OBJ/MTL/texture files of one download. Returns null when the set
 * has no text OBJ (nothing to relink). Never throws for unresolved or
 * ambiguous references; those become warnings, `resolved_to: null` entries
 * and `status: "incomplete"`.
 */
export async function relinkMaterials(files: readonly LinkableFile[]): Promise<MaterialLinkReport | null> {
  const obj = files.find((f) => isObjKey(f.key) && /\.obj$/i.test(f.path));
  if (!obj) return null;
  if (looksBinary(obj.path)) return null;
  const mtl = files.find((f) => isMtlKey(f.key)) ?? null;
  const textures: TextureDescriptor[] = files
    .filter((f) => isTextureKey(f.key))
    .map((f) => {
      const d = describeTextureKey(f.key);
      return { key: f.key, name: basename(f.path), source_name: f.sourceName ?? null, set: d.set, channel: d.channel };
    });
  const report: MaterialLinkReport = {
    obj: obj.path,
    mtl: mtl?.path ?? null,
    textures,
    mtllib: [],
    texture_maps: [],
    rewritten: [],
    status: "complete",
    warnings: [],
  };

  // --- OBJ: every mtllib points at the MTL that was actually saved.
  const mtlName = mtl ? basename(mtl.path) : null;
  const objChanged = await rewriteLines(obj.path, (line, lineNo) => {
    const t = line.trim();
    if (!t || keywordOf(t) !== "mtllib") return null;
    const ref = t.slice("mtllib".length).trim();
    if (!ref) return null;
    if (!mtlName) {
      report.mtllib.push({ line: lineNo, material: null, reference: ref, resolved_to: null, method: "unresolved" });
      return null;
    }
    if (ref === mtlName) {
      report.mtllib.push({ line: lineNo, material: null, reference: ref, resolved_to: mtlName, method: "unchanged" });
      return null;
    }
    report.mtllib.push({ line: lineNo, material: null, reference: ref, resolved_to: mtlName, method: "downloaded_mtl" });
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    return `${indent}mtllib ${mtlName}`;
  });
  if (objChanged) report.rewritten.push(obj.path);
  if (!mtlName && report.mtllib.length > 0) {
    report.status = "incomplete";
    report.warnings.push(
      warning(
        "material_reference_unresolved",
        `${basename(obj.path)} references ${report.mtllib.map((l) => `'${l.reference}'`).join(", ")} but no MTL was downloaded with it; the geometry loads without materials`,
      ),
    );
  }

  // --- MTL: every map_* points at a texture that was actually saved, and only when the match is unambiguous.
  if (mtl) {
    let size = 0;
    try {
      size = statSync(mtl.path).size;
    } catch {
      size = 0;
    }
    if (size > MAX_MTL_BYTES) {
      report.status = "incomplete";
      report.warnings.push(warning("material_reference_unresolved", `${basename(mtl.path)} is ${size} bytes; too large for an MTL, texture references were not checked`));
      return report;
    }
    const distinctRefs = new Set<string>();
    for (const raw of readFileSync(mtl.path, "utf8").split(/\r?\n/)) {
      const parsed = parseMapLine(raw);
      if (parsed) distinctRefs.add(parsed.ref);
    }
    let material: string | null = null;
    const mtlChanged = await rewriteLines(mtl.path, (line, lineNo) => {
      const t = line.trim();
      if (keywordOf(t) === "newmtl") {
        material = t.slice("newmtl".length).trim() || null;
        return null;
      }
      const parsed = parseMapLine(line);
      if (!parsed) return null;
      const res = resolveTextureReference(parsed.key, parsed.ref, textures, distinctRefs.size);
      if (res.kind === "none") {
        report.texture_maps.push({ line: lineNo, material, reference: parsed.ref, resolved_to: null, method: "unresolved" });
        return null;
      }
      if (res.kind === "ambiguous") {
        report.texture_maps.push({ line: lineNo, material, reference: parsed.ref, resolved_to: null, method: "ambiguous", candidates: res.candidates });
        return null;
      }
      report.texture_maps.push({ line: lineNo, material, reference: parsed.ref, resolved_to: res.name, method: res.method });
      if (res.name === parsed.ref) return null;
      return `${parsed.indent}${parsed.key}${parsed.options ? ` ${parsed.options}` : ""} ${res.name}`;
    });
    if (mtlChanged) report.rewritten.push(mtl.path);
    const ambiguous = report.texture_maps.filter((l) => l.method === "ambiguous");
    const unresolved = report.texture_maps.filter((l) => l.method === "unresolved");
    if (ambiguous.length > 0) {
      report.status = "incomplete";
      report.warnings.push(
        warning(
          "material_reference_ambiguous",
          `${basename(mtl.path)}: ${ambiguous.map((l) => `'${l.reference}'${l.material ? ` (${l.material})` : ""} could be ${l.candidates!.join(" or ")}`).join("; ")}; the references stay as written — the CLI does not guess between material groups`,
        ),
      );
    }
    if (unresolved.length > 0) {
      report.status = "incomplete";
      report.warnings.push(
        warning(
          "material_reference_unresolved",
          `${basename(mtl.path)} references ${[...new Set(unresolved.map((l) => `'${l.reference}'`))].join(", ")} which ${textures.length === 0 ? "were not downloaded" : "match none of the downloaded textures"}; those maps stay as written`,
        ),
      );
    }
  }
  return report;
}
