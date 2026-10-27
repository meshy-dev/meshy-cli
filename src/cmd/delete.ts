/**
 * Top-level `meshy-cli delete <id>` — destructive. Sends DELETE to
 * /openapi/v2/text-to-3d/<id>, which the server answers for a task of any
 * type except Creative Lab: those have their own per-product DELETE (which
 * cancels rather than deletes) and the shared route answers 404 for them.
 */

import { Command } from "commander";
import { MeshyApiError } from "../client/errors.js";
import { emitResult, openCommand, rejectOutputFlag } from "../internal/command-helpers.js";
import { buildRuntime } from "../internal/runtime.js";
import { deleteFailure } from "../internal/task-command.js";

const CREATIVE_LAB_HINT =
  "Creative Lab tasks are not reachable here: cancel one with `meshy creative-lab <product> <stage> delete <task-id>`";

export const deleteCommand = new Command("delete")
  .description(
    "Permanently delete a task of any type except Creative Lab (use `meshy creative-lab <product> <stage> delete`); an IN_PROGRESS task cannot be stopped and is refused with exit 14",
  )
  .argument("<task-id>", "Meshy task id")
  .action(async (taskId: string, _opts: Record<string, unknown>, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "delete");
    rejectOutputFlag(opened, undefined);
    const runtime = await buildRuntime(opened.flags);
    try {
      await runtime.client.textTo3d.delete(taskId);
    } catch (err) {
      if (err instanceof MeshyApiError && err.code === "not_found") {
        // Same class and shape, one more sentence: a 404 here may be a Creative Lab task.
        throw new MeshyApiError({ message: `${err.message}. ${CREATIVE_LAB_HINT}`, status: err.status, code: err.code, path: err.path, body: err.body, credentialKind: err.credentialKind });
      }
      // The type is unknown here, so there is no runnable wait command to offer.
      throw deleteFailure(err, taskId);
    }
    await emitResult(opened, { task_id: taskId, resource: null, endpoint: "/openapi/v2/text-to-3d", deleted: true });
  });
