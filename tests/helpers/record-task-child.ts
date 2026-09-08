/**
 * Child for the project-store concurrency test: records one task in the given
 * project. argv: <project-dir> <task-id> <stage> <root>
 */
import { recordTask } from "../../src/internal/project-store.js";

const [dir, taskId, stage, root] = process.argv.slice(2);
if (!dir || !taskId || !stage || !root) {
  process.stderr.write("usage: record-task-child <project-dir> <task-id> <stage> <root>\n");
  process.exit(2);
}
const res = recordTask(dir, { taskId, stage, resource: "text-to-3d", files: [`${taskId}.glb`] }, { root });
process.stdout.write(`${JSON.stringify({ action: res.action, count: res.metadata.tasks.length, index: res.index.updated })}\n`);
