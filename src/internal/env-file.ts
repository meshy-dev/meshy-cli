/**
 * Explicit `--api-key-file` support (a dotenv-style file read for MESHY_API_KEY only).
 *
 * Only MESHY_API_KEY is read. The file is parsed, never executed: no variable
 * expansion, no command substitution, no `source`. Other keys are ignored and
 * never change process configuration (PATH, NODE_OPTIONS, base URLs …).
 *
 * Grammar (one assignment per line):
 *   [export ]KEY=value        # value may be 'single' or "double" quoted
 *   # comment                 # blank lines and comments are skipped
 * An unquoted value ends at the first ` #` (whitespace then hash). Quoted
 * values keep their text verbatim, including `#`, `$` and spaces. `${…}`,
 * backticks and `$(…)` are not expanded — a key containing them is invalid.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { CliError } from "./errors.js";

export const ENV_FILE_MAX_BYTES = 64 * 1024;
const TARGET_KEY = "MESHY_API_KEY";

export interface EnvFileResult {
  path: string;
  /** null when the file is valid but carries no MESHY_API_KEY assignment. */
  apiKey: string | null;
  /** Other keys present in the file, reported so doctor can list them without values. */
  otherKeys: string[];
}

export function parseEnvFile(text: string, path = "<env-file>"): { apiKey: string | null; otherKeys: string[] } {
  let apiKey: string | null = null;
  let seenTarget = false;
  const otherKeys: string[] = [];
  const lines = text.split(/\r?\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      throw invalid(path, `line ${i + 1} is not a KEY=value assignment`);
    }
    const key = m[1]!;
    const rest = m[2] ?? "";
    let value: string;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]!;
      const end = rest.indexOf(quote, 1);
      if (end === -1) throw invalid(path, `line ${i + 1} has an unterminated ${quote} quote`);
      value = rest.slice(1, end);
      const trailing = rest.slice(end + 1).trim();
      if (trailing && !trailing.startsWith("#")) {
        throw invalid(path, `line ${i + 1} has unexpected text after the closing quote`);
      }
    } else {
      // Unquoted: comment starts at whitespace followed by '#'.
      const hash = rest.search(/\s#/);
      value = (hash === -1 ? rest : rest.slice(0, hash)).trim();
    }
    if (key !== TARGET_KEY) {
      otherKeys.push(key);
      continue;
    }
    if (seenTarget) throw invalid(path, `${TARGET_KEY} is assigned more than once`);
    seenTarget = true;
    if (/\$\{|\$\(|`|\$[A-Za-z_]/.test(value)) {
      throw new CliError({
        code: "auth",
        message: `${path}: ${TARGET_KEY} contains shell expansion syntax; env files are never evaluated — write the literal key`,
      });
    }
    if (/\s/.test(value)) {
      throw new CliError({ code: "auth", message: `${path}: ${TARGET_KEY} contains whitespace; quote the value or remove the stray text` });
    }
    apiKey = value;
  }
  return { apiKey, otherKeys };
}

/** Resolve, check and parse an explicit env file. Throws for anything that is not a readable, valid file. */
export function loadEnvFile(path: string, cwd: string = process.cwd()): EnvFileResult {
  const abs = isAbsolute(path) ? path : resolvePath(cwd, path);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new CliError({ code: "usage", message: `--api-key-file: file not found: ${path}` });
  }
  if (!st.isFile()) throw new CliError({ code: "usage", message: `--api-key-file: not a regular file: ${path}` });
  if (st.size > ENV_FILE_MAX_BYTES) {
    throw new CliError({ code: "usage", message: `--api-key-file: ${path} is larger than ${ENV_FILE_MAX_BYTES} bytes; env files hold keys, not data` });
  }
  const text = readFileSync(abs, "utf8");
  const parsed = parseEnvFile(text, path);
  return { path: abs, apiKey: parsed.apiKey, otherKeys: parsed.otherKeys };
}

function invalid(path: string, detail: string): CliError {
  return new CliError({ code: "usage", message: `--api-key-file: ${path}: ${detail}` });
}
