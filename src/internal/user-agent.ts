import { agentToken, detectAgent, type AgentDetection } from "./agent.js";
import { VERSION } from "./version.js";

const MAX_CLIENT = 100;

/**
 * User-Agent string for outbound HTTP requests. Format:
 *
 *   meshy-cli/<version> (<platform> <arch>; node <version>[; agent <id>[/<surface>]])[ <client>]
 *
 * The agent segment names the AI agent running the command (internal/agent.ts)
 * and goes only to Meshy (apiUserAgent). It sits inside the parentheses, from
 * which the known readers (the account settings page, the API's client_host)
 * take only the platform, so they read the same platform and tool name with it
 * as without it (D-092).
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

const NO_AGENT: AgentDetection = { agent: null, override: "unset" };

/**
 * Without the agent segment: what every request sent before D-092. For the
 * requests that follow redirects to wherever they lead — sign-in (OAuth,
 * device), the preflight of an input URL, asset downloads — since the host
 * they end on is not chosen here.
 */
export const USER_AGENT = userAgent(process.env, NO_AGENT);

const AGENT_USER_AGENT = userAgent();

function isMeshyOrLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (["meshy.ai", "meshy.cn"].some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * For the API transport to `baseUrl`: names the agent when its origin is
 * Meshy's (meshy.ai, meshy.cn and their subdomains) or a loopback host — the
 * user's own machine, a Meshy server run locally; any other origin (a custom
 * MESHY_BASE_URL_*) gets USER_AGENT. The transport never follows a redirect and
 * refuses a URL outside its base, so this origin is the only one it reaches.
 */
export function apiUserAgent(baseUrl: string): string {
  try {
    return isMeshyOrLoopback(new URL(baseUrl).hostname) ? AGENT_USER_AGENT : USER_AGENT;
  } catch {
    return USER_AGENT;
  }
}
