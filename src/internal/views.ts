/**
 * Per-command views for `--format pretty` (gh: view/display, kubectl: printers).
 *
 * `pretty` is what a person sees at a terminal, so it is designed per command
 * instead of dumping the payload: the fields a reader acts on first, times a
 * person can read, and no 400-character signed URLs (`--json` has all of it).
 * Nothing here is a contract — json/ndjson are, and they never pass through
 * this file.
 *
 * Views are pure (command, value, painter) → text and accept either schema:
 * tasks are normalised through toTaskView, so a legacy summary and a v1
 * result of the same command read the same. A command without a view — or a
 * payload its view does not recognise — gets the generic fallback: the v1
 * `result` only, epoch-ms times as local time, URLs shortened.
 */

import { relative } from "node:path";
import { plain, type Painter, type Style } from "./color.js";
import { renderPretty } from "./output.js";
import { safeSegment } from "./paths.js";
import { SCHEMA_VERSION } from "./result.js";
import { toTaskView, type TaskView } from "./task-view.js";

type Obj = Record<string, unknown>;

/** Facts only a command knows, noted for its human view (see noteForView in context.ts). */
export interface ViewFacts {
  /** A name to derive a download directory from (make: the prompt or image name). */
  name?: string;
  estimatedCredits?: number;
  totalSeconds?: number;
}

export function renderView(command: string | undefined, value: unknown, paint: Painter = plain, facts: ViewFacts = {}): string {
  const body = isEnvelope(value) ? value["result"] : value;
  return (command ? viewFor(command, body, paint, facts) : null) ?? fallback(body, paint);
}

function viewFor(command: string, body: unknown, paint: Painter, facts: ViewFacts): string | null {
  switch (command) {
    case "make":
      return spaced(makeView(body, paint, facts));
    case "balance":
      return balanceView(body);
    case "doctor":
      return doctorView(body, paint);
    case "download":
      return downloadView(body, paint);
    case "delete":
      return deleteView(body, paint);
    case "auth.login":
      return loginView(body, paint);
    case "auth.status":
      return authStatusView(body, paint);
    case "auth.logout":
    case "auth.use":
      return profileChangeView(body, paint);
    case "auth.list":
      return profileListView(body, paint);
  }
  const dot = command.lastIndexOf(".");
  const prefix = command.slice(0, Math.max(0, dot));
  switch (command.slice(dot + 1)) {
    case "get":
      return taskResultView(body, paint, prefix);
    case "create":
    case "wait":
    case "stream":
      return spaced(taskResultView(body, paint, prefix));
    case "list":
      return taskListView(body, paint);
    case "delete":
      return deleteView(body, paint);
  }
  return null;
}

/** Commands that showed progress on stderr start their result one line below it. */
function spaced(view: string | null): string | null {
  return view === null ? null : `\n${view}`;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function taskResultView(body: unknown, paint: Painter, prefix: string): string | null {
  if (!isObj(body)) return null;
  const task = taskFrom(body);
  if (!task) return submittedView(body, paint, prefix);
  const resource = task.resource ?? str(body["resource"]) ?? prefix;
  const saved = savedFiles(body);
  const lines = taskCard(task, paint, { fallbackSeconds: elapsedOf(body), saved });
  if (task.status === "SUCCEEDED" && saved.length === 0) {
    lines.push("", ...downloadTip(resource, task.task_id, `${safeSegment(resource)}-${task.task_id.slice(0, 8)}`, "the command", paint));
  }
  return lines.join("\n");
}

/** `create --async`: nothing but an id and how to follow it. */
function submittedView(body: Obj, paint: Painter, prefix: string): string | null {
  const taskId = str(body["task_id"]);
  if (!taskId) return null;
  return [
    `${paint("⧗", "yellow")} Submitted  ${taskId}`,
    paint(`next: meshy ${prefix.split(".").join(" ")} wait ${taskId}`, "dim"),
  ].join("\n");
}

export interface TaskCardOptions {
  /** Wins over the server's timestamps (make: the whole chain, wall clock). */
  seconds?: number | null;
  /** Used only when the server's timestamps cannot say (legacy `wait`: the time spent waiting). */
  fallbackSeconds?: number | null;
  saved?: string[];
  /** Replaces the Credits row (make: the chain's estimate). */
  credits?: string;
}

/** The fields a person reads first, in the order they read them. No URLs. */
export function taskCard(task: TaskView, paint: Painter, opts: TaskCardOptions = {}): string[] {
  const lines = [statusLine(task, paint)];
  const row = (label: string, value: string): void => {
    lines.push(`${paint(label.padEnd(9), "dim")}${value}`);
  };
  row("Task", task.task_id);
  if (task.created_at !== null) row("Created", localTime(task.created_at));
  const start = task.started_at ?? task.created_at;
  const server = task.finished_at !== null && start !== null ? (task.finished_at - start) / 1000 : null;
  const took = opts.seconds ?? server ?? opts.fallbackSeconds ?? null;
  if (took !== null && took >= 0) row("Took", formatDuration(took));
  if (opts.credits) row("Credits", opts.credits);
  // A missing count is unknown, not zero — say nothing rather than "0".
  else if (task.consumed_credits !== null) row("Credits", String(task.consumed_credits));
  const assets = assetSummary(task);
  if (assets) row("Assets", assets);
  const saved = opts.saved ?? [];
  saved.forEach((file, i) => row(i === 0 ? "Saved" : "", displayPath(file)));
  if (task.task_error?.message) row("Error", paint(task.task_error.message, "red"));
  return lines;
}

function statusLine(task: TaskView, paint: Painter): string {
  const status = task.status ?? "UNKNOWN";
  const type = task.type ? `  ${paint(task.type, "dim")}` : "";
  if (status === "SUCCEEDED") return `${paint("✓", "green")} ${paint(status, "green")}${type}`;
  if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") return `${paint("✗", "red")} ${paint(status, "red")}${type}`;
  const pct = task.progress !== null && status === "IN_PROGRESS" ? ` ${task.progress}%` : "";
  return `${paint("⧗", "yellow")} ${paint(`${status}${pct}`, "yellow")}${type}`;
}

function assetSummary(task: TaskView): string {
  const parts: string[] = [];
  const models = Object.entries(task.model_urls).filter(([, u]) => u).map(([k]) => k);
  if (models.length) parts.push(models.join(", "));
  const sets = task.texture_urls.filter((s) => Object.values(s).some(Boolean));
  if (sets.length === 1) parts.push(`textures: ${Object.keys(sets[0]!).filter((k) => sets[0]![k]).join(", ")}`);
  else if (sets.length > 1) parts.push(`${sets.length} texture sets`);
  if (task.image_urls.length) parts.push(plural(task.image_urls.length, "image"));
  const resultFiles = task.result ? countUrls(task.result) : 0;
  if (resultFiles) parts.push(plural(resultFiles, "result file"));
  if (task.thumbnail_url) parts.push("thumbnail");
  return parts.join(" · ");
}

function downloadTip(resource: string, taskId: string, dir: string, where: string, paint: Painter): string[] {
  return [
    paint(`tip: download it now:  meshy download --resource ${resource} --task-id ${taskId} --all --output-dir ./${dir}`, "dim"),
    paint(`     or add -o <dir> to ${where} to save files automatically`, "dim"),
  ];
}

function taskListView(body: unknown, paint: Painter): string | null {
  const items = Array.isArray(body) ? body : isObj(body) && Array.isArray(body["items"]) ? (body["items"] as unknown[]) : null;
  if (!items) return null;
  const tasks = items.map((i) => (isObj(i) ? taskFrom({ task: i }) ?? taskFrom(i) : null));
  if (tasks.some((t) => t === null)) return null; // not a task list (showcases, projects, …)
  // Only a task list has a legacy array body or a v1 `page`; an empty showcase list is not "No tasks".
  if (tasks.length === 0) return Array.isArray(body) || (isObj(body) && isObj(body["page"])) ? paint("No tasks.", "dim") : null;
  const rows = (tasks as TaskView[]).map((t) => [
    t.task_id,
    t.status ?? "-",
    t.progress !== null ? `${t.progress}%` : "-",
    t.type ?? "-",
    t.created_at !== null ? relativeTime(t.created_at) : "-",
  ]);
  const out = [table(["TASK ID", "STATUS", "PROGRESS", "TYPE", "CREATED"], rows, paint, (col, v) => (col === 1 ? statusStyle(v) : null))];
  const page = isObj(body) && isObj(body["page"]) ? body["page"] : null;
  if (page && typeof page["page_num"] === "number" && tasks.length === page["page_size"]) {
    out.push(paint(`more: --page ${page["page_num"] + 1}`, "dim"));
  }
  return out.join("\n");
}

function deleteView(body: unknown, paint: Painter): string | null {
  if (!isObj(body) || body["deleted"] !== true || !str(body["task_id"])) return null;
  return `${paint("✓", "green")} Deleted ${body["task_id"] as string}`;
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

function makeView(body: unknown, paint: Painter, facts: ViewFacts): string | null {
  if (!isObj(body)) return null;
  if (Array.isArray(body["steps"])) return planView(body, paint);

  const stopped = body["stopped_after"];
  if (stopped !== undefined) {
    const id = str(body["task_id"]) ?? (isObj(stopped) ? str(stopped["task_id"]) : null);
    const resume = str(body["resume"]) ?? str(body["hint"]);
    return [`${paint("✓", "green")} Stopped after step 1  ${id ?? ""}`, ...(resume ? [paint(`resume: ${resume}`, "dim")] : [])].join("\n");
  }

  const task = taskFrom(body);
  if (!task) {
    // --async: step 1 submitted, the rest is the caller's.
    const submitted = body["submitted"];
    const id = str(body["task_id"]) ?? (isObj(submitted) ? str(submitted["task_id"]) : null);
    if (!id) return null;
    const resource = isObj(submitted) ? str(submitted["resource"]) : null;
    const next = str(body["hint"]) ?? `meshy ${resource ?? "text-to-3d"} wait ${id}`;
    const later = Array.isArray(body["pending_steps"])
      ? (body["pending_steps"] as unknown[]).map((s) => (isObj(s) ? str(s["command"]) : null)).filter((c): c is string => Boolean(c))
      : [];
    return [`${paint("⧗", "yellow")} Submitted step 1  ${id}`, paint(`next: ${next}`, "dim"), ...later.map((c) => paint(`then: ${c}`, "dim"))].join("\n");
  }

  const saved = savedFiles(body);
  const lines = taskCard(task, paint, {
    seconds: facts.totalSeconds ?? null,
    fallbackSeconds: elapsedOf(body),
    saved,
    ...(facts.estimatedCredits !== undefined ? { credits: `~${facts.estimatedCredits} (estimate for the whole chain)` } : {}),
  });
  if (task.status === "SUCCEEDED" && saved.length === 0) {
    const resource = task.resource ?? str(body["resource"]) ?? "text-to-3d";
    lines.push("", ...downloadTip(resource, task.task_id, dirName(facts.name, task.task_id), "make", paint));
  }
  return lines.join("\n");
}

function planView(body: Obj, paint: Painter): string {
  const steps = (body["steps"] as unknown[]).filter(isObj);
  const rows = steps.map((s) => [`${String(s["step"] ?? "")}.`, `${String(s["resource"] ?? "")} ${String(s["action"] ?? "")}`, `~${String(s["estimated_credits"] ?? "?")}`]);
  const out = [
    `Plan  ${plural(steps.length, "step")} · ~${String(body["estimated_credits"] ?? "?")} credits`,
    table(null, rows, paint),
  ];
  if (str(body["note"])) out.push(paint(body["note"] as string, "dim"));
  return out.join("\n");
}

/** A directory name a person would pick: the prompt, lower-cased and hyphenated. */
function dirName(name: string | undefined, taskId: string): string {
  const slug = (name ?? "").toLowerCase().trim().replace(/\s+/g, "-").slice(0, 48);
  return safeSegment(slug, `meshy-${taskId.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// balance / doctor / download
// ---------------------------------------------------------------------------

function balanceView(body: unknown): string | null {
  if (!isObj(body) || typeof body["balance"] !== "number") return null;
  return `Balance  ${body["balance"].toLocaleString("en-US")} credits`;
}

const CHECK_STYLE: Record<string, { icon: string; style: Style }> = {
  ok: { icon: "✓", style: "green" },
  warn: { icon: "!", style: "yellow" },
  fail: { icon: "✗", style: "red" },
  skipped: { icon: "-", style: "dim" },
};

function doctorView(body: unknown, paint: Painter): string | null {
  if (!isObj(body) || !Array.isArray(body["checks"])) return null;
  const cli = isObj(body["cli"]) ? body["cli"] : {};
  const checks = (body["checks"] as unknown[]).filter(isObj);
  const width = Math.max(0, ...checks.map((c) => String(c["id"] ?? "").length));
  const out = [paint(`meshy-cli ${String(cli["version"] ?? "?")} · node ${String(cli["node"] ?? "?")} · ${String(cli["platform"] ?? "")} ${String(cli["arch"] ?? "")}`, "dim")];
  for (const c of checks) {
    const s = CHECK_STYLE[String(c["status"])] ?? CHECK_STYLE["skipped"]!;
    out.push(`${paint(s.icon, s.style)} ${String(c["id"] ?? "").padEnd(width)}  ${String(c["detail"] ?? "")}`);
  }
  const api = body["api_ready"] === null ? paint("not checked (--check-api)", "dim") : yesNo(body["api_ready"] === true, paint);
  out.push("", `Local ready  ${yesNo(body["local_ready"] === true, paint)}`, `API ready    ${api}`);
  return out.join("\n");
}

function downloadView(body: unknown, paint: Painter): string | null {
  if (!isObj(body)) return null;
  const downloads = isObj(body["downloads"]) ? body["downloads"] : null;
  if (!downloads && Array.isArray(body["assets"])) {
    const assets = (body["assets"] as unknown[]).filter(isObj);
    if (assets.length === 0) return paint("No downloadable assets.", "dim");
    return table(["KEY", "KIND", "FORMAT", "FILE"], assets.map((a) => [String(a["key"] ?? ""), String(a["kind"] ?? "-"), String(a["format"] ?? "-"), String(a["filename"] ?? "-")]), paint);
  }
  if (!downloads) return null;
  if (downloads["state"] === "not_ready") return `${paint("⧗", "yellow")} Not ready yet — nothing to download`;
  const files = Array.isArray(downloads["files"]) ? (downloads["files"] as unknown[]).filter(isObj) : [];
  const written = files.filter((f) => f["status"] === "written");
  const out = [`${paint("✓", "green")} Saved ${plural(written.length, "file")}`];
  for (const f of files) {
    const failed = f["status"] === "failed";
    const mark = failed ? paint("✗", "red") : f["status"] === "skipped" ? paint("-", "dim") : " ";
    out.push(`${mark} ${displayPath(String(f["path"] ?? f["key"] ?? ""))}${failed && f["error"] ? `  ${paint(String(f["error"]), "red")}` : ""}`);
  }
  if (str(downloads["metadata_path"])) out.push(paint(`metadata: ${displayPath(downloads["metadata_path"] as string)}`, "dim"));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

const SOURCE: Record<string, string> = {
  flag: "--api-key",
  env: "MESHY_API_KEY",
  "env-file": "--api-key-file",
  file: "stored profile",
};

function loginView(body: unknown, paint: Painter): string | null {
  if (!isObj(body)) return null;
  if (body["status"] === "device_flow_started") {
    return [
      `${paint("⧗", "yellow")} Approve this login in the browser`,
      `${paint("Code".padEnd(9), "dim")}${String(body["user_code"] ?? "")}`,
      `${paint("Open".padEnd(9), "dim")}${String(body["verification_url"] ?? "")}`,
      paint(`then: ${String(body["poll_command"] ?? "meshy auth login --device-flow <id>")}`, "dim"),
    ].join("\n");
  }
  if (body["status"] !== "logged_in") return null;
  const hint = str(body["hint"]);
  const out = [
    hint ? `${paint("!", "yellow")} Logged in, but the credential could not be verified` : `${paint("✓", "green")} Logged in to Meshy`,
    `${paint("Profile".padEnd(9), "dim")}${String(body["profile"] ?? "default")}`,
  ];
  const balance = balanceOf(body);
  if (balance !== null) out.push(`${paint("Balance".padEnd(9), "dim")}${balance}`);
  if (str(body["credentials_file"])) out.push(`${paint("Saved to".padEnd(9), "dim")}${tildify(body["credentials_file"] as string)}`);
  if (hint) out.push(paint(`hint: ${hint}`, "dim"));
  return out.join("\n");
}

function authStatusView(body: unknown, paint: Painter): string | null {
  if (!isObj(body) || typeof body["authenticated"] !== "boolean") return null;
  const hint = str(body["hint"]);
  if (!body["authenticated"]) {
    return [`${paint("✗", "red")} Not logged in`, paint(`hint: ${hint ?? "meshy auth login"}`, "dim")].join("\n");
  }
  const source = SOURCE[String(body["source"])] ?? String(body["source"] ?? "");
  const profile = str(body["profile"]);
  const head =
    body["verified"] === false
      ? `${paint("✗", "red")} Credential rejected`
      : body["verified"] === true
        ? `${paint("✓", "green")} Logged in`
        : `${paint("✓", "green")} Logged in ${paint("(not verified: --offline)", "dim")}`;
  const out = [head];
  const row = (label: string, value: string): void => {
    out.push(`${paint(label.padEnd(11), "dim")}${value}`);
  };
  row("Using", profile ? `${source} "${profile}"` : source);
  const balance = balanceOf(body);
  if (balance !== null) row("Balance", balance);
  row("Credential", String(body["credential"] ?? ""));
  const profiles = Array.isArray(body["profiles"]) ? (body["profiles"] as unknown[]).map(String) : [];
  if (profiles.length > 1) row("Profiles", profiles.map((p) => (p === body["active_profile"] ? `${p} (active)` : p)).join(", "));
  if (str(body["base_url_v1"]) && !String(body["base_url_v1"]).startsWith("https://api.meshy.ai/")) row("API", body["base_url_v1"] as string);
  if (hint) out.push(paint(`hint: ${hint}`, "dim"));
  return out.join("\n");
}

function profileChangeView(body: unknown, paint: Painter): string | null {
  if (!isObj(body)) return null;
  const ok = `${paint("✓", "green")} `;
  const profile = String(body["profile"] ?? body["active_profile"] ?? "");
  switch (body["status"]) {
    case "switched":
      return `${ok}Switched to profile ${profile}`;
    case "removed":
      return `${ok}Logged out of profile ${profile}`;
    case "nothing_to_remove":
      return paint(`No stored profile named ${profile} — nothing to log out.`, "dim");
    case "deleted":
      return `${ok}Removed every stored credential (${tildify(String(body["credentials_file"] ?? ""))})`;
    case "nothing_to_delete":
      return paint("No stored credentials — nothing to remove.", "dim");
  }
  return null;
}

function profileListView(body: unknown, paint: Painter): string | null {
  if (!isObj(body) || !Array.isArray(body["profiles"])) return null;
  const profiles = (body["profiles"] as unknown[]).filter(isObj);
  if (profiles.length === 0) return `${paint("No stored profiles.", "dim")}\n${paint("hint: meshy auth login", "dim")}`;
  const rows = profiles.map((p) => [
    `${p["active"] ? "*" : " "} ${String(p["name"] ?? "")}`,
    p["kind"] === "oauth" ? "browser login" : "API key",
    String(p["credential"] ?? ""),
    typeof p["created_at"] === "number" ? relativeTime(p["created_at"]) : typeof p["created_at"] === "string" ? String(p["created_at"]).slice(0, 10) : "-",
  ]);
  return table(["  PROFILE", "KIND", "CREDENTIAL", "CREATED"], rows, paint);
}

/** `balance` in auth payloads is the API's `{balance: n}` object. */
function balanceOf(body: Obj): string | null {
  const b = body["balance"];
  const n = typeof b === "number" ? b : isObj(b) && typeof b["balance"] === "number" ? b["balance"] : null;
  return n === null ? null : `${n.toLocaleString("en-US")} credits`;
}

function tildify(p: string): string {
  const home = process.env["HOME"];
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/** The generic dump, made readable: times as local time, URLs without their signatures. */
function fallback(body: unknown, paint: Painter): string {
  return renderPretty(humanize(body), 0, paint);
}

function humanize(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => humanize(x));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, humanize(x, k)]));
  // Epoch milliseconds: anything after 2001 in a *_at field.
  if (typeof v === "number" && key.endsWith("_at") && v > 1e12) return localTime(v);
  if (typeof v === "string" && /^https?:\/\//i.test(v)) return shortUrl(v);
  return v;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

/**
 * A recovery command as a person should run it. Hints are written for agents
 * (`--output-schema v1 --format json`), and since D-065 an explicit
 * `--output-schema v1` means JSON — copied at a terminal it would answer in
 * braces. The views are the same in both schemas, so the flags only get in the way.
 */
export function forHumans(text: string): string {
  return text.replace(/\s+--output-schema[ =]v1\b/g, "").replace(/\s+--format[ =](?:json|ndjson)\b/g, "");
}

/**
 * The line under `error:` for a person: the hint, else the recovery command,
 * else — when the failure still names a task (a poll that lost the network) —
 * the fact that the server keeps running it and how to pick it up again.
 */
export function humanHint(hint: unknown, recovery: string | null | undefined, result: unknown): string | undefined {
  if (typeof hint === "string" && hint) return forHumans(hint);
  if (recovery) return forHumans(recovery);
  const wait = isObj(result) && isObj(result["next"]) ? str(result["next"]["wait"]) : null;
  return wait ? `the task keeps running on the server — resume with: ${forHumans(wait)}` : undefined;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return localTime(ms);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return localTime(ms).slice(0, 10);
}

/** Drop the query string (signatures) and keep the host plus the last two path segments. */
export function shortUrl(url: string, max = 80): string {
  const bare = url.split(/[?#]/)[0]!;
  if (bare.length <= max) return bare;
  const m = /^(https?:\/\/[^/]+)(\/.*)$/i.exec(bare);
  if (!m) return `${bare.slice(0, max - 1)}…`;
  const segs = m[2]!.split("/").filter(Boolean);
  return `${m[1]}/…/${segs.slice(-2).join("/")}`;
}

/** Columns padded on plain text, painted after, so escapes never skew the widths. */
export function table(headers: string[] | null, rows: string[][], paint: Painter, styleFor?: (col: number, value: string) => Style | null): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths = all[0]?.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length))) ?? [];
  const line = (r: string[], head: boolean): string =>
    r
      .map((cell, c) => {
        const padded = c === r.length - 1 ? cell : cell.padEnd(widths[c]!);
        const style = head ? "dim" : styleFor?.(c, cell);
        return style ? paint(padded, style) : padded;
      })
      .join("  ")
      .trimEnd();
  return [...(headers ? [line(headers, true)] : []), ...rows.map((r) => line(r, false))].join("\n");
}

function statusStyle(status: string): Style | null {
  if (status === "SUCCEEDED") return "green";
  if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") return "red";
  if (status === "PENDING" || status === "IN_PROGRESS") return "yellow";
  return null;
}

function yesNo(v: boolean, paint: Painter): string {
  return v ? paint("yes", "green") : paint("no", "red");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith("..") ? rel : p;
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function isEnvelope(v: unknown): v is Obj {
  return isObj(v) && v["schema_version"] === SCHEMA_VERSION && "result" in v;
}

/** A v1 result's `task` (a TaskView), or a legacy summary normalised into one. */
function taskFrom(body: Obj): TaskView | null {
  const t = body["task"];
  if (isObj(t) && typeof t["task_id"] === "string") return t as unknown as TaskView;
  if (typeof body["id"] === "string" && typeof body["status"] === "string") return toTaskView(body);
  return null;
}

function savedFiles(body: Obj): string[] {
  const downloads = isObj(body["downloads"]) ? body["downloads"] : null;
  const files = downloads && Array.isArray(downloads["files"]) ? (downloads["files"] as unknown[]) : [];
  return files.filter((f): f is Obj => isObj(f) && f["status"] === "written" && typeof f["path"] === "string").map((f) => f["path"] as string);
}

function elapsedOf(body: Obj): number | null {
  if (typeof body["elapsed_seconds"] === "number") return body["elapsed_seconds"];
  for (const k of ["wait", "stream"]) {
    const info = body[k];
    if (isObj(info) && typeof info["elapsed_seconds"] === "number") return info["elapsed_seconds"];
  }
  return null;
}

function countUrls(v: unknown): number {
  if (typeof v === "string") return /^https?:\/\//i.test(v) ? 1 : 0;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + countUrls(x), 0);
  if (isObj(v)) return Object.values(v).reduce((n: number, x) => n + countUrls(x), 0);
  return 0;
}
