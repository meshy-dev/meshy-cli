/**
 * Material references of a downloaded OBJ set (src/internal/material-links.ts):
 * a map line is rewritten only when exactly one saved texture was served under
 * the referenced name; the OBJ is never rewritten; everything else stays as
 * written and is reported.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/internal/errors.js";
import { relinkMaterials, type LinkableFile } from "../src/internal/material-links.js";

/** A downloaded set on disk, as the downloader saves it, with the names each file was served under. */
function savedSet(obj: string, mtl: string | null, textures: Array<[key: string, saved: string, served: string]>): { dir: string; files: LinkableFile[] } {
  const dir = mkdtempSync(join(tmpdir(), "meshy-links-"));
  const files: LinkableFile[] = [];
  writeFileSync(join(dir, "model.obj"), obj);
  files.push({ key: "model.obj", path: join(dir, "model.obj"), sourceName: "model.obj" });
  if (mtl !== null) {
    writeFileSync(join(dir, "model.mtl"), mtl);
    files.push({ key: "model.mtl", path: join(dir, "model.mtl"), sourceName: "model.mtl" });
  }
  for (const [key, saved, served] of textures) {
    writeFileSync(join(dir, saved), "png");
    files.push({ key, path: join(dir, saved), sourceName: served });
  }
  return { dir, files };
}

const OBJ = "# Blender\nmtllib model.mtl\nv 0 0 0\nmtllib late.mtl\nf 1 1 1\n";

test("a map naming a served texture points at its saved name; options, indentation and line endings are kept; the OBJ is untouched", async () => {
  const mtl = "newmtl a\r\n  map_Kd texture_0.png\r\nmap_Bump -bm 0.5 texture_0_normal.png\r\nKd 1 1 1\r\n";
  const { dir, files } = savedSet(OBJ, mtl, [
    ["texture.0.base_color", "texture_0_base_color.png", "texture_0.png"],
    ["texture.0.normal", "texture_0_normal.png", "texture_0_normal.png"],
  ]);
  const report = (await relinkMaterials(files))!;
  assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), "newmtl a\r\n  map_Kd texture_0_base_color.png\r\nmap_Bump -bm 0.5 texture_0_normal.png\r\nKd 1 1 1\r\n");
  assert.equal(readFileSync(join(dir, "model.obj"), "utf8"), OBJ);
  assert.deepEqual(report.texture_maps, [
    { line: 2, reference: "texture_0.png", resolved_to: "texture_0_base_color.png" },
    { line: 3, reference: "texture_0_normal.png", resolved_to: "texture_0_normal.png" },
  ]);
  assert.deepEqual(report.mtllib, [{ line: 2, reference: "model.mtl", resolved_to: "model.mtl" }], "mtllib after the first vertex is not read");
  assert.deepEqual(report.rewritten, [join(dir, "model.mtl")]);
  assert.equal(report.status, "complete");
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp-")), [], "no temp file is left");
});

test("no guessing: a name no texture was served as, or one served by two textures, stays as written and is reported", async () => {
  const mtl = "newmtl a\nmap_Kd albedo.png\nnewmtl b\nmap_Kd texture_0.png\n";
  const { dir, files } = savedSet(OBJ, mtl, [
    ["texture.0.base_color", "texture_0_base_color.png", "texture_0.png"],
    ["texture.1.base_color", "texture_1_base_color.png", "texture_0.png"],
  ]);
  const report = (await relinkMaterials(files))!;
  assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), mtl);
  assert.deepEqual(report.texture_maps.map((l) => l.resolved_to), [null, null]);
  assert.deepEqual(report.rewritten, []);
  assert.equal(report.status, "incomplete");
  assert.equal(report.warnings[0]?.code, "material_reference_unresolved");
  assert.match(report.warnings[0]!.message, /'albedo\.png', 'texture_0\.png'/);
});

test("an OBJ whose mtllib names no saved MTL is reported, and nothing is rewritten", async () => {
  const other = savedSet("mtllib box.mtl\nv 0 0 0\n", "newmtl a\n", []);
  const mismatch = (await relinkMaterials(other.files))!;
  assert.deepEqual(mismatch.mtllib, [{ line: 1, reference: "box.mtl", resolved_to: null }]);
  assert.equal(mismatch.status, "incomplete");
  assert.match(mismatch.warnings[0]!.message, /references 'box\.mtl' but the MTL was saved as model\.mtl/);
  assert.equal(readFileSync(join(other.dir, "model.obj"), "utf8"), "mtllib box.mtl\nv 0 0 0\n");
  const geometryOnly = (await relinkMaterials(savedSet(OBJ, null, []).files))!;
  assert.match(geometryOnly.warnings[0]!.message, /no MTL was downloaded with it/);
});

test("nothing to do without an OBJ; an aborted run stops before it writes", async () => {
  assert.equal(await relinkMaterials([{ key: "model.glb", path: "/x/model.glb" }]), null);
  const { dir, files } = savedSet(OBJ, "map_Kd texture_0.png\n", [["texture.0.base_color", "texture_0_base_color.png", "texture_0.png"]]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => relinkMaterials(files, { signal: controller.signal }), (err: unknown) => err instanceof CliError && err.code === "interrupted");
  assert.equal(readFileSync(join(dir, "model.mtl"), "utf8"), "map_Kd texture_0.png\n");
});
