/**
 * Outbound requests honor the standard proxy variables (D-093): with
 * HTTPS_PROXY / HTTP_PROXY set, every request goes through the proxy unless
 * NO_PROXY exempts its host; without them nothing changes. Cursor's sandbox
 * enforces its network allowlist through such a proxy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

import { proxySettings, useProxyFromEnv } from "../src/internal/proxy.js";
import { jsonReply, runCli, startMockApi } from "./helpers/cli.js";

/** A forward proxy on loopback that counts the requests it carries (plain HTTP and CONNECT). */
async function startProxy(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const target = new URL(req.url ?? "/");
    const upstream = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  server.on("connect", (req, socket) => {
    hits += 1;
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host ?? "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("no proxy variable: no settings, nothing installed", () => {
  assert.equal(proxySettings({}), null);
  assert.equal(proxySettings({ HTTPS_PROXY: "  ", NO_PROXY: "example.com" }), null, "blank values and NO_PROXY alone name no proxy");
  const installed: Dispatcher[] = [];
  assert.equal(useProxyFromEnv({ PATH: "/usr/bin" }, (d) => installed.push(d)), false);
  assert.equal(installed.length, 0);
});

test("proxy settings read both spellings, lowercase first, and fill what is unset with empty strings", () => {
  assert.deepEqual(proxySettings({ HTTPS_PROXY: "http://proxy:3128" }), {
    httpsProxy: "http://proxy:3128",
    httpProxy: "",
    noProxy: "",
  });
  assert.deepEqual(
    proxySettings({
      https_proxy: "http://lower:1",
      HTTPS_PROXY: "http://upper:1",
      http_proxy: "http://lower:2",
      HTTP_PROXY: "http://upper:2",
      no_proxy: "lower.example",
      NO_PROXY: "upper.example",
    }),
    { httpsProxy: "http://lower:1", httpProxy: "http://lower:2", noProxy: "lower.example" },
  );
  assert.deepEqual(proxySettings({ HTTP_PROXY: "http://proxy:3128", NO_PROXY: "localhost,.internal" }), {
    httpsProxy: "",
    httpProxy: "http://proxy:3128",
    noProxy: "localhost,.internal",
  });
});

test("with a proxy variable, fetch goes through the proxy, and NO_PROXY exempts a host", async (t) => {
  const previous = getGlobalDispatcher();
  t.after(() => setGlobalDispatcher(previous));
  const target = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const proxy = await startProxy();
  t.after(proxy.close);
  const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`;

  assert.equal(useProxyFromEnv({ HTTP_PROXY: proxy.url }), true);
  assert.equal(await (await fetch(url)).text(), "ok");
  assert.equal(proxy.hits(), 1, "the request went through the proxy");

  assert.equal(useProxyFromEnv({ HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1" }), true);
  assert.equal(await (await fetch(url)).text(), "ok");
  assert.equal(proxy.hits(), 1, "NO_PROXY sent it direct");
});

test("the CLI's API requests go through HTTP_PROXY, and straight to the API without it", async (t) => {
  const api = await startMockApi((_req, res) => jsonReply(res, 200, { balance: 7 }));
  t.after(() => api.close());
  const proxy = await startProxy();
  t.after(proxy.close);

  const viaProxy = await runCli(["balance"], { env: api.env({ MESHY_API_KEY: "msy_test", HTTP_PROXY: proxy.url }) });
  assert.equal(viaProxy.code, 0, viaProxy.stderr);
  assert.equal(proxy.hits(), 1, "the API request went through the proxy");

  const direct = await runCli(["balance"], { env: api.env({ MESHY_API_KEY: "msy_test" }) });
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal(proxy.hits(), 1, "without a proxy variable the request goes direct");

  const exempt = await runCli(["balance"], {
    env: api.env({ MESHY_API_KEY: "msy_test", HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1" }),
  });
  assert.equal(exempt.code, 0, exempt.stderr);
  assert.equal(proxy.hits(), 1, "NO_PROXY sent it direct");
});
