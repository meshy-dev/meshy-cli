/**
 * image-to-image — https://docs.meshy.ai/en/api/image-to-image
 */

import { Option } from "commander";
import { parseBool, parseCsv } from "../internal/flags.js";
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
  name: "image-to-image",
  description:
    "Instruction-driven image editing and generation from 1-5 reference images — extraction, " +
    "transformation, combination, restyling",
  create: {
    description: "Create an image-to-image task",
    configure(cmd) {
      return cmd
        .addOption(new Option("--ai-model <model>", IMAGE_MODEL_HELP).choices([...IMAGE_MODELS]))
        .option(
          "--prompt <text>",
          "required — a straightforward, specific instruction, e.g. 'Extract the person on the " +
            "left onto a clean white background' or 'Restyle into chibi cartoon style'. With " +
            "multiple references say 'the first image', 'the second image', ...",
        )
        .option(
          "--reference-image-urls <csv>",
          "required — 1-5 reference images as CSV; each entry is a URL or local file path",
          parseCsv,
        )
        .option(
          "--generate-multi-view <bool>",
          "generate multi-angle views of the subject; mutually exclusive with --aspect-ratio",
          parseBool,
        )
        .addOption(new Option("--aspect-ratio <ratio>", ASPECT_RATIO_HELP).choices([...ASPECT_RATIOS]));
    },
    toPayload(opts) {
      if (!opts.prompt && !opts.data) {
        throw new UsageError("--prompt is required");
      }
      const urls = opts.referenceImageUrls as string[] | undefined;
      if ((!urls || urls.length < 1 || urls.length > 5) && !opts.data) {
        throw new UsageError("--reference-image-urls must be a CSV of 1-5 URLs");
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
        reference_image_urls: urls,
        generate_multi_view: opts.generateMultiView,
        aspect_ratio: opts.aspectRatio,
      };
    },
    toDefaults() {
      return { ai_model: DEFAULT_IMAGE_MODEL };
    },
  },
  endpointOf: (c) => c.imageToImage,
};

export const imageToImageCommand = buildResourceCommand(spec);
