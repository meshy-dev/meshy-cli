/**
 * Outbound requests honor the standard proxy variables (D-093).
 *
 * Node's fetch ignores HTTPS_PROXY / HTTP_PROXY / NO_PROXY unless Node itself
 * was started with NODE_USE_ENV_PROXY=1 (22.21+, 24+), so a command run behind
 * a proxy (Cursor's sandbox enforces its network allowlist through one, and so
 * do many corporate networks) failed at its first request. When one of those
 * variables is set, the CLI installs undici's EnvHttpProxyAgent as the global
 * dispatcher once, at start, so every fetch — API, sign-in, downloads, the
 * update check — goes through the proxy unless NO_PROXY exempts its host. On
 * every Node version the CLI supports; without the variables nothing changes.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

export interface ProxySettings {
  /** Proxy for https: URLs; "" = use httpProxy. */
  httpsProxy: string;
  /** Proxy for http: URLs (and https: ones when httpsProxy is ""); "" = none. */
  httpProxy: string;
  /** Hosts that go direct, as NO_PROXY lists them; "" = none. */
  noProxy: string;
}

/** The first non-blank value among names: lowercase first, as curl and undici read them. */
function first(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * The proxy the environment names, or null when it names none. Unset values
 * are "", never undefined: undici would otherwise read process.env again.
 */
export function proxySettings(env: NodeJS.ProcessEnv = process.env): ProxySettings | null {
  const httpsProxy = first(env, "https_proxy", "HTTPS_PROXY");
  const httpProxy = first(env, "http_proxy", "HTTP_PROXY");
  if (!httpsProxy && !httpProxy) return null;
  return { httpsProxy, httpProxy, noProxy: first(env, "no_proxy", "NO_PROXY") };
}

/**
 * Routes every fetch through the proxy the environment names. Returns whether
 * it did; a no-op when no proxy variable is set.
 */
export function useProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  install: (dispatcher: Dispatcher) => void = setGlobalDispatcher,
): boolean {
  const settings = proxySettings(env);
  if (!settings) return false;
  install(new EnvHttpProxyAgent(settings));
  return true;
}
