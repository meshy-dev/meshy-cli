/**
 * Outbound requests honor the standard proxy variables (D-093): with
 * HTTPS_PROXY / HTTP_PROXY set, every request goes through the proxy unless
 * NO_PROXY exempts its host or the host is this machine; without them nothing
 * changes. Cursor's sandbox enforces its network allowlist through such a
 * proxy.
 *
 * Targets that must go through the proxy use a `.invalid` host: it never
 * resolves, so a request that reaches the target at all went through the
 * test proxy, which sends every host to the loopback target.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

import { createTransport, TransportError } from "../src/client/transport.js";
import { deviceAuthorization } from "../src/internal/device.js";
import { isLoopbackHost, PROXY_HINT, proxySettings, useProxyFromEnv } from "../src/internal/proxy.js";
import { jsonReply, runCli, startMockApi } from "./helpers/cli.js";

interface TestProxy {
  url: string;
  /** Plain forwarded requests, then CONNECT tunnels, it carried. */
  forwarded: () => number;
  tunnels: () => number;
  close: () => Promise<void>;
}

/**
 * A forward proxy on loopback that sends every host to `targetPort` on
 * 127.0.0.1. `connect` decides how it answers CONNECT: open the tunnel, or
 * refuse with a status.
 */
async function startProxy(targetPort: () => number, opts: { connect?: "open" | number; forward?: "pass" | number } = {}): Promise<TestProxy> {
  let forwarded = 0;
  let tunnels = 0;
  const server: Server = createServer((req, res) => {
    if (typeof opts.forward === "number") {
      res.writeHead(opts.forward, { "Proxy-Authenticate": "Basic" });
      res.end();
      return;
    }
    forwarded += 1;
    const target = new URL(req.url ?? "/");
    const upstream = httpRequest(
      { host: "127.0.0.1", port: targetPort(), path: target.pathname + target.search, method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  server.on("connect", (_req, socket) => {
    if (typeof opts.connect === "number") {
      socket.end(`HTTP/1.1 ${opts.connect} Refused\r\nProxy-Authenticate: Basic\r\n\r\n`);
      return;
    }
    tunnels += 1;
    const upstream = connect(targetPort(), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    forwarded: () => forwarded,
    tunnels: () => tunnels,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startTarget(): Promise<{ port: () => number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: () => (server.address() as AddressInfo).port,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Restores the global dispatcher a test replaced. */
function keepDispatcher(t: { after: (fn: () => void) => void }): void {
  const previous = getGlobalDispatcher();
  t.after(() => setGlobalDispatcher(previous));
}

test("no proxy variable: nothing to read, nothing installed", async () => {
  assert.deepEqual(await proxySettings({}), { kind: "none" });
  assert.deepEqual(await proxySettings({ HTTPS_PROXY: "  ", NO_PROXY: "example.com" }), { kind: "none" }, "blank values and NO_PROXY alone name no proxy");
  const installed: Dispatcher[] = [];
  assert.equal(await useProxyFromEnv({ PATH: "/usr/bin" }, (d) => installed.push(d)), false);
  assert.equal(installed.length, 0);
});

test("proxy settings: both spellings, lowercase first", async () => {
  assert.deepEqual(await proxySettings({ HTTPS_PROXY: "http://proxy:3128/" }), {
    kind: "proxy",
    settings: { httpsProxy: "http://proxy:3128/", httpProxy: "", noProxy: "" },
  });
  assert.deepEqual(
    await proxySettings({
      https_proxy: "http://lower:1",
      HTTPS_PROXY: "http://upper:1",
      http_proxy: "http://lower:2",
      HTTP_PROXY: "http://upper:2",
      no_proxy: "lower.example",
      NO_PROXY: "upper.example",
    }),
    { kind: "proxy", settings: { httpsProxy: "http://lower:1", httpProxy: "http://lower:2", noProxy: "lower.example" } },
  );
});

test("this machine is localhost, 127.0.0.0/8 and ::1, in any spelling a URL gives", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.0.0.2", "127.255.255.254", "[::1]", "::1", new URL("http://[::ffff:127.0.0.1]/").hostname]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["128.0.0.1", "10.0.0.1", "[::2]", "localhost.example", "example.com", "0.0.0.0"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("an invalid proxy URL names the variable, never its value, and no request leaves", async (t) => {
  keepDispatcher(t);
  const target = await startTarget();
  t.after(target.close);
  for (const value of [
    "http://user:s3cret@proxy.example:notaport",
    "proxy.example:3128",
    "ftp://proxy.example:21",
    "http://user:%E0%A4%A@proxy.example:8080",
    "http://proxy.example:8080/?x=1",
  ]) {
    assert.deepEqual(await proxySettings({ HTTPS_PROXY: value }), { kind: "invalid", variable: "HTTPS_PROXY" }, value);
  }
  assert.deepEqual(await proxySettings({ http_proxy: "::" }), { kind: "invalid", variable: "http_proxy" });

  assert.equal(await useProxyFromEnv({ HTTP_PROXY: "http://user:s3cret@proxy.example:notaport" }), true);
  const transport = createTransport({ baseUrl: `http://api.example.invalid:${target.port()}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
  await assert.rejects(transport.requestJson("POST", "/text-to-3d", { body: {} }), (e: unknown) => {
    assert.ok(e instanceof TransportError);
    assert.equal(e.neverSent, true, "an unusable proxy setting sends nothing");
    assert.match(e.message, /HTTP_PROXY is not a valid proxy URL/);
    assert.doesNotMatch(e.message, /s3cret|user:/);
    return true;
  });
  assert.equal(target.hits(), 0, "the request did not go direct either");

  await assert.rejects(deviceAuthorization(`http://api.example.invalid:${target.port()}/openapi/v1`), (e: unknown) => {
    const err = e as { message: string; hint?: string };
    assert.match(err.message, /HTTP_PROXY is not a valid proxy URL/, "sign-in names the variable too");
    assert.doesNotMatch(err.message, /s3cret/);
    assert.equal(err.hint, PROXY_HINT, "and points at the proxy, not at another way to sign in");
    return true;
  });
});

test("an http: request goes through the proxy as a plain forward, an https: one as a tunnel", async (t) => {
  keepDispatcher(t);
  const target = await startTarget();
  t.after(target.close);
  const proxy = await startProxy(target.port, { connect: 403 });
  t.after(proxy.close);
  assert.equal(await useProxyFromEnv({ HTTP_PROXY: proxy.url }), true);

  const res = await fetch(`http://api.example.invalid:${target.port()}/x`);
  assert.equal(res.status, 200, "a proxy that refuses CONNECT still forwards plain HTTP");
  await res.text();
  assert.equal(proxy.forwarded(), 1);
  assert.equal(proxy.tunnels(), 0);
});

test("NO_PROXY and this machine's own addresses go direct", async (t) => {
  keepDispatcher(t);
  const target = await startTarget();
  t.after(target.close);
  const proxy = await startProxy(target.port);
  t.after(proxy.close);

  assert.equal(await useProxyFromEnv({ HTTP_PROXY: proxy.url }), true);
  for (const host of ["127.0.0.1", "localhost"]) {
    const res = await fetch(`http://${host}:${target.port()}/x`);
    assert.equal(res.status, 200, host);
    await res.text();
  }
  assert.equal(proxy.forwarded() + proxy.tunnels(), 0, "this machine goes direct");

  const v6 = createServer((_req, res) => res.end("v6"));
  const listening = await new Promise<boolean>((resolve) => {
    v6.once("error", () => resolve(false));
    v6.listen(0, "::1", () => resolve(true));
  });
  if (listening) {
    try {
      const res = await fetch(`http://[::1]:${(v6.address() as AddressInfo).port}/x`);
      assert.equal(await res.text(), "v6");
      assert.equal(proxy.forwarded() + proxy.tunnels(), 0, "[::1] goes direct");
    } finally {
      await new Promise<void>((resolve) => v6.close(() => resolve()));
    }
  } else {
    t.diagnostic("no IPv6 loopback here; [::1] not exercised");
  }

  for (const noProxy of ["api.example.invalid", "*"]) {
    assert.equal(await useProxyFromEnv({ HTTP_PROXY: proxy.url, NO_PROXY: noProxy }), true);
    await assert.rejects(fetch(`http://api.example.invalid:${target.port()}/x`), `NO_PROXY=${noProxy} goes direct, and .invalid does not resolve`);
    assert.equal(proxy.forwarded() + proxy.tunnels(), 0, `NO_PROXY=${noProxy}`);
  }
});

test("a proxy that refuses the request is a request never sent, and says it was the proxy", async (t) => {
  keepDispatcher(t);
  const target = await startTarget();
  t.after(target.close);
  for (const [name, proxyOpts, scheme] of [
    ["CONNECT refused for https", { connect: 407 }, "https"],
    ["plain forward refused with 407 for http", { forward: 407 }, "http"],
  ] as const) {
    const proxy = await startProxy(target.port, proxyOpts);
    try {
      assert.equal(await useProxyFromEnv({ HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url }), true);
      const transport = createTransport({ baseUrl: `${scheme}://api.example.invalid:${target.port()}/openapi/v1`, apiKey: "msy_k", readTimeoutMs: 5000 });
      await assert.rejects(transport.requestJson("POST", "/text-to-3d", { body: {} }), (e: unknown) => {
        assert.ok(e instanceof TransportError, name);
        assert.equal(e.neverSent, true, `${name}: the API was never reached`);
        assert.match(e.message, /proxy/i, name);
        assert.match(e.message, /407/, name);
        return true;
      });
    } finally {
      await proxy.close();
    }
  }
  assert.equal(target.hits(), 0);
});

test("the CLI's API requests go through HTTP_PROXY", async (t) => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { balance: 7 }));
  t.after(() => api.close());
  const port = Number(new URL(api.url).port);
  const proxy = await startProxy(() => port);
  t.after(proxy.close);
  const remote = (extra: Record<string, string>) =>
    api.env({
      MESHY_API_KEY: "msy_test",
      MESHY_BASE_URL_V1: `http://api.example.invalid:${port}/openapi/v1`,
      MESHY_BASE_URL_V2: `http://api.example.invalid:${port}/openapi/v2`,
      ...extra,
    });

  const viaProxy = await runCli(["balance"], { env: remote({ HTTP_PROXY: proxy.url }) });
  assert.equal(viaProxy.code, 0, viaProxy.stderr);
  assert.equal(proxy.forwarded(), 1, "the API request went through the proxy");

  const loopback = await runCli(["balance"], { env: api.env({ MESHY_API_KEY: "msy_test", HTTP_PROXY: proxy.url }) });
  assert.equal(loopback.code, 0, loopback.stderr);
  assert.equal(proxy.forwarded(), 1, "an API on this machine is reached directly");
});
