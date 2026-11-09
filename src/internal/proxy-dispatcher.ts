/**
 * The undici side of D-093, loaded only when a proxy variable is set (see
 * proxy.ts): checking proxy URLs as undici would use them, and the global
 * dispatcher that sends this machine direct and everything else through
 * EnvHttpProxyAgent.
 */

import { Agent, Dispatcher, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";

import { isLoopbackHost, PROXY_INVALID_CODE, type ProxyFromEnv } from "./proxy.js";

/** Whether undici accepts value as a proxy URL: http(s), a host, nothing it cannot decode. */
export function isUsableProxyUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if ((protocol !== "http:" && protocol !== "https:") || hostname === "") return false;
    void new ProxyAgent({ uri: value }).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends requests for this machine (localhost, 127.0.0.0/8, ::1) direct and
 * every other one through the proxy dispatcher. NO_PROXY cannot express a
 * range, and appending hosts to it would break NO_PROXY=*.
 */
class LoopbackDirect extends Dispatcher {
  constructor(
    private readonly proxied: Dispatcher,
    private readonly direct: Dispatcher,
  ) {
    super();
  }

  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = opts.origin === undefined ? undefined : new URL(String(opts.origin));
    return (origin && isLoopbackHost(origin.hostname) ? this.direct : this.proxied).dispatch(opts, handler);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const done = Promise.all([this.proxied.close(), this.direct.close()]).then(() => undefined);
    if (!callback) return done;
    void done.then(callback);
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const err = typeof errOrCallback === "function" ? null : (errOrCallback ?? null);
    const cb = typeof errOrCallback === "function" ? errOrCallback : callback;
    const done = Promise.all([this.proxied.destroy(err), this.direct.destroy(err)]).then(() => undefined);
    if (!cb) return done;
    void done.then(cb);
  }
}

function invalidProxyError(variable: string): Error {
  const err = new Error(`${variable} is not a valid proxy URL (expected http://host:port or https://host:port); fix or unset it`);
  (err as { code?: string }).code = PROXY_INVALID_CODE;
  return err;
}

/** Installs the global dispatcher for a proxy setting, or one whose every connection fails for an unusable one. */
export function installProxy(
  proxy: Exclude<ProxyFromEnv, { kind: "none" }>,
  install: (dispatcher: Dispatcher) => void = setGlobalDispatcher,
): void {
  if (proxy.kind === "invalid") {
    install(new Agent({ connect: (_opts, callback) => callback(invalidProxyError(proxy.variable), null) }));
    return;
  }
  install(new LoopbackDirect(new EnvHttpProxyAgent({ ...proxy.settings, proxyTunnel: false }), new Agent()));
}
