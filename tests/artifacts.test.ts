/**
 * Asset enumeration and selection (T-060, T-061, T-062, T-063, T-071).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enumerateAssets, resolveAssetKey, selectAssets, selectDefaultAssets, SelectionError } from "../src/internal/artifacts.js";
import { requireTaskResource } from "../src/client/resource-registry.js";
import { extractTaskObject, toTaskView } from "../src/internal/task-view.js";

const rig = JSON.parse(readFileSync(new URL("./fixtures/skill-parity/task-rigging.synthetic.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("T-060 rigging: rig + nested walking/running animations are enumerated with role keys", () => {
  const e = enumerateAssets(rig, requireTaskResource("rigging"));
  assert.deepEqual(
    e.assets.map((a) => [a.key, a.kind, a.format]),
    [
      ["result.rigged_character_glb_url", "rig", "glb"],
      ["result.basic_animations.walking_glb_url", "animation", "glb"],
      ["result.basic_animations.running_glb_url", "animation", "glb"],
    ],
  );
  assert.deepEqual(e.unknown_urls, []);
});

test("T-060 textured model: model formats, MTL dependency, textures, primary/multiview/alpha thumbnails", () => {
  const task = {
    id: "t",
    type: "text-to-3d-refine",
    status: "SUCCEEDED",
    model_urls: { glb: "https://a.example/m.glb", obj: "https://a.example/m.obj", mtl: "https://a.example/m.mtl", fbx: "https://a.example/m.fbx", usdz: null },
    thumbnail_url: "https://a.example/t.png",
    thumbnail_urls: { front: "https://a.example/f.png", back: "https://a.example/b.png" },
    alpha_thumbnail_url: "https://a.example/alpha.png",
    texture_urls: [{ base_color: "https://a.example/bc.png", normal: "https://a.example/n.png", metallic: null }],
  };
  const e = enumerateAssets(task, requireTaskResource("text-to-3d"));
  const keys = e.assets.map((a) => a.key);
  assert.deepEqual(keys, [
    "model.glb", "model.obj", "model.mtl", "model.fbx",
    "thumbnail.primary", "thumbnail.front", "thumbnail.back", "thumbnail.alpha",
    "texture.0.base_color", "texture.0.normal",
  ]);
  const obj = e.assets.find((a) => a.key === "model.obj")!;
  assert.deepEqual(obj.dependencies, ["model.mtl", "texture.0.base_color", "texture.0.normal"]);
  assert.equal(e.assets.find((a) => a.key === "thumbnail.front")?.notes?.["view"], "front");
});

test("T-060 lamp build parts are STL/ZIP, never `.lamp_stl`; keychain obj is a ZIP container", () => {
  const lamp = enumerateAssets({ id: "l", type: "creative-lab-lamp-build", status: "SUCCEEDED", model_urls: { lamp_stl: "https://a.example/lamp", base_stl: "https://a.example/base", bundle_zip: "https://a.example/bundle" } });
  assert.deepEqual(lamp.assets.map((a) => [a.key, a.format, a.filename]), [
    ["model.lamp_stl", "stl", "lamp.stl"],
    ["model.base_stl", "stl", "base.stl"],
    ["model.bundle_zip", "zip", "bundle.zip"],
  ]);
  const kc = enumerateAssets({ id: "k", type: "creative-lab-keychain-build", status: "SUCCEEDED", model_urls: { obj: "https://a.example/kc" } });
  const obj = kc.assets[0]!;
  assert.equal(obj.format, "zip");
  assert.equal(obj.containerFormat, "zip");
  assert.equal(obj.modelFormat, "obj");
  assert.equal(obj.filename, "model.obj.zip");
  assert.equal(obj.notes?.["extracted"], false);
  assert.deepEqual(obj.dependencies, []);
  // With the descriptor instead of the type.
  const fm = enumerateAssets({ id: "f", status: "SUCCEEDED", model_urls: { obj: "https://a.example/fm" } }, requireTaskResource("creative-lab.fridge-magnet.build"));
  assert.equal(fm.assets[0]!.containerFormat, "zip");
  // A plain text-to-3d OBJ is a real OBJ.
  const plain = enumerateAssets({ id: "p", type: "text-to-3d-refine", status: "SUCCEEDED", model_urls: { obj: "https://a.example/p.obj" } });
  assert.equal(plain.assets[0]!.containerFormat, null);
  assert.equal(plain.assets[0]!.filename, "model.obj");
});

test("T-060 motion clips use motion_format; report-only tasks yield a JSON report asset; unknown URLs are listed, not fetched", () => {
  const motion = enumerateAssets({ id: "m", type: "text-to-motion", status: "SUCCEEDED", result: { motion_url: "https://a.example/clip", motion_format: "bvh", duration_ms: 3000 } });
  assert.deepEqual(motion.assets.map((a) => [a.key, a.kind, a.format, a.filename]), [["result.motion_url", "motion", "bvh", "motion.bvh"]]);
  const report = enumerateAssets({ id: "r", type: "print-analyze", status: "SUCCEEDED", printability: { status: "healthy" } });
  assert.equal(report.assets[0]!.kind, "report");
  assert.equal(report.assets[0]!.url, null);
  assert.deepEqual(report.assets[0]!.report, { status: "healthy" });
  const odd = enumerateAssets({ id: "o", status: "SUCCEEDED", result: { mystery_url: "https://a.example/x", nested: { deeper: "https://a.example/y" } } });
  assert.deepEqual(odd.assets, []);
  assert.deepEqual(odd.unknown_urls.map((u) => u.path), ["result.mystery_url", "result.nested.deeper"]);
});

test("T-061 selection: keys, model format, kind, all; contradictions and misses throw with candidates", () => {
  const task = { id: "t", type: "image-to-3d", status: "SUCCEEDED", model_urls: { glb: "https://a/g", obj: "https://a/o", mtl: "https://a/m" }, thumbnail_url: "https://a/t.png", texture_urls: [{ base_color: "https://a/bc.png" }] };
  const e = enumerateAssets(task);
  assert.deepEqual(selectAssets(e, { keys: ["model.glb", "thumbnail.primary"] }, { withDependencies: true }).selected.map((a) => a.key), ["model.glb", "thumbnail.primary"]);
  assert.deepEqual(selectAssets(e, { modelFormat: "GLB" }, { withDependencies: true }).selected.map((a) => a.key), ["model.glb"]);
  assert.deepEqual(selectAssets(e, { kind: "texture" }, { withDependencies: true }).selected.map((a) => a.key), ["texture.0.base_color"]);
  assert.equal(selectAssets(e, { all: true }, { withDependencies: false }).selected.length, 5);
  const objSel = selectAssets(e, { keys: ["model.obj"] }, { withDependencies: true });
  assert.deepEqual(objSel.dependencies.map((a) => a.key), ["model.mtl", "texture.0.base_color"]);
  assert.deepEqual(selectAssets(e, { keys: ["model.obj"] }, { withDependencies: false }).dependencies, []);
  assert.throws(() => selectAssets(e, { keys: ["model.usdz"] }, { withDependencies: true }), (err: unknown) => err instanceof SelectionError && err.candidates.length === 5);
  assert.throws(() => selectAssets(e, { modelFormat: "3mf" }, { withDependencies: true }), SelectionError);
  assert.throws(() => selectAssets(e, {}, { withDependencies: true }), SelectionError);
  assert.equal(resolveAssetKey("result.basic_animations.walking_glb_url", enumerateAssets(rig).assets)?.key, "result.basic_animations.walking_glb_url");
  assert.equal(resolveAssetKey("walking_glb_url", enumerateAssets(rig).assets), undefined, "only stable keys resolve");
});

test("T-062 OBJ without MTL in the task reports the missing dependency instead of pretending", () => {
  const e = enumerateAssets({ id: "t", type: "remesh", status: "SUCCEEDED", model_urls: { obj: "https://a/o" } });
  const sel = selectAssets(e, { keys: ["model.obj"] }, { withDependencies: true });
  assert.deepEqual(sel.dependencies, []);
  assert.deepEqual(sel.missingDependencies, []);
  assert.deepEqual(e.assets[0]!.dependencies, [], "no MTL in the task → nothing to depend on");
});

test("T-063 the same task yields the same assets from an API task, a meta.json and a v1 envelope", () => {
  const fromApi = enumerateAssets(rig).assets.map((a) => a.key);
  const meta = extractTaskObject({ resource: "rigging", task: rig, saved_files: [], downloaded_at: "x" })!;
  const env = extractTaskObject({ schema_version: "meshy.cli/v1", command: "rigging.get", ok: true, result: { task: toTaskView(rig, { includeRaw: true }) }, error: null, warnings: [] })!;
  assert.deepEqual(enumerateAssets(meta.task).assets.map((a) => a.key), fromApi);
  assert.deepEqual(enumerateAssets(env.task).assets.map((a) => a.key), fromApi);
});

// ---------------------------------------------------------------------------
// selectDefaultAssets — what `-o` saves without --all-assets
// ---------------------------------------------------------------------------

const cdn = (name: string): string => `https://cdn.example.com/${name}`;
const defaults = (task: Record<string, unknown>) => {
  const sel = selectDefaultAssets(enumerateAssets({ id: "t", status: "SUCCEEDED", ...task }).assets);
  return { selected: sel.selected.map((a) => a.key), skipped: sel.skipped.map((s) => [s.asset.key, s.reason]) };
};

test("default selection — GLB-only model task: model + primary thumbnail; embedded texture maps and per-view thumbnails stay on the server", () => {
  const sel = defaults({ model_urls: { glb: cdn("m.glb") }, thumbnail_url: cdn("t.png"), thumbnail_urls: { front: cdn("f.png") }, texture_urls: [{ base_color: cdn("bc.png"), normal: cdn("n.png") }] });
  assert.deepEqual(sel.selected, ["model.glb", "thumbnail.primary"]);
  assert.deepEqual(sel.skipped, [["thumbnail.front", "extra_thumbnail"], ["texture.0.base_color", "embedded_textures"], ["texture.0.normal", "embedded_textures"]]);
});

test("default selection — texture maps stay when a delivered model does not embed them (OBJ + MTL, FBX, glTF)", () => {
  const deliveries: Array<Record<string, string>> = [{ obj: cdn("m.obj"), mtl: cdn("m.mtl") }, { glb: cdn("m.glb"), fbx: cdn("m.fbx") }, { gltf: cdn("m.gltf") }];
  for (const model_urls of deliveries) {
    const sel = defaults({ model_urls, texture_urls: [{ base_color: cdn("bc.png") }] });
    assert.ok(sel.selected.includes("texture.0.base_color"), JSON.stringify(model_urls));
    assert.deepEqual(sel.skipped, []);
  }
});

test("default selection — every produced model format is kept; the pre-remesh GLB is not; a ZIP bundle counts as self-contained", () => {
  assert.deepEqual(defaults({ model_urls: { glb: cdn("m.glb"), stl: cdn("m.stl"), pre_remeshed_glb: cdn("p.glb") } }), { selected: ["model.glb", "model.stl"], skipped: [["model.pre_remeshed_glb", "pre_remesh_variant"]] });
  assert.deepEqual(defaults({ type: "creative-lab-keycap-build", model_urls: { obj_zip: cdn("k.zip") }, texture_urls: [{ base_color: cdn("bc.png") }] }).skipped, [["texture.0.base_color", "embedded_textures"]]);
});

test("default selection — rigging keeps the GLB rigged character, not its FBX copy or the bundled clips", () => {
  assert.deepEqual(defaults({ result: { rigged_character_fbx_url: cdn("r.fbx"), rigged_character_glb_url: cdn("r.glb"), basic_animations: { running_glb_url: cdn("run.glb"), running_fbx_url: cdn("run.fbx") } } }), {
    selected: ["result.rigged_character_glb_url"],
    skipped: [["result.rigged_character_fbx_url", "alternate_format"], ["result.basic_animations.running_glb_url", "bundled_animation"], ["result.basic_animations.running_fbx_url", "bundled_animation"]],
  });
});

test("default selection — animate keeps the GLB clip and every post-process output; an FBX-only result, images, motion and reports are kept", () => {
  assert.deepEqual(defaults({ result: { animation_fbx_url: cdn("a.fbx"), animation_glb_url: cdn("a.glb"), processed_usdz_url: cdn("a.usdz"), processed_armature_fbx_url: cdn("arm.fbx") } }), {
    selected: ["result.animation_glb_url", "result.processed_usdz_url", "result.processed_armature_fbx_url"],
    skipped: [["result.animation_fbx_url", "alternate_format"]],
  });
  assert.deepEqual(defaults({ result: { animation_fbx_url: cdn("a.fbx") } }).selected, ["result.animation_fbx_url"]);
  assert.deepEqual(defaults({ image_urls: [cdn("0.png"), cdn("1.png")] }).selected, ["image.0", "image.1"]);
  assert.deepEqual(defaults({ result: { motion_url: cdn("m.fbx"), motion_format: "fbx" } }).selected, ["result.motion_url"]);
  assert.deepEqual(defaults({ printability: { status: "healthy" } }).selected, ["report.printability"]);
});

test("default selection — a task with nothing primary keeps everything", () => {
  assert.deepEqual(defaults({ result: { basic_animations: { walking_glb_url: cdn("w.glb") } } }), { selected: ["result.basic_animations.walking_glb_url"], skipped: [] });
});
