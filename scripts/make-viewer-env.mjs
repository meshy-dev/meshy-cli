// Builds assets/viewer-env.hdr, the lighting environment `meshy view` ships.
//
//   node scripts/make-viewer-env.mjs decor_shop_1k.hdr
//
// Source: Poly Haven "Decor Shop" (CC0), the 1k Radiance .hdr from
// https://polyhaven.com/a/decor_shop. It is halved to 512×256 (2×2 box filter;
// the viewer only lights with it, the background is hidden) and its saturation
// lowered by 45% for a neutral studio light. Written flat
// (no run-length encoding), which every Radiance reader accepts.
import { readFileSync, writeFileSync } from "node:fs";

const SATURATION = 0.55;
const src = readFileSync(process.argv[2]);

// Header: lines up to a blank one, then the resolution line.
let pos = 0;
const line = () => {
  const end = src.indexOf(0x0a, pos);
  const text = src.subarray(pos, end).toString("latin1");
  pos = end + 1;
  return text;
};
if (!line().startsWith("#?")) throw new Error("not a Radiance file");
while (line() !== "");
const [, height, , width] = line().split(" ").map((v, i) => (i % 2 ? Number(v) : v));

// Scanlines (new-style RLE), decoded to linear RGB floats.
const rgb = new Float32Array(width * height * 3);
const scan = new Uint8Array(width * 4);
for (let y = 0; y < height; y++) {
  if (src[pos] !== 2 || src[pos + 1] !== 2) throw new Error("expected run-length encoded scanlines");
  pos += 4;
  for (let c = 0; c < 4; c++) {
    for (let x = 0; x < width; ) {
      let n = src[pos++];
      if (n > 128) {
        n -= 128;
        scan.fill(src[pos++], c * width + x, c * width + x + n);
      } else {
        scan.set(src.subarray(pos, pos + n), c * width + x);
        pos += n;
      }
      x += n;
    }
  }
  for (let x = 0; x < width; x++) {
    const e = scan[3 * width + x];
    const f = e ? 2 ** (e - 136) : 0;
    for (let c = 0; c < 3; c++) rgb[(y * width + x) * 3 + c] = scan[c * width + x] * f;
  }
}

// Halve, desaturate, encode RGBE.
const w = width / 2, h = height / 2;
const out = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const px = [0, 0, 0];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      for (let c = 0; c < 3; c++) px[c] += rgb[((2 * y + dy) * width + 2 * x + dx) * 3 + c] / 4;
    }
    const lum = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
    const v = px.map((p) => lum + (p - lum) * SATURATION);
    const max = Math.max(...v);
    const i = (y * w + x) * 4;
    if (max < 1e-32) continue;
    const e = Math.ceil(Math.log2(max) + 1e-9);
    const scale = 256 / 2 ** e;
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.floor(v[c] * scale));
    out[i + 3] = e + 128;
  }
}
const header = `#?RADIANCE\n# Poly Haven "Decor Shop" (CC0), 512x256, saturation x${SATURATION}\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`;
writeFileSync(new URL("../assets/viewer-env.hdr", import.meta.url), Buffer.concat([Buffer.from(header, "latin1"), out]));
console.log(`assets/viewer-env.hdr: ${w}x${h}`);
