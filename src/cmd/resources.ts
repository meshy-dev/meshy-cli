/**
 * resources — the index for the per-endpoint commands.
 *
 * Those commands stay registered and stay supported; they are simply not what
 * the root help leads with. An agent that reads `--help` on every invocation
 * pays for the whole surface every time, so the root lists the one verb most
 * callers need and points here for the rest.
 */

import { Command } from "commander";
import { emit } from "../internal/output.js";
import { readGlobalFlags } from "../internal/runtime.js";

interface ResourceEntry {
  name: string;
  summary: string;
}

/** Kept in registration order, matching root.ts. */
export const RESOURCES: ResourceEntry[] = [
  { name: "text-to-3d", summary: "two-stage 3D generation from text (preview → refine)" },
  { name: "image-to-3d", summary: "3D from a single image (standard or smart-topology low-poly)" },
  { name: "multi-image-to-3d", summary: "3D from multiple views (beta; prefer image-to-3d)" },
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
  { name: "delete", summary: "delete any task, whatever its resource" },
];

const VERBS = `Every resource carries the same verbs:

    meshy <resource> create [flags] [--data '<json>'] [--async] [--timeout <s>]
    meshy <resource> get    <task-id>
    meshy <resource> list   [--page <n>] [--page-size <n>] [--sort-by <field>]
    meshy <resource> wait   <task-id> [--timeout <s>]
    meshy <resource> delete <task-id>

\`create\` is sync by default — it blocks until the task is terminal. Pass
--async for the task id straight away, then \`wait\`/\`get\` it later.

Endpoints without a dedicated command are reachable through the passthrough:

    meshy api GET  /balance
    meshy api POST /text-to-3d --data '{"mode":"preview","prompt":"car"}'`;

export const resourcesCommand = new Command("resources")
  .description("List the per-endpoint commands and the verbs they share")
  .addHelpText("after", `\n${VERBS}\n`)
  .action((_opts: Record<string, unknown>, thisCmd: Command) => {
    const { format } = readGlobalFlags(thisCmd);
    if (format === "pretty") {
      const width = Math.max(...RESOURCES.map((r) => r.name.length));
      const lines = RESOURCES.map((r) => `  ${r.name.padEnd(width)}  ${r.summary}`);
      process.stdout.write(`${lines.join("\n")}\n\n${VERBS}\n`);
      return;
    }
    emit(RESOURCES, { format });
  });
