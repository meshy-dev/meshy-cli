/**
 * make — one command for "give me a 3D model".
 *
 * The per-resource commands mirror the API one endpoint at a time, which
 * leaves the caller to carry task ids between steps by hand. `make` chains the
 * documented flows instead:
 *
 *   a prompt  → text-to-3d preview → text-to-3d refine
 *   an image  → image-to-3d (textured)
 *
 * What it deliberately does NOT do: pick a route by inspecting the input,
 * insert an image step ahead of a prompt, or stop for confirmation between
 * stages. Those are judgement calls, and a CLI that makes them silently spends
 * someone else's credits on its own opinion. The resource commands remain the
 * way to compose anything else.
 *
 * When a later step fails, the error carries the finished step's task id and
 * the command that resumes from it, so a retry never re-runs — or re-bills —
 * work that already succeeded.
 */

import { Command, Option } from "commander";
import { HintedError, UsageError } from "../internal/errors.js";
import { parseInt10 } from "../internal/flags.js";
import { resolveImageFields } from "../internal/file-input.js";
import { logger } from "../internal/logger.js";
import { planMake, type MakePlan, type MakeStep } from "../internal/make-plan.js";
import { emit } from "../internal/output.js";
import { pollUntilTerminal } from "../internal/poll.js";
import { PRICING_DOCS } from "../internal/pricing.js";
import { buildRuntime, readGlobalFlags, type Runtime } from "../internal/runtime.js";
import { emitTerminalOutcome } from "../internal/task-command.js";
import type { Task } from "../client/types.js";
import type { TaskEndpoint } from "../client/endpoints/base.js";

const DESCRIPTION =
  "Generate a 3D model in one command. A prompt runs the two-stage text flow " +
  "(preview then refine); an image runs the single textured image-to-3d task. " +
  "Use -o to download the result. Compose anything else from the resource commands";

interface MakeOptions {
  dryRun?: boolean;
  maxCredits?: number;
  async?: boolean;
  timeout?: string;
}

export const makeCommand = new Command("make")
  .description(DESCRIPTION)
  .argument("<input>", "a text prompt, a local image path, or an http(s) image URL")
  .addOption(
    new Option(
      "--dry-run",
      "print the planned steps and the estimate, then exit without calling the API",
    ).default(false),
  )
  .addOption(
    new Option("--max-credits <n>", "refuse to start when the estimate exceeds this budget")
      .argParser(parseInt10),
  )
  .addOption(
    new Option(
      "--async",
      "start the first step and return its task id instead of running the whole chain",
    ).default(false),
  )
  .addOption(new Option("--timeout <seconds>", "max seconds to poll each step").default("600"))
  .action(async (input: string, opts: MakeOptions, thisCmd: Command) => {
    const plan = planMake(input);
    const flags = readGlobalFlags(thisCmd);

    // Budget check before anything is created: refusing costs nothing, and a
    // refusal after step one has already billed is not a budget at all.
    if (opts.maxCredits !== undefined && plan.estimatedCredits > opts.maxCredits) {
      throw new UsageError(
        `estimate ${plan.estimatedCredits} exceeds --max-credits ${opts.maxCredits} ` +
          `(${describeChain(plan)}). Nothing was started.`,
      );
    }

    if (opts.dryRun) {
      emit(planPayload(plan), { format: flags.format });
      return;
    }

    await runChain(plan, opts, await buildRuntime(flags));
  });

async function runChain(plan: MakePlan, opts: MakeOptions, runtime: Runtime): Promise<void> {
  const timeoutSeconds = Number(opts.timeout ?? 600);
  const payloadFor = await buildPayloads(plan);

  /** Task id of the last step that reached SUCCEEDED — what a resume hangs off. */
  let completedTaskId = "";

  for (const step of plan.steps) {
    const endpoint = endpointFor(step, runtime);
    const payload = payloadFor[step.index - 1]?.(completedTaskId) ?? {};
    logger.debug(`make step ${step.index} payload`, payload);

    // The id is announced before polling starts: an interrupted run leaves a
    // task progressing server-side, and the caller needs its id to exist
    // somewhere other than this process's memory.
    const taskId = await endpoint.create(payload);
    announceStart(plan, step, taskId);

    const started = Date.now();
    const { task, timedOut } = await pollUntilTerminal(endpoint, taskId, {
      timeoutSeconds,
      intervalMs: runtime.config.pollIntervalMs,
    });
    const elapsed = (Date.now() - started) / 1000;
    announceOutcome(task, timedOut, elapsed);

    if (timedOut || task.status !== "SUCCEEDED") {
      throw stepFailure(plan, step, task, timedOut, completedTaskId, runtime);
    }

    if (step.index === plan.steps.length) {
      await emitTerminalOutcome(task, false, elapsed, step.resource, runtime);
      return;
    }

    completedTaskId = task.id;

    if (opts.async) {
      emit(
        {
          command: "make",
          route: plan.route,
          stopped_after: step.action,
          task_id: task.id,
          status: task.status,
          hint: resumeCommand(plan, task.id, runtime),
        },
        { format: runtime.flags.format },
      );
      return;
    }
  }
}

/**
 * One payload builder per step, taking the previous step's task id so the
 * chain stays a function of the plan plus what actually ran.
 *
 * Texture settings reuse the resource commands' pinned defaults (full PBR map
 * set, 4k base color, relightable, GLB out) rather than inventing a second set.
 */
async function buildPayloads(
  plan: MakePlan,
): Promise<Array<(completedTaskId: string) => Record<string, unknown>>> {
  if (plan.route === "text") {
    return [
      () => ({ mode: "preview", prompt: plan.input, target_formats: ["glb"] }),
      (previewTaskId: string) => ({
        mode: "refine",
        preview_task_id: previewTaskId,
        enable_pbr: true,
        texture_resolution: "4k",
        remove_lighting: true,
        target_formats: ["glb"],
      }),
    ];
  }

  // Resolve the image before anything is created: a missing file or an
  // unreachable URL must fail while the run is still free.
  const resolved: Record<string, unknown> = { imageUrl: plan.input };
  await resolveImageFields(resolved);

  return [
    () => ({
      image_url: resolved.imageUrl,
      should_texture: true,
      enable_pbr: true,
      texture_resolution: "4k",
      remove_lighting: true,
      target_formats: ["glb"],
    }),
  ];
}

function endpointFor(step: MakeStep, runtime: Runtime): TaskEndpoint {
  return step.resource === "text-to-3d" ? runtime.client.textTo3d : runtime.client.imageTo3d;
}

/**
 * The command that picks the chain back up from a completed step. Only the
 * text route has a resumable hand-off (a preview's latents are what refine
 * consumes); the image route is a single task with nothing to resume.
 */
export function resumeCommand(
  plan: MakePlan,
  completedTaskId: string,
  runtime: Runtime,
): string | undefined {
  if (plan.route !== "text" || !completedTaskId) return undefined;
  const output = runtime.flags.output ? ` -o ${runtime.flags.output}` : "";
  return `meshy text-to-3d create --mode refine --preview-task-id ${completedTaskId}${output}`;
}

function stepFailure(
  plan: MakePlan,
  step: MakeStep,
  task: Task,
  timedOut: boolean,
  completedTaskId: string,
  runtime: Runtime,
): HintedError {
  if (timedOut) {
    return new HintedError({
      message: `make: ${step.label} did not finish within the timeout — task ${task.id} is still running`,
      code: "step_timeout",
      hint: `meshy ${step.resource} wait ${task.id}`,
      exitCode: 8,
    });
  }
  // A resume is only offered when an earlier step actually succeeded; without
  // one, a suggested command would be a guess, and a wrong command is worse
  // than none.
  const resume = resumeCommand(plan, completedTaskId, runtime);
  return new HintedError({
    message:
      task.task_error?.message ||
      `make: ${step.label} ended as ${task.status} — task ${task.id}`,
    code: "step_failed",
    ...(resume ? { hint: `${resume}   # step ${step.index} failed; step ${step.index - 1} is kept` } : {}),
  });
}

function planPayload(plan: MakePlan): Record<string, unknown> {
  return {
    command: "make",
    route: plan.route,
    steps: plan.steps.map((s) => ({
      step: s.index,
      resource: s.resource,
      action: s.action,
      estimated_credits: s.credits,
    })),
    estimated_credits: plan.estimatedCredits,
    note: `Estimates only — confirm prices at ${PRICING_DOCS} and your balance with \`meshy balance\`.`,
  };
}

function describeChain(plan: MakePlan): string {
  return plan.steps.map((s) => `${s.resource} ${s.action}`).join(" → ");
}

/** Progress goes to stderr so stdout stays the machine-readable channel. */
function announceStart(plan: MakePlan, step: MakeStep, taskId: string): void {
  process.stderr.write(`[${step.index}/${plan.steps.length}] ${step.label}  ${taskId}\n`);
}

function announceOutcome(task: Task, timedOut: boolean, elapsed: number): void {
  const mark = timedOut ? "timed out" : task.status === "SUCCEEDED" ? "ok" : task.status;
  process.stderr.write(`      ${mark} in ${elapsed.toFixed(0)}s\n`);
}
