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
 * Texture references are matched in this order: the exact saved file name, a
 * channel word in the referenced name (…_normal.png), the MTL key's channel
 * (map_Kd → base color), and finally "the only texture there is" when the MTL
 * has exactly one distinct reference. Anything else stays as written and is
 * reported as `material_reference_unresolved`.
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
}

export interface ReferenceLink {
  /** 1-based line in the file that carried the reference. */
  line: number;
  /** The reference as written before relinking. */
  reference: string;
  /** Saved file name the reference now points at, or null when it could not be resolved. */
  resolved_to: string | null;
  /** How the link was decided. */
  method: "unchanged" | "exact" | "channel_in_name" | "channel_of_key" | "only_texture" | "downloaded_mtl" | "unresolved";
}

export interface MaterialLinkReport {
  obj: string;
  mtl: string | null;
  textures: string[];
  mtllib: ReferenceLink[];
  texture_maps: ReferenceLink[];
  /** Absolute paths whose content was rewritten. */
  rewritten: string[];
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

/** Channel encoded in an asset key: `texture.0.base_color` / `texture_0_base_color`. */
export function channelOfTextureKey(key: string): string | null {
  const m = /^texture[._](\d+)[._](.+)$/.exec(key);
  return m ? canonicalChannel(m[2]!) : null;
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

/**
 * Relink the OBJ/MTL/texture files of one download. Returns null when the set
 * has no text OBJ (nothing to relink). Never throws for unresolved references;
 * those become warnings and `resolved_to: null` entries.
 */
export async function relinkMaterials(files: readonly LinkableFile[]): Promise<MaterialLinkReport | null> {
  const obj = files.find((f) => isObjKey(f.key) && /\.obj$/i.test(f.path));
  if (!obj) return null;
  if (looksBinary(obj.path)) return null;
  const mtl = files.find((f) => isMtlKey(f.key)) ?? null;
  const textures = files.filter((f) => isTextureKey(f.key));
  const report: MaterialLinkReport = {
    obj: obj.path,
    mtl: mtl?.path ?? null,
    textures: textures.map((t) => t.path),
    mtllib: [],
    texture_maps: [],
    rewritten: [],
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
      report.mtllib.push({ line: lineNo, reference: ref, resolved_to: null, method: "unresolved" });
      return null;
    }
    if (ref === mtlName) {
      report.mtllib.push({ line: lineNo, reference: ref, resolved_to: mtlName, method: "unchanged" });
      return null;
    }
    report.mtllib.push({ line: lineNo, reference: ref, resolved_to: mtlName, method: "downloaded_mtl" });
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    return `${indent}mtllib ${mtlName}`;
  });
  if (objChanged) report.rewritten.push(obj.path);
  if (!mtlName && report.mtllib.length > 0) {
    report.warnings.push(
      warning(
        "material_reference_unresolved",
        `${basename(obj.path)} references ${report.mtllib.map((l) => `'${l.reference}'`).join(", ")} but no MTL was downloaded with it; the geometry loads without materials`,
      ),
    );
  }

  // --- MTL: every map_* points at a texture that was actually saved.
  if (mtl) {
    let size = 0;
    try {
      size = statSync(mtl.path).size;
    } catch {
      size = 0;
    }
    if (size > MAX_MTL_BYTES) {
      report.warnings.push(warning("material_reference_unresolved", `${basename(mtl.path)} is ${size} bytes; too large for an MTL, texture references were not checked`));
      return report;
    }
    const textureNames = textures.map((t) => basename(t.path));
    const byChannel = new Map<string, string>();
    for (const t of textures) {
      const ch = channelOfTextureKey(t.key);
      if (ch && !byChannel.has(ch)) byChannel.set(ch, basename(t.path));
    }
    const distinctRefs = new Set<string>();
    for (const raw of readFileSync(mtl.path, "utf8").split(/\r?\n/)) {
      const parsed = parseMapLine(raw);
      if (parsed) distinctRefs.add(parsed.ref);
    }
    const resolve = (key: string, ref: string): { name: string; method: ReferenceLink["method"] } | null => {
      const refBase = basename(ref.replaceAll("\\", "/"));
      const exact = textureNames.find((n) => n === refBase) ?? textureNames.find((n) => n.toLowerCase() === refBase.toLowerCase());
      if (exact) return { name: exact, method: exact === ref ? "unchanged" : "exact" };
      const inName = channelInFileName(refBase);
      if (inName && byChannel.has(inName)) return { name: byChannel.get(inName)!, method: "channel_in_name" };
      const ofKey = MAP_KEY_CHANNEL[key.toLowerCase()];
      if (ofKey && byChannel.has(ofKey)) return { name: byChannel.get(ofKey)!, method: "channel_of_key" };
      if (textureNames.length === 1 && distinctRefs.size === 1) return { name: textureNames[0]!, method: "only_texture" };
      return null;
    };
    const mtlChanged = await rewriteLines(mtl.path, (line, lineNo) => {
      const parsed = parseMapLine(line);
      if (!parsed) return null;
      const hit = resolve(parsed.key, parsed.ref);
      if (!hit) {
        report.texture_maps.push({ line: lineNo, reference: parsed.ref, resolved_to: null, method: "unresolved" });
        return null;
      }
      report.texture_maps.push({ line: lineNo, reference: parsed.ref, resolved_to: hit.name, method: hit.method });
      if (hit.name === parsed.ref) return null;
      return `${parsed.indent}${parsed.key}${parsed.options ? ` ${parsed.options}` : ""} ${hit.name}`;
    });
    if (mtlChanged) report.rewritten.push(mtl.path);
    const unresolved = report.texture_maps.filter((l) => l.resolved_to === null);
    if (unresolved.length > 0) {
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
