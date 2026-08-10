/**
 * Raw API passthrough: `meshy-cli api [--v1|--v2] <method> <path> [--data <json>] [--params <json>]`
 *
 * Prints the JSON body when the response is JSON, or raw text otherwise.
 * Non-2xx responses exit with code 1 and print an error summary on stderr.
 */

import { Command } from "commander";
import { emit } from "../internal/output.js";
import { parseJsonFlag } from "../internal/payload.js";
import { buildRuntime, readGlobalFlags } from "../internal/runtime.js";

export const apiCommand = new Command("api")
  .description("Raw HTTP passthrough to the Meshy API (JSON only)")
  .argument("<method>", "HTTP method: GET | POST | PUT | PATCH | DELETE")
  .argument("<path>", "API path (e.g. /text-to-3d or /balance)")
  .option("--v2", "use the v2 base URL (default: v1)")
  .option("--v1", "force v1 (default)")
  .option("--data <json>", "request body JSON (or @file.json)")
  .option("--params <json>", "query params JSON object")
  .action(async (method: string, path: string, opts: Record<string, unknown>, thisCmd: Command) => {
    const runtime = await buildRuntime(readGlobalFlags(thisCmd));
    const apiVersion = opts.v2 ? "v2" : "v1";
    const verb = method.toUpperCase();

    let finalPath = path.startsWith("/") ? path : `/${path}`;
    const params = parseJsonFlag(opts.params as string | undefined, "--params");
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) finalPath += (finalPath.includes("?") ? "&" : "?") + qs;

    const init: RequestInit = { method: verb };
    if (opts.data) {
      const body = parseJsonFlag(opts.data as string, "--data");
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }

    // The fetcher throws MeshyApiError (with credentialKind attached) on non-2xx,
    // so we only reach the body-reading code on success responses.
    const resp = await runtime.client.raw(apiVersion, verb, finalPath, init);
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* leave as text */
    }
    emit(parsed, { format: runtime.flags.format, file: runtime.flags.output });
  });
