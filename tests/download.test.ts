/**
 * Tests for artifact enumeration, extension reconciliation, and the
 * file/directory routing in downloadArtifacts. Network is mocked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  downloadArtifacts,
  enumerateArtifacts,
  looksLikeFile,
} from "../src/internal/download.js";
import type { Task } from "../src/client/types.js";

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

test("looksLikeFile — detects extensions", () => {
  assert.equal(looksLikeFile("foo.jpg"), true);
  assert.equal(looksLikeFile("foo/bar.glb"), true);
  assert.equal(looksLikeFile("foo"), false);
  assert.equal(looksLikeFile("character/front"), false);
  assert.equal(looksLikeFile("out/"), false);
});

test("enumerateArtifacts — 2D image_urls", () => {
  const arts = enumerateArtifacts(
    task({
      image_urls: ["https://example.com/a.png", "https://example.com/b.png"],
    }),
  );
  assert.equal(arts.length, 2);
  assert.deepEqual(arts.map((a) => a.key), ["image_0", "image_1"]);
});

test("enumerateArtifacts — 3D model_urls + thumbnail + textures", () => {
  const arts = enumerateArtifacts(
    task({
      model_urls: {
        glb: "https://example.com/m.glb",
        fbx: "https://example.com/m.fbx",
        mtl: null,
      },
      thumbnail_url: "https://example.com/t.png",
      texture_urls: [
        { base_color: "https://example.com/bc.png", metallic: null, normal: "https://example.com/n.png" },
      ],
    }),
  );
  const keys = arts.map((a) => a.key).sort();
  assert.deepEqual(keys, [
    "model_fbx",
    "model_glb",
    "texture_0_base_color",
    "texture_0_normal",
    "thumbnail",
  ]);
});

test("enumerateArtifacts — animate-style result.*_url", () => {
  const arts = enumerateArtifacts(
    task({
      result: {
        animation_glb_url: "https://example.com/a.glb",
        animation_fbx_url: "https://example.com/a.fbx",
        empty_url: "",
      },
    }),
  );
  const keys = arts.map((a) => a.key).sort();
  assert.deepEqual(keys, ["animation_fbx_url", "animation_glb_url"]);
});

test("downloadArtifacts — single 2D file, content-type matches user ext, no conversion", async () => {
  const url = "https://cdn.example.com/img_0";
  const png = await tinyPngBytes();
  const restore = installFetch({
    [url]: { body: png, contentType: "image/png" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    const { savedFiles, metadataPath } = await downloadArtifacts(
      task({ id: "t1", type: "text-to-image", image_urls: [url] }),
      join(dir, "character", "front.png"),
      "text-to-image",
    );
    assert.equal(savedFiles.length, 1);
    assert.match(savedFiles[0]!, /character\/front\.png$/);
    const bytes = readFileSync(savedFiles[0]!);
    assert.ok(bytes.equals(png), "PNG bytes passed through unchanged");
    // Meta is named after the file stem, not a generic meta.json.
    assert.match(metadataPath, /character\/front_meta\.json$/);
    assert.ok(existsSync(metadataPath));
  } finally {
    restore();
  }
});

test("downloadArtifacts — two single-file outputs in one directory don't collide", async () => {
  const url1 = "https://cdn.example.com/a";
  const url2 = "https://cdn.example.com/b";
  const png = await tinyPngBytes();
  const restore = installFetch({
    [url1]: { body: png, contentType: "image/png" },
    [url2]: { body: png, contentType: "image/png" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    const r1 = await downloadArtifacts(
      task({ id: "t1", type: "text-to-image", image_urls: [url1] }),
      join(dir, "a.png"),
      "text-to-image",
    );
    // Second call into the same directory with a different filename must not
    // trip the overwrite guard — per-file meta keeps them independent.
    const r2 = await downloadArtifacts(
      task({ id: "t2", type: "text-to-image", image_urls: [url2] }),
      join(dir, "b.png"),
      "text-to-image",
    );
    assert.match(r1.metadataPath, /a_meta\.json$/);
    assert.match(r2.metadataPath, /b_meta\.json$/);
    assert.notEqual(r1.metadataPath, r2.metadataPath);
  } finally {
    restore();
  }
});

test("downloadArtifacts — converts PNG → JPEG when user requests .jpeg", async () => {
  const url = "https://cdn.example.com/img_0";
  const png = await tinyPngBytes();
  const restore = installFetch({
    [url]: { body: png, contentType: "image/png" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    const { savedFiles } = await downloadArtifacts(
      task({ id: "t1", type: "text-to-image", image_urls: [url] }),
      join(dir, "character", "front.jpeg"),
      "text-to-image",
    );
    assert.equal(savedFiles.length, 1);
    assert.match(savedFiles[0]!, /character\/front\.jpeg$/, "file keeps the .jpeg extension");
    const bytes = readFileSync(savedFiles[0]!);
    // JPEG magic: 0xFF 0xD8 0xFF
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.equal(bytes[2], 0xff);
  } finally {
    restore();
  }
});

test("downloadArtifacts — converts PNG → WebP when user requests .webp", async () => {
  const url = "https://cdn.example.com/img_0";
  const restore = installFetch({
    [url]: { body: await tinyPngBytes(), contentType: "image/png" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    const { savedFiles } = await downloadArtifacts(
      task({ id: "t1", type: "text-to-image", image_urls: [url] }),
      join(dir, "out", "front.webp"),
      "text-to-image",
    );
    const bytes = readFileSync(savedFiles[0]!);
    // WebP magic: "RIFF" .... "WEBP"
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
  } finally {
    restore();
  }
});

test("downloadArtifacts — non-convertible mismatch falls back to correct extension", async () => {
  const url = "https://cdn.example.com/m.raw";
  const restore = installFetch({
    [url]: { body: "GLB", contentType: "model/gltf-binary" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    // User asks for .png but the server returns a 3D binary — sharp can't
    // transcode glb → png, so we save as the true .glb and warn.
    const { savedFiles } = await downloadArtifacts(
      task({ id: "t1", type: "text-to-image", image_urls: [url] }),
      join(dir, "out", "thing.png"),
      "text-to-image",
    );
    assert.match(savedFiles[0]!, /out\/thing\.glb$/);
  } finally {
    restore();
  }
});

test("downloadArtifacts — multi-file 3D fans out into a directory", async () => {
  const urls = {
    glb: "https://cdn.example.com/model.glb",
    fbx: "https://cdn.example.com/model.fbx",
    thumb: "https://cdn.example.com/thumb.png",
  };
  const restore = installFetch({
    [urls.glb]: { body: "GLB", contentType: "model/gltf-binary" },
    [urls.fbx]: { body: "FBX", contentType: "application/octet-stream" },
    [urls.thumb]: { body: "THUMB", contentType: "image/png" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    const outDir = join(dir, "robot");
    const { savedFiles, metadataPath } = await downloadArtifacts(
      task({
        id: "t2",
        type: "image-to-3d",
        model_urls: { glb: urls.glb, fbx: urls.fbx },
        thumbnail_url: urls.thumb,
      }),
      outDir,
      "image-to-3d",
    );
    const names = readdirSync(outDir).sort();
    assert.deepEqual(names, ["meta.json", "model.fbx", "model.glb", "thumbnail.png"]);
    assert.equal(savedFiles.length, 3);
    assert.ok(existsSync(metadataPath));
  } finally {
    restore();
  }
});

test("downloadArtifacts — refuses a file-looking path when task has multiple artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
  await assert.rejects(
    () =>
      downloadArtifacts(
        task({
          id: "t3",
          type: "image-to-3d",
          model_urls: { glb: "https://cdn.example.com/m.glb" },
          thumbnail_url: "https://cdn.example.com/t.png",
        }),
        join(dir, "robot.glb"),
        "image-to-3d",
      ),
    /Pass a directory path/,
  );
});

test("downloadArtifacts — 2D image with no extension hint gets content-type extension", async () => {
  const url = "https://cdn.example.com/a";
  const png = await tinyPngBytes();
  const restore = installFetch({ [url]: { body: png, contentType: "image/png" } });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    // Passing a directory — the image_0 filename has no extension, so the
    // downloader must append .png from the content-type.
    const { savedFiles } = await downloadArtifacts(
      task({ id: "t4", type: "text-to-image", image_urls: [url] }),
      join(dir, "out"),
      "text-to-image",
    );
    assert.equal(savedFiles.length, 1);
    assert.match(savedFiles[0]!, /out\/image_0\.png$/);
  } finally {
    restore();
  }
});

test("downloadArtifacts — refuses to overwrite existing output files", async () => {
  const url = "https://cdn.example.com/img_0";
  const png = await tinyPngBytes();
  const restore = installFetch({
    [url]: { body: png, contentType: "image/png" },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
    const out = join(dir, "already", "there.png");
    // First run succeeds.
    await downloadArtifacts(
      task({ id: "t1", type: "text-to-image", image_urls: [url] }),
      out,
      "text-to-image",
    );
    // Second run with the same path aborts before hitting the network.
    await assert.rejects(
      () =>
        downloadArtifacts(
          task({ id: "t2", type: "text-to-image", image_urls: [url] }),
          out,
          "text-to-image",
        ),
      /refusing to overwrite existing file/,
    );
  } finally {
    restore();
  }
});

test("downloadArtifacts — throws when task has no artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
  await assert.rejects(
    () => downloadArtifacts(task({ id: "empty", type: "balance" }), join(dir, "out"), "balance"),
    /no downloadable artifacts/,
  );
});

test("downloadArtifacts — analyze-printability writes report.json in single-file mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
  const out = join(dir, "report.json");
  const t = task({
    id: "analyze-1",
    type: "print-analyze",
    printability: {
      status: "warning",
      issue_count: 2,
      warning_count: 2,
      error_count: 0,
      metrics: { is_watertight: true, holes: 0 },
    },
  });
  const { savedFiles, metadataPath } = await downloadArtifacts(t, out, "analyze-printability");
  assert.deepEqual(savedFiles, []);
  assert.equal(metadataPath, out);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.resource, "analyze-printability");
  assert.equal(written.task.printability.status, "warning");
});

test("downloadArtifacts — analyze-printability writes meta.json in directory mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
  const outDir = join(dir, "analysis");
  const t = task({
    id: "analyze-2",
    type: "print-analyze",
    printability: { status: "healthy", issue_count: 0 },
  });
  const { savedFiles, metadataPath } = await downloadArtifacts(t, outDir, "analyze-printability");
  assert.deepEqual(savedFiles, []);
  assert.match(metadataPath, /analysis\/meta\.json$/);
  const written = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(written.task.printability.status, "healthy");
});

test("downloadArtifacts — analyze-printability rejects non-json single-file extensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshy-dl-"));
  const t = task({
    id: "analyze-3",
    type: "print-analyze",
    printability: { status: "healthy" },
  });
  await assert.rejects(
    () => downloadArtifacts(t, join(dir, "report.txt"), "analyze-printability"),
    /produces a JSON report/,
  );
});
