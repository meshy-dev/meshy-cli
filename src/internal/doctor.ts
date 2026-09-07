/**
 * doctor — read-only environment diagnosis.
 *
 * The default run is fully local and must complete with no credential, no
 * network and an empty config directory. It reports versions, which credential
 * sources are *present* — never their values: the stored profile is stat'ed
 * and not parsed, the flag and env var become booleans, and an explicit
 * `--api-key-file` is run through the same parser API commands use with only
 * its verdict kept — the effective base URLs, workspace writability and
 * whether the cwd holds a `.env` candidate (named, never read: there is no
 * auto-discovery, D-016). Nothing here refreshes an OAuth token or writes.
 *
 * `--check-api` resolves the credential exactly like an API command (flags →
 * env → key file → stored profile) and makes one GET /balance — the only free
 * authenticated endpoint. `--check-slicers` runs the local slicer detection.
 * Neither is implied by the other (D-024). Everything else stays offline.
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { MeshyClient } from "../client/index.js";
import {
  DEFAULT_BASE_URL_V1,
  DEFAULT_BASE_URL_V2,
  deriveCreativeLabBase,
  derivePublicWebBase,
  loadConfig,
  type MeshyConfig,
} from "./config.js";
import { credentialsPath } from "./credentials.js";
import { loadEnvFile } from "./env-file.js";
import { configOverridesFrom, type GlobalFlags } from "./runtime.js";
import { detectSlicers as detectSlicersImpl, type DetectionEnv, type SlicerDetection } from "./slicers.js";
import { VERSION } from "./version.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorReport {
  cli: { version: string; node: string; platform: string; arch: string };
  /** Node satisfies the engine range and the CLI loaded: local commands can run. */
  local_ready: boolean;
  /** null unless --check-api was requested. */
  api_ready: boolean | null;
  checks: DoctorCheck[];
  credential_sources: {
    flag: boolean;
    env: boolean;
    /** Absolute path of --api-key-file when given (its verdict is a check), else null. */
    api_key_file: string | null;
    stored_profile: { path: string; exists: boolean };
  };
  base_urls: { v1: string; v2: string; creative_lab: string | null; public_web: string };
  workspace: { path: string | null; writable: boolean | null };
  /** Names among .env / .env.local present in cwd — never read. */
  cwd_env_candidates: string[];
  slicers?: unknown;
  api?: { balance: number } | { error: string } | null;
}

export type { SlicerDetection } from "./slicers.js";

/** Injectable slicer detection (tests pass a fake); the default is internal/slicers.ts. */
export type SlicerDetector = (env?: Partial<DetectionEnv>) => SlicerDetection | unknown;

export interface DoctorOptions {
  flags: GlobalFlags;
  checkApi: boolean;
  checkSlicers: boolean;
  /** Drives the local checks (default process.env). `--check-api` resolves through loadConfig, which reads process.env like every API command. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  detectSlicers?: SlicerDetector;
  probeBalance?: () => Promise<number>;
}

export interface DoctorApiFailure {
  /** `credentials`: no usable credential could be resolved; `balance`: the single GET failed. */
  stage: "credentials" | "balance";
  error: unknown;
}

export interface DoctorOutcome {
  report: DoctorReport;
  /** Set when --check-api did not end with api_ready true; the command maps it to an exit code. */
  apiFailure: DoctorApiFailure | null;
}

const REQUIRED_NODE_MAJOR = 24;
const CWD_ENV_CANDIDATES = [".env", ".env.local"] as const;
/** Mirrors config.ts: an empty or placeholder key means "unset". */
const PLACEHOLDER_KEYS = new Set(["", "YOUR_MESHY_API_KEY_HERE"]);

function keyPresent(value: string | null | undefined): boolean {
  return typeof value === "string" && !PLACEHOLDER_KEYS.has(value.trim());
}

function stripTrail(s: string): string {
  return s.replace(/\/+$/, "");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Replace every known secret in free text; paths and verdicts are all a report needs. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function summarizeSlicers(detection: unknown): string {
  if (detection && typeof detection === "object") {
    const d = detection as Partial<SlicerDetection>;
    const found = Array.isArray(d.slicers) ? d.slicers : null;
    if (found) {
      const names = found.map((s) => (s && typeof s === "object" && typeof s.name === "string" ? s.name : "?"));
      const platform = typeof d.platform === "string" ? d.platform : process.platform;
      return found.length === 0
        ? `no registered slicer detected on ${platform}`
        : `${found.length} slicer(s) detected on ${platform}: ${names.join(", ")}`;
    }
  }
  return "slicer detection completed";
}

/** Run the diagnosis and also return the raw API failure for exit-code mapping. */
export async function runDoctorDetailed(opts: DoctorOptions): Promise<DoctorOutcome> {
  const { flags } = opts;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const secrets: string[] = [];
  if (typeof flags.apiKey === "string") secrets.push(flags.apiKey.trim());
  if (typeof env["MESHY_API_KEY"] === "string") secrets.push(env["MESHY_API_KEY"].trim());

  // --- CLI and runtime -----------------------------------------------------
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= REQUIRED_NODE_MAJOR;
  checks.push({ id: "cli", status: "ok", detail: `meshy-cli ${VERSION} on node ${process.version} (${process.platform} ${process.arch})` });
  checks.push({
    id: "node",
    status: nodeOk ? "ok" : "fail",
    detail: nodeOk
      ? `node ${process.version} satisfies the required >=${REQUIRED_NODE_MAJOR}`
      : `node ${process.version} is below the required >=${REQUIRED_NODE_MAJOR}; install Node ${REQUIRED_NODE_MAJOR} or newer`,
  });

  // --- Base URLs (same precedence as config.ts, resolved without a credential) ---
  const v1 = stripTrail(flags.baseUrlV1 ?? env["MESHY_BASE_URL_V1"] ?? DEFAULT_BASE_URL_V1);
  const v2 = stripTrail(flags.baseUrlV2 ?? env["MESHY_BASE_URL_V2"] ?? DEFAULT_BASE_URL_V2);
  const explicitCreativeLab = flags.baseUrlCreativeLab ?? env["MESHY_BASE_URL_CREATIVE_LAB"];
  const creativeLab = explicitCreativeLab ? stripTrail(explicitCreativeLab) : deriveCreativeLabBase(v1);
  const publicWeb = derivePublicWebBase(v1);
  let v1Parses = true;
  try {
    new URL(v1);
  } catch {
    v1Parses = false;
  }
  checks.push({
    id: "base_urls",
    status: v1Parses && creativeLab !== null ? "ok" : "warn",
    detail: !v1Parses
      ? `v1 base ${JSON.stringify(v1)} is not a valid URL (check --base-url-v1 / MESHY_BASE_URL_V1)`
      : creativeLab === null
        ? `v1 ${v1}; v2 ${v2}; Creative Lab base cannot be derived from a non-standard v1 path — pass --base-url-creative-lab when using creative-lab commands`
        : `v1 ${v1}; v2 ${v2}; creative-lab ${creativeLab}; public-web ${publicWeb}`,
  });

  // --- Credential sources: presence only ----------------------------------
  const flagPresent = keyPresent(flags.apiKey);
  const envPresent = keyPresent(env["MESHY_API_KEY"]);
  let apiKeyFilePath: string | null = null;
  let apiKeyFileUsable = false;
  if (flags.envFile) {
    apiKeyFilePath = resolvePath(cwd, flags.envFile);
    try {
      const loaded = loadEnvFile(flags.envFile, cwd);
      apiKeyFilePath = loaded.path;
      if (loaded.apiKey) secrets.push(loaded.apiKey.trim());
      const ignored = loaded.otherKeys.length > 0 ? `; ${loaded.otherKeys.length} other key(s) ignored: ${loaded.otherKeys.join(", ")}` : "";
      if (keyPresent(loaded.apiKey)) {
        apiKeyFileUsable = true;
        checks.push({ id: "api_key_file", status: "ok", detail: `${loaded.path} defines MESHY_API_KEY (value not shown${ignored})` });
      } else {
        checks.push({ id: "api_key_file", status: "fail", detail: `${loaded.path} defines no usable MESHY_API_KEY (missing, empty or placeholder${ignored})` });
      }
    } catch (err) {
      checks.push({ id: "api_key_file", status: "fail", detail: messageOf(err) });
    }
  } else {
    checks.push({ id: "api_key_file", status: "skipped", detail: "--api-key-file not given" });
  }
  const storedPath = credentialsPath(v1, env);
  const storedExists = isFile(storedPath);
  const anySource = flagPresent || envPresent || apiKeyFileUsable || storedExists;
  checks.push({
    id: "credentials",
    status: anySource ? "ok" : "warn",
    detail:
      `sources present: --api-key=${flagPresent ? "yes" : "no"}, MESHY_API_KEY=${envPresent ? "yes" : "no"}, ` +
      `--api-key-file=${flags.envFile ? (apiKeyFileUsable ? "usable" : "unusable") : "none"}, ` +
      `stored profile=${storedExists ? "present" : "absent"} (${storedPath}); values are never read by doctor` +
      (anySource ? "" : ". API commands need --api-key, MESHY_API_KEY, --api-key-file <file> or `meshy auth login`"),
  });

  // --- Workspace -----------------------------------------------------------
  let workspace: DoctorReport["workspace"] = { path: null, writable: null };
  if (flags.workspace) {
    const abs = resolvePath(cwd, flags.workspace);
    workspace = { path: abs, writable: null };
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(abs);
    } catch {
      st = null;
    }
    if (!st) {
      checks.push({ id: "workspace", status: "warn", detail: `${abs} does not exist yet; local tools will create it on first write` });
    } else if (!st.isDirectory()) {
      workspace.writable = false;
      checks.push({ id: "workspace", status: "fail", detail: `${abs} is not a directory` });
    } else {
      try {
        accessSync(abs, fsConstants.W_OK);
        workspace.writable = true;
        checks.push({ id: "workspace", status: "ok", detail: `${abs} is a writable directory` });
      } catch {
        workspace.writable = false;
        checks.push({ id: "workspace", status: "fail", detail: `${abs} is not writable by this user` });
      }
    }
  } else {
    checks.push({ id: "workspace", status: "skipped", detail: "--workspace not given (files land next to their targets)" });
  }

  // --- cwd .env candidates: names only --------------------------------------
  const cwdEnvCandidates = CWD_ENV_CANDIDATES.filter((name) => isFile(resolvePath(cwd, name)));
  checks.push({
    id: "cwd_env_files",
    status: "ok",
    detail:
      cwdEnvCandidates.length === 0
        ? `no .env or .env.local in ${cwd} (none is ever read automatically)`
        : `${cwdEnvCandidates.join(", ")} found in ${cwd}; not read — pass --api-key-file <file> to use one`,
  });

  const report: DoctorReport = {
    cli: { version: VERSION, node: process.version, platform: process.platform, arch: process.arch },
    local_ready: nodeOk && VERSION.length > 0,
    api_ready: null,
    checks,
    credential_sources: {
      flag: flagPresent,
      env: envPresent,
      api_key_file: apiKeyFilePath,
      stored_profile: { path: storedPath, exists: storedExists },
    },
    base_urls: { v1, v2, creative_lab: creativeLab, public_web: publicWeb },
    workspace,
    cwd_env_candidates: cwdEnvCandidates,
    slicers: null,
    api: null,
  };

  // --- --check-api: one free GET /balance ------------------------------------
  let apiFailure: DoctorApiFailure | null = null;
  if (opts.checkApi) {
    let config: MeshyConfig | null = null;
    try {
      config = loadConfig(configOverridesFrom(flags));
      secrets.push(config.apiKey);
    } catch (err) {
      apiFailure = { stage: "credentials", error: err };
      report.api_ready = false;
      report.api = { error: messageOf(err) };
      checks.push({ id: "api", status: "fail", detail: `no usable credential: ${messageOf(err)}` });
    }
    if (config) {
      const resolved = config;
      const probe = opts.probeBalance ?? (async (): Promise<number> => (await new MeshyClient(resolved).balance.get()).balance);
      try {
        const balance = await probe();
        report.api_ready = true;
        report.api = { balance };
        checks.push({
          id: "api",
          status: "ok",
          detail: `GET ${resolved.baseUrlV1}/balance succeeded with the ${resolved.credentialSource} credential; balance ${balance}`,
        });
      } catch (err) {
        apiFailure = { stage: "balance", error: err };
        report.api_ready = false;
        report.api = { error: messageOf(err) };
        checks.push({ id: "api", status: "fail", detail: `GET /balance failed: ${messageOf(err)}` });
      }
    }
  } else {
    checks.push({ id: "api", status: "skipped", detail: "not requested (pass --check-api for one free GET /balance)" });
  }

  // --- --check-slicers: local detection only ---------------------------------
  if (opts.checkSlicers) {
    try {
      const detect: SlicerDetector = opts.detectSlicers ?? ((overrides) => detectSlicersImpl(overrides));
      // Detection reads the real platform/filesystem; only the environment block is injectable.
      const detection = detect(opts.env ? { env: opts.env as Record<string, string | undefined> } : undefined);
      report.slicers = detection;
      checks.push({ id: "slicers", status: "ok", detail: summarizeSlicers(detection) });
    } catch (err) {
      report.slicers = { error: messageOf(err) };
      checks.push({ id: "slicers", status: "fail", detail: `slicer detection failed: ${messageOf(err)}` });
    }
  } else {
    checks.push({ id: "slicers", status: "skipped", detail: "not requested (pass --check-slicers)" });
  }

  // Free text is the only place a secret could slip through; strip every known value.
  for (const check of checks) check.detail = scrub(check.detail, secrets);
  if (report.api && "error" in report.api) report.api = { error: scrub(report.api.error, secrets) };

  return { report, apiFailure };
}

/** Run the diagnosis; never throws for a missing credential or a failed check. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  return (await runDoctorDetailed(opts)).report;
}
