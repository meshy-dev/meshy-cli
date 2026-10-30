/**
 * analyze-printability — https://docs.meshy.ai/en/api/analyze-printability
 * Inspect a 3D model for 3D-printing issues (watertight, manifold, holes…).
 * Produces a `printability` report on the task — no downloadable model files.
 * Free endpoint (consumes 0 credits).
 *
 * The print-size trio (printer type, intended height or longest side) is
 * shared with repair-printability: with any of them the task also checks wall
 * thickness at that size (`printability.thin_walls`).
 */

import { Option, type Command } from "commander";
import { UsageError } from "../internal/errors.js";
import { parseNumber } from "../internal/flags.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

/** --printer-type and the two print-size flags (millimetres, at most one). */
export function printSizeOptions(cmd: Command, verb: string): Command {
  return cmd
    .addOption(
      new Option(
        "--printer-type <type>",
        `${verb} walls against this printer's minimum: fdm (1.0 mm) | sla (0.8 mm) | full_color (2.0 mm); fdm when only a size is given`,
      ).choices(["fdm", "sla", "full_color"]),
    )
    .option("--intended-print-height-mm <mm>", "planned print height, 1-1000 mm (GLB input only); exclusive with --intended-print-longest-side-mm", parseNumber)
    .option("--intended-print-longest-side-mm <mm>", "planned longest side, 1-1000 mm (any input format)", parseNumber);
}

export function printSizePayload(opts: Record<string, unknown>): Record<string, unknown> {
  return {
    printer_type: opts.printerType,
    intended_print_height_mm: opts.intendedPrintHeightMm,
    intended_print_longest_side_mm: opts.intendedPrintLongestSideMm,
  };
}

export function validatePrintSize(payload: Record<string, unknown>): void {
  const sizes = (["intended_print_height_mm", "intended_print_longest_side_mm"] as const).filter((k) => payload[k] !== undefined);
  if (sizes.length > 1) throw new UsageError("send at most one of --intended-print-height-mm and --intended-print-longest-side-mm");
  for (const k of sizes) {
    const v = payload[k];
    if (typeof v !== "number" || v < 1 || v > 1000) throw new UsageError(`${k} must be between 1 and 1000 (millimetres)`);
  }
}

const spec: ResourceCommandSpec = {
  name: "analyze-printability",
  description:
    "Diagnose whether a 3D model is ready for 3D printing — overall status " +
    "(healthy/warning/error), issue counts, and geometry metrics (watertight, volume, " +
    "non-manifold edges, degenerate faces, holes); with a printer type or print size, also " +
    "wall thickness at that size. Produces a report, not files",
  create: {
    description: "Create an analyze-printability task",
    configure(cmd) {
      cmd
        .option(
          "--input-task-id <id>",
          "source SUCCEEDED task: image-to-3d, multi-image-to-3d, text-to-3d, remesh or retexture (Meshy 6 or newer), or repair-printability",
        )
        .option(
          "--model-url <src>",
          "3D model: an http(s) URL (.glb/.gltf/.obj/.fbx/.stl, max 400MB) or a local .glb/.gltf file (max 50 MiB) — the API takes inline uploads as glTF only, so host .stl/.obj/.fbx at a URL",
        );
      return printSizeOptions(cmd, "check");
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        ...printSizePayload(opts),
      };
    },
    validatePayload: validatePrintSize,
  },
  endpointOf: (c) => c.analyzePrintability,
};

export const analyzePrintabilityCommand = buildResourceCommand(spec);
