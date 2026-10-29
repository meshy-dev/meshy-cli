import { VERSION } from "./version.js";

const MAX_CLIENT = 100;

/**
 * Shared User-Agent string for all outbound HTTP requests (API calls and
 * OAuth token exchanges). Format: meshy-cli/0.1.0 (darwin arm64; node v22.1.0)
 *
 * A tool that runs meshy-cli for its users, such as Meshy DCC Core, names
 * itself in MESHY_CLI_CLIENT ("meshy-dcc/0.2.2 (blender)"). The value is
 * appended so the API can tell which product a request came through. Only
 * printable ASCII is kept, which also keeps CR/LF out of the header.
 *
 * DeepSeek Harness sets DSH_SHELL=1 on every model shell call but lets a
 * plugin add only DSH_* variables, so the Meshy dsh plugin cannot set
 * MESHY_CLI_CLIENT itself; without it, such a call is tagged "dsh".
 */
export function userAgent(env: NodeJS.ProcessEnv = process.env): string {
  const base = `meshy-cli/${VERSION} (${process.platform} ${process.arch}; node ${process.version})`;
  const raw = env["MESHY_CLI_CLIENT"]?.trim() || (env["DSH_SHELL"] === "1" ? "dsh" : "");
  const client = raw.replace(/[^\x20-\x7e]/g, "").trim().slice(0, MAX_CLIENT);
  return client ? `${base} ${client}` : base;
}

export const USER_AGENT = userAgent();
