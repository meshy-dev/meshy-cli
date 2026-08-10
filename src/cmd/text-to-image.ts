/**
 * text-to-image — https://docs.meshy.ai/en/api/text-to-image
 */

import { Option } from "commander";
import { parseBool } from "../internal/flags.js";
import { UsageError } from "../internal/errors.js";
import {
  ASPECT_RATIOS,
  ASPECT_RATIO_HELP,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_MODEL_HELP,
  checkImageCombo,
} from "../internal/image-models.js";
import { buildResourceCommand, type ResourceCommandSpec } from "../internal/task-command.js";

const spec: ResourceCommandSpec = {
  name: "text-to-image",
  description:
    "Generate a 2D image from a text prompt. For edits based on existing images use " +
    "image-to-image instead",
  create: {
    description: "Create a text-to-image task",
    configure(cmd) {
      return cmd
        .addOption(new Option("--ai-model <model>", IMAGE_MODEL_HELP).choices([...IMAGE_MODELS]))
        .option("--prompt <text>", "required — image description; be descriptive for best results")
        .option(
          "--generate-multi-view <bool>",
          "generate multi-angle views of the subject (feeds multi-image-to-3d); mutually exclusive with --aspect-ratio",
          parseBool,
        )
        .addOption(
          new Option("--pose-mode <pose>", "a-pose | t-pose character pose preset").choices([
            "a-pose",
            "t-pose",
          ]),
        )
        .addOption(new Option("--aspect-ratio <ratio>", ASPECT_RATIO_HELP).choices([...ASPECT_RATIOS]));
    },
    toPayload(opts) {
      if (!opts.prompt && !opts.data) {
        throw new UsageError("--prompt is required");
      }
      checkImageCombo({
        // With --data in play an unset flag may be supplied there; leave the
        // ratio check to the server rather than validating against a model
        // the request won't use.
        aiModel: (opts.aiModel as string | undefined) ?? (opts.data ? undefined : DEFAULT_IMAGE_MODEL),
        aspectRatio: opts.aspectRatio as string | undefined,
        generateMultiView: opts.generateMultiView as boolean | undefined,
      });
      return {
        ai_model: opts.aiModel,
        prompt: opts.prompt,
        generate_multi_view: opts.generateMultiView,
        pose_mode: opts.poseMode,
        aspect_ratio: opts.aspectRatio,
      };
    },
    toDefaults() {
      return { ai_model: DEFAULT_IMAGE_MODEL };
    },
  },
  endpointOf: (c) => c.textToImage,
};

export const textToImageCommand = buildResourceCommand(spec);
