/**
 * Outbound requests honor the standard proxy variables (D-093).
 *
 * Node's fetch ignores HTTPS_PROXY / HTTP_PROXY / NO_PROXY unless Node itself
 * was started with NODE_USE_ENV_PROXY=1 (22.21+, 24+), so a command run behind
 * a proxy (Cursor's sandbox enforces its network allowlist through one, and so
 * do many corporate networks) failed at its first request. When one of those
 * variables is set, the CLI installs a global dispatcher once, at start, so
 * every fetch — API, sign-in, downloads, the update check — goes through the
 * proxy, on every Node version the CLI supports. Without the variables
 * nothing changes.
 *
 * - An http: URL goes to an http:// proxy as a plain forwarded request, as
 *   curl sends it; an https: URL goes through a CONNECT tunnel. undici always
 *   tunnels through an https:// proxy, http: URLs included.
 * - Hosts in NO_PROXY go direct, and this machine always does (localhost,
 *   127.0.0.0/8, ::1), as Go's net/http does, so a credential for a local API
 *   never crosses the proxy in the clear.
 * - A proxy value undici cannot use sends nothing at all, rather than going
 *   direct, and the error names the variable, never its value, which may hold
 *   a password.
 */

import { BlockList, isIP } from "node:net";
import type { Dispatcher } from "undici";

export interface ProxySettings {
  /** Proxy for https: URLs; "" = use httpProxy. */
  httpsProxy: string;
  /** Proxy for http: URLs (and https: ones when httpsProxy is ""); "" = none. */
  httpProxy: string;
  /** Hosts that go direct, as NO_PROXY lists them; "" = none. */
  noProxy: string;
}

export type ProxyFromEnv =
  | { kind: "none" }
  /** The named variable holds something undici cannot use as a proxy. */
  | { kind: "invalid"; variable: string }
  | { kind: "proxy"; settings: ProxySettings };

/** The code of the error a request fails with while the proxy setting is unusable. */
export const PROXY_INVALID_CODE = "MESHY_PROXY_INVALID";

/** What to check when a request failed at the proxy. */
export const PROXY_HINT = "Check HTTPS_PROXY, HTTP_PROXY and NO_PROXY (or unset them)";

/** The first variable among names with a non-blank value: lowercase first, as curl and undici read them. */
function first(env: NodeJS.ProcessEnv, ...names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

/**
 * The proxy the environment names. Unset values are "", never undefined:
 * undici would otherwise read process.env again. undici, which checks the
 * URLs, is loaded only when a proxy variable is set: every command pays for
 * it otherwise (~40 ms at start).
 */
export async function proxySettings(env: NodeJS.ProcessEnv = process.env): Promise<ProxyFromEnv> {
  const https = first(env, "https_proxy", "HTTPS_PROXY");
  const http = first(env, "http_proxy", "HTTP_PROXY");
  if (!https && !http) return { kind: "none" };
  const { isUsableProxyUrl } = await import("./proxy-dispatcher.js");
  for (const named of [https, http]) {
    if (named && !isUsableProxyUrl(named.value)) return { kind: "invalid", variable: named.name };
  }
  return {
    kind: "proxy",
    settings: {
      httpsProxy: https?.value ?? "",
      httpProxy: http?.value ?? "",
      noProxy: first(env, "no_proxy", "NO_PROXY")?.value ?? "",
    },
  };
}

// BlockList also matches an IPv4-mapped IPv6 address (::ffff:127.0.0.1) against the IPv4 rule.
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Whether a URL hostname is this machine: localhost, 127.0.0.0/8, ::1 (bracketed or not). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return LOOPBACK.check(host, "ipv4");
  if (family === 6) return LOOPBACK.check(host, "ipv6");
  return false;
}

/**
 * Routes every fetch through the proxy the environment names. Returns whether
 * it installed a dispatcher; a no-op when no proxy variable is set. With an
 * unusable value it installs one whose every connection fails, so nothing
 * goes direct behind the user's back. Never throws.
 */
export async function useProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  install?: (dispatcher: Dispatcher) => void,
): Promise<boolean> {
  const proxy = await proxySettings(env);
  if (proxy.kind === "none") return false;
  const { installProxy } = await import("./proxy-dispatcher.js");
  installProxy(proxy, install);
  return true;
}

/** undici's own errors for a proxy that refused a request (pinned by tests/proxy.test.ts). */
const PROXY_REFUSALS = [/^Proxy response \(\d{3}\) !== 200 when HTTP Tunneling$/, /^Proxy Authentication Required \(407\)$/];

/**
 * Why a fetch failed at the proxy, before reaching its target: the proxy
 * setting is unusable, or the proxy refused the request (a CONNECT answered
 * other than 200, a forwarded request answered 407). Undefined for any other
 * failure. Either way the target was never reached.
 */
export function proxyFailure(err: unknown): string | undefined {
  // fetch wraps it: "fetch failed" → (a refused tunnel: "Request was cancelled.") → undici's error.
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1, cause = cause.cause) {
    if ((cause as { code?: unknown }).code === PROXY_INVALID_CODE) return cause.message;
    const { message } = cause;
    if (PROXY_REFUSALS.some((re) => re.test(message))) return `the proxy refused the request: ${message}`;
  }
  return undefined;
}

/** A fetch failure for a message: the proxy's part when it failed there, else the error's own. */
export function fetchErrorMessage(err: unknown): string {
  return proxyFailure(err) ?? (err instanceof Error ? err.message : String(err));
}
