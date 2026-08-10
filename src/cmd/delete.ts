/**
 * Top-level `meshy-cli delete <id>` — destructive. Uses the unified task
 * lookup (v2 /text-to-3d/<id>) so the caller doesn't need to know the type.
 */

import { Command } from "commander";
import { emit } from "../internal/output.js";
import { buildRuntime, readGlobalFlags } from "../internal/runtime.js";

export const deleteCommand = new Command("delete")
  .description("Delete any task by id")
  .argument("<task-id>", "Meshy task id")
  .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
    const runtime = await buildRuntime(readGlobalFlags(thisCmd));
    await runtime.client.textTo3d.delete(taskId);
    emit({ task_id: taskId, deleted: true }, {
      format: runtime.flags.format,
      file: runtime.flags.output,
    });
  });
