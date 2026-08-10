/**
 * Planning for `make` — pure, offline, and computed in full before the first
 * task is created.
 *
 * Planning up front is what lets `--dry-run` and a real run share one code
 * path: the quote the user approves is the quote the run bills against. A
 * plan built step-by-step could always disagree with what was shown.
 *
 * The input decides the chain and nothing else does. There is no heuristic
 * that picks a "better" route behind the user's back — a prompt runs the
 * documented two-stage text flow, an image runs the single-task image flow.
 * Anything more opinionated belongs in the caller's hands, reachable through
 * the per-resource commands.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { UsageError } from "./errors.js";
import { estimateFor, type PricedOperation } from "./pricing.js";

export type MakeRoute = "text" | "image";

export interface MakeStep {
  /** 1-based position, as reported in progress lines. */
  index: number;
  resource: "text-to-3d" | "image-to-3d";
  /** The step's role in the chain: preview | refine | textured. */
  action: string;
  credits: number;
  /** One line of human progress text. */
  label: string;
}

export interface MakePlan {
  route: MakeRoute;
  /** The prompt (text route) or the resolved image source (image route). */
  input: string;
  steps: MakeStep[];
  estimatedCredits: number;
}

/** Extensions that make a bare argument look like an image path. */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** Prefixes that make a bare argument look like a filesystem path. */
const PATH_PREFIX = /^(\.\.?[/\\]|[/\\]|~[/\\]|[A-Za-z]:[/\\])/;

/**
 * Decide whether the argument is a prompt or an image.
 *
 * A path-shaped argument that does not exist is an error rather than a prompt:
 * silently generating "./cat.png" as text would spend credits on a typo.
 */
export function classifyInput(input: string): MakeRoute {
  const value = input.trim();
  if (!value) throw new UsageError("make requires a prompt or an image");
  if (/^https?:\/\//i.test(value)) return "image";
  if (value.startsWith("data:")) {
    throw new UsageError(
      "make does not accept data: URIs — pass a local file path instead",
    );
  }

  const looksLikePath = PATH_PREFIX.test(value) || IMAGE_EXT.test(value);
  if (!looksLikePath) return "text";

  const abs = isAbsolute(value) ? value : resolvePath(process.cwd(), value);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new UsageError(
      `no such image: ${value} — pass an existing file, an http(s) URL, or quote it if you meant it as a prompt`,
    );
  }
  return "image";
}

export function planMake(input: string): MakePlan {
  const route = classifyInput(input);
  const steps: MakeStep[] =
    route === "text"
      ? [
          step(1, "text-to-3d", "preview", "text-to-3d:preview", "text-to-3d preview (geometry)"),
          step(2, "text-to-3d", "refine", "text-to-3d:refine", "text-to-3d refine (textures)"),
        ]
      : [
          step(1, "image-to-3d", "textured", "image-to-3d:textured", "image-to-3d (geometry + textures)"),
        ];

  return {
    route,
    input: input.trim(),
    steps,
    estimatedCredits: steps.reduce((sum, s) => sum + s.credits, 0),
  };
}

function step(
  index: number,
  resource: MakeStep["resource"],
  action: string,
  priced: PricedOperation,
  label: string,
): MakeStep {
  return { index, resource, action, credits: estimateFor(priced), label };
}
