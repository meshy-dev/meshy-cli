/**
 * Outbound requests honor the standard proxy variables (D-093).
 *
 * Node's fetch ignores HTTPS_PROXY / HTTP_PROXY / NO_PROXY unless Node itself
 * was started with NODE_USE_ENV_PROXY=1 (22.21+, 24+), so a command run behind
 * a proxy (Cursor's sandbox enforces its network allowlist through one, and so
 * do many corporate networks) failed at its first request. When one of those
 * variables is set, the CLI installs undici's EnvHttpProxyAgent as the global
 * dispatcher once, at start, so every fetch — API, sign-in, downloads, the
 * update check — goes through the proxy, on every Node version the CLI
 * supports. Without the variables nothing changes.
 *
 * As curl does, an http: URL goes to the proxy as a plain forwarded request
 * and an https: URL through a CONNECT tunnel. Hosts in NO_PROXY, and this
 * machine (localhost, 127.0.0.1, ::1) always, go direct, so a credential for a
 * local API never passes through the proxy in the clear. A proxy URL that
 * does not parse sends nothing at all, rather than going direct, and the
 * error names the variable, never its value, which may hold a password.
 */

import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

export interface ProxySettings {
  /** Proxy for https: URLs; "" = use httpProxy. */
  httpsProxy: string;
  /** Proxy for http: URLs (and https: ones when httpsProxy is ""); "" = none. */
  httpProxy: string;
  /** Hosts that go direct, as NO_PROXY lists them, plus this machine's. */
  noProxy: string;
}

export type ProxyFromEnv =
  | { kind: "none" }
  /** The named variable holds something that is not an http: or https: URL. */
  | { kind: "invalid"; variable: string }
  | { kind: "proxy"; settings: ProxySettings };

/** This machine: never proxied (D-093), as Go's net/http does. */
// "[::1]" with brackets: undici matches the URL's bracketed host, and reads a
// bare "::1" as host ":" port 1.
const LOOPBACK_HOSTS = "localhost,127.0.0.1,[::1]";

/** The code of the error a request fails with while the proxy setting is unusable. */
export const PROXY_INVALID_CODE = "MESHY_PROXY_INVALID";

/** The first variable among names with a non-blank value: lowercase first, as curl and undici read them. */
function first(env: NodeJS.ProcessEnv, ...names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

function isProxyUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === "http:" || protocol === "https:") && hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The proxy the environment names. Unset values are "", never undefined:
 * undici would otherwise read process.env again.
 */
export function proxySettings(env: NodeJS.ProcessEnv = process.env): ProxyFromEnv {
  const https = first(env, "https_proxy", "HTTPS_PROXY");
  const http = first(env, "http_proxy", "HTTP_PROXY");
  if (!https && !http) return { kind: "none" };
  for (const named of [https, http]) {
    if (named && !isProxyUrl(named.value)) return { kind: "invalid", variable: named.name };
  }
  const noProxy = first(env, "no_proxy", "NO_PROXY")?.value;
  return {
    kind: "proxy",
    settings: {
      httpsProxy: https?.value ?? "",
      httpProxy: http?.value ?? "",
      noProxy: noProxy ? `${noProxy},${LOOPBACK_HOSTS}` : LOOPBACK_HOSTS,
    },
  };
}

function invalidProxyError(variable: string): Error {
  const err = new Error(`${variable} is not a valid proxy URL (expected http://host:port or https://host:port); fix or unset it`);
  (err as { code?: string }).code = PROXY_INVALID_CODE;
  return err;
}

/**
 * Routes every fetch through the proxy the environment names. Returns whether
 * it installed a dispatcher; a no-op when no proxy variable is set. With an
 * unusable value it installs one whose every connection fails, so nothing
 * goes direct behind the user's back.
 */
export function useProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  install: (dispatcher: Dispatcher) => void = setGlobalDispatcher,
): boolean {
  const proxy = proxySettings(env);
  switch (proxy.kind) {
    case "none":
      return false;
    case "invalid":
      install(new Agent({ connect: (_opts, callback) => callback(invalidProxyError(proxy.variable), null) }));
      return true;
    case "proxy":
      install(new EnvHttpProxyAgent({ ...proxy.settings, proxyTunnel: false }));
      return true;
  }
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
