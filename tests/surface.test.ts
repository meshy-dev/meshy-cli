/**
 * Command-surface pins for the agent-ts alignment (2026-07).
 *
 * The flag surface is a curated contract, not a mirror of every API field:
 * deprecated parameters (symmetry_mode) stay gone, geometry knobs live on
 * remesh only, and the game-ready defaults are advertised. These tests walk
 * the commander tree so a reintroduced flag or a lost command fails loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Command } from "commander";
import { buildRootCommand } from "../src/root.js";
import { retextureSpec } from "../src/cmd/retexture.js";

const root = buildRootCommand();

function sub(parent: Command, name: string): Command {
  const cmd = parent.commands.find((c) => c.name() === name);
  assert.ok(cmd, `expected command '${name}' under '${parent.name()}'`);
  return cmd as Command;
}

function createFlags(resource: string): Set<string> {
  const create = sub(sub(root, resource), "create");
  return new Set(create.options.map((o) => o.long ?? ""));
}

test("deprecated and relocated flags are gone from the generation commands", () => {
  for (const resource of ["text-to-3d", "image-to-3d", "multi-image-to-3d"]) {
    const flags = createFlags(resource);
    // symmetry_mode is deprecated API-wide (no effect since 2026-05).
    assert.ok(!flags.has("--symmetry-mode"), `${resource} still has --symmetry-mode`);
    // Geometry shaping belongs to remesh; sizing belongs to resize.
    assert.ok(!flags.has("--should-remesh"), `${resource} still has --should-remesh`);
    assert.ok(!flags.has("--topology"), `${resource} still has --topology`);
    assert.ok(!flags.has("--decimation-mode"), `${resource} still has --decimation-mode`);
    assert.ok(!flags.has("--auto-size"), `${resource} still has --auto-size`);
    assert.ok(!flags.has("--origin-at"), `${resource} still has --origin-at`);
    assert.ok(!flags.has("--moderation"), `${resource} still has --moderation`);
  }
  // Exception: smart-topology's polycount is native to image-to-3d.
  assert.ok(createFlags("image-to-3d").has("--target-polycount"));
  assert.ok(!createFlags("text-to-3d").has("--target-polycount"));
  assert.ok(!createFlags("multi-image-to-3d").has("--target-polycount"));
});

test("texture_resolution replaced the hd_texture era on every texturing command", () => {
  for (const resource of ["text-to-3d", "image-to-3d", "multi-image-to-3d", "retexture"]) {
    assert.ok(createFlags(resource).has("--texture-resolution"), resource);
  }
});

test("remesh kept geometry, lost sizing and format-only conversion", () => {
  const flags = createFlags("remesh");
  for (const kept of ["--topology", "--target-polycount", "--decimation-mode"]) {
    assert.ok(flags.has(kept), `remesh lost ${kept}`);
  }
  for (const moved of ["--resize-height", "--auto-size", "--origin-at", "--convert-format-only"]) {
    assert.ok(!flags.has(moved), `remesh still has ${moved}`);
  }
});

test("convert and resize are first-class resources with the full verb set", () => {
  for (const resource of ["convert", "resize"]) {
    const cmd = sub(root, resource);
    for (const verb of ["create", "get", "wait", "delete", "list"]) {
      sub(cmd, verb);
    }
  }
  const resizeFlags = createFlags("resize");
  for (const flag of ["--resize-height", "--resize-longest-side", "--auto-size", "--origin-at"]) {
    assert.ok(resizeFlags.has(flag), `resize is missing ${flag}`);
  }
});

test("image-to-3d gained the smart-topology surface and task chaining", () => {
  const flags = createFlags("image-to-3d");
  for (const flag of ["--model-type", "--input-task-id", "--target-polycount"]) {
    assert.ok(flags.has(flag), `image-to-3d is missing ${flag}`);
  }
  // Both image-driven 3D commands chain from prior image tasks.
  assert.ok(createFlags("multi-image-to-3d").has("--input-task-id"));
});

test("the mode is the model: no model flag on the 3D generation commands", () => {
  // After culling meshy-5/meshy-t1, each mode has exactly one model
  // (standard → meshy-7, smart-topology → meshy-t2), so --ai-model is gone
  // from 3D generation — the 2D image commands keep theirs. text-to-3d also
  // lost --model-type (lowpoly was the t1-era engine).
  for (const resource of ["text-to-3d", "image-to-3d", "multi-image-to-3d"]) {
    assert.ok(!createFlags(resource).has("--ai-model"), `${resource} still has --ai-model`);
  }
  assert.ok(!createFlags("text-to-3d").has("--model-type"), "text-to-3d still has --model-type");
  for (const resource of ["text-to-image", "image-to-image"]) {
    assert.ok(createFlags(resource).has("--ai-model"), `${resource} lost --ai-model`);
  }
});

test("the Meshy 7 surface: ultra-mode is single-image only, multi-view is retexture only", () => {
  // ultra_mode exists on /image-to-3d and nowhere else — the API silently
  // ignores it on multi-image-to-3d, which is worse than rejecting it, so the
  // flag must not appear there and invite the assumption that it worked.
  assert.ok(createFlags("image-to-3d").has("--ultra-mode"), "image-to-3d is missing --ultra-mode");
  for (const resource of ["text-to-3d", "multi-image-to-3d", "retexture"]) {
    assert.ok(!createFlags(resource).has("--ultra-mode"), `${resource} should not have --ultra-mode`);
  }
  // multiview_image_urls is retexture's third style input, not a generation flag.
  assert.ok(
    createFlags("retexture").has("--multiview-image-urls"),
    "retexture is missing --multiview-image-urls",
  );
  for (const resource of ["image-to-3d", "multi-image-to-3d"]) {
    assert.ok(
      !createFlags(resource).has("--multiview-image-urls"),
      `${resource} should not have --multiview-image-urls`,
    );
  }
});

test("multi-view retexture pins ai_model meshy-7 — the endpoint rejects 'latest'", () => {
  // Verified against production: /retexture answers
  // "multiview_image_urls requires ai_model meshy-7" for an omitted ai_model
  // AND for "latest". Dropping this pin is a guaranteed 400, so it is a wire
  // contract rather than the usual leave-it-to-the-server default.
  const defaults = retextureSpec.create.toDefaults!;
  assert.equal(defaults({ multiviewImageUrls: ["a.png"] }).ai_model, "meshy-7");
  // Every other style input keeps the no-model-choice contract.
  assert.equal(defaults({ textStylePrompt: "gold" }).ai_model, undefined);
  assert.equal(defaults({ multiviewImageUrls: [] }).ai_model, undefined);
  assert.equal(defaults({}).ai_model, undefined);
});

test("2D image commands default to gpt-image-2 and share the aspect-ratio surface", () => {
  for (const resource of ["text-to-image", "image-to-image"]) {
    const create = sub(sub(root, resource), "create");
    const model = create.options.find((o) => o.long === "--ai-model");
    assert.ok(model, `${resource} is missing --ai-model`);
    // The default is a payload-layer default (so --data can override it),
    // advertised in the help text rather than pinned on the commander Option.
    assert.equal(model?.defaultValue, undefined, resource);
    assert.match(model?.description ?? "", /gpt-image-2 \(default/, resource);
    assert.ok(model?.argChoices?.includes("nano-banana-2-lite"), `${resource} lost nano-banana-2-lite`);
    assert.ok(createFlags(resource).has("--aspect-ratio"), `${resource} is missing --aspect-ratio`);
  }
});

test("rigging carries no texture flag and documents its bundled animations", () => {
  const flags = createFlags("rigging");
  assert.ok(!flags.has("--texture-image-url"));
  assert.match(sub(root, "rigging").description(), /walking and running/i);
});

test("text-to-motion exposes the v1 motion contract", () => {
  const cmd = sub(root, "text-to-motion");
  for (const verb of ["create", "get", "wait", "delete", "list"]) {
    sub(cmd, verb);
  }
  const create = sub(cmd, "create");
  const flags = createFlags("text-to-motion");
  for (const flag of ["--prompt", "--mode", "--duration"]) {
    assert.ok(flags.has(flag), `text-to-motion is missing ${flag}`);
  }
  const mode = create.options.find((o) => o.long === "--mode");
  assert.deepEqual(mode?.argChoices, ["prime", "swift"]);
  assert.match(mode?.description ?? "", /default: prime/);
});

test("descriptions and flag help stay lean: no credit prices in the command surface", () => {
  // Pricing lives in the skills (linked to https://docs.meshy.ai/en/api/pricing),
  // not in --help output that rides along in every agent context. "credit
  // balance" as a concept is fine; "N credits" price tags are not.
  const price = /\d+\s*credits?|credit cost/i;
  function walk(cmd: Command): void {
    assert.doesNotMatch(cmd.description(), price, `${cmd.name()} description carries a price`);
    for (const opt of cmd.options) {
      assert.doesNotMatch(opt.description ?? "", price, `${cmd.name()} ${opt.long} carries a price`);
    }
    for (const child of cmd.commands) walk(child as Command);
  }
  walk(root);
});

test("image-driven 3D commands default to a draft white mesh", () => {
  // The pipeline is prompt → image → draft mesh → texture: texturing is its
  // own step, so should_texture defaults false (advertised in the help).
  for (const resource of ["image-to-3d", "multi-image-to-3d"]) {
    const create = sub(sub(root, resource), "create");
    const flag = create.options.find((o) => o.long === "--should-texture");
    assert.ok(flag, `${resource} is missing --should-texture`);
    assert.match(flag?.description ?? "", /default: false/, resource);
  }
});

test("generation commands default target_formats to glb instead of every format", () => {
  for (const resource of ["text-to-3d", "image-to-3d", "multi-image-to-3d", "remesh", "retexture"]) {
    const create = sub(sub(root, resource), "create");
    const flag = create.options.find((o) => o.long === "--target-formats");
    assert.ok(flag, `${resource} is missing --target-formats`);
    assert.match(flag?.description ?? "", /default: glb/, resource);
  }
});
