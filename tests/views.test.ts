/**
 * The human views behind `--format pretty` (src/internal/views.ts). They are
 * not a contract, but they must: read the same in both schemas, never print a
 * signed URL, never call an unknown credit count 0, and hand the person a
 * command that actually runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { forHumans, formatDuration, renderView, relativeTime, shortUrl } from "../src/internal/views.js";
import { painted, plain } from "../src/internal/color.js";
import { okEnvelope } from "../src/internal/result.js";
import { toTaskView } from "../src/internal/task-view.js";

const SIGNED = "https://assets.meshy.ai/u/tasks/abc/output/model.glb?Expires=4943635200&Signature=" + "x".repeat(300);
const TEX = (name: string) => `https://assets.meshy.ai/u/tasks/abc/output/${name}.png?Signature=${"y".repeat(200)}`;

/** A text-to-3d refine as the API returns it (no started_at / consumed_credits, like the legacy summary). */
const RAW = {
  id: "01a0c94d-eaba-710e-b5b7-da5b2f620c95",
  type: "text-to-3d-refine",
  status: "SUCCEEDED",
  progress: 100,
  created_at: 1_790_083_721_925,
  finished_at: 1_790_084_057_634,
  model_urls: { glb: SIGNED, fbx: SIGNED, usdz: null },
  texture_urls: [{ base_color: TEX("t0"), metallic: TEX("t0m"), normal: TEX("t0n"), roughness: TEX("t0r") }],
  thumbnail_url: TEX("preview"),
};

const LEGACY = { resource: "text-to-3d", ...RAW, elapsed_seconds: 336.19 };
const V1 = okEnvelope("text-to-3d.wait", {
  task: toTaskView(RAW, { descriptor: { id: "text-to-3d", legacyEndpoint: "/openapi/v2/text-to-3d" } as never }),
  submission: { state: "accepted", operation_id: null },
  downloads: { state: "not_requested", files: [], metadata_path: null },
  saved_json: null,
  wait: { timed_out: false, elapsed_seconds: 336.19, polls: 12 },
});

test("task card: status, id, time, assets — and no URL anywhere", () => {
  const out = renderView("text-to-3d.wait", LEGACY, plain);
  assert.match(out, /^✓ SUCCEEDED  text-to-3d-refine$/m);
  assert.match(out, /^Task {5}01a0c94d-eaba-710e-b5b7-da5b2f620c95$/m);
  assert.match(out, /^Took {5}5m 36s$/m, "server timestamps, not the time spent waiting");
  assert.match(out, /^Assets {3}glb, fbx · textures: base_color, metallic, normal, roughness · thumbnail$/m);
  assert.doesNotMatch(out, /Signature|https:\/\/assets/, "signed URLs are --json only");
  assert.doesNotMatch(out, /^Credits/m, "an unknown credit count is not shown as 0");
});

test("legacy summary and v1 envelope read the same", () => {
  assert.equal(renderView("text-to-3d.wait", V1, plain), renderView("text-to-3d.wait", LEGACY, plain));
});

test("a known credit count is shown, a failed task carries its error", () => {
  const out = renderView("text-to-3d.get", { ...LEGACY, status: "FAILED", consumed_credits: 0, task_error: { message: "prompt rejected" } }, plain);
  assert.match(out, /^✗ FAILED/m);
  assert.match(out, /^Credits  0$/m, "0 reported by the server is a real 0");
  assert.match(out, /^Error {4}prompt rejected$/m);
  assert.doesNotMatch(out, /tip:/, "no download tip for a task with nothing to download");
});

test("make: the tip is a runnable download command with the full id and a directory named after the prompt", () => {
  const out = renderView("make", LEGACY, plain, { name: "a lovely baby husky", estimatedCredits: 30, totalSeconds: 423 });
  assert.match(out, /^Took {5}7m 03s$/m, "the whole chain, not the last step");
  assert.match(out, /^Credits  ~30 \(estimate for the whole chain\)$/m);
  assert.match(
    out,
    /^tip: download it now: {2}meshy download --resource text-to-3d --task-id 01a0c94d-eaba-710e-b5b7-da5b2f620c95 --all --output-dir \.\/a-lovely-baby-husky$/m,
  );
  assert.match(out, /^ {5}or add -o <dir> to make to save files automatically$/m);
});

test("saved files replace the tip", () => {
  const withFiles = {
    ...V1,
    result: { ...(V1.result as object), downloads: { state: "completed", files: [{ key: "model_glb", path: "/tmp/husky/model.glb", status: "written" }], metadata_path: "/tmp/husky/meta.json" } },
  };
  const out = renderView("text-to-3d.wait", withFiles, plain);
  assert.match(out, /^Saved {4}\/tmp\/husky\/model\.glb$/m);
  assert.doesNotMatch(out, /tip:/);
});

test("--async create and make: the id and what to run next", () => {
  assert.equal(
    renderView("text-to-3d.create", { resource: "text-to-3d", task_id: "t-1", status: "PENDING", hint: "meshy-cli text-to-3d wait t-1" }, plain),
    "\n⧗ Submitted  t-1\nnext: meshy text-to-3d wait t-1",
    "create/wait/stream/make start one line below their stderr progress",
  );
  assert.ok(!renderView("text-to-3d.get", LEGACY, plain).startsWith("\n"), "get shows no progress, so no gap");
  const make = renderView("make", { command: "make", route: "text", submitted: "preview", task_id: "t-1", status: null, pending_steps: [{ command: "meshy text-to-3d create --mode refine --preview-task-id t-1" }], hint: "meshy text-to-3d wait t-1" }, plain);
  assert.match(make, /^⧗ Submitted step 1 {2}t-1$/m);
  assert.match(make, /^then: meshy text-to-3d create --mode refine --preview-task-id t-1$/m);
});

test("list: a table with the full id, both schemas; an empty non-task list is not 'No tasks'", () => {
  const legacy = renderView("text-to-3d.list", [LEGACY, { ...LEGACY, id: "t-2", status: "IN_PROGRESS", progress: 42 }], plain);
  const lines = legacy.split("\n");
  assert.match(lines[0]!, /^TASK ID\s+STATUS\s+PROGRESS\s+TYPE\s+CREATED$/);
  assert.match(lines[1]!, /^01a0c94d-eaba-710e-b5b7-da5b2f620c95 {2}SUCCEEDED\s+100%/);
  assert.match(lines[2]!, /^t-2\s+IN_PROGRESS\s+42%/);
  const v1 = renderView("text-to-3d.list", okEnvelope("text-to-3d.list", { items: [V1.result!["task" as never]], count: 1, page: { page_num: 1, page_size: 1 } }), plain);
  assert.match(v1, /^01a0c94d-eaba-710e-b5b7-da5b2f620c95 {2}SUCCEEDED/m);
  assert.match(v1, /^more: --page 2$/m);
  assert.equal(renderView("text-to-3d.list", [], plain), "No tasks.");
  assert.notEqual(renderView("showcases.list", okEnvelope("showcases.list", { items: [], count: 0 }), plain), "No tasks.");
});

test("balance, delete and dry-run plans", () => {
  assert.equal(renderView("balance", { balance: 2357 }, plain), "Balance  2,357 credits");
  assert.equal(renderView("balance", okEnvelope("balance", { balance: 42, saved_json: null }), plain), "Balance  42 credits");
  assert.equal(renderView("text-to-3d.delete", { resource: "text-to-3d", task_id: "t-1", deleted: true }, plain), "✓ Deleted t-1");
  const plan = renderView("make", { command: "make", route: "text", steps: [{ step: 1, resource: "text-to-3d", action: "preview", estimated_credits: 20 }, { step: 2, resource: "text-to-3d", action: "refine", estimated_credits: 10 }], estimated_credits: 30, note: "Estimates only." }, plain);
  assert.match(plan, /^Plan {2}2 steps · ~30 credits$/m);
  assert.match(plan, /^1\. {2}text-to-3d preview {2}~20$/m);
});

test("fallback: v1 shows only the result, times are local, URLs lose their signatures", () => {
  const out = renderView("project.show", okEnvelope("project.show", { created_at: 1_790_083_721_925, url: SIGNED }), plain);
  assert.doesNotMatch(out, /schema_version|^ok:|warnings:/m, "the envelope is for machines");
  assert.match(out, /^created_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
  assert.match(out, /^url: https:\/\/assets\.meshy\.ai\/u\/tasks\/abc\/output\/model\.glb$/m);
  assert.equal(renderView(undefined, { status: "ok" }, plain), "status: ok", "no command: the plain dump");
});

test("plain painter never emits escapes; the painted one colours status words only", () => {
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(renderView("make", LEGACY, plain, { name: "x" }), /\u001b/);
  const out = renderView("text-to-3d.wait", LEGACY, painted);
  assert.match(out, /\u001b\[32mSUCCEEDED\u001b\[0m/);
});

test("formatters", () => {
  assert.equal(formatDuration(87), "1m 27s");
  assert.equal(formatDuration(9), "9s");
  assert.equal(formatDuration(3725), "1h 02m");
  assert.equal(relativeTime(1_000_000, 1_000_000 + 125_000), "2m ago");
  assert.equal(shortUrl("https://x.io/a?sig=1"), "https://x.io/a");
  assert.equal(forHumans("meshy text-to-3d wait t-1 --output-schema v1"), "meshy text-to-3d wait t-1");
  assert.equal(forHumans("meshy text-to-3d stream t-1 --format ndjson --output-schema v1"), "meshy text-to-3d stream t-1");
});

test("auth: login, status, not logged in, logout, list — no masked-token dump, balance as credits", () => {
  const login = renderView("auth.login", { status: "logged_in", kind: "oauth", profile: "default", active_profile: "default", credential: "msy_at_N…yy8A", credentials_file: "/x/credentials.json", verified: true, balance: { balance: 2327 } }, plain);
  assert.equal(login, "✓ Logged in to Meshy\nProfile  default\nBalance  2,327 credits\nSaved to /x/credentials.json");
  const unverified = renderView("auth.login", { status: "logged_in", profile: "default", verified: false, hint: "Credential stored but balance check failed — re-check with: meshy auth status" }, plain);
  assert.match(unverified, /^! Logged in, but the credential could not be verified$/m);
  assert.match(unverified, /^hint: Credential stored/m);

  const status = renderView("auth.status", { authenticated: true, source: "file", profile: "default", credential: "msy_at_N…yy8A", base_url_v1: "https://api.meshy.ai/openapi/v1", profiles: ["default", "work"], active_profile: "default", verified: true, balance: { balance: 2327 } }, plain);
  assert.equal(status, '✓ Logged in\nUsing      stored profile "default"\nBalance    2,327 credits\nCredential msy_at_N…yy8A\nProfiles   default (active), work');
  assert.match(renderView("auth.status", { authenticated: true, source: "env", credential: "msy_…", verified: false, hint: "Run: meshy auth login" }, plain), /^✗ Credential rejected\nUsing {6}MESHY_API_KEY/);
  assert.equal(renderView("auth.status", { authenticated: false, profiles: [], active_profile: null, hint: "Run: meshy auth login" }, plain), "✗ Not logged in\nhint: Run: meshy auth login");

  assert.equal(renderView("auth.logout", { status: "removed", profile: "work" }, plain), "✓ Logged out of profile work");
  assert.equal(renderView("auth.use", { status: "switched", active_profile: "work" }, plain), "✓ Switched to profile work");
  const list = renderView("auth.list", { active_profile: "default", profiles: [{ name: "default", active: true, kind: "oauth", credential: "msy_at_N…yy8A", created_at: null }] }, plain);
  assert.match(list, /^\* default {2}browser login {2}msy_at_N…yy8A {2}-$/m);
});

test("humanHint: the hint, else the recovery command, else how to resume a task the server still runs", async () => {
  const { humanHint } = await import("../src/internal/views.js");
  assert.equal(humanHint("Run: meshy auth login", "x", null), "Run: meshy auth login");
  assert.equal(humanHint(undefined, "meshy text-to-3d wait t-1 --output-schema v1", null), "meshy text-to-3d wait t-1");
  assert.equal(
    humanHint(undefined, null, { task_id: "t-1", next: { wait: "meshy text-to-3d wait t-1 --output-schema v1" } }),
    "the task keeps running on the server — resume with: meshy text-to-3d wait t-1",
  );
  assert.equal(humanHint(undefined, null, { route: "text" }), undefined);
});
