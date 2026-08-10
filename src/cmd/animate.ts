/**
 * animate — https://docs.meshy.ai/en/api/rigging-and-animation
 *
 * Meshy's POST /animations expects `rig_task_id` + `action_id` (int) plus an
 * optional nested `post_process` object for change_fps / fbx2usdz /
 * extract_armature.
 */

import { Option } from "commander";
import { parseInt10 } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "animate",
  description:
    "Apply an animation action from Meshy's library to a rigged character — pick the " +
    "--action-id from https://api.meshy.ai/web/public/animations/resources",
  create: {
    description: "Create an animation task",
    configure(cmd) {
      return cmd
        .option("--rig-task-id <id>", "SUCCEEDED rigging task id (required)")
        .option("--action-id <n>", "animation action id from Meshy's library (integer)", parseInt10)
        .addOption(
          new Option("--post-process-operation <op>", "optional post-processing step")
            .choices(["change_fps", "fbx2usdz", "extract_armature"]),
        )
        .addOption(
          new Option("--post-process-fps <fps>", "target FPS for change_fps (default: 30)")
            .choices(["24", "25", "30", "60"]),
        );
    },
    toPayload(opts) {
      if (!opts.rigTaskId && !opts.data) {
        throw new UsageError("--rig-task-id is required");
      }
      if (opts.actionId == null && !opts.data) {
        throw new UsageError("--action-id is required");
      }
      const payload: Record<string, unknown> = {
        rig_task_id: opts.rigTaskId,
        action_id: opts.actionId,
      };
      if (opts.postProcessOperation) {
        const post: Record<string, unknown> = { operation_type: opts.postProcessOperation };
        if (opts.postProcessOperation === "change_fps" && opts.postProcessFps != null) {
          post.fps = Number(opts.postProcessFps);
        }
        payload.post_process = post;
      }
      return payload;
    },
  },
  endpointOf: (c) => c.animate,
};

export const animateCommand = buildResourceCommand(spec);
