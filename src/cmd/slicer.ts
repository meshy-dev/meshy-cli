/**
 * slicer — detect installed slicers and hand a model file to one of them.
 *
 * Purely local: no API, no credential, no network. `detect` reports the seven
 * registered slicers found on this machine (an empty list is a valid answer);
 * `open` launches only a registered, detected slicer at its detected path with
 * the file as one argument — no shell, no default-application fallback — and
 * reports `launch_requested`, which is not a claim that the import succeeded.
 */

import { Command } from "commander";
import { emitResult, openCommand, type OpenedCommand } from "../internal/command-helpers.js";
import { UsageError } from "../internal/errors.js";
import { buildLocalRuntime } from "../internal/runtime.js";
import { detectSlicers, LAUNCHABLE_EXTENSIONS, openInSlicer, SLICERS } from "../internal/slicers.js";

/** `-o` downloads assets elsewhere; here it would be silently ignored, so refuse it. */
function rejectOutputFlag(opened: OpenedCommand): void {
  if (opened.flags.output !== undefined) {
    throw new UsageError(`--output/-o has no meaning for ${opened.command}; this command writes no files`);
  }
}

const detectCommand = new Command("detect")
  .description(
    `Detect installed slicers (${SLICERS.map((s) => s.name).join(", ")}). Local only; an empty list is a successful result`,
  )
  .action(async (_opts: Record<string, never>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "slicer.detect", "v1");
    rejectOutputFlag(opened);
    buildLocalRuntime(opened.flags);
    const detection = detectSlicers();
    await emitResult(opened, detection, detection);
  });

const openCmd = new Command("open")
  .description(
    "Open a model file in a detected slicer. Launches the detected executable (macOS: open -a <bundle>) with the " +
      "file as a single argument and returns once the process started; it never waits for the GUI to close",
  )
  .requiredOption("--slicer <name>", "registered slicer name or id (see: meshy slicer detect)")
  .requiredOption("--file <path>", `model file to open (${[...LAUNCHABLE_EXTENSIONS].join(", ")})`)
  .action(async (opts: { slicer: string; file: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "slicer.open", "v1");
    rejectOutputFlag(opened);
    buildLocalRuntime(opened.flags);
    const launch = await openInSlicer(opts.file, opts.slicer);
    await emitResult(opened, launch, launch);
  });

export const slicerCommand = new Command("slicer")
  .description("Detect installed slicers and open models in them (no API key required)")
  .addCommand(detectCommand)
  .addCommand(openCmd);
