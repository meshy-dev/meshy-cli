/**
 * view — show a local .glb/.gltf in a browser viewer (D-094).
 *
 * Local only: no API, no credential. The model is served read-only on
 * 127.0.0.1 and the page opens in the default browser unless --no-open. The
 * envelope (with `url`) is printed as soon as the server listens; the command
 * then keeps serving until Ctrl-C or VIEW_IDLE_MS without a request.
 * `--detach` hands the server to a background process and returns at once,
 * which is what an agent wants: it runs one command and gets a URL.
 */

import { spawn } from "node:child_process";
import { Command } from "commander";
import { emitResult, openCommand } from "../internal/command-helpers.js";
import { abortSignal } from "../internal/context.js";
import { UsageError } from "../internal/errors.js";
import { openBrowser } from "../internal/oauth.js";
import { buildLocalRuntime } from "../internal/runtime.js";
import { resolveViewModel, startViewer, VIEW_IDLE_MS, type ViewModel } from "../internal/viewer.js";

interface ViewOptions {
  open: boolean;
  detach?: boolean;
}

/** Set on the background child that `--detach` starts; it serves and reports its URL on stdout. */
const CHILD_ENV = "MESHY_VIEW_CHILD";

function describe(model: ViewModel, url: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { url, file: model.path, bytes: model.bytes, idle_timeout_s: VIEW_IDLE_MS / 1000, ...extra };
}

/** Start the server in a detached child and wait for the URL it prints. */
function startDetached(model: ViewModel): Promise<{ url: string; pid: number }> {
  const script = process.argv[1];
  if (!script) throw new UsageError("--detach needs the meshy entry script");
  const child = spawn(process.execPath, [script, "view", model.path, "--no-open", "--no-update-check"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, [CHILD_ENV]: "1" },
  });
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new UsageError(`the background viewer did not start: ${why}`));
    };
    const timer = setTimeout(() => fail("no URL within 10 s"), 10_000);
    child.on("error", (err) => fail(err.message));
    child.on("exit", (code) => fail(`it exited with ${code}`));
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n")[0]!;
      if (!out.includes("\n") || settled) return;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.stdout!.destroy();
      child.unref();
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(line)) return fail(`unexpected output '${line}'`);
      settled = true;
      resolve({ url: line, pid: child.pid! });
    });
  });
}

export function buildViewCommand(): Command {
  return new Command("view")
    .description(
      "Show a local .glb or .gltf in an interactive 3D viewer in the browser. Serves the model read-only on 127.0.0.1 " +
        `(nothing is uploaded) and stops after ${VIEW_IDLE_MS / 60_000} min without a request or on Ctrl-C. ` +
        "--detach serves from a background process and returns the URL at once",
    )
    .argument("<model>", "path to a .glb or .gltf file")
    .option("--no-open", "print the URL without opening a browser")
    .option("--detach", "serve from a background process and return immediately")
    .action(async (input: string, opts: ViewOptions, thisCmd: Command) => {
      const opened = openCommand(thisCmd, "view");
      if (opened.flags.output !== undefined) throw new UsageError("--output/-o has no meaning for view; this command writes no files");
      buildLocalRuntime(opened.flags);
      const model = resolveViewModel(input);

      if (opts.detach) {
        const { url, pid } = await startDetached(model);
        const browserOpened = opts.open ? await openBrowser(url) : false;
        await emitResult(opened, describe(model, url, { opened: browserOpened, detached: true, pid }));
        return;
      }

      const viewer = await startViewer(model);
      abortSignal().addEventListener("abort", () => viewer.close(), { once: true });
      if (process.env[CHILD_ENV]) {
        process.stdout.write(`${viewer.url}\n`);
      } else {
        const browserOpened = opts.open ? await openBrowser(viewer.url) : false;
        await emitResult(opened, describe(model, viewer.url, { opened: browserOpened, detached: false }));
      }
      await viewer.closed;
    });
}

export const viewCommand = buildViewCommand();
