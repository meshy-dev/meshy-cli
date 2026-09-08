/**
 * OBJ print preparation (T-083..T-087) against the independent fixture oracle
 * tests/fixtures/skill-parity/box-height-80.expected.json. Nothing here derives
 * an expected value from the implementation under test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareObjForPrint, defaultOutputPath, formatObjNumber, textureReferencesInMtl } from "../src/internal/obj-transform.js";
import { CliError, UsageError } from "../src/internal/errors.js";
import { tmpDir } from "./helpers/cli.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/skill-parity/", import.meta.url));
const ORACLE = JSON.parse(readFileSync(join(FIXTURES, "box-height-80.expected.json"), "utf8")) as {
  height_mm: number;
  scale: number;
  translation: [number, number, number];
  vertices: number[][];
  normals: number[][];
  bbox_min: number[];
  bbox_max: number[];
  face_count: number;
  vertex_count: number;
  uv_count: number;
  material_dependency: string;
  tolerance: { absolute_mm: number; relative_to_height: number };
};

function tol(height: number): number {
  return ORACLE.tolerance.absolute_mm + ORACLE.tolerance.relative_to_height * height;
}

function near(actual: number, expected: number, eps: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${label}: ${actual} vs ${expected} (eps ${eps})`);
}

interface ParsedObj {
  v: number[][];
  vExtra: string[][];
  vn: number[][];
  vt: string[];
  f: string[];
  other: string[];
  eol: "\n" | "\r\n";
}

function parseObj(text: string): ParsedObj {
  const out: ParsedObj = { v: [], vExtra: [], vn: [], vt: [], f: [], other: [], eol: text.includes("\r\n") ? "\r\n" : "\n" };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    if (t[0] === "v") {
      out.v.push([Number(t[1]), Number(t[2]), Number(t[3])]);
      out.vExtra.push(t.slice(4));
    } else if (t[0] === "vn") out.vn.push([Number(t[1]), Number(t[2]), Number(t[3])]);
    else if (t[0] === "vt") out.vt.push(line);
    else if (t[0] === "f") out.f.push(line);
    else out.other.push(line);
  }
  return out;
}

/** Copy the fixture box (OBJ + MTL) into a fresh temp dir; returns the OBJ path. */
function fixtureCopy(dir = tmpDir("obj-")): { dir: string; obj: string; mtl: string } {
  const obj = join(dir, "box-y-up.obj");
  const mtl = join(dir, "box.mtl");
  copyFileSync(join(FIXTURES, "box-y-up.obj"), obj);
  copyFileSync(join(FIXTURES, "box.mtl"), mtl);
  return { dir, obj, mtl };
}

const ORIGINAL = readFileSync(join(FIXTURES, "box-y-up.obj"), "utf8");
const ORIGINAL_PARSED = parseObj(ORIGINAL);

test("T-083 oracle: every vertex, normal, bbox, scale, translation and count match box-height-80.expected.json", async () => {
  const { dir, obj } = fixtureCopy();
  const report = await prepareObjForPrint(obj, { heightMm: ORACLE.height_mm });
  const eps = tol(ORACLE.height_mm);
  assert.equal(report.output, join(dir, "box-y-up.print.obj"));
  near(report.scale, ORACLE.scale, 1e-9, "scale");
  ORACLE.translation.forEach((t, i) => near(report.translation[i]!, t, eps, `translation[${i}]`));
  ORACLE.bbox_min.forEach((b, i) => near(report.after_bbox.min[i]!, b, eps, `bbox_min[${i}]`));
  ORACLE.bbox_max.forEach((b, i) => near(report.after_bbox.max[i]!, b, eps, `bbox_max[${i}]`));
  assert.equal(report.counts.vertices, ORACLE.vertex_count);
  assert.equal(report.counts.normals, ORACLE.normals.length);
  assert.equal(report.counts.uvs, ORACLE.uv_count);
  assert.equal(report.counts.faces, ORACLE.face_count);
  assert.deepEqual(report.material.mtllib, [ORACLE.material_dependency]);
  assert.deepEqual(report.material.missing, []);

  const written = parseObj(readFileSync(report.output, "utf8"));
  assert.equal(written.v.length, ORACLE.vertices.length);
  ORACLE.vertices.forEach((exp, i) => exp.forEach((c, j) => near(written.v[i]![j]!, c, eps, `v[${i}][${j}]`)));
  ORACLE.normals.forEach((exp, i) => exp.forEach((c, j) => near(written.vn[i]![j]!, c, 1e-9, `vn[${i}][${j}]`)));
  // Extra vertex fields (the fixture carries rgb after xyz) and face/UV/normal index triplets are untouched.
  written.vExtra.forEach((extra, i) => assert.deepEqual(extra, ORIGINAL_PARSED.vExtra[i], `v[${i}] extra fields`));
  assert.deepEqual(written.f, ORIGINAL_PARSED.f);
  assert.deepEqual(written.vt, ORIGINAL_PARSED.vt);
  assert.deepEqual(written.other, ORIGINAL_PARSED.other, "mtllib/o/usemtl/comments preserved verbatim");
  // Input untouched.
  assert.equal(readFileSync(obj, "utf8"), ORIGINAL);
});

test("T-084 default height is 75 mm; CRLF, scientific notation and stray whitespace yield the same geometry", async () => {
  const base = fixtureCopy();
  const def = await prepareObjForPrint(base.obj);
  assert.equal(def.height_mm, 75);
  near(def.after_bbox.max[2]! - def.after_bbox.min[2]!, 75, tol(75), "height");
  near(def.after_bbox.min[2]!, 0, tol(75), "minZ");
  near((def.after_bbox.min[0]! + def.after_bbox.max[0]!) / 2, 0, tol(75), "x centre");
  near((def.after_bbox.min[1]! + def.after_bbox.max[1]!) / 2, 0, tol(75), "y centre");
  const reference = parseObj(readFileSync(def.output, "utf8"));

  const variants: Array<[string, string]> = [
    ["crlf", ORIGINAL.replace(/\n/g, "\r\n")],
    ["scientific", ORIGINAL.replace(/^v (\S+) (\S+) (\S+)/gm, (_m, x, y, z) => `v ${Number(x).toExponential(3)} ${Number(y).toExponential(3)} ${Number(z).toExponential(3)}`)],
    ["whitespace", ORIGINAL.replace(/^v /gm, "   v   ").replace(/\n/g, "  \n")],
  ];
  for (const [name, text] of variants) {
    const dir = tmpDir("obj-var-");
    const path = join(dir, `${name}.obj`);
    writeFileSync(path, text);
    copyFileSync(join(FIXTURES, "box.mtl"), join(dir, "box.mtl"));
    const rep = await prepareObjForPrint(path);
    const parsed = parseObj(readFileSync(rep.output, "utf8"));
    assert.equal(parsed.v.length, reference.v.length, name);
    reference.v.forEach((v, i) => v.forEach((c, j) => near(parsed.v[i]![j]!, c, 2e-3, `${name} v[${i}][${j}]`)));
    assert.deepEqual(parsed.f, reference.f, `${name} faces`);
    if (name === "crlf") assert.equal(parsed.eol, "\r\n", "line-ending style preserved");
  }
});

test("T-085 invalid inputs fail with validation and write nothing", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["empty", "", /empty/],
    ["no-vertices", "# comment\nvt 0 0\nf 1 2 3\n", /no vertex/],
    ["nan", "v 0 NaN 0\nv 1 1 1\n", /unparseable|non-finite/],
    ["infinity", "v 0 0 0\nv 1 Infinity 1\n", /unparseable|non-finite/],
    ["bad-token", "v 0 0 abc\nv 1 1 1\n", /unparseable|non-finite/],
    ["degenerate", "v 0 1 0\nv 1 1 0\nv 0 1 1\n", /degenerate/],
    ["short", "v 0 1\nv 1 1 1\n", /expected 3/],
  ];
  for (const [name, text, re] of cases) {
    const dir = tmpDir("obj-bad-");
    const path = join(dir, `${name}.obj`);
    writeFileSync(path, text);
    await assert.rejects(prepareObjForPrint(path), (e: unknown) => e instanceof CliError && e.code === "validation" && re.test(e.message), name);
    assert.ok(!existsSync(defaultOutputPath(path)), `${name}: no output written`);
    assert.equal(readFileSync(path, "utf8"), text, `${name}: input untouched`);
  }
  const { obj } = fixtureCopy();
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(prepareObjForPrint(obj, { heightMm: bad }), (e: unknown) => e instanceof CliError && e.code === "validation", String(bad));
  }
  await assert.rejects(prepareObjForPrint(obj, { outputPath: join(tmpDir(), "x.obj"), inPlace: true }), UsageError);
  await assert.rejects(prepareObjForPrint(join(tmpDir(), "missing.obj")), (e: unknown) => e instanceof CliError && e.code === "not_found");
});

test("T-086 in-place replaces the input only on success; existing outputs are refused; cross-directory copies materials", async () => {
  // In place.
  const a = fixtureCopy();
  const before = statSync(a.obj).mode & 0o777;
  const rep = await prepareObjForPrint(a.obj, { heightMm: 80, inPlace: true });
  assert.equal(rep.output, a.obj);
  assert.equal(rep.in_place, true);
  const parsed = parseObj(readFileSync(a.obj, "utf8"));
  ORACLE.vertices.forEach((exp, i) => exp.forEach((c, j) => near(parsed.v[i]![j]!, c, tol(80), `in-place v[${i}][${j}]`)));
  assert.equal(statSync(a.obj).mode & 0o777, before, "mode preserved");
  assert.ok(!existsSync(join(a.dir, "box-y-up.print.obj")));
  // Failed transform in place leaves the original intact.
  const b = tmpDir("obj-");
  const badPath = join(b, "bad.obj");
  writeFileSync(badPath, "v 0 0 0\nv 1 1 NaN\n");
  await assert.rejects(prepareObjForPrint(badPath, { inPlace: true }), CliError);
  assert.equal(readFileSync(badPath, "utf8"), "v 0 0 0\nv 1 1 NaN\n");

  // Existing output refused, untouched.
  const c = fixtureCopy();
  const target = join(c.dir, "box-y-up.print.obj");
  writeFileSync(target, "keep");
  await assert.rejects(prepareObjForPrint(c.obj), (e: unknown) => e instanceof CliError && e.code === "local_io" && /refusing to overwrite/.test(e.message));
  assert.equal(readFileSync(target, "utf8"), "keep");

  // Cross-directory: MTL copied next to the output and recorded.
  const d = fixtureCopy();
  const outDir = join(tmpDir("obj-out-"), "nested");
  const rep2 = await prepareObjForPrint(d.obj, { outputPath: join(outDir, "printable.obj") });
  assert.equal(rep2.output, join(outDir, "printable.obj"));
  assert.ok(existsSync(join(outDir, "box.mtl")));
  assert.deepEqual(rep2.material.copied, [join(outDir, "box.mtl")]);
  assert.equal(readFileSync(join(outDir, "box.mtl"), "utf8"), readFileSync(d.mtl, "utf8"));
  // Output directory as target: default name inside it.
  const e = fixtureCopy();
  const dirTarget = tmpDir("obj-dirtarget-");
  const rep3 = await prepareObjForPrint(e.obj, { outputPath: dirTarget });
  assert.equal(rep3.output, join(dirTarget, "box-y-up.print.obj"));

  // Missing mtllib + different directory → validation unless geometryOnly.
  const f = tmpDir("obj-");
  const missingMtl = join(f, "m.obj");
  writeFileSync(missingMtl, "mtllib nowhere.mtl\nv 0 0 0\nv 1 2 3\nf 1 2\n");
  await assert.rejects(prepareObjForPrint(missingMtl, { outputPath: join(tmpDir("obj-out-"), "m.obj") }), (e: unknown) => e instanceof CliError && e.code === "validation" && /geometry-only/.test(e.message));
  const geo = await prepareObjForPrint(missingMtl, { outputPath: join(tmpDir("obj-out-"), "m.obj"), geometryOnly: true });
  assert.deepEqual(geo.material.missing, ["nowhere.mtl"]);
  assert.ok(geo.warnings.some((w) => w.code === "material_dependency_missing"));
  // Same directory with a missing mtllib is only a warning (nothing to carry).
  const same = await prepareObjForPrint(missingMtl);
  assert.ok(same.warnings.some((w) => w.code === "material_dependency_missing"));

  // A mtllib escaping the input directory is never read or copied.
  const g = tmpDir("obj-");
  const outside = tmpDir("obj-outside-");
  writeFileSync(join(outside, "secret.mtl"), "newmtl s\nmap_Kd ../../etc/passwd\n");
  const escaping = join(g, "e.obj");
  writeFileSync(escaping, `mtllib ${join(outside, "secret.mtl")}\nmtllib ../${outside.split("/").pop()}/secret.mtl\nv 0 0 0\nv 1 2 3\n`);
  const rep4 = await prepareObjForPrint(escaping, { outputPath: join(tmpDir("obj-out-"), "e.obj"), geometryOnly: true });
  assert.equal(rep4.material.copied.length, 0);
  assert.ok(rep4.warnings.every((w) => w.code === "material_dependency_outside_input_dir" || w.code === "material_dependencies_not_copied"));
});

test("T-087 a large OBJ streams with bounded memory", async () => {
  const dir = tmpDir("obj-big-");
  const path = join(dir, "big.obj");
  const n = 200_000;
  const chunks: string[] = ["# big\n"];
  for (let i = 0; i < n; i++) chunks.push(`v ${(i % 100) / 10} ${((i * 7) % 1000) / 10} ${(i % 37) / 3}\n`);
  for (let i = 1; i + 2 <= n; i += 3) chunks.push(`f ${i} ${i + 1} ${i + 2}\n`);
  writeFileSync(path, chunks.join(""));
  const size = statSync(path).size;
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const rep = await prepareObjForPrint(path, { heightMm: 100 });
  const after = process.memoryUsage().heapUsed;
  assert.equal(rep.counts.vertices, n);
  assert.ok(existsSync(rep.output));
  assert.ok(statSync(rep.output).size > size * 0.5);
  assert.ok(after - before < 200 * 1024 * 1024, `heap grew by ${((after - before) / 1048576).toFixed(1)} MB`);
});

test("helpers: number formatting stays inside the oracle tolerance; MTL texture references are parsed", () => {
  assert.equal(formatObjNumber(0), "0");
  assert.equal(formatObjNumber(-0), "0");
  assert.equal(formatObjNumber(20), "20");
  assert.equal(formatObjNumber(-60.0000004), "-60");
  assert.equal(formatObjNumber(1.23456789), "1.234568");
  assert.deepEqual(textureReferencesInMtl("newmtl a\nmap_Kd tex.png\nmap_Bump -bm 0.5 bump.png\n# map_Ks ignored.png\nbump ../up.png\n"), ["tex.png", "bump.png", "../up.png"]);
});
