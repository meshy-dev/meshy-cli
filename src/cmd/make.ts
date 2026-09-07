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
 * Submission goes through the same journal → single POST → journal primitive
 * as the resource commands (`submitCreate`), so there is one state machine for
 * accepted / rejected / unknown and a local journal failure after acceptance is
 * local_io with the known task id — never "unknown".
 *
 * Three ways to stop early, none of them a re-run:
 *   --async             submit step 1 and return immediately (no polling);
 *                       `pending_steps` lists what was not executed.
 *   --stop-after-first  run step 1 to completion, then return the resume plan.
 *   a failed later step keeps the finished step's task id and the command that
 *                       resumes from it, so a retry never re-bills done work.
 */

import { Command, Option } from "commander";
import { abortSignal, wasInterrupted } from "../internal/context.js";
import { CliError, HintedError, UsageError } from "../internal/errors.js";
import { parseInt10 } from "../internal/flags.js";
import { normalizeMediaPayload } from "../internal/file-input.js";
import { logger } from "../internal/logger.js";
import { planMake, type MakePlan, type MakeStep } from "../internal/make-plan.js";
import { emit, emitEnvelope } from "../internal/output.js";
import { emitResult, openCommand, type OpenedCommand } from "../internal/command-helpers.js";
import { downloadArtifacts } from "../internal/download.js";
import { parseTimeoutSeconds, pollUntilTerminal, type PollResult } from "../internal/poll.js";
import { PRICING_DOCS } from "../internal/pricing.js";
import { okEnvelope, warning, type Warning } from "../internal/result.js";
import { buildRuntime, type Runtime } from "../internal/runtime.js";
import {
  buildTaskResult,
  emitTerminalOutcome,
  preflightOutputPath,
  submitCreate,
  taskNextCommands,
  wrapWithResult,
} from "../internal/task-command.js";
import { requireTaskResource } from "../client/resource-registry.js";
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
  stopAfterFirst?: boolean;
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
      "submit the first step and return its task id immediately (no polling); later steps are reported as pending",
    ).default(false),
  )
  .addOption(
    new Option(
      "--stop-after-first",
      "run the first step to completion, then return the resume plan instead of continuing",
    ).default(false),
  )
  .addOption(new Option("--timeout <seconds>", "max seconds to poll each step").default("600"))
  .action(async (input: string, opts: MakeOptions, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "make", "legacy");
    if (opts.async && opts.stopAfterFirst) {
      throw new UsageError("--async and --stop-after-first are mutually exclusive (--async submits and returns; --stop-after-first waits for step 1)");
    }
    const timeoutSeconds = parseTimeoutSeconds(opts.timeout ?? "600");
    const plan = planMake(input);

    // Budget check before anything is created: refusing costs nothing, and a
    // refusal after step one has already billed is not a budget at all.
    if (opts.maxCredits !== undefined && plan.estimatedCredits > opts.maxCredits) {
      throw new UsageError(
        `estimate ${plan.estimatedCredits} exceeds --max-credits ${opts.maxCredits} ` +
          `(${describeChain(plan)}). Nothing was started.`,
      );
    }

    if (opts.dryRun) {
      await emitResult(opened, planPayload(plan), { ...planPayload(plan), dry_run: true, requests_made: 0 });
      return;
    }

    await runChain(plan, opts, timeoutSeconds, await buildRuntime(opened.flags), opened);
  });

interface ExecutedStep {
  step: number;
  resource: string;
  action: string;
  task_id: string;
  status: string | null;
  operation_id: string;
}

function pendingSteps(plan: MakePlan, from: number, parentTaskId: string | null, output: string | undefined): Array<Record<string, unknown>> {
  return plan.steps.slice(from).map((s) => ({
    step: s.index,
    resource: s.resource,
    action: s.action,
    estimated_credits: s.credits,
    requires: `step ${s.index - 1} SUCCEEDED`,
    command:
      s.resource === "text-to-3d" && s.action === "refine"
        ? `meshy text-to-3d create --mode refine --preview-task-id ${parentTaskId ?? "<preview-task-id>"}${output ? ` -o ${output}` : ""}`
        : null,
  }));
}

async function runChain(plan: MakePlan, opts: MakeOptions, timeoutSeconds: number, runtime: Runtime, opened: OpenedCommand): Promise<void> {
  const payloadFor = await buildPayloads(plan);
  // -o is checked before the first billable request: an unwritable or
  // out-of-workspace target must refuse while the run is still free.
  if (runtime.flags.output) preflightOutputPath(runtime.flags.output, runtime.flags.workspace);
  const executed: ExecutedStep[] = [];
  const warnings: Warning[] = [];

  /** Task id of the last step that reached SUCCEEDED — what a resume hangs off. */
  let completedTaskId = "";

  for (const step of plan.steps) {
    const endpoint = endpointFor(step, runtime);
    const descriptor = requireTaskResource(step.resource);
    const payload = payloadFor[step.index - 1]?.(completedTaskId) ?? {};
    logger.debug(`make step ${step.index} payload`, payload);

    // The id is announced before polling starts: an interrupted run leaves a
    // task progressing server-side, and the caller needs its id to exist
    // somewhere other than this process's memory.
    const submitted = await submitCreate(runtime, descriptor, endpoint, payload, null, {
      label: `make: the ${step.label} request`,
      extraResult: { step: step.index, route: plan.route, executed: [...executed] },
    });
    const { taskId, operationId } = submitted;
    warnings.push(...submitted.warnings);
    announceStart(plan, step, taskId);
    executed.push({ step: step.index, resource: step.resource, action: step.action, task_id: taskId, status: null, operation_id: operationId });
    const submission = { state: "accepted", operation_id: operationId, task_id: taskId };

    if (opts.async) {
      // Exactly one POST, zero polls: the caller owns the rest of the plan.
      const pending = pendingSteps(plan, step.index, null, runtime.flags.output);
      if (opened.schema === "v1") {
        await emitEnvelope(
          okEnvelope("make", {
            route: plan.route,
            submitted: { step: step.index, resource: step.resource, action: step.action, task_id: taskId, operation_id: operationId },
            submission,
            task: null,
            executed,
            pending_steps: pending,
            estimated_credits: plan.estimatedCredits,
            next: taskNextCommands(descriptor, taskId),
          }, warnings),
          opened.format,
        );
        return;
      }
      emit(
        {
          command: "make",
          route: plan.route,
          submitted: step.action,
          task_id: taskId,
          status: null,
          operation_id: operationId,
          pending_steps: pending,
          hint: `meshy ${step.resource} wait ${taskId}`,
        },
        { format: runtime.flags.format },
      );
      return;
    }

    const started = performance.now();
    let poll: PollResult;
    try {
      poll = await pollUntilTerminal(endpoint, taskId, {
        timeoutSeconds,
        intervalMs: runtime.config.pollIntervalMs,
        requestTimeoutMs: runtime.config.readTimeoutMs,
        signal: abortSignal(),
      });
    } catch (err) {
      const context = {
        route: plan.route,
        executed,
        task_id: taskId,
        submission,
        task: null,
        pending_steps: pendingSteps(plan, step.index, null, runtime.flags.output),
        next: taskNextCommands(descriptor, taskId),
      };
      if (wasInterrupted() || abortSignal().aborted) {
        throw new CliError({
          code: "interrupted",
          message: `make: interrupted while waiting for ${step.label} (task ${taskId}); the server keeps running it`,
          recovery: { action: "wait", automatic: false, command: `meshy ${step.resource} wait ${taskId}` },
          result: context,
        });
      }
      // A polling failure is not "no task": the id and the resume command travel with the error.
      throw wrapWithResult(err, context);
    }
    const { task, raw, timedOut, aborted } = poll;
    const elapsed = (performance.now() - started) / 1000;
    executed[executed.length - 1]!.status = task?.status ?? null;
    announceOutcome(task, timedOut, elapsed);

    if (aborted) {
      throw new CliError({
        code: "interrupted",
        message: `make: interrupted while waiting for ${step.label} (task ${taskId}); the server keeps running it`,
        recovery: { action: "wait", automatic: false, command: `meshy ${step.resource} wait ${taskId}` },
        result: {
          route: plan.route,
          executed,
          task_id: taskId,
          submission,
          task: task ? buildTaskResult({ task, raw, descriptor, includeRaw: false, submission }).task : null,
          pending_steps: pendingSteps(plan, step.index, null, runtime.flags.output),
          next: taskNextCommands(descriptor, taskId),
        },
      });
    }

    if (timedOut || !task || task.status !== "SUCCEEDED") {
      throw stepFailure(plan, step, task, taskId, raw, timedOut, completedTaskId, runtime, executed, opened);
    }

    if (step.index === plan.steps.length) {
      await finalOutcome(opened, runtime, plan, step, task, raw, elapsed, executed, warnings);
      return;
    }

    completedTaskId = task.id;

    if (opts.stopAfterFirst) {
      const pending = pendingSteps(plan, step.index, task.id, runtime.flags.output);
      if (opened.schema === "v1") {
        await emitEnvelope(
          okEnvelope("make", {
            route: plan.route,
            stopped_after: { step: step.index, resource: step.resource, action: step.action, task_id: task.id, status: task.status },
            task: buildTaskResult({ task, raw, descriptor, includeRaw: false, submission }).task,
            executed,
            pending_steps: pending,
            resume: resumeCommand(plan, task.id, runtime) ?? null,
          }, warnings),
          opened.format,
        );
        return;
      }
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

async function finalOutcome(
  opened: OpenedCommand,
  runtime: Runtime,
  plan: MakePlan,
  step: MakeStep,
  task: Task,
  raw: unknown,
  elapsed: number,
  executed: ExecutedStep[],
  warnings: Warning[],
): Promise<void> {
  if (opened.schema !== "v1") {
    await emitTerminalOutcome(task, false, elapsed, step.resource, runtime);
    return;
  }
  const descriptor = requireTaskResource(step.resource);
  const base = buildTaskResult({ task, raw, descriptor, includeRaw: false, submission: { state: "accepted", operation_id: null, task_id: task.id } });
  let downloads = base.downloads as Record<string, unknown>;
  if (runtime.flags.output) {
    try {
      const { savedFiles, metadataPath, materialLinks } = await downloadArtifacts(task, runtime.flags.output, step.resource, { root: runtime.flags.workspace });
      if (materialLinks) warnings.push(...materialLinks.warnings);
      downloads = { state: "completed", files: savedFiles.map((p) => ({ path: p, status: "written" })), metadata_path: metadataPath, material_links: materialLinks };
    } catch (err) {
      throw new CliError({
        code: err instanceof CliError ? err.code : "local_io",
        message: `make finished (task ${task.id}) but downloading its assets failed: ${err instanceof Error ? err.message : String(err)}`,
        result: { route: plan.route, executed, task_id: task.id, task: base.task, submission: base.submission, downloads: { state: "failed", files: [], metadata_path: null }, next: taskNextCommands(descriptor, task.id) },
        cause: err,
      });
    }
  }
  await emitEnvelope(okEnvelope("make", { route: plan.route, executed, task: base.task, submission: base.submission, downloads, pending_steps: [] }, warnings), opened.format);
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
  const { payload } = await normalizeMediaPayload({ image_url: plan.input }, requireTaskResource("image-to-3d").mediaFields, { signal: abortSignal() });

  return [
    () => ({
      image_url: payload.image_url,
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
  task: Task | null,
  taskId: string,
  raw: unknown,
  timedOut: boolean,
  completedTaskId: string,
  runtime: Runtime,
  executed: ExecutedStep[],
  opened: OpenedCommand,
): Error {
  const descriptor = requireTaskResource(step.resource);
  const taskView = task ? buildTaskResult({ task, raw, descriptor, includeRaw: false, submission: { state: "accepted", operation_id: null, task_id: taskId } }).task : null;
  const resume = resumeCommand(plan, completedTaskId, runtime);
  const status = task?.status ?? "unknown";
  if (opened.schema === "v1") {
    if (timedOut) {
      return new CliError({
        code: "timed_out",
        message: `make: ${step.label} did not finish within the timeout — task ${taskId} is still running`,
        recovery: { action: "wait", automatic: false, command: `meshy ${step.resource} wait ${taskId}` },
        result: { route: plan.route, executed, task_id: taskId, task: taskView, pending_steps: pendingSteps(plan, step.index, null, runtime.flags.output), resume: resume ?? null, next: taskNextCommands(descriptor, taskId) },
      });
    }
    return new CliError({
      code: "task_failed",
      message: task?.task_error?.message || `make: ${step.label} ended as ${status} — task ${taskId}`,
      recovery: resume ? { action: "resume", automatic: false, command: resume } : null,
      result: { route: plan.route, executed, task_id: taskId, task: taskView, pending_steps: pendingSteps(plan, step.index, completedTaskId || null, runtime.flags.output), resume: resume ?? null },
    });
  }
  if (timedOut) {
    return new HintedError({
      message: `make: ${step.label} did not finish within the timeout — task ${taskId} is still running`,
      code: "step_timeout",
      hint: `meshy ${step.resource} wait ${taskId}`,
      exitCode: 8,
    });
  }
  // A resume is only offered when an earlier step actually succeeded; without
  // one, a suggested command would be a guess, and a wrong command is worse
  // than none.
  return new HintedError({
    message:
      task?.task_error?.message ||
      `make: ${step.label} ended as ${status} — task ${taskId}`,
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

function announceOutcome(task: Task | null, timedOut: boolean, elapsed: number): void {
  const mark = timedOut ? "timed out" : task ? (task.status === "SUCCEEDED" ? "ok" : task.status) : "no status received";
  process.stderr.write(`      ${mark} in ${elapsed.toFixed(0)}s\n`);
}

export { warning as _makeWarning };
