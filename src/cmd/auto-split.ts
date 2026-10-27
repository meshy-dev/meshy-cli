/**
 * auto-split — https://docs.meshy.ai/en/api/auto-split
 *
 * Cuts the model of a SUCCEEDED task (image-to-3d, multi-image-to-3d,
 * text-to-3d preview, remesh, convert, resize; Meshy 6 or 7, not Smart
 * Topology) into separately printable parts. Textured inputs are accepted;
 * the texture is not carried over (each part gets a flat colour). Thin
 * regions left by a cut are always reinforced — there is no switch for it.
 */

import { Option } from "commander";
import { UsageError } from "../internal/errors.js";
import { parseBool, parseCsv, parseNumber } from "../internal/flags.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const PROMPT_MAX = 600;

const spec: ResourceCommandSpec = {
  name: "auto-split",
  description:
    "Split a model into separately printable parts — automatically, by named parts, or by colour " +
    "region — with optional connectors. Input is a SUCCEEDED Meshy 6/7 task; textures are not kept",
  create: {
    description: "Create an auto-split task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "SUCCEEDED source task: image-to-3d, multi-image-to-3d, text-to-3d preview, remesh, convert or resize (required)")
        .addOption(
          new Option(
            "--mode <mode>",
            "auto (default; Meshy picks the cuts) | by_parts (cut along the parts --prompt names) | by_color (along the colour regions --prompt names; image-to-3d / multi-image-to-3d inputs only)",
          ).choices(["auto", "by_parts", "by_color"]),
        )
        .option("--prompt <text>", `by_parts / by_color: the 1-10 parts to split into, e.g. "head, torso, arms" (max ${PROMPT_MAX} chars)`)
        .option("--target-formats <csv>", "glb,obj,fbx,stl,usdz,blend,3mf (glb is always produced; stl fuses the parts into one solid)", parseCsv)
        .addOption(new Option("--layout <layout>", "assembled (default; parts where the model had them) | on_plate (laid out ready to slice)").choices(["assembled", "on_plate"]))
        .option("--connectors <bool>", "add mortise-and-tenon connectors at each cut (default: false)", parseBool)
        .addOption(new Option("--connector-type <shape>", "with --connectors true: cube (default) | cylinder").choices(["cube", "cylinder"]))
        .option("--connector-size <n>", "with --connectors true: size relative to the cut surface, 0.1-0.8 (default: 0.5)", parseNumber)
        .option("--connector-height <n>", "with --connectors true: height relative to the cut surface, 0.1-0.8 (default: 0.1)", parseNumber);
    },
    toPayload(opts) {
      return {
        input_task_id: opts.inputTaskId,
        mode: opts.mode,
        prompt: opts.prompt,
        target_formats: opts.targetFormats,
        layout: opts.layout,
        connectors: opts.connectors,
        connector_type: opts.connectorType,
        connector_size: opts.connectorSize,
        connector_height: opts.connectorHeight,
      };
    },
    validatePayload(payload) {
      if (typeof payload.input_task_id !== "string" || !payload.input_task_id) {
        throw new UsageError("provide --input-task-id (a SUCCEEDED task whose model to split)");
      }
      const byPrompt = payload.mode === "by_parts" || payload.mode === "by_color";
      if (byPrompt && (typeof payload.prompt !== "string" || !payload.prompt.trim())) {
        throw new UsageError(`--mode ${String(payload.mode)} requires --prompt naming the parts`);
      }
      if (typeof payload.prompt === "string" && payload.prompt.length > PROMPT_MAX) {
        throw new UsageError(`--prompt must be at most ${PROMPT_MAX} characters (got ${payload.prompt.length})`);
      }
      for (const key of ["connector_size", "connector_height"] as const) {
        const v = payload[key];
        if (v !== undefined && (typeof v !== "number" || v < 0.1 || v > 0.8)) {
          throw new UsageError(`${key} must be between 0.1 and 0.8`);
        }
      }
      const tuned = ["connector_type", "connector_size", "connector_height"].filter((k) => payload[k] !== undefined);
      if (tuned.length > 0 && payload.connectors !== true) {
        throw new UsageError(`${tuned.join(", ")} only apply with --connectors true`);
      }
    },
  },
};

export const autoSplitCommand = buildResourceCommand(spec);
