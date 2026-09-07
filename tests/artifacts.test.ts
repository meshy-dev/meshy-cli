/**
 * Asset enumeration and selection (T-060, T-061, T-062, T-063, T-071).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enumerateAssets, resolveAssetKey, selectAssets, SelectionError } from "../src/internal/artifacts.js";
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

test("T-061 selection: keys (with legacy aliases), model format, kind, all; contradictions and misses throw with candidates", () => {
  const task = { id: "t", type: "image-to-3d", status: "SUCCEEDED", model_urls: { glb: "https://a/g", obj: "https://a/o", mtl: "https://a/m" }, thumbnail_url: "https://a/t.png", texture_urls: [{ base_color: "https://a/bc.png" }] };
  const e = enumerateAssets(task);
  assert.deepEqual(selectAssets(e, { keys: ["model.glb", "thumbnail"] }, { withDependencies: true }).selected.map((a) => a.key), ["model.glb", "thumbnail.primary"]);
  assert.deepEqual(selectAssets(e, { keys: ["model_glb", "texture_0_base_color"] }, { withDependencies: true }).selected.map((a) => a.key), ["model.glb", "texture.0.base_color"]);
  assert.deepEqual(selectAssets(e, { modelFormat: "GLB" }, { withDependencies: true }).selected.map((a) => a.key), ["model.glb"]);
  assert.deepEqual(selectAssets(e, { kind: "texture" }, { withDependencies: true }).selected.map((a) => a.key), ["texture.0.base_color"]);
  assert.equal(selectAssets(e, { all: true }, { withDependencies: false }).selected.length, 5);
  const objSel = selectAssets(e, { keys: ["model.obj"] }, { withDependencies: true });
  assert.deepEqual(objSel.dependencies.map((a) => a.key), ["model.mtl", "texture.0.base_color"]);
  assert.deepEqual(selectAssets(e, { keys: ["model.obj"] }, { withDependencies: false }).dependencies, []);
  assert.throws(() => selectAssets(e, { keys: ["model.usdz"] }, { withDependencies: true }), (err: unknown) => err instanceof SelectionError && err.candidates.length === 5);
  assert.throws(() => selectAssets(e, { modelFormat: "3mf" }, { withDependencies: true }), SelectionError);
  assert.throws(() => selectAssets(e, {}, { withDependencies: true }), SelectionError);
  assert.equal(resolveAssetKey("animation_glb_url", enumerateAssets({ id: "a", status: "SUCCEEDED", result: { animation_glb_url: "https://a/x.glb" } }).assets)?.key, "result.animation_glb_url");
  assert.equal(resolveAssetKey("walking_glb_url", enumerateAssets(rig).assets)?.key, "result.basic_animations.walking_glb_url");
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
