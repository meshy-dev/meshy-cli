/**
 * Tests for the file-input resolver (local path → data URI, URL preflight)
 * covering both image and 3D-model inputs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { resolveImageFields, resolveModelFields } from "../src/internal/file-input.js";

function installFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

test("resolveImageFields — local PNG becomes a data:image/png URI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-img-"));
  const path = join(dir, "ref.png");
  writeFileSync(path, await tinyPng());

  const opts: Record<string, unknown> = { imageUrl: path };
  await resolveImageFields(opts);
  assert.match(opts.imageUrl as string, /^data:image\/png;base64,/);
});

test("resolveImageFields — relative path resolves against cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-img-"));
  const path = join(dir, "img.png");
  writeFileSync(path, await tinyPng());

  const saved = process.cwd();
  process.chdir(dir);
  try {
    const opts: Record<string, unknown> = { imageUrl: "img.png" };
    await resolveImageFields(opts);
    assert.match(opts.imageUrl as string, /^data:image\/png;base64,/);
  } finally {
    process.chdir(saved);
  }
});

test("resolveImageFields — JPEG file is detected via magic bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-img-"));
  const path = join(dir, "photo.jpg");
  const jpeg = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).jpeg().toBuffer();
  writeFileSync(path, jpeg);

  const opts: Record<string, unknown> = { imageUrl: path };
  await resolveImageFields(opts);
  assert.match(opts.imageUrl as string, /^data:image\/jpeg;base64,/);
});

test("resolveImageFields — missing file fails fast with flag name in error", async () => {
  const opts = { imageUrl: "/nonexistent/path/to/image.png" };
  await assert.rejects(
    () => resolveImageFields(opts),
    /--image-url: file not found/,
  );
});

test("resolveImageFields — directory path rejected as non-regular file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-img-"));
  const opts = { imageUrl: dir };
  await assert.rejects(
    () => resolveImageFields(opts),
    /not a regular file/,
  );
});

test("resolveImageFields — URL preflighted with HEAD, accepted on 2xx", async () => {
  const calls: { url: string; method: string }[] = [];
  const restore = installFetch((url, init) => {
    calls.push({ url, method: init.method ?? "GET" });
    return new Response(null, { status: 200 });
  });
  try {
    const opts = { imageUrl: "https://example.com/ref.png" };
    await resolveImageFields(opts);
    assert.equal(opts.imageUrl, "https://example.com/ref.png");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "HEAD");
  } finally {
    restore();
  }
});

test("resolveImageFields — URL returning 404 fails fast", async () => {
  const restore = installFetch(() => new Response(null, { status: 404, statusText: "Not Found" }));
  try {
    await assert.rejects(
      () => resolveImageFields({ imageUrl: "https://example.com/missing.png" }),
      /--image-url: https:\/\/example\.com\/missing\.png returned 404/,
    );
  } finally {
    restore();
  }
});

test("resolveImageFields — network error surfaced with flag context", async () => {
  const restore = installFetch(() => { throw new Error("ENOTFOUND"); });
  try {
    await assert.rejects(
      () => resolveImageFields({ imageUrl: "https://nope.invalid/x.png" }),
      /--image-url: cannot reach.*ENOTFOUND/,
    );
  } finally {
    restore();
  }
});

test("resolveImageFields — list flag expands each entry (mix of local + URL)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-img-"));
  const localPath = join(dir, "a.png");
  writeFileSync(localPath, await tinyPng());

  const restore = installFetch(() => new Response(null, { status: 200 }));
  try {
    const opts = {
      referenceImageUrls: [localPath, "https://example.com/b.png"],
    };
    await resolveImageFields(opts);
    const urls = opts.referenceImageUrls as string[];
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /^data:image\/png;base64,/);
    assert.equal(urls[1], "https://example.com/b.png");
  } finally {
    restore();
  }
});

test("resolveImageFields — retexture's multi-view list resolves local paths too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-img-"));
  const front = join(dir, "front.png");
  writeFileSync(front, await tinyPng());

  const restore = installFetch(() => new Response(null, { status: 200 }));
  try {
    const opts = { multiviewImageUrls: [front, "https://example.com/back.png"] };
    await resolveImageFields(opts);
    const urls = opts.multiviewImageUrls as string[];
    assert.match(urls[0]!, /^data:image\/png;base64,/);
    assert.equal(urls[1], "https://example.com/back.png");
  } finally {
    restore();
  }
});

test("resolveImageFields — data: URIs rejected with helpful message", async () => {
  await assert.rejects(
    () => resolveImageFields({ imageUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    /data: URIs aren't accepted on the command line/,
  );
});

test("resolveImageFields — fields that aren't image inputs are ignored", async () => {
  const opts = { prompt: "hello", aiModel: "nano-banana", imageUrl: undefined };
  await resolveImageFields(opts);
  assert.equal(opts.prompt, "hello");
  assert.equal(opts.aiModel, "nano-banana");
});

// ---------- 3D-model inputs ----------

/** Minimal valid GLB: 12-byte header only. Good enough for MIME detection. */
function fakeGlb(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write("glTF", 0, "ascii");          // magic
  buf.writeUInt32LE(2, 4);                // version
  buf.writeUInt32LE(12, 8);               // total length
  return buf;
}

function fakeFbxBinary(): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("Kaydara FBX Binary", 0, "ascii");
  return buf;
}

test("resolveModelFields — local .glb detected via magic bytes → model/gltf-binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-mdl-"));
  const path = join(dir, "weird-name.bin"); // extension is wrong — magic should win
  writeFileSync(path, fakeGlb());

  const opts: Record<string, unknown> = { modelUrl: path };
  await resolveModelFields(opts);
  assert.match(opts.modelUrl as string, /^data:model\/gltf-binary;base64,/);
});

test("resolveModelFields — local binary FBX detected by signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-mdl-"));
  const path = join(dir, "char.fbx");
  writeFileSync(path, fakeFbxBinary());

  const opts: Record<string, unknown> = { modelUrl: path };
  await resolveModelFields(opts);
  assert.match(opts.modelUrl as string, /^data:application\/octet-stream;base64,/);
});

test("resolveModelFields — falls back to extension for text formats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-mdl-"));
  const path = join(dir, "scene.obj");
  writeFileSync(path, "# OBJ file\nv 0 0 0\n", "utf8");

  const opts: Record<string, unknown> = { modelUrl: path };
  await resolveModelFields(opts);
  assert.match(opts.modelUrl as string, /^data:model\/obj;base64,/);
});

test("resolveModelFields — unknown extension rejected with clear error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-mdl-"));
  const path = join(dir, "mystery.xyz");
  writeFileSync(path, "random bytes", "utf8");

  await assert.rejects(
    () => resolveModelFields({ modelUrl: path }),
    /could not detect 3d model MIME type/,
  );
});

test("resolveModelFields — missing file fails fast", async () => {
  await assert.rejects(
    () => resolveModelFields({ modelUrl: "/nonexistent/model.glb" }),
    /--model-url: file not found/,
  );
});

test("resolveModelFields — URL preflighted, passed through on 2xx", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${input}`);
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const opts = { modelUrl: "https://example.com/model.glb" };
    await resolveModelFields(opts);
    assert.equal(opts.modelUrl, "https://example.com/model.glb");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /^HEAD https:\/\/example\.com\/model\.glb$/);
  } finally {
    globalThis.fetch = original;
  }
});

test("resolveModelFields — data: URIs rejected", async () => {
  await assert.rejects(
    () => resolveModelFields({ modelUrl: "data:model/gltf-binary;base64,Z2xURg==" }),
    /data: URIs aren't accepted on the command line/,
  );
});
