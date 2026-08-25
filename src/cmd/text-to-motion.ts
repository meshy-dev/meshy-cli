/**
 * text-to-motion — generate a standalone skeletal motion clip from a prompt.
 */

import { Option } from "commander";
import { UsageError } from "../internal/errors.js";
import { parseNumber } from "../internal/flags.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const MIN_DURATION_SECONDS = 2;
const MAX_DURATION_SECONDS = 10;
const DURATION_STEP_SECONDS = 0.5;

const spec: ResourceCommandSpec = {
  name: "text-to-motion",
  description:
    "Generate a standalone skeletal motion clip from a text prompt. Prime returns FBX; " +
    "Swift returns BVH",
  create: {
    description: "Create a text-to-motion task",
    configure(cmd) {
      return cmd
        .option("--prompt <text>", "required — describe the character motion; max 400 chars")
        .addOption(
          new Option("--mode <mode>", "generation model (default: prime)")
            .choices(["prime", "swift"]),
        )
        .option(
          "--duration <seconds>",
          "required — clip length from 2 to 10 seconds in 0.5-second increments",
          parseNumber,
        );
    },
    toPayload(opts) {
      if (!opts.prompt && !opts.data) {
        throw new UsageError("--prompt is required");
      }
      if (opts.duration == null && !opts.data) {
        throw new UsageError("--duration is required");
      }
      if (opts.duration != null) {
        const duration = opts.duration as number;
        const onStep = Number.isInteger(duration / DURATION_STEP_SECONDS);
        if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS || !onStep) {
          throw new UsageError("--duration must be from 2 to 10 seconds in 0.5-second increments");
        }
      }
      return {
        prompt: opts.prompt,
        mode: opts.mode,
        duration: opts.duration,
      };
    },
    toDefaults() {
      return { mode: "prime" };
    },
  },
  endpointOf: (c) => c.textToMotion,
};

export const textToMotionCommand = buildResourceCommand(spec);
