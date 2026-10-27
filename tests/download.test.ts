/**
 * `-o` (downloadTaskAssets): the default selection written into a directory
 * or one file, extension reconciliation, the sidecar, and the refusals that
 * happen before any request. Network is mocked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { requireTaskResource } from "../src/client/resource-registry.js";
import type { Task } from "../src/client/types.js";
import { CliError } from "../src/internal/errors.js";
import { downloadTaskAssets } from "../src/internal/download.js";
import { looksLikeFile } from "../src/internal/paths.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-test",
    type: "",
    status: "SUCCEEDED",
    progress: 100,
    preceding_tasks: 0,
    created_at: 0,
    started_at: 0,
    finished_at: 0,
    expires_at: 0,
    ...overrides,
  } as Task;
}

function installFetch(bodies: Record<string, { body: string | Uint8Array; contentType: string }>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = input instanceof URL ? input.href : String(input);
    const entry = bodies[url];
    if (!entry) return new Response("not found", { status: 404 });
    const body = typeof entry.body === "string" ? entry.body : new Uint8Array(entry.body);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": entry.contentType },
    });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

/** Real 2x2 PNG built via sharp so decoders accept it. */
async function tinyPngBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** A body that passes the GLB magic check. */
const GLB = (tag: string): string => `glTF${tag}`;

/** A fresh directory, by its real path (the manifest reports real paths). */
const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "meshy-dl-")));
const paths = (files: Array<{ path: string }>): string[] => files.map((f) => f.path);
const IMAGE = requireTaskResource("text-to-image");
const IMAGE_TO_3D = requireTaskResource("image-to-3d");
const RIGGING = requireTaskResource("rigging");
const ANALYZE = requireTaskResource("analyze-printability");

test("looksLikeFile — detects extensions", () => {
  assert.equal(looksLikeFile("foo.jpg"), true);
  assert.equal(looksLikeFile("foo/bar.glb"), true);
  assert.equal(looksLikeFile("foo"), false);
  assert.equal(looksLikeFile("character/front"), false);
  assert.equal(looksLikeFile("out/"), false);
});

test("a single image into a file: bytes unchanged, the sidecar is named after the file", async () => {
  const url = "https://cdn.example.com/img_0";
  const png = await tinyPngBytes();
  const restore = installFetch({ [url]: { body: png, contentType: "image/png" } });
  try {
    const dir = tmp();
    const { files, metadataPath } = await downloadTaskAssets(task({ id: "t1", type: "text-to-image", image_urls: [url] }), join(dir, "character", "front.png"), IMAGE);
    assert.equal(files.length, 1);
    assert.match(files[0]!.path, /character\/front\.png$/);
    assert.ok(readFileSync(files[0]!.path).equals(png), "PNG bytes passed through unchanged");
    assert.match(metadataPath, /character\/front_meta\.json$/);
    assert.ok(existsSync(metadataPath));
  } finally {
    restore();
  }
});

test("two single-file outputs in one directory keep separate sidecars", async () => {
  const [url1, url2] = ["https://cdn.example.com/a", "https://cdn.example.com/b"];
  const png = await tinyPngBytes();
  const restore = installFetch({ [url1!]: { body: png, contentType: "image/png" }, [url2!]: { body: png, contentType: "image/png" } });
  try {
    const dir = tmp();
    const r1 = await downloadTaskAssets(task({ id: "t1", type: "text-to-image", image_urls: [url1!] }), join(dir, "a.png"), IMAGE);
    const r2 = await downloadTaskAssets(task({ id: "t2", type: "text-to-image", image_urls: [url2!] }), join(dir, "b.png"), IMAGE);
    assert.match(r1.metadataPath, /a_meta\.json$/);
    assert.match(r2.metadataPath, /b_meta\.json$/);
  } finally {
    restore();
  }
});

test("an image is transcoded to the extension the file path asks for (JPEG, WebP)", async () => {
  const url = "https://cdn.example.com/img_0";
  const restore = installFetch({ [url]: { body: await tinyPngBytes(), contentType: "image/png" } });
  try {
    const dir = tmp();
    const jpeg = await downloadTaskAssets(task({ id: "t1", type: "text-to-image", image_urls: [url] }), join(dir, "front.jpeg"), IMAGE);
    const jb = readFileSync(jpeg.files[0]!.path);
    assert.match(jpeg.files[0]!.path, /front\.jpeg$/);
    assert.deepEqual([jb[0], jb[1], jb[2]], [0xff, 0xd8, 0xff], "JPEG magic");
    assert.ok(jpeg.warnings.some((w) => w.code === "image_transcoded"));
    const webp = await downloadTaskAssets(task({ id: "t2", type: "text-to-image", image_urls: [url] }), join(dir, "side.webp"), IMAGE);
    const wb = readFileSync(webp.files[0]!.path);
    assert.equal(wb.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wb.subarray(8, 12).toString("ascii"), "WEBP");
  } finally {
    restore();
  }
});

test("a body that cannot be transcoded keeps its true extension, with a warning", async () => {
  const url = "https://cdn.example.com/m.raw";
  const restore = installFetch({ [url]: { body: GLB("-model"), contentType: "model/gltf-binary" } });
  try {
    const { files, warnings } = await downloadTaskAssets(task({ id: "t1", type: "text-to-image", image_urls: [url] }), join(tmp(), "out", "thing.png"), IMAGE);
    assert.match(files[0]!.path, /out\/thing\.glb$/);
    assert.ok(warnings.some((w) => w.code === "extension_corrected"));
  } finally {
    restore();
  }
});

test("an image without an extension hint gets the content-type extension in a directory", async () => {
  const url = "https://cdn.example.com/a";
  const restore = installFetch({ [url]: { body: await tinyPngBytes(), contentType: "image/png" } });
  try {
    const { files } = await downloadTaskAssets(task({ id: "t4", type: "text-to-image", image_urls: [url] }), join(tmp(), "out"), IMAGE);
    assert.match(files[0]!.path, /out\/image_0\.png$/);
  } finally {
    restore();
  }
});

test("a directory gets every model format the task produced and the thumbnail; embedded texture maps stay on the server", async () => {
  const base = "https://cdn.example.com/m/";
  const restore = installFetch({
    [`${base}m.glb`]: { body: GLB("-glb"), contentType: "model/gltf-binary" },
    [`${base}m.stl`]: { body: "solid x", contentType: "model/stl" },
    [`${base}t.png`]: { body: await tinyPngBytes(), contentType: "image/png" },
  });
  try {
    const outDir = join(tmp(), "robot");
    const { files, skipped, metadataPath } = await downloadTaskAssets(
      task({ id: "t2", type: "image-to-3d", model_urls: { glb: `${base}m.glb`, stl: `${base}m.stl` }, thumbnail_url: `${base}t.png`, texture_urls: [{ base_color: `${base}bc.png` }] }),
      outDir,
      IMAGE_TO_3D,
    );
    assert.deepEqual(readdirSync(outDir).sort(), ["meta.json", "model.glb", "model.stl", "thumbnail.png"]);
    assert.deepEqual(files.map((f) => f.key), ["model.glb", "model.stl", "thumbnail.primary"]);
    assert.deepEqual(skipped, [{ key: "texture.0.base_color", reason: "embedded_textures" }]);
    const meta = JSON.parse(readFileSync(metadataPath, "utf8")) as { saved_files: string[]; skipped: unknown; task: { texture_urls: unknown } };
    assert.deepEqual(meta.saved_files, paths(files));
    assert.deepEqual(meta.skipped, skipped);
    assert.deepEqual(meta.task.texture_urls, [{ base_color: `${base}bc.png` }], "meta.json keeps every URL for meshy download");
  } finally {
    restore();
  }
});

test("rigging into a directory: the GLB rigged character only; the FBX copy and the bundled clips are listed as skipped", async () => {
  const base = "https://cdn.example.com/r/";
  const result = {
    rigged_character_glb_url: `${base}rig.glb`,
    rigged_character_fbx_url: `${base}rig.fbx`,
    basic_animations: { walking_glb_url: `${base}w.glb`, walking_armature_glb_url: `${base}wa.glb` },
  };
  const restore = installFetch({ [`${base}rig.glb`]: { body: GLB("-rig"), contentType: "model/gltf-binary" } });
  try {
    const outDir = join(tmp(), "rig");
    const { files, skipped } = await downloadTaskAssets(task({ id: "r2", type: "rig", result }), outDir, RIGGING);
    assert.deepEqual(readdirSync(outDir).sort(), ["meta.json", "rigged_character.glb"]);
    assert.deepEqual(files.map((f) => f.key), ["result.rigged_character_glb_url"]);
    assert.deepEqual(skipped, [
      { key: "result.rigged_character_fbx_url", reason: "alternate_format" },
      { key: "result.basic_animations.walking_glb_url", reason: "bundled_animation" },
      { key: "result.basic_animations.walking_armature_glb_url", reason: "bundled_animation" },
    ]);
  } finally {
    restore();
  }
});

test("a file path picks the asset of that format: `make -o car.glb` → the model, `-o hero.fbx` on a rig → the FBX copy", async () => {
  const base = "https://cdn.example.com/p/";
  const restore = installFetch({
    [`${base}m.glb`]: { body: GLB("-car"), contentType: "model/gltf-binary" },
    [`${base}rig.fbx`]: { body: "Kaydara FBX Binary", contentType: "application/octet-stream" },
  });
  try {
    const dir = tmp();
    const car = await downloadTaskAssets(
      task({ id: "t3", type: "text-to-3d", model_urls: { glb: `${base}m.glb` }, thumbnail_url: `${base}t.png`, texture_urls: [{ base_color: `${base}bc.png` }] }),
      join(dir, "car.glb"),
      IMAGE_TO_3D,
    );
    assert.deepEqual(paths(car.files), [join(dir, "car.glb")]);
    assert.equal(readFileSync(join(dir, "car.glb"), "utf8"), GLB("-car"));
    assert.deepEqual(readdirSync(dir).sort(), ["car.glb", "car_meta.json"]);
    assert.deepEqual(car.skipped, [
      { key: "thumbnail.primary", reason: "not_selected" },
      { key: "texture.0.base_color", reason: "embedded_textures" },
    ]);
    const hero = await downloadTaskAssets(
      task({ id: "r1", type: "rig", result: { rigged_character_glb_url: `${base}rig.glb`, rigged_character_fbx_url: `${base}rig.fbx` } }),
      join(dir, "hero.fbx"),
      RIGGING,
    );
    assert.equal(readFileSync(join(dir, "hero.fbx"), "utf8"), "Kaydara FBX Binary");
    assert.deepEqual(hero.skipped, [{ key: "result.rigged_character_glb_url", reason: "not_selected" }]);
  } finally {
    restore();
  }
});

test("a file path that names none of the files, or a model format change, is refused before anything is written", async () => {
  const dir = tmp();
  const t = task({ id: "t3", type: "image-to-3d", model_urls: { glb: "https://cdn.example.com/m.glb" }, thumbnail_url: "https://cdn.example.com/t.png" });
  await assert.rejects(() => downloadTaskAssets(t, join(dir, "robot.obj"), IMAGE_TO_3D), /it has model\.glb, thumbnail\.png.*pass a directory path/);
  const glbOnly = task({ id: "t4", type: "image-to-3d", model_urls: { glb: "https://cdn.example.com/m.glb" } });
  await assert.rejects(() => downloadTaskAssets(glbOnly, join(dir, "robot.fbx"), IMAGE_TO_3D), /does not name exactly one file/);
  assert.deepEqual(readdirSync(dir), [], "nothing is written");
});

test("allAssets saves every asset of the task and needs a directory", async () => {
  const base = "https://cdn.example.com/a/";
  const t = task({ id: "a1", type: "image-to-3d", model_urls: { glb: `${base}m.glb` }, thumbnail_url: `${base}t.png`, texture_urls: [{ base_color: `${base}bc.png` }] });
  const png = await tinyPngBytes();
  const restore = installFetch({
    [`${base}m.glb`]: { body: GLB("-all"), contentType: "model/gltf-binary" },
    [`${base}t.png`]: { body: png, contentType: "image/png" },
    [`${base}bc.png`]: { body: png, contentType: "image/png" },
  });
  try {
    const dir = tmp();
    const { skipped } = await downloadTaskAssets(t, join(dir, "all"), IMAGE_TO_3D, { allAssets: true });
    assert.deepEqual(readdirSync(join(dir, "all")).sort(), ["meta.json", "model.glb", "texture_0_base_color.png", "thumbnail.png"]);
    assert.deepEqual(skipped, []);
    await assert.rejects(() => downloadTaskAssets(t, join(dir, "x.glb"), IMAGE_TO_3D, { allAssets: true }), /--all-assets saves all 3 files.*needs a directory/);
  } finally {
    restore();
  }
});

test("a rerun of the same task replaces what its earlier -o saved; anything else already there is refused before the network is touched", async () => {
  const base = "https://cdn.example.com/r/";
  const png = await tinyPngBytes();
  const restore = installFetch({
    [`${base}m.glb`]: { body: GLB("-rerun"), contentType: "model/gltf-binary" },
    [`${base}t.png`]: { body: png, contentType: "image/png" },
    [`${base}bc.png`]: { body: png, contentType: "image/png" },
  });
  const counting = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = ((...args: Parameters<typeof globalThis.fetch>) => {
    fetches += 1;
    return counting(...args);
  }) as typeof globalThis.fetch;
  try {
    const t = task({ id: "r1", type: "image-to-3d", model_urls: { glb: `${base}m.glb` }, thumbnail_url: `${base}t.png`, texture_urls: [{ base_color: `${base}bc.png` }] });
    const savedFiles = (dir: string): string[] => (JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { saved_files: string[] }).saved_files.sort();
    const dir = join(tmp(), "out");
    await downloadTaskAssets(t, dir, IMAGE_TO_3D);
    const again = await downloadTaskAssets(t, dir, IMAGE_TO_3D);
    assert.deepEqual(again.files.map((f) => f.status), ["written", "written"]);
    await downloadTaskAssets(t, dir, IMAGE_TO_3D, { allAssets: true });
    await downloadTaskAssets(t, dir, IMAGE_TO_3D);
    assert.deepEqual(savedFiles(dir), [join(dir, "model.glb"), join(dir, "texture_0_base_color.png"), join(dir, "thumbnail.png")], "the texture an --all-assets run left stays recorded");

    const before = fetches;
    const other = task({ ...t, id: "r2" });
    await assert.rejects(() => downloadTaskAssets(other, dir, IMAGE_TO_3D), (e: unknown) => e instanceof CliError && e.code === "local_io" && /no earlier -o of task r2 saved/.test(e.message));
    const stray = join(tmp(), "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "model.glb"), "mine");
    await assert.rejects(() => downloadTaskAssets(t, stray, IMAGE_TO_3D), /no earlier -o of task r1 saved:\n  .*model\.glb/);
    assert.equal(readFileSync(join(stray, "model.glb"), "utf8"), "mine");
    assert.equal(fetches, before, "a refusal costs no transfer");

    const file = join(tmp(), "robot.glb");
    await downloadTaskAssets(t, file, IMAGE_TO_3D);
    await downloadTaskAssets(t, file, IMAGE_TO_3D);
    assert.ok(existsSync(file.replace(/\.glb$/, "_meta.json")));
  } finally {
    restore();
  }
});

test("a task without assets is an error", async () => {
  await assert.rejects(() => downloadTaskAssets(task({ id: "empty", type: "image-to-3d" }), join(tmp(), "out"), IMAGE_TO_3D), /no downloadable assets/);
});

test("analyze-printability: the report is the JSON file, in a directory or under a .json path; other extensions are refused", async () => {
  const printability = { status: "warning", issue_count: 2, metrics: { is_watertight: true, holes: 0 } };
  const t = task({ id: "analyze-1", type: "print-analyze", printability });
  const dir = tmp();
  const file = await downloadTaskAssets(t, join(dir, "report.json"), ANALYZE);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")), printability);
  assert.match(file.metadataPath, /report_meta\.json$/);
  const inDir = await downloadTaskAssets(t, join(dir, "analysis"), ANALYZE);
  assert.deepEqual(readdirSync(join(dir, "analysis")).sort(), ["meta.json", "printability.json"]);
  assert.equal((JSON.parse(readFileSync(inDir.metadataPath, "utf8")) as { task: { printability: { status: string } } }).task.printability.status, "warning");
  await assert.rejects(() => downloadTaskAssets(t, join(dir, "report.txt"), ANALYZE), /does not name exactly one file/);
});
