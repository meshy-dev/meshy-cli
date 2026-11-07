import { agentToken, detectAgent, type AgentDetection } from "./agent.js";
import { VERSION } from "./version.js";

const MAX_CLIENT = 100;

/**
 * Shared User-Agent string for all outbound HTTP requests (API calls and
 * OAuth token exchanges). Format:
 *
 *   meshy-cli/<version> (<platform> <arch>; node <version>[; agent <id>[/<surface>]])[ <client>]
 *
 * The agent segment names the AI agent running the command (internal/agent.ts).
 * It sits inside the parentheses, which servers read only for the platform,
 * so a server that does not know it yet ignores it.
 *
 * A tool that runs meshy-cli for its users, such as Meshy DCC Core, names
 * itself in MESHY_CLI_CLIENT ("meshy-dcc/0.2.2 (blender)"). The value is
 * appended so the API can tell which product a request came through. Only
 * printable ASCII is kept, which also keeps CR/LF out of the header.
 *
 * DeepSeek Harness sets DSH_SHELL=1 on every model shell call but lets a
 * plugin add only DSH_* variables, so the Meshy dsh plugin cannot set
 * MESHY_CLI_CLIENT itself; without it, such a call is still tagged "dsh" after
 * the parentheses too, where servers that predate the agent segment read it.
 */
export function userAgent(env: NodeJS.ProcessEnv = process.env, detection: AgentDetection = detectAgent(env)): string {
  const agent = agentToken(detection);
  const base = `meshy-cli/${VERSION} (${process.platform} ${process.arch}; node ${process.version}${agent ? `; agent ${agent}` : ""})`;
  const raw = env["MESHY_CLI_CLIENT"]?.trim() || (env["DSH_SHELL"] === "1" ? "dsh" : "");
  const client = raw.replace(/[^\x20-\x7e]/g, "").trim().slice(0, MAX_CLIENT);
  return client ? `${base} ${client}` : base;
}

export const USER_AGENT = userAgent();
