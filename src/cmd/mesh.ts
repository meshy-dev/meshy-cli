/**
 * mesh — local geometry helpers. No API, no credential, no network.
 *
 * `prepare-print` is the legacy `fix_obj.py` transform (Y-up → Z-up, scaled to a
 * target height, XY centred, grounded at Z=0) as a streaming, never-overwriting
 * command. The output file is chosen by the global `-o/--output <file>` flag:
 * Commander parses root options wherever they appear, so a second `--output`
 * declared here would never receive the value. Without `-o` the result is
 * `<stem>.print.obj` next to the input; `--in-place` replaces the input itself.
 */

import { Command } from "commander";
import { dirname, resolve as resolvePath } from "node:path";
import { emitResult, openCommand } from "../internal/command-helpers.js";
import { UsageError } from "../internal/errors.js";
import { parseNumber } from "../internal/flags.js";
import { DEFAULT_HEIGHT_MM, defaultOutputPath, prepareObjForPrint } from "../internal/obj-transform.js";
import { resolveWithinRoot } from "../internal/paths.js";
import { buildLocalRuntime } from "../internal/runtime.js";

const prepareCommand = new Command("prepare-print")
  .description(
    "Rotate a Y-up OBJ to Z-up, scale it to --height-mm, centre XY and rest it on Z=0 for slicing. " +
      "Writes <stem>.print.obj beside the input unless -o, --output <file> names the target (a new file, " +
      "or an existing directory) or --in-place replaces the input. mtllib/texture dependencies are copied " +
      "when the output moves to another directory; a missing dependency is refused unless --geometry-only",
  )
  .argument("<input>", "OBJ file to prepare")
  .option("--height-mm <mm>", "target height in millimetres, finite and > 0", parseNumber, DEFAULT_HEIGHT_MM)
  .option("--in-place", "replace the input file itself (temp file + atomic rename); cannot be combined with -o/--output")
  .option("--geometry-only", "never copy MTL/texture dependencies; a missing dependency becomes a warning")
  .action(
    async (
      input: string,
      opts: { heightMm: number; inPlace?: boolean; geometryOnly?: boolean },
      thisCmd: Command,
    ) => {
      const opened = openCommand(thisCmd, "mesh.prepare-print", "v1");
      buildLocalRuntime(opened.flags);
      const outputFlag = opened.flags.output;
      if (outputFlag !== undefined && opts.inPlace) {
        throw new UsageError("--output/-o and --in-place are mutually exclusive: pick a new file or replace the input, not both");
      }
      const cwd = process.cwd();
      const workspace = opened.flags.workspaceRoot;

      // Reads may follow a symlinked input; an in-place replacement may not
      // (renaming over the link would drop the bytes somewhere else).
      const inputAbs = resolvePath(cwd, input);
      const resolvedInput = resolveWithinRoot(inputAbs, workspace ?? dirname(inputAbs), {
        cwd,
        allowSymlinkLeaf: !opts.inPlace,
        label: "input",
      });

      let outputPath: string | undefined;
      if (outputFlag !== undefined) {
        const outAbs = resolvePath(cwd, outputFlag);
        outputPath = resolveWithinRoot(outAbs, workspace ?? dirname(outAbs), { cwd, label: "--output" }).path;
      } else if (!opts.inPlace && workspace) {
        outputPath = resolveWithinRoot(defaultOutputPath(resolvedInput.path), workspace, { cwd, label: "output" }).path;
      }

      // The workspace (when given) is the root for the output *and* every
      // copied material dependency; without one the output directory is.
      const report = await prepareObjForPrint(resolvedInput.path, {
        heightMm: opts.heightMm,
        outputPath,
        inPlace: opts.inPlace,
        geometryOnly: opts.geometryOnly,
        root: workspace,
      });
      await emitResult(opened, report, report, { warnings: report.warnings });
    },
  );

export const meshCommand = new Command("mesh")
  .description("Local mesh helpers (no API key required)")
  .addCommand(prepareCommand);
