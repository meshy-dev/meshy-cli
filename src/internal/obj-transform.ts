/**
 * OBJ print preparation — the legacy `fix_obj.py` transform as a streaming module.
 *
 * Meshy exports Y-up OBJ files in arbitrary units; slicers want Z-up
 * millimetres with the model standing on the build plate. The transform is
 *
 *   R(x, y, z) = (x, -z, y)        Y-up → Z-up; determinant +1, so face winding is kept
 *   v' = s·R(v) + (tx, ty, tz)     s = height_mm / (zmax − zmin) of the rotated box,
 *                                  XY centred on the origin, minZ on the plate (0)
 *   n' = R(n)                      normals only rotate — no scale, no translation
 *
 * Every other line (vt, f, o, g, s, usemtl, mtllib, comments, blanks) is copied
 * verbatim, so topology, UVs and material bindings cannot drift. Extra fields on
 * a `v` line (vertex colours, w) are kept verbatim after the three coordinates.
 *
 * Two streaming passes keep memory constant regardless of file size: pass 1 folds
 * every vertex into a bounding box, pass 2 rewrites lines through a write stream
 * into a temp file in the target directory. The temp file is published only after
 * the whole rewrite succeeded — nothing is written when validation fails, an
 * existing output is never overwritten, and the input is replaced only with
 * `inPlace` (temp file + rename on the same filesystem).
 *
 * Material dependencies (`mtllib`, and `map_*` textures inside those MTLs) are
 * resolved relative to the input and only inside the input's directory tree.
 * When the output lands in another directory they are copied alongside it; a
 * missing or escaping dependency is a validation error there unless the caller
 * asked for `geometryOnly`, because a "success" with a silently broken material
 * is worse than a refusal. No env, no credentials, no network.
 */

import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { once } from "node:events";
import { basename, dirname, extname, join, posix, relative, resolve as resolvePath, win32 } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { copyFilePublished, publishTempFile, tempPathFor } from "./atomic-file.js";
import { CliError, UsageError, type Warning } from "./errors.js";
import { isInside, realpathLenient } from "./paths.js";
import { warning } from "./result.js";

export type Vec3 = [number, number, number];

export interface Bbox {
  min: Vec3;
  max: Vec3;
}

export const OBJ_ROTATION = "(x,y,z)->(x,-z,y)" as const;
export const DEFAULT_HEIGHT_MM = 75;
/** Same engineering ceiling as endpoint-contracts.json `limits.obj_bytes`. */
export const DEFAULT_MAX_OBJ_BYTES = 2 * 1024 * 1024 * 1024;
/** A rotated height at or below this is treated as degenerate (flat model). */
export const MIN_MODEL_HEIGHT = 1e-6;

const READ_CHUNK_BYTES = 256 * 1024;
/** A "line" longer than this is not a text OBJ; refusing keeps the carry buffer bounded. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const WS = /\s+/;
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TEXTURE_KEY_RE = /^(?:map_[A-Za-z0-9_]+|bump|disp|decal|refl|norm)$/i;
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export interface ObjTransformReport {
  /** Absolute input path. */
  input: string;
  /** Absolute path of the written file (equals `input` when in place). */
  output: string;
  height_mm: number;
  scale: number;
  rotation: typeof OBJ_ROTATION;
  translation: Vec3;
  /** Bounding box of the input as written (its own axes and units). */
  before_bbox: Bbox;
  /** Bounding box of the output (Z-up, millimetres). */
  after_bbox: Bbox;
  counts: {
    vertices: number;
    normals: number;
    uvs: number;
    faces: number;
    lines_total: number;
  };
  material: {
    /** `mtllib` references as written, in order, deduplicated. */
    mtllib: string[];
    /** Absolute paths of dependencies copied next to the output by this run. */
    copied: string[];
    /** References (as written) that could not be resolved inside the input's directory. */
    missing: string[];
  };
  in_place: boolean;
  warnings: Warning[];
}

export interface PrepareObjOptions {
  /** Target height in millimetres (default 75). Must be finite and > 0. */
  heightMm?: number;
  /** Explicit output file (or existing directory). Mutually exclusive with `inPlace`. */
  outputPath?: string;
  /** Replace the input itself via temp file + rename. */
  inPlace?: boolean;
  /** Never copy MTL/texture dependencies; missing ones become warnings only. */
  geometryOnly?: boolean;
  /** Refuse inputs larger than this many bytes (default 2 GiB). */
  maxBytes?: number;
}

export function rotateYUpToZUp(v: Vec3): Vec3 {
  return [v[0], -v[2], v[1]];
}

/** Default output beside the input: `<stem>.print.obj`. */
export function defaultOutputPath(input: string): string {
  const ext = extname(input);
  const stem = ext ? basename(input, ext) : basename(input);
  return join(dirname(input), `${stem}.print.obj`);
}

/**
 * Six fixed decimals (error ≤ 5e-7, inside the 1e-5 mm oracle tolerance) with
 * trailing zeros trimmed so a unit box does not become a wall of `.000000`.
 * `-0` never appears: a slicer gains nothing from a signed zero.
 */
export function formatObjNumber(n: number): string {
  if (n === 0) return "0";
  let s = n.toFixed(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function validation(message: string, extra: { hint?: string; details?: unknown } = {}): CliError {
  return new CliError({ code: "validation", message, hint: extra.hint, details: extra.details });
}

function localIo(message: string, cause?: unknown): CliError {
  return new CliError({ code: "local_io", message, cause });
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function noNegZero(n: number): number {
  return n === 0 ? 0 : n;
}

function parseCoord(token: string | undefined): number | null {
  if (token === undefined || !NUMBER_RE.test(token)) return null;
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** First whitespace-delimited token (the OBJ keyword) of an already-trimmed line. */
function keywordOf(t: string): string {
  const m = WS.exec(t);
  return m ? t.slice(0, m.index) : t;
}

function parseVec3(tokens: string[], lineNo: number, kind: string): Vec3 {
  if (tokens.length < 4) {
    throw validation(`${kind} line ${lineNo} has ${tokens.length - 1} coordinate(s); expected 3`);
  }
  const out: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const n = parseCoord(tokens[i]);
    if (n === null) {
      throw validation(`non-finite or unparseable coordinate '${tokens[i] ?? ""}' in ${kind} line ${lineNo}`);
    }
    out.push(n);
  }
  return [out[0]!, out[1]!, out[2]!];
}

/** Negate a numeric token textually so the input's precision survives the rotation. */
function negateToken(token: string): string {
  const n = Number(token);
  if (n === 0) return "0";
  if (token.startsWith("-")) return token.slice(1);
  if (token.startsWith("+")) return `-${token.slice(1)}`;
  return `-${token}`;
}

interface MutableBbox {
  min: Vec3;
  max: Vec3;
  seen: boolean;
}

function emptyBbox(): MutableBbox {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], seen: false };
}

function fold(b: MutableBbox, v: Vec3): void {
  for (let i = 0; i < 3; i++) {
    const c = v[i]!;
    if (c < b.min[i]!) b.min[i] = c;
    if (c > b.max[i]!) b.max[i] = c;
  }
  b.seen = true;
}

type LineSink = (text: string, eol: string, lineNo: number) => void;

/**
 * Stream `path` line by line. Each line's own terminator ("\n", "\r\n", or ""
 * for a final unterminated line) is handed to the sink so pass 2 can preserve
 * the input's style. UTF-8 is decoded across chunk boundaries. `afterChunk`
 * runs after every read chunk so a writer can apply backpressure.
 */
async function forEachLine(path: string, onLine: LineSink, afterChunk: (() => Promise<void>) | null): Promise<number> {
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES });
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let lineNo = 0;
  try {
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
        lineNo += 1;
        onLine(carry.slice(start, end), eol, lineNo);
        start = nl + 1;
      }
      carry = start > 0 ? carry.slice(start) : carry;
      if (carry.length > MAX_LINE_CHARS) {
        throw validation(`line ${lineNo + 1} exceeds ${MAX_LINE_CHARS} characters; not a text OBJ file`);
      }
      if (afterChunk) await afterChunk();
    }
    carry += decoder.end();
    if (carry.length > 0) {
      lineNo += 1;
      onLine(carry, "", lineNo);
      if (afterChunk) await afterChunk();
    }
    return lineNo;
  } catch (err) {
    stream.destroy();
    if (err instanceof CliError || err instanceof UsageError) throw err;
    throw localIo(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

interface Scan {
  raw: MutableBbox;
  rotated: MutableBbox;
  vertices: number;
  normals: number;
  uvs: number;
  faces: number;
  lines: number;
  mtllib: string[];
}

/** Pass 1: bounding boxes, counts and material references. Constant memory. */
async function scanObj(input: string): Promise<Scan> {
  const scan: Scan = { raw: emptyBbox(), rotated: emptyBbox(), vertices: 0, normals: 0, uvs: 0, faces: 0, lines: 0, mtllib: [] };
  const seenMtl = new Set<string>();
  scan.lines = await forEachLine(
    input,
    (text, _eol, lineNo) => {
      const t = text.trim();
      if (t.length === 0) return;
      switch (keywordOf(t)) {
        case "v": {
          const v = parseVec3(t.split(WS), lineNo, "v");
          fold(scan.raw, v);
          fold(scan.rotated, rotateYUpToZUp(v));
          scan.vertices += 1;
          break;
        }
        case "vn":
          parseVec3(t.split(WS), lineNo, "vn");
          scan.normals += 1;
          break;
        case "vt":
          scan.uvs += 1;
          break;
        case "f":
          scan.faces += 1;
          break;
        case "mtllib": {
          const ref = t.slice("mtllib".length).trim();
          if (ref && !seenMtl.has(ref)) {
            seenMtl.add(ref);
            scan.mtllib.push(ref);
          }
          break;
        }
        default:
          break;
      }
    },
    null,
  );
  return scan;
}

interface Transform {
  scale: number;
  translation: Vec3;
}

function rewriteLine(text: string, lineNo: number, tf: Transform): string {
  const t = text.trim();
  if (t.length === 0) return text;
  const key = keywordOf(t);
  if (key === "v") {
    const tokens = t.split(WS);
    const [rx, ry, rz] = rotateYUpToZUp(parseVec3(tokens, lineNo, "v"));
    const parts = [
      "v",
      formatObjNumber(rx * tf.scale + tf.translation[0]),
      formatObjNumber(ry * tf.scale + tf.translation[1]),
      formatObjNumber(rz * tf.scale + tf.translation[2]),
    ];
    for (let i = 4; i < tokens.length; i++) parts.push(tokens[i]!);
    return parts.join(" ");
  }
  if (key === "vn") {
    const tokens = t.split(WS);
    parseVec3(tokens, lineNo, "vn");
    // (nx, ny, nz) → (nx, -nz, ny), reordering the original tokens so no precision is lost.
    const parts = ["vn", tokens[1]!, negateToken(tokens[3]!), tokens[2]!];
    for (let i = 4; i < tokens.length; i++) parts.push(tokens[i]!);
    return parts.join(" ");
  }
  return text;
}

/** Pass 2: rewrite into `tmp`, streaming with backpressure. */
async function rewriteObj(input: string, tmp: string, tf: Transform): Promise<void> {
  const out = createWriteStream(tmp, { flags: "wx" });
  let writeError: Error | null = null;
  out.on("error", (err) => {
    writeError = err;
  });
  let buf = "";
  const flush = async (): Promise<void> => {
    if (writeError) throw writeError;
    if (buf.length === 0) return;
    const chunk = buf;
    buf = "";
    if (!out.write(chunk)) await once(out, "drain");
    if (writeError) throw writeError;
  };
  try {
    await forEachLine(
      input,
      (text, eol, lineNo) => {
        buf += rewriteLine(text, lineNo, tf) + eol;
      },
      flush,
    );
    await flush();
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    if (err instanceof CliError || err instanceof UsageError) throw err;
    throw localIo(`failed to write ${tmp}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

type Located = { kind: "found"; path: string; real: string } | { kind: "outside" } | { kind: "missing" };

/**
 * Resolve a material reference relative to `baseDir`, admitting only regular
 * files whose real path stays inside `rootDir`. URLs, absolute paths (POSIX or
 * Windows) and anything escaping the tree are never read.
 */
function locateDependency(ref: string, baseDir: string, rootReal: string): Located {
  if (!ref || URL_RE.test(ref) || /^data:/i.test(ref)) return { kind: "outside" };
  const candidates = [ref];
  if (ref.includes("\\")) candidates.push(ref.replaceAll("\\", "/"));
  let sawMissing = false;
  for (const candidate of candidates) {
    if (posix.isAbsolute(candidate) || win32.isAbsolute(candidate)) return { kind: "outside" };
    const abs = resolvePath(baseDir, candidate);
    let real: string;
    try {
      real = realpathLenient(abs);
    } catch {
      sawMissing = true;
      continue;
    }
    if (!isInside(rootReal, real)) return { kind: "outside" };
    let st: Stats | null = null;
    try {
      st = statSync(real);
    } catch (err) {
      if (errno(err) !== "ENOENT" && errno(err) !== "ENOTDIR") throw localIo(`cannot access ${abs}: ${(err as Error).message}`, err);
    }
    if (st?.isFile()) return { kind: "found", path: abs, real };
    sawMissing = true;
  }
  return sawMissing ? { kind: "missing" } : { kind: "outside" };
}

/** Texture references (`map_Kd [-options] file`) inside an MTL. */
export function textureReferencesInMtl(text: string): string[] {
  const refs: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const key = keywordOf(line);
    if (!TEXTURE_KEY_RE.test(key)) continue;
    const rest = line.slice(key.length).trim();
    if (!rest) continue;
    // Options (`-s 1 1 1`, `-bm 0.5`) precede the filename; without options the
    // whole remainder is the name so spaces in filenames survive.
    const ref = rest.startsWith("-") ? rest.split(WS).at(-1)! : rest;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

interface MaterialPlan {
  copies: Array<{ ref: string; source: string; target: string }>;
  missing: string[];
  warnings: Warning[];
}

function planMaterials(
  refs: string[],
  inputDir: string,
  outputDir: string,
  wantCopies: boolean,
): MaterialPlan {
  const plan: MaterialPlan = { copies: [], missing: [], warnings: [] };
  const inputReal = realpathLenient(inputDir);
  const targets = new Set<string>();

  const note = (ref: string, located: Located, origin: string): void => {
    plan.missing.push(ref);
    if (located.kind === "outside") {
      plan.warnings.push(
        warning(
          "material_dependency_outside_input_dir",
          `${origin} references '${ref}', which is a URL, an absolute path or escapes the input's directory; it was not read or copied`,
        ),
      );
    } else {
      plan.warnings.push(warning("material_dependency_missing", `${origin} references '${ref}', which does not exist next to the input`));
    }
  };

  const schedule = (ref: string, real: string): void => {
    if (!wantCopies) return;
    const target = join(outputDir, relative(inputReal, real));
    if (targets.has(target)) return;
    targets.add(target);
    plan.copies.push({ ref, source: real, target });
  };

  for (const written of refs) {
    // `mtllib a.mtl b.mtl` lists several files, but names with spaces exist in
    // the wild: try the whole remainder first, split only when it is not a file.
    let names = [written];
    if (WS.test(written) && locateDependency(written, inputDir, inputReal).kind !== "found") {
      names = written.split(WS);
    }
    for (const name of names) {
      const located = locateDependency(name, inputDir, inputReal);
      if (located.kind !== "found") {
        note(name, located, "mtllib");
        continue;
      }
      schedule(name, located.real);
      let mtlText: string;
      try {
        mtlText = readFileSync(located.real, "utf8");
      } catch (err) {
        throw localIo(`failed to read material file ${located.path}: ${(err as Error).message}`, err);
      }
      const mtlDir = dirname(located.real);
      for (const texRef of textureReferencesInMtl(mtlText)) {
        const tex = locateDependency(texRef, mtlDir, inputReal);
        if (tex.kind !== "found") {
          note(texRef, tex, `${name}`);
          continue;
        }
        schedule(texRef, tex.real);
      }
    }
  }
  return plan;
}

function sameContent(a: string, b: string): boolean {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/** Copy a dependency without overwriting; an identical file already there counts as present. */
function copyDependency(source: string, target: string): "copied" | "present" {
  let existing: Stats | null = null;
  try {
    existing = lstatSync(target);
  } catch (err) {
    if (errno(err) !== "ENOENT" && errno(err) !== "ENOTDIR") throw localIo(`cannot access ${target}: ${(err as Error).message}`, err);
  }
  if (existing) {
    if (existing.isFile() && sameContent(source, target)) return "present";
    throw localIo(`refusing to overwrite ${target}: a different file already exists there (needed for material dependency ${basename(source)})`);
  }
  copyFilePublished(source, target);
  return "copied";
}

function statInput(input: string): { stat: Stats; lstat: Stats } {
  let lst: Stats;
  try {
    lst = lstatSync(input);
  } catch (err) {
    if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") {
      throw new CliError({ code: "not_found", message: `input file not found: ${input}` });
    }
    throw localIo(`cannot access ${input}: ${(err as Error).message}`, err);
  }
  let st: Stats;
  try {
    st = statSync(input);
  } catch (err) {
    if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") {
      throw new CliError({ code: "not_found", message: `input file not found: ${input} (dangling symbolic link)` });
    }
    throw localIo(`cannot access ${input}: ${(err as Error).message}`, err);
  }
  if (!st.isFile()) throw validation(`input is not a regular file: ${input}`);
  return { stat: st, lstat: lst };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate, scale and ground an OBJ for printing. See the module comment for the
 * maths and the file contract. Throws CliError (`validation` / `local_io` /
 * `not_found`) or UsageError; on any failure no output file exists.
 */
export async function prepareObjForPrint(inputPath: string, opts: PrepareObjOptions = {}): Promise<ObjTransformReport> {
  const heightMm = opts.heightMm ?? DEFAULT_HEIGHT_MM;
  if (typeof heightMm !== "number" || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw validation(`--height-mm must be a finite number greater than 0 (got ${String(heightMm)})`);
  }
  const inPlace = opts.inPlace === true;
  const geometryOnly = opts.geometryOnly === true;
  if (opts.outputPath !== undefined && inPlace) {
    throw new UsageError("--output/-o and --in-place are mutually exclusive: pick a new file or replace the input, not both");
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_OBJ_BYTES;

  const input = resolvePath(inputPath);
  const { stat, lstat } = statInput(input);
  if (stat.size === 0) throw validation(`input is empty: ${input}`);
  if (stat.size > maxBytes) {
    throw localIo(`input is ${stat.size} bytes, above the ${maxBytes}-byte limit for local OBJ processing: ${input}`);
  }
  if (inPlace && lstat.isSymbolicLink()) {
    throw localIo(`refusing to replace ${input} in place: it is a symbolic link`);
  }
  const inputDir = dirname(input);

  let output: string;
  if (inPlace) {
    output = input;
  } else {
    output = opts.outputPath !== undefined ? resolvePath(opts.outputPath) : defaultOutputPath(input);
    if (isDirectory(output)) output = join(output, basename(defaultOutputPath(input)));
    if (exists(output)) {
      throw new CliError({
        code: "local_io",
        message: `refusing to overwrite existing file: ${output} (choose another --output path, or pass --in-place to replace the input itself)`,
        recovery: { action: "choose_path", automatic: false },
      });
    }
  }
  const outputDir = dirname(output);

  // Pass 1 — validate and measure. Nothing has been written yet.
  const scan = await scanObj(input);
  if (scan.vertices === 0) throw validation(`no vertex (v) lines found in ${input}`);
  const rot = scan.rotated;
  const height = rot.max[2] - rot.min[2];
  if (!(height > MIN_MODEL_HEIGHT)) {
    throw validation(
      `degenerate model: rotated height is ${height} (≤ ${MIN_MODEL_HEIGHT}); every vertex shares the same up-axis value, so no scale can be derived`,
    );
  }
  const scale = heightMm / height;
  const translation: Vec3 = [
    noNegZero((-(rot.min[0] + rot.max[0]) / 2) * scale),
    noNegZero((-(rot.min[1] + rot.max[1]) / 2) * scale),
    noNegZero(-rot.min[2] * scale),
  ];
  const tf: Transform = { scale, translation };

  // Materials — decided before any write so a broken binding is refused up front.
  const crossDir = !inPlace && realpathLenient(outputDir) !== realpathLenient(inputDir);
  const wantCopies = crossDir && !geometryOnly;
  const plan = planMaterials(scan.mtllib, inputDir, outputDir, wantCopies);
  const warnings: Warning[] = [...plan.warnings];
  if (wantCopies && plan.missing.length > 0) {
    throw validation(
      `material dependencies of ${input} cannot be carried to ${outputDir}: ${plan.missing.join(", ")} — the output would reference files that are not there. ` +
        "Pass --geometry-only to write only the geometry, or keep the output in the input's directory",
      { hint: "pass --geometry-only, or write the output next to the input" },
    );
  }
  if (crossDir && geometryOnly && scan.mtllib.length > 0) {
    warnings.push(
      warning(
        "material_dependencies_not_copied",
        `--geometry-only: ${scan.mtllib.join(", ")} referenced by the output were not copied to ${outputDir}`,
      ),
    );
  }

  // Pass 2 — rewrite into a temp file beside the target, then publish.
  if (!inPlace) {
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      throw localIo(`cannot create output directory ${outputDir}: ${(err as Error).message}`, err);
    }
  }
  const tmp = tempPathFor(output);
  const copied: string[] = [];
  try {
    await rewriteObj(input, tmp, tf);
    if (inPlace) {
      const fd = openSync(tmp, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(tmp, stat.mode & 0o777);
      } catch {
        /* keep default mode */
      }
      renameSync(tmp, output);
    } else {
      for (const copy of plan.copies) {
        if (copyDependency(copy.source, copy.target) === "copied") {
          copied.push(copy.target);
        } else {
          warnings.push(
            warning("material_dependency_already_present", `${copy.target} already exists with identical content; not copied again`),
          );
        }
      }
      publishTempFile(tmp, output);
    }
  } catch (err) {
    removeQuietly(tmp);
    if (err instanceof CliError || err instanceof UsageError) throw err;
    throw localIo(`failed to write ${output}: ${err instanceof Error ? err.message : String(err)}`, err);
  }

  const afterBbox: Bbox = {
    min: [
      noNegZero(rot.min[0] * scale + translation[0]),
      noNegZero(rot.min[1] * scale + translation[1]),
      noNegZero(rot.min[2] * scale + translation[2]),
    ],
    max: [
      noNegZero(rot.max[0] * scale + translation[0]),
      noNegZero(rot.max[1] * scale + translation[1]),
      noNegZero(rot.max[2] * scale + translation[2]),
    ],
  };

  return {
    input,
    output,
    height_mm: heightMm,
    scale,
    rotation: OBJ_ROTATION,
    translation,
    before_bbox: { min: [...scan.raw.min], max: [...scan.raw.max] },
    after_bbox: afterBbox,
    counts: {
      vertices: scan.vertices,
      normals: scan.normals,
      uvs: scan.uvs,
      faces: scan.faces,
      lines_total: scan.lines,
    },
    material: { mtllib: scan.mtllib, copied, missing: plan.missing },
    in_place: inPlace,
    warnings,
  };
}
