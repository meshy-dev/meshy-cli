/**
 * resources — the index for the per-endpoint commands.
 *
 * Those commands stay registered and stay supported; they are simply not what
 * the root help leads with. An agent that reads `--help` on every invocation
 * pays for the whole surface every time, so the root lists the one verb most
 * callers need and points here for the rest.
 *
 * `result.items` carries `kind` (task | query | action | local), the command
 * line, the endpoint and the supported verbs — all generated from the registry
 * and filtered to what this build actually registers. RESOURCES below is the
 * hand-written summary table the root help and tests cross-check against.
 */

import { Command } from "commander";
import { resourceIndex, type ResourceIndexEntry } from "../client/resource-registry.js";
import { emitResult, openCommand } from "../internal/command-helpers.js";
import { buildLocalRuntime } from "../internal/runtime.js";

interface ResourceEntry {
  name: string;
  summary: string;
}

/** Kept in registration order, matching root.ts. */
export const RESOURCES: ResourceEntry[] = [
  { name: "text-to-3d", summary: "two-stage 3D generation from text (preview → refine)" },
  { name: "image-to-3d", summary: "3D from a single image (standard or smart-topology low-poly)" },
  { name: "multi-image-to-3d", summary: "3D from 1-4 views of one object (prefer image-to-3d for a single image)" },
  { name: "remesh", summary: "retopologize / change polycount" },
  { name: "convert", summary: "change file format only" },
  { name: "resize", summary: "resize to real-world dimensions" },
  { name: "rigging", summary: "rig a humanoid mesh (+ bundled walk/run animations)" },
  { name: "animate", summary: "apply an animation clip to a rigged mesh" },
  { name: "retexture", summary: "regenerate textures" },
  { name: "text-to-image", summary: "2D image generation" },
  { name: "text-to-motion", summary: "generate a standalone skeletal motion clip from text" },
  { name: "image-to-image", summary: "2D image editing" },
  { name: "multi-color-print", summary: "color-separated 3D print output" },
  { name: "analyze-printability", summary: "inspect a model for 3D-printing issues (free)" },
  { name: "repair-printability", summary: "fix non-watertight / non-manifold geometry" },
  { name: "balance", summary: "remaining credit balance" },
  { name: "delete", summary: "delete a task of any resource except Creative Lab (whose own delete verb cancels)" },
  { name: "uv-unwrap", summary: "generate fresh UVs for a GLB (≤40k faces) — a UV white model for external texturing" },
  { name: "creative-lab", summary: "photo → printable product: figure | vinyl-figure | brick-figure | lamp | keychain | fridge-magnet | keycap | fidget-pixel (prototype then build) | fidget-collapsible (one stage)" },
  { name: "animation-catalog", summary: "animation library (action ids for animate); free, server-side search" },
  { name: "showcases", summary: "Enterprise community showcases (every request is billed)" },
  { name: "download", summary: "download selected assets of a task (saved task JSON, URL, or API)" },
  { name: "project", summary: "meshy_output project folders: init | record | show | list | rebuild-index" },
  { name: "inspect", summary: "local checks: faces (face-count gate pass | fail | unknown)" },
  { name: "mesh", summary: "prepare-print: OBJ Y-up → Z-up, scale to height, centre, ground at Z=0" },
  { name: "slicer", summary: "detect installed slicers | open a model in one" },
  { name: "doctor", summary: "local environment diagnosis (no network by default)" },
  { name: "auto-split", summary: "split a model into printable parts (auto / by named parts / by colour; optional connectors)" },
  { name: "usage", summary: "usage tasks: finished API tasks with the credits each consumed (Studio/Enterprise)" },
];

const VERBS = `Every task resource carries the same verbs:

    meshy <resource> create [flags] [--data '<json>'] [--async] [--timeout <s>]
    meshy <resource> get    <task-id>
    meshy <resource> list   [--page <n>] [--page-size <n>] [--sort-by <field>]
    meshy <resource> wait   <task-id> [--timeout <s>]
    meshy <resource> stream <task-id> [--timeout <s>] [--idle-timeout <s>]
    meshy <resource> delete <task-id>

\`create\` is sync by default — it blocks until the task is terminal. Pass
--async for the task id straight away, then \`wait\`/\`get\`/\`stream\` it later.

Endpoints without a dedicated command are reachable through the passthrough:

    meshy api GET  /balance
    meshy api POST /text-to-3d --data '{"mode":"preview","prompt":"car"}'`;

export const resourcesCommand = new Command("resources")
  .description("List the per-endpoint commands and the verbs they share")
  .addHelpText("after", `\n${VERBS}\n`)
  .action(async (_opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "resources");
    buildLocalRuntime(opened.flags);
    const registered = new Set((thisCmd.parent?.commands ?? []).map((c) => c.name()));
    const items = resourceIndex().filter((e) => registered.has(e.command.split(" ")[1] ?? ""));
    const byKind = (kind: ResourceIndexEntry["kind"]) => items.filter((e) => e.kind === kind).length;
    await emitResult(opened, {
      items,
      counts: { task: byKind("task"), query: byKind("query"), action: byKind("action"), local: byKind("local") },
      verbs_help: "meshy resources --help",
    });
  });
