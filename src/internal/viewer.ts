/**
 * The local model viewer behind `meshy view` (D-094).
 *
 * One read-only HTTP server on 127.0.0.1 shows one model: `/` is the viewer
 * page, `/model.glb` (or `/model.gltf`) the file, `/env.hdr` the lighting
 * environment shipped in the package, and for a .gltf the files beside it
 * that it may reference (buffers, textures). Nothing else on disk is
 * reachable, and the model never leaves this machine.
 *
 * The page is a few lines of three.js (pinned, SRI-checked, from jsDelivr)
 * with a neutral studio look: Neutral tone mapping, a studio environment, a
 * key light and fills, a soft ground shadow and a dark radial backdrop.
 */

import { createReadStream, closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./errors.js";

const CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0";
/** The jsDelivr files the page loads (its imports and theirs), with SRI hashes the import map checks. */
const MODULES: Record<string, string> = {
  "/build/three.module.min.js": "sha384-IDC7sAMAIMB/TZ6dgKKPPAKZ2bXXXP8+FBMBC8cU319eBhKITx+PaalhfDkDNH28",
  "/examples/jsm/controls/OrbitControls.js": "sha384-aJoe4qqS/DgF2jh9njAuvA6QIveJYoCuYOfYjdFY8P3eawzmc9bEQ40jq2TvOyuP",
  "/examples/jsm/loaders/GLTFLoader.js": "sha384-Lq1Wl94so5JCKGDvezrdVMJhdeKQkwb8iwRo59QrPPd61CnrCJZLxYmFlQ8ZuOKR",
  "/examples/jsm/loaders/RGBELoader.js": "sha384-df8Ij6+muzecLENB3U9Z40GSfTjNV/TbniF7LQdZiYn4nHS5Javsoo5xFTWG0EJE",
  "/examples/jsm/utils/BufferGeometryUtils.js": "sha384-wOjwauvHlJO7K6APr7FmMGH2nupQa3Ndzas9bJZhsAMOK055efJud8ns4aYmASKv",
};
/** Studio environment (Poly Haven "Decor Shop", CC0, 512×256, desaturated), shipped in the package. */
const ENV_FILE = fileURLToPath(new URL("../../assets/viewer-env.hdr", import.meta.url));

/** The server stops after this long without a request. */
export const VIEW_IDLE_MS = 30 * 60 * 1000;

const MODEL_TYPES: Record<string, string> = { ".glb": "model/gltf-binary", ".gltf": "model/gltf+json" };
/** What a .gltf may reference beside it. */
const SIDE_TYPES: Record<string, string> = {
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
};

export interface ViewModel {
  path: string;
  ext: ".glb" | ".gltf";
  bytes: number;
}

/** Resolve and check the model: an existing .glb (with the glTF magic) or .gltf file. */
export function resolveViewModel(input: string): ViewModel {
  let path: string;
  try {
    path = realpathSync(input);
  } catch {
    throw new UsageError(`model not found: ${input}`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) throw new UsageError(`not a file: ${input}`);
  const ext = extname(path).toLowerCase();
  if (ext !== ".glb" && ext !== ".gltf") throw new UsageError(`meshy view shows .glb and .gltf models (got '${extname(path) || basename(path)}'); convert other formats first`);
  if (ext === ".glb") {
    const head = Buffer.alloc(4);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    if (head.toString("latin1") !== "glTF") throw new UsageError(`${basename(path)} is not a binary glTF file`);
  }
  return { path, ext, bytes: stat.size };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function viewerPage(model: ViewModel): string {
  const title = escapeHtml(basename(model.path));
  const jsTitle = JSON.stringify(basename(model.path)).replace(/</g, "\\u003c");
  const imports = { three: `${CDN}/build/three.module.min.js`, "three/addons/": `${CDN}/examples/jsm/` };
  const integrity = Object.fromEntries(Object.entries(MODULES).map(([path, hash]) => [`${CDN}${path}`, hash]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;color:#a1a1aa;font:13px/1.4 system-ui,sans-serif;
background:radial-gradient(circle closest-side,#34373c 0,#303338 25%,#27292d 50%,#1e1f20 75%,#191919 100%) #191919}
canvas{display:block;filter:saturate(.92)}
#note{position:fixed;left:12px;bottom:10px;pointer-events:none}
</style>
<script type="importmap">${JSON.stringify({ imports, integrity })}</script>
<script>setTimeout(() => { const n = document.getElementById("note"); if (n.textContent.endsWith("loading…")) n.textContent += " (the viewer loads three.js from cdn.jsdelivr.net)"; }, 15000);</script>
</head><body><div id="note">${title} · loading…</div>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
const note = document.getElementById("note");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.environmentIntensity = 1;
scene.environmentRotation.y = THREE.MathUtils.degToRad(159);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
const clock = new THREE.Clock();
let mixer;
new RGBELoader().load("/env.hdr", (t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.environment = t; });
new GLTFLoader().load("/model${model.ext}", (gltf) => {
  const root = gltf.scene;
  // A file without materials (an untextured preview) would get glTF's default: white, fully metallic. Show it as matte clay.
  const clay = !gltf.parser.json.materials?.length;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // glTF asks the viewer to compute normals a file leaves out; smooth ones suit a sculpted mesh.
    if (!o.geometry.attributes.normal) { o.geometry = o.geometry.index ? o.geometry : mergeVertices(o.geometry); o.geometry.computeVertexNormals(); }
    if (clay) o.material = new THREE.MeshStandardMaterial({ color: 0xd4d4d4, roughness: 0.7, metalness: 0, vertexColors: !!o.geometry.attributes.color });
  });
  const box = new THREE.Box3().setFromObject(root);
  root.position.sub(box.getCenter(new THREE.Vector3()));
  scene.add(root);
  const size = box.getSize(new THREE.Vector3()), r = size.length() / 2, floor = -size.y / 2 - 0.015 * r;
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  const spot = new THREE.SpotLight(0xffffff, 1.5, 0, 0.6, 1, 0);
  spot.position.set(r, 2 * r, r);
  const point = new THREE.PointLight(0xffffff, 1, 0, 0);
  point.position.set(-2 * r, -0.5 * r, -2 * r);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-1.75, 15, 7).setLength(4 * r);
  key.castShadow = true;
  key.shadow.intensity = 0.45;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  Object.assign(key.shadow.camera, { left: -2 * r, right: 2 * r, top: 2 * r, bottom: -2 * r, near: 0.01, far: 10 * r });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.37 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floor;
  ground.scale.setScalar(Math.max(2.4 * Math.max(size.x, size.z), 3 * r));
  ground.receiveShadow = true;
  scene.add(spot, point, key, ground);
  const fit = (1.4 * Math.max(size.x, size.y, size.z)) / (2 * Math.tan(THREE.MathUtils.degToRad(35) / 2));
  camera.position.set(3, 3, 10).setLength(fit);
  camera.near = fit / 100;
  camera.far = fit * 100;
  controls.minDistance = 0.1 * fit;
  controls.maxDistance = 10 * fit;
  controls.update();
  if (gltf.animations.length) { mixer = new THREE.AnimationMixer(root); mixer.clipAction(gltf.animations[0]).play(); }
  note.textContent = ${jsTitle};
  resize();
}, undefined, () => { note.textContent = "Could not load the model."; });
function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener("resize", resize);
resize();
renderer.setAnimationLoop(() => { mixer?.update(clock.getDelta()); controls.update(); renderer.render(scene, camera); });
</script></body></html>
`;
}

export interface RunningViewer {
  url: string;
  /** Resolves when the server has stopped (idle timeout or close()). */
  closed: Promise<void>;
  close(): void;
}

function send(res: ServerResponse, status: number, type?: string, body?: string | Buffer): void {
  res.writeHead(status, { "Cache-Control": "no-store", ...(type ? { "Content-Type": type } : {}) });
  res.end(body);
}

/** Start serving `model` on a free port of 127.0.0.1. */
export function startViewer(model: ViewModel): Promise<RunningViewer> {
  const dir = dirname(model.path);
  const page = viewerPage(model);
  let timer: NodeJS.Timeout | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    arm();
    const port = (server.address() as { port: number }).port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 403);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405);
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      return send(res, 400);
    }
    if (pathname === "/") return send(res, 200, "text/html; charset=utf-8", req.method === "HEAD" ? undefined : page);

    let file: string | undefined;
    let type: string | undefined;
    if (pathname === `/model${model.ext}`) {
      file = model.path;
      type = MODEL_TYPES[model.ext];
    } else if (pathname === "/env.hdr") {
      file = ENV_FILE;
      type = "image/vnd.radiance";
    } else if (model.ext === ".gltf") {
      type = SIDE_TYPES[extname(pathname).toLowerCase()];
      try {
        const real = type ? realpathSync(resolvePath(dir, `.${pathname}`)) : undefined;
        if (real?.startsWith(dir + sep) && statSync(real).isFile()) file = real;
      } catch {
        file = undefined;
      }
    }
    const size = file ? statSync(file, { throwIfNoEntry: false })?.size : undefined;
    if (!file || !type || size === undefined) return send(res, 404);
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": type, "Content-Length": size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  server.on("close", () => {
    if (timer) clearTimeout(timer);
    resolveClosed();
  });
  const close = (): void => {
    server.close();
    server.closeAllConnections();
  };
  function arm(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(close, VIEW_IDLE_MS);
  }

  return new Promise((resolve, reject) => {
    server.once("error", (err) => reject(new UsageError(`cannot start the viewer server: ${(err as Error).message}`)));
    server.listen(0, "127.0.0.1", () => {
      arm();
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/`, closed, close });
    });
  });
}
