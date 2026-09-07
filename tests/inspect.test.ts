/**
 * inspect faces — verdict logic (T-080, T-081) and the command driven
 * in-process: the file source needs no credential or network, the API source
 * makes exactly one GET against a loopback mock (T-082). The dist/ subprocess
 * variant is present but skipped until root.ts registers the command.
 */

// Keep envelope rendering hermetic whatever the dev machine's update cache holds.
process.env["MESHY_CLI_NO_UPDATE_NOTIFIER"] = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInspectCommand, parseMaxFaces, readTaskJsonFile, type FacesResult } from "../src/cmd/inspect.js";
import { resetCommandContextForTests } from "../src/internal/context.js";
import { CliError, UsageError } from "../src/internal/errors.js";
import { mirrorGlobalOptionsToDescendants, registerRootGlobalOptions, walkCommands } from "../src/internal/global-options.js";
import { faceCountFromTask, judgeFaceCount, judgeTask, remeshSuggestion, type FaceVerdict } from "../src/internal/inspect.js";
import type { V1Envelope } from "../src/internal/result.js";
import { toTaskView } from "../src/internal/task-view.js";
import { jsonReply, parseSingleJson, runCli, startMockApi } from "./helpers/cli.js";

const FIXTURE_URL = new URL("./fixtures/skill-parity/task-rigging.synthetic.json", import.meta.url);
const FIXTURE_PATH = fileURLToPath(FIXTURE_URL);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Record<string, unknown>;
const FIXTURE_FACES = 250_000;

// ---------------------------------------------------------------------------
// In-process harness: a fresh command tree per run (Commander keeps option
// state on the instance), stdout captured (writeStdout needs its callback
// invoked), and the module-level command context reset afterwards.
// ---------------------------------------------------------------------------

interface InProcessRun {
  stdout: string;
  error: unknown;
}

function buildTree(cmd: Command): Command {
  const root = new Command("meshy");
  registerRootGlobalOptions(root);
  root.addCommand(cmd);
  mirrorGlobalOptionsToDescendants(root);
  walkCommands(root, (c) => {
    c.exitOverride();
    c.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  });
  return root;
}

async function runInspect(args: string[]): Promise<InProcessRun> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
    // The node test runner reports to its parent over this same stdout with
    // binary frames; only the CLI's string writes belong to the capture.
    if (typeof chunk !== "string") {
      return (original as (c: string | Uint8Array, e?: unknown, cb?: unknown) => boolean).call(process.stdout, chunk, encodingOrCb, cb);
    }
    chunks.push(chunk);
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : typeof cb === "function" ? cb : undefined;
    if (callback) (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;
  let error: unknown = null;
  try {
    await buildTree(buildInspectCommand()).parseAsync(["node", "meshy", "inspect", "faces", ...args]);
  } catch (err) {
    error = err;
  } finally {
    process.stdout.write = original;
    resetCommandContextForTests();
  }
  return { stdout: chunks.join(""), error };
}

function envelopeOf(run: InProcessRun): V1Envelope<FacesResult> {
  assert.equal(run.error, null, run.error instanceof Error ? run.error.stack : String(run.error));
  return parseSingleJson(run.stdout) as V1Envelope<FacesResult>;
}

function cliErrorOf(run: InProcessRun): CliError {
  assert.ok(run.error instanceof CliError, `expected a CliError, got ${String(run.error)}`);
  assert.equal(run.stdout, "", "a failed check prints nothing in-process; the entry point renders the envelope");
  return run.error;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meshy-inspect-"));
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Pure verdict logic
// ---------------------------------------------------------------------------

test("T-080 judgeFaceCount: limit-1 / limit / limit+1 → pass / pass / fail", () => {
  for (const limit of [300_000, 40_000, 1]) {
    assert.equal(judgeFaceCount(limit - 1, limit).verdict, limit - 1 >= 0 ? "pass" : "unknown", `${limit}-1`);
    assert.equal(judgeFaceCount(limit, limit).verdict, "pass", `${limit} == limit`);
    const over = judgeFaceCount(limit + 1, limit);
    assert.equal(over.verdict, "fail", `${limit}+1`);
    assert.equal(over.face_count, limit + 1);
    assert.match(over.reason ?? "", /exceeds the limit/);
  }
  // The fixture (250000 faces) against the three limits the black-box tests use.
  const at = (limit: number): FaceVerdict => judgeFaceCount(fixture["face_count"], limit);
  assert.deepEqual(at(300_000), { face_count: FIXTURE_FACES, limit: 300_000, comparison: "lte", verdict: "pass", reason: null });
  assert.equal(at(FIXTURE_FACES).verdict, "pass");
  assert.equal(at(FIXTURE_FACES - 1).verdict, "fail");
  // A real 0 from the server is a known count, not "unknown".
  assert.deepEqual(judgeFaceCount(0, 10), { face_count: 0, limit: 10, comparison: "lte", verdict: "pass", reason: null });
});

test("T-081 judgeFaceCount: missing/null/negative/string/NaN/float/… → unknown, never a fabricated 0", () => {
  const cases: Array<[unknown, RegExp]> = [
    [undefined, /face_count missing/],
    [null, /face_count is null/],
    [-1, /not a non-negative integer/],
    ["1234", /string, not a number/],
    ["", /string, not a number/],
    [Number.NaN, /not a finite number/],
    [Number.POSITIVE_INFINITY, /not a finite number/],
    [3.5, /not a non-negative integer/],
    [true, /not a number \(got boolean\)/],
    [{ count: 5 }, /not a number \(got object\)/],
    [[5], /not a number \(got array\)/],
  ];
  for (const [raw, reason] of cases) {
    const v = judgeFaceCount(raw, 300_000);
    assert.equal(v.verdict, "unknown", `raw=${String(raw)}`);
    assert.equal(v.face_count, null, `raw=${String(raw)} must not become a number`);
    assert.equal(v.comparison, "lte");
    assert.equal(v.limit, 300_000);
    assert.match(v.reason ?? "", reason, `raw=${String(raw)}`);
  }
  // "1234" is never parsed even when it would pass or fail numerically.
  assert.equal(judgeFaceCount("1234", 1000).verdict, "unknown");
  assert.equal(judgeFaceCount("1234", 2000).verdict, "unknown");
});

test("judgeFaceCount rejects an invalid limit instead of guessing", () => {
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => judgeFaceCount(10, bad), RangeError, String(bad));
  }
});

test("faceCountFromTask reads only the top-level face_count and reports absence as absence", () => {
  const nested = { id: "t", status: "SUCCEEDED", result: { face_count: 5 }, printability: { metrics: { face_count: 7 } } };
  assert.deepEqual(faceCountFromTask(nested), { value: undefined, source: "none", status: "SUCCEEDED" });
  assert.deepEqual(faceCountFromTask({ id: "t", status: "SUCCEEDED", face_count: null }), { value: null, source: "face_count", status: "SUCCEEDED" });
  assert.deepEqual(faceCountFromTask({ id: "t", face_count: 12 }), { value: 12, source: "face_count", status: null });
  assert.deepEqual(faceCountFromTask({ id: "t", status: 3, face_count: 0 }), { value: 0, source: "face_count", status: null });
});

test("T-081 judgeTask: a non-terminal task without face_count is unknown because it is still running", () => {
  for (const status of ["PENDING", "IN_PROGRESS", "QUEUED"]) {
    const v = judgeTask({ id: "t", status }, 300_000);
    assert.equal(v.verdict, "unknown", status);
    assert.equal(v.face_count, null);
    assert.equal(v.reason, `task is ${status}; no face count yet`);
    assert.equal(judgeTask({ id: "t", status, face_count: null }, 300_000).reason, `task is ${status}; no face count yet`);
  }
  // Terminal tasks without the field: the field is simply missing.
  assert.equal(judgeTask({ id: "t", status: "SUCCEEDED" }, 300_000).reason, "face_count missing");
  assert.equal(judgeTask({ id: "t", status: "FAILED" }, 300_000).reason, "face_count missing");
  assert.equal(judgeTask({ id: "t" }, 300_000).reason, "face_count missing");
  // A malformed value on a running task is reported as malformed, not as "not yet".
  assert.match(judgeTask({ id: "t", status: "IN_PROGRESS", face_count: "12" }, 300_000).reason ?? "", /string/);
  // A count the server did send is judged whatever the status.
  assert.equal(judgeTask({ id: "t", status: "IN_PROGRESS", face_count: 10 }, 300_000).verdict, "pass");
  assert.equal(judgeTask(fixture, FIXTURE_FACES - 1).verdict, "fail");
});

test("remeshSuggestion describes an unexecuted remesh and clamps the target to the endpoint range", () => {
  const s = remeshSuggestion("fixture-rig-1", 249_999);
  assert.equal(s.executed, false);
  assert.equal(s.command, "meshy remesh create --input-task-id fixture-rig-1 --target-polycount 249999 --output-schema v1");
  assert.match(s.description, /not executed/);
  assert.ok(s.description.includes(s.command));
  assert.match(remeshSuggestion("t", 50).command ?? "", /--target-polycount 100 /);
  assert.match(remeshSuggestion("t", 10_000_000).command ?? "", /--target-polycount 300000 /);
  // No id, or an id that is not a plain token: no command is fabricated.
  const none = remeshSuggestion(null, 1000);
  assert.equal(none.command, null);
  assert.equal(none.executed, false);
  assert.match(none.description, /task id is unknown/);
  const unsafe = remeshSuggestion("a b; rm -rf /", 1000);
  assert.equal(unsafe.command, null);
  assert.ok(!unsafe.description.includes("rm -rf"));
});

test("parseMaxFaces accepts plain positive integers only", () => {
  assert.equal(parseMaxFaces("300000"), 300_000);
  assert.equal(parseMaxFaces(" 40000 "), 40_000);
  for (const bad of ["0", "-1", "3.5", "abc", "1e5", "", "0x10"]) {
    assert.throws(() => parseMaxFaces(bad), UsageError, bad);
  }
});

test("readTaskJsonFile: bounded read, invalid JSON, non-task JSON and missing files are usage errors", () => {
  const dir = tmp();
  const ok = readTaskJsonFile(FIXTURE_PATH);
  assert.equal(ok.shape, "api");
  assert.equal(ok.task["id"], "fixture-rig-1");
  assert.throws(() => readTaskJsonFile(FIXTURE_PATH, { maxBytes: 64 }), (e: unknown) => e instanceof UsageError && /exceeds 64 bytes/.test(e.message));
  assert.throws(() => readTaskJsonFile(join(dir, "missing.json")), (e: unknown) => e instanceof UsageError && /cannot open/.test(e.message));
  assert.throws(() => readTaskJsonFile(dir), (e: unknown) => e instanceof UsageError && /not a regular file/.test(e.message));
  writeFileSync(join(dir, "bad.json"), "{ not json");
  assert.throws(() => readTaskJsonFile(join(dir, "bad.json")), (e: unknown) => e instanceof UsageError && /not valid JSON/.test(e.message));
  writeJson(dir, "notask.json", { hello: "world" });
  assert.throws(() => readTaskJsonFile(join(dir, "notask.json")), (e: unknown) => e instanceof UsageError && /does not contain a task/.test(e.message));
  // Relative paths resolve against the given cwd.
  writeJson(dir, "rel.json", fixture);
  assert.equal(readTaskJsonFile("rel.json", { cwd: dir }).path, join(dir, "rel.json"));
});

// ---------------------------------------------------------------------------
// The command, in-process: file source (T-080/T-081/T-082 local part)
// ---------------------------------------------------------------------------

test("T-080 command: fixture 250000 vs 300000 / 250000 / 249999 → pass 0 / pass 0 / fail 12", async () => {
  const pass = envelopeOf(await runInspect(["--task-json", FIXTURE_PATH, "--max-faces", "300000", "--output-schema", "v1"]));
  assert.deepEqual(Object.keys(pass), ["schema_version", "command", "ok", "result", "error", "warnings"]);
  assert.equal(pass.schema_version, "meshy.cli/v1");
  assert.equal(pass.command, "inspect.faces");
  assert.equal(pass.ok, true);
  assert.equal(pass.error, null);
  const r = pass.result!;
  assert.equal(r.verdict, "pass");
  assert.equal(r.face_count, FIXTURE_FACES);
  assert.equal(r.limit, 300_000);
  assert.equal(r.comparison, "lte");
  assert.equal(r.reason, null);
  assert.equal(r.task_id, "fixture-rig-1");
  assert.equal(r.status, "SUCCEEDED");
  assert.equal(r.suggestion, null);
  assert.equal(r.saved_json, null);
  assert.equal(r.source.kind, "task-json");
  assert.equal((r.source as { path: string }).path, FIXTURE_PATH);
  // The gate answers the face count and nothing more.
  assert.doesNotMatch(JSON.stringify(pass), /rig[- ]?ready|riggable/i);

  const equal = envelopeOf(await runInspect(["--task-json", FIXTURE_PATH, "--max-faces", String(FIXTURE_FACES)]));
  assert.equal(equal.result!.verdict, "pass");

  const fail = cliErrorOf(await runInspect(["--task-json", FIXTURE_PATH, "--max-faces", String(FIXTURE_FACES - 1), "--output-schema", "v1"]));
  assert.equal(fail.code, "check_failed");
  assert.equal(fail.exitCode, 12);
  const failResult = fail.result as unknown as FacesResult;
  assert.equal(failResult.verdict, "fail");
  assert.equal(failResult.face_count, FIXTURE_FACES);
  assert.match(failResult.reason ?? "", /exceeds the limit 249999 by 1/);
  assert.equal(failResult.suggestion?.executed, false);
  assert.equal(failResult.suggestion?.command, "meshy remesh create --input-task-id fixture-rig-1 --target-polycount 249999 --output-schema v1");
});

test("T-081 command: missing/null/string face_count and a running task → unknown, exit 13, no remesh suggestion", async () => {
  const dir = tmp();
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["running.json", { id: "t-run", status: "IN_PROGRESS", progress: 40 }, /task is IN_PROGRESS; no face count yet/],
    ["pending-null.json", { id: "t-pend", status: "PENDING", face_count: null }, /task is PENDING; no face count yet/],
    ["missing.json", { id: "t-done", status: "SUCCEEDED", result: { face_count: 5 } }, /face_count missing/],
    ["null.json", { id: "t-null", status: "SUCCEEDED", face_count: null }, /face_count is null/],
    ["string.json", { id: "t-str", status: "SUCCEEDED", face_count: "1234" }, /string, not a number/],
    ["negative.json", { id: "t-neg", status: "SUCCEEDED", face_count: -5 }, /not a non-negative integer/],
    ["float.json", { id: "t-flt", status: "SUCCEEDED", face_count: 3.5 }, /not a non-negative integer/],
  ];
  for (const [name, task, reason] of cases) {
    const path = writeJson(dir, name, task);
    const err = cliErrorOf(await runInspect(["--task-json", path, "--max-faces", "300000"]));
    assert.equal(err.code, "check_unknown", name);
    assert.equal(err.exitCode, 13, name);
    const result = err.result as unknown as FacesResult;
    assert.equal(result.verdict, "unknown", name);
    assert.equal(result.face_count, null, `${name}: nothing is fabricated`);
    assert.match(result.reason ?? "", reason, name);
    assert.equal(result.suggestion, null, `${name}: unknown never suggests a remesh`);
    assert.equal(result.task_id, task["id"]);
  }
});

test("T-082 local: meta.json and v1 envelope shapes yield the same verdict as the API task shape", async () => {
  const dir = tmp();
  const meta = writeJson(dir, "meta.json", { resource: "rigging", endpoint: "/openapi/v1/rigging", task: fixture, saved_files: [] });
  const envelopeWithRaw = writeJson(dir, "envelope-raw.json", {
    schema_version: "meshy.cli/v1",
    command: "rigging.get",
    ok: true,
    result: { task: toTaskView(fixture, { includeRaw: true }), submission: null, downloads: null, saved_json: null },
    error: null,
    warnings: [],
  });
  const envelopePlain = writeJson(dir, "envelope-plain.json", {
    schema_version: "meshy.cli/v1",
    command: "rigging.get",
    ok: true,
    result: { task: toTaskView(fixture) },
    error: null,
    warnings: [],
  });
  const shapes: Array<[string, string]> = [
    [FIXTURE_PATH, "api"],
    [meta, "meta.json"],
    [envelopeWithRaw, "v1-envelope"],
    [envelopePlain, "v1-result"],
  ];
  for (const [path, shape] of shapes) {
    const pass = envelopeOf(await runInspect(["--task-json", path, "--max-faces", "300000"]));
    assert.equal(pass.result!.verdict, "pass", shape);
    assert.equal(pass.result!.face_count, FIXTURE_FACES, shape);
    assert.equal(pass.result!.task_id, "fixture-rig-1", shape);
    assert.equal((pass.result!.source as { shape: string }).shape, shape);
    const fail = cliErrorOf(await runInspect(["--task-json", path, "--max-faces", String(FIXTURE_FACES - 1)]));
    assert.equal(fail.code, "check_failed", shape);
    assert.equal((fail.result as unknown as FacesResult).face_count, FIXTURE_FACES, shape);
  }
});

test("command: usage errors before any work — sources, --max-faces, schema, -o and --save-json", async () => {
  const usage = async (args: string[], pattern: RegExp): Promise<void> => {
    const run = await runInspect(args);
    assert.ok(run.error instanceof UsageError, `${args.join(" ")}: expected UsageError, got ${String(run.error)}`);
    assert.match(run.error.message, pattern, args.join(" "));
    assert.equal(run.stdout, "");
  };
  await usage(["--task-json", FIXTURE_PATH], /--max-faces <n> is required/);
  await usage(["--task-json", FIXTURE_PATH, "--max-faces", "0"], /positive integer/);
  await usage(["--task-json", FIXTURE_PATH, "--max-faces", "3.5"], /positive integer/);
  await usage(["--task-json", FIXTURE_PATH, "--max-faces", "abc"], /positive integer/);
  await usage(["--max-faces", "300000"], /task source is required/);
  await usage(["--task-json", FIXTURE_PATH, "--resource", "rigging", "--task-id", "x", "--max-faces", "300000"], /not both/);
  await usage(["--task-json", FIXTURE_PATH, "--task-id", "x", "--max-faces", "300000"], /not both/);
  await usage(["--resource", "rigging", "--max-faces", "300000"], /together with --task-id/);
  await usage(["--task-id", "x", "--max-faces", "300000"], /together with --task-id/);
  await usage(["--resource", "no-such-resource", "--task-id", "x", "--max-faces", "300000"], /unknown --resource 'no-such-resource'.*rigging.*uv-unwrap/);
  await usage(["--task-json", FIXTURE_PATH, "--max-faces", "300000", "--output-schema", "legacy"], /only emits the v1 envelope/);
  await usage(["--task-json", FIXTURE_PATH, "--max-faces", "300000", "-o", "out.glb"], /--save-json/);
  await usage(["--task-json", FIXTURE_PATH, "--max-faces", "300000", "--save-json", "x.json"], /only applies to the API source/);
  await usage(["--task-json", join(tmp(), "missing.json"), "--max-faces", "300000"], /cannot open/);
});

// ---------------------------------------------------------------------------
// The command, in-process: API source (T-082) against a loopback mock
// ---------------------------------------------------------------------------

test("T-082 api: exactly one GET through the registry, same verdict as the file, no download and no remesh", async () => {
  const noFace = { id: "no-face", type: "rigging", status: "SUCCEEDED", progress: 100, result: {} };
  const api = await startMockApi((req, res) => {
    if (req.method === "GET" && req.path === "/openapi/v1/rigging/fixture-rig-1") return jsonReply(res, 200, fixture);
    if (req.method === "GET" && req.path === "/openapi/v1/rigging/no-face") return jsonReply(res, 200, noFace);
    return jsonReply(res, 404, { message: "nope" });
  });
  const dir = tmp();
  try {
    const common = ["--base-url-v1", `${api.url}/openapi/v1`, "--api-key", "msy_fixture_key_loopback_only", "--output-schema", "v1"];
    const pass = envelopeOf(await runInspect(["--resource", "rigging", "--task-id", "fixture-rig-1", "--max-faces", "300000", ...common]));
    assert.equal(pass.result!.verdict, "pass");
    assert.equal(pass.result!.face_count, FIXTURE_FACES);
    assert.deepEqual(pass.result!.source, { kind: "api", resource: "rigging", task_id: "fixture-rig-1", endpoint: "/openapi/v1/rigging", requests_made: 1 });
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0]!.method, "GET");
    assert.equal(api.requests[0]!.path, "/openapi/v1/rigging/fixture-rig-1");
    assert.equal(api.requests[0]!.headers["authorization"], "Bearer msy_fixture_key_loopback_only");

    // Same fact, other source: identical verdict.
    const local = envelopeOf(await runInspect(["--task-json", FIXTURE_PATH, "--max-faces", "300000"]));
    assert.equal(local.result!.verdict, pass.result!.verdict);
    assert.equal(local.result!.face_count, pass.result!.face_count);
    assert.equal(api.requests.length, 1, "the file source made no request");

    // A failing verdict describes a remesh; the mock sees no POST.
    const saveTo = join(dir, "task.json");
    const fail = cliErrorOf(
      await runInspect(["--resource", "rigging", "--task-id", "fixture-rig-1", "--max-faces", String(FIXTURE_FACES - 1), "--save-json", saveTo, ...common]),
    );
    assert.equal(fail.code, "check_failed");
    assert.equal(fail.exitCode, 12);
    const failResult = fail.result as unknown as FacesResult;
    assert.equal(failResult.suggestion?.executed, false);
    assert.match(failResult.suggestion?.command ?? "", /^meshy remesh create --input-task-id fixture-rig-1 --target-polycount 249999/);
    assert.equal(failResult.saved_json?.path, realpathSync(saveTo));
    assert.deepEqual(JSON.parse(readFileSync(saveTo, "utf8")), fixture, "--save-json keeps the raw task, not the envelope");
    assert.equal(api.requests.length, 2);
    assert.ok(api.requests.every((r) => r.method === "GET"), "never a POST (no remesh, no download)");

    // D-009: the public task DTO usually carries no face_count → unknown, exit 13, still one GET.
    const unknown = cliErrorOf(await runInspect(["--resource", "rigging", "--task-id", "no-face", "--max-faces", "300000", ...common]));
    assert.equal(unknown.code, "check_unknown");
    assert.equal(unknown.exitCode, 13);
    assert.equal((unknown.result as unknown as FacesResult).reason, "face_count missing");
    assert.equal(api.requests.length, 3);

    // An unknown resource is refused before any request or credential resolution.
    const bad = await runInspect(["--resource", "nope", "--task-id", "x", "--max-faces", "1", ...common]);
    assert.ok(bad.error instanceof UsageError);
    assert.equal(api.requests.length, 3);
  } finally {
    await api.close();
  }
});

test("T-082 subprocess: dist/ inspect faces — file source needs no credential, API source makes one GET", async () => {
  const api = await startMockApi((req, res) => {
    if (req.method === "GET" && req.path === "/openapi/v1/rigging/fixture-rig-1") return jsonReply(res, 200, fixture);
    return jsonReply(res, 404, { message: "nope" });
  });
  try {
    // File source: no MESHY_API_KEY, no profile, no base URL — still exit 0.
    const local = await runCli(["inspect", "faces", "--task-json", FIXTURE_PATH, "--max-faces", "300000", "--output-schema", "v1"]);
    assert.equal(local.code, 0, local.stderr);
    const localOut = parseSingleJson(local.stdout) as V1Envelope<FacesResult>;
    assert.equal(localOut.command, "inspect.faces");
    assert.equal(localOut.result!.verdict, "pass");

    const remote = await runCli(["inspect", "faces", "--resource", "rigging", "--task-id", "fixture-rig-1", "--max-faces", "300000"], { env: api.env() });
    assert.equal(remote.code, 0, remote.stderr);
    const remoteOut = parseSingleJson(remote.stdout) as V1Envelope<FacesResult>;
    assert.equal(remoteOut.result!.verdict, localOut.result!.verdict);
    assert.equal(remoteOut.result!.face_count, localOut.result!.face_count);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0]!.method, "GET");

    const fail = await runCli(["inspect", "faces", "--task-json", FIXTURE_PATH, "--max-faces", String(FIXTURE_FACES - 1)]);
    assert.equal(fail.code, 12, fail.stderr);
    const failOut = parseSingleJson(fail.stdout) as V1Envelope<FacesResult>;
    assert.equal(failOut.ok, false);
    assert.equal(failOut.error?.code, "check_failed");
    assert.equal(failOut.result?.verdict, "fail");
    assert.equal(failOut.result?.suggestion?.executed, false);

    const unknown = await runCli(["inspect", "faces", "--resource", "rigging", "--task-id", "fixture-rig-1", "--max-faces", "300000"], {
      env: api.env({ MESHY_API_KEY: undefined }),
    });
    assert.equal(unknown.code, 3, "API source without a credential is an auth failure, not unknown");
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});
