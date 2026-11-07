/**
 * Which AI coding agent is running this command, read from the variables the
 * agent sets on the commands it executes. The answer only tags the User-Agent
 * and doctor's report, so usage can be told apart by agent; no behaviour
 * depends on it, and like the rest of a User-Agent it is self-reported.
 *
 * Only markers with first-party evidence count: the agent's own docs, source
 * or shipped code. Signals that a human's terminal carries too (TERM_PROGRAM,
 * VSCODE_*, CLAUDECODE alone, the retired CURSOR_TRACE_ID) or that are only
 * user configuration are deliberately not read.
 *
 * Order matters when one agent runs inside another, because the inner one
 * inherits the outer one's variables. A command-line agent started by an IDE
 * agent is the one actually running the command, so command-line agents are
 * checked first; the generic AI_AGENT comes last, since some agents leave an
 * existing value alone and it is often the outer agent's.
 *
 * MESHY_CLI_AGENT names the agent explicitly (for an agent with no marker),
 * or turns detection off with "none".
 */

import { existsSync } from "node:fs";

export interface DetectedAgent {
  /** Fixed lowercase id, e.g. "cursor", "claude-code". */
  id: string;
  /** Optional sub-surface from a small fixed vocabulary, e.g. "desktop"; "" when unknown. */
  surface: string;
  /** The variable that decided it (a name, never a value), for doctor. */
  via: string;
}

export type AgentOverride = "unset" | "none" | "valid" | "invalid";

export interface AgentDetection {
  agent: DetectedAgent | null;
  /** MESHY_CLI_AGENT: absent, "none" (detection off), a usable name, or a value that was ignored. */
  override: AgentOverride;
}

type Env = NodeJS.ProcessEnv;
type Exists = (path: string) => boolean;

interface Rule {
  id: string;
  /** The name of the variable that matched, or null. */
  match(env: Env): string | null;
  surface?(env: Env, platform: NodeJS.Platform, exists: Exists): string;
}

const OVERRIDE = /^([a-z0-9][a-z0-9.-]{0,31})(?:\/([a-z0-9][a-z0-9.-]{0,15}))?$/;
/** Claude Code sets AI_AGENT to claude-code_<version>_agent on the commands its model runs. */
const CLAUDE_AGENT = /^claude-code_[0-9-]+_agent$/;
/** Hooks, MCP servers and other processes Claude Code itself starts carry its _harness form. */
const CLAUDE_ANY = /^claude-code[_/]/;
const CURSOR_CLOUD_SOCKET = "/run/cursor/api.sock";

function value(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function is(env: Env, name: string, expected: string): string | null {
  return value(env, name) === expected ? name : null;
}

/** CLAUDE_CODE_ENTRYPOINT, folded into a few surfaces; the raw value is never sent. */
function claudeSurface(env: Env): string {
  const entry = value(env, "CLAUDE_CODE_ENTRYPOINT");
  if (!entry) return "";
  switch (entry) {
    case "cli":
    case "sdk-cli":
      return "cli";
    case "sdk-ts":
    case "sdk-py":
      return "sdk";
    case "claude-desktop":
    case "claude-desktop-3p":
    case "remote_desktop":
      return "desktop";
    case "claude-vscode":
      return "vscode";
    case "claude-code-github-action":
      return "action";
    case "local-agent":
    case "local_agent":
    case "remote_cowork":
      return "cowork";
  }
  if (entry.startsWith("claude-coworker")) return "cowork";
  if (entry.startsWith("remote")) return "remote";
  return "other";
}

/** The desktop app passes its originator to the commands it runs; the CLI and IDE extension do not. */
function codexSurface(env: Env): string {
  switch (value(env, "CODEX_INTERNAL_ORIGINATOR_OVERRIDE")) {
    case "Codex Desktop":
    case "codex_work_desktop":
      return "desktop";
    case "codex_sdk_ts":
      return "sdk";
    default:
      return "";
  }
}

/** Cursor's cloud machines serve agent metadata on a unix socket; nothing is read from it. */
function cursorSurface(env: Env, platform: NodeJS.Platform, exists: Exists): string {
  if (platform !== "linux") return "";
  return exists(value(env, "CURSOR_AGENT_SOCKET") || CURSOR_CLOUD_SOCKET) ? "cloud" : "";
}

const RULES: readonly Rule[] = [
  { id: "hermes-agent", match: (env) => is(env, "HERMES_AGENT", "true") },
  { id: "dsh", match: (env) => is(env, "DSH_SHELL", "1") },
  { id: "opencode", match: (env) => is(env, "OPENCODE", "1") },
  { id: "gemini-cli", match: (env) => is(env, "GEMINI_CLI", "1") },
  {
    // Kiro CLI exports a pair of per-call FIFOs only while it drives the command; either name alone is generic.
    id: "kiro-cli",
    match: (env) =>
      value(env, "AGENT_DISPLAY_OUT") && value(env, "AGENT_CONTEXT_OUT") ? "AGENT_DISPLAY_OUT+AGENT_CONTEXT_OUT" : null,
  },
  {
    id: "codex",
    match: (env) => (value(env, "CODEX_THREAD_ID") ? "CODEX_THREAD_ID" : is(env, "CODEX_CI", "1")),
    surface: codexSurface,
  },
  {
    id: "claude-code",
    match: (env) => {
      const ai = value(env, "AI_AGENT");
      if (CLAUDE_AGENT.test(ai)) return "AI_AGENT";
      // Hooks and status lines carry CLAUDE_CODE_CHILD_SESSION too, beside the _harness AI_AGENT:
      // not a command the model ran. Without a Claude AI_AGENT (older releases), the child marker decides.
      if (CLAUDE_ANY.test(ai)) return null;
      return is(env, "CLAUDE_CODE_CHILD_SESSION", "1");
    },
    surface: claudeSurface,
  },
  {
    id: "copilot",
    match: (env) => is(env, "COPILOT_AGENT", "1") ?? is(env, "AI_AGENT", "github_copilot_vscode_agent"),
    surface: () => "vscode",
  },
  { id: "cursor", match: (env) => is(env, "CURSOR_AGENT", "1"), surface: cursorSurface },
  { id: "cline", match: (env) => is(env, "CLINE_ACTIVE", "true") },
  { id: "roo-code", match: (env) => is(env, "ROO_ACTIVE", "true") },
];

/** Known AI_AGENT values that differ from our ids. A Map, so a value like "constructor" is not a hit. */
const AI_AGENT_NAMES: ReadonlyMap<string, { id: string; surface: string }> = new Map([
  ["github_copilot_cloud_agent", { id: "copilot", surface: "cloud" }],
  ["github-copilot-cli", { id: "copilot", surface: "cli" }],
  ["opencode", { id: "opencode", surface: "" }],
  ["hermes-agent", { id: "hermes-agent", surface: "" }],
]);

/** Any other AI_AGENT value, cut to the id charset: lowercase letters, digits, '.', '-', at most 32. */
function genericAiAgent(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 32)
    .replace(/[.-]+$/, "");
}

export function detectAgent(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: Exists = existsSync,
): AgentDetection {
  let override: AgentOverride = "unset";
  const named = value(env, "MESHY_CLI_AGENT").toLowerCase();
  if (named) {
    if (named === "none") return { agent: null, override: "none" };
    const m = OVERRIDE.exec(named);
    if (m) return { agent: { id: m[1]!, surface: m[2] ?? "", via: "MESHY_CLI_AGENT" }, override: "valid" };
    override = "invalid";
  }

  for (const rule of RULES) {
    const via = rule.match(env);
    if (via) return { agent: { id: rule.id, surface: rule.surface?.(env, platform, exists) ?? "", via }, override };
  }

  const ai = value(env, "AI_AGENT");
  if (ai && !CLAUDE_ANY.test(ai)) {
    const known = AI_AGENT_NAMES.get(ai);
    if (known) return { agent: { ...known, via: "AI_AGENT" }, override };
    const id = genericAiAgent(ai);
    if (id) return { agent: { id, surface: "", via: "AI_AGENT" }, override };
  }
  return { agent: null, override };
}

/** The User-Agent's agent segment: "cursor", "claude-code/desktop"; "" when no agent. */
export function agentToken(detection: AgentDetection): string {
  const { agent } = detection;
  if (!agent) return "";
  return agent.surface ? `${agent.id}/${agent.surface}` : agent.id;
}
