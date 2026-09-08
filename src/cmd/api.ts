/**
 * Raw API passthrough: `meshy-cli api [--v1|--v2|--creative-lab] <method> <path> [--data <json>] [--params <json>]`
 *
 * Prints the JSON body when the response is JSON, or raw text otherwise.
 * Non-2xx responses exit non-zero with an error payload. Write verbs are
 * never retried: the passthrough is a controlled escape hatch, not a client.
 */

import { Command, Option } from "commander";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson } from "../internal/command-helpers.js";
import { UsageError } from "../internal/errors.js";
import { parseJsonFlag } from "../internal/payload.js";
import { buildRuntime } from "../internal/runtime.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const apiCommand = new Command("api")
  .description("Raw HTTP passthrough to the Meshy API (JSON only)")
  .argument("<method>", "HTTP method: GET | POST | PUT | PATCH | DELETE")
  .argument("<path>", "API path (e.g. /text-to-3d or /balance)")
  .option("--v2", "use the v2 base URL (default: v1)")
  .option("--v1", "force v1 (default)")
  .addOption(new Option("--creative-lab", "use the Creative Lab base URL (paths like /figure/v1/prototype)"))
  .option("--data <json>", "request body JSON (or @file.json)")
  .option("--params <json>", "query params JSON object")
  .option("--save-json <file>", "v1: also save the raw response body to this file (never overwrites)")
  .action(async (method: string, path: string, opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "api", "legacy");
    rejectOutputFlagForV1(opened, opts.saveJson as string | undefined);
    const verb = method.toUpperCase();
    if (!METHODS.has(verb)) throw new UsageError(`unsupported HTTP method '${method}'. Expected: GET | POST | PUT | PATCH | DELETE`);
    if ((opts.v2 ? 1 : 0) + (opts.v1 ? 1 : 0) + (opts.creativeLab ? 1 : 0) > 1) {
      throw new UsageError("--v1, --v2 and --creative-lab are mutually exclusive");
    }
    const apiVersion = opts.v2 ? "v2" : opts.creativeLab ? "creative-lab" : "v1";
    const runtime = await buildRuntime(opened.flags);

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
    const saveJson = opts.saveJson as string | undefined;
    const saved = saveJson ? saveRawJson(saveJson, parsed, { workspace: opened.flags.workspaceRoot }) : null;
    await emitResult(
      opened,
      parsed,
      { http_status: resp.status, method: verb, path: finalPath, api: apiVersion, body: parsed, saved_json: saved },
      { legacyFile: opened.flags.output },
    );
  });
