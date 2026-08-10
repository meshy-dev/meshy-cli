/**
 * resize — https://docs.meshy.ai/en/api/resize
 *
 * Standalone model resizing (extracted from remesh by Meshy in May 2026).
 * Exactly one sizing mode per task.
 */

import { Option } from "commander";
import { parseBool, parseNumber } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "resize",
  description:
    "Resize a 3D model to real-world dimensions — set a target height, a longest-side " +
    "length, or let AI estimate the real size",
  create: {
    description: "Create a resize task",
    configure(cmd) {
      return cmd
        .option("--input-task-id <id>", "source Meshy task id (takes priority over --model-url)")
        .option("--model-url <src>", "3D model as http(s) URL or local file path")
        .option("--resize-height <m>", "target height in meters (one sizing mode required)", parseNumber)
        .option("--resize-longest-side <m>", "target longest dimension in meters", parseNumber)
        .option("--auto-size <bool>", "AI-estimate the real-world size", parseBool)
        .addOption(
          new Option("--origin-at <where>", "bottom (default) | center").choices(["bottom", "center"]),
        );
    },
    toPayload(opts) {
      if (!opts.inputTaskId && !opts.modelUrl && !opts.data) {
        throw new UsageError("provide --input-task-id or --model-url");
      }
      const modes = [
        opts.resizeHeight != null,
        opts.resizeLongestSide != null,
        opts.autoSize === true,
      ].filter(Boolean).length;
      if (modes !== 1 && !opts.data) {
        throw new UsageError(
          "provide exactly one sizing mode: --resize-height, --resize-longest-side, or --auto-size true",
        );
      }
      return {
        input_task_id: opts.inputTaskId,
        model_url: opts.modelUrl,
        resize_height: opts.resizeHeight,
        resize_longest_side: opts.resizeLongestSide,
        auto_size: opts.autoSize,
        origin_at: opts.originAt,
      };
    },
  },
  endpointOf: (c) => c.resize,
};

export const resizeCommand = buildResourceCommand(spec);
