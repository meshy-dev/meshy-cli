/**
 * Top-level `meshy-cli delete <id>` — destructive. Uses the unified task
 * lookup (v2 /text-to-3d/<id>) so the caller doesn't need to know the type.
 */

import { Command } from "commander";
import { emitResult, openCommand, rejectOutputFlagForV1 } from "../internal/command-helpers.js";
import { buildRuntime } from "../internal/runtime.js";

export const deleteCommand = new Command("delete")
  .description("Delete any task by id")
  .argument("<task-id>", "Meshy task id")
  .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "delete", "legacy");
    rejectOutputFlagForV1(opened, undefined);
    const runtime = await buildRuntime(opened.flags);
    await runtime.client.textTo3d.delete(taskId);
    await emitResult(
      opened,
      { task_id: taskId, deleted: true },
      { task_id: taskId, resource: null, endpoint: "/openapi/v2/text-to-3d", deleted: true },
      { legacyFile: opened.flags.output },
    );
  });
