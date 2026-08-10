/**
 * Human-readable status report printed when `-o` is in play.
 *
 * Format:
 *     Status: SUCCESS | FAIL
 *     Task Id: <id>
 *     Generated <type>
 *     Saved to:
 *     - <path>
 *     - <path>
 *     Metadata path: <path>
 *     [optional update notice line when a newer version is available]
 *
 * Success reports list every saved file and the meta.json path. Failure
 * reports include the task_error.message (if present) and skip the Saved
 * to / Metadata path lines since nothing is written.
 */

import type { Task } from "../client/types.js";
import type { UpdateNotice } from "./update-notifier.js";

export interface SuccessReport {
  status: "SUCCESS";
  taskId: string;
  type: string;
  savedFiles: string[];
  metadataPath: string;
  _notice?: UpdateNotice;
}

export interface FailReport {
  status: "FAIL";
  taskId: string;
  type: string;
  error?: string;
  timedOut?: boolean;
  _notice?: UpdateNotice;
}

export type Report = SuccessReport | FailReport;

export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`Status: ${r.status}`);
  lines.push(`Task Id: ${r.taskId}`);
  lines.push(`Generated ${r.type || "(unknown)"}`);

  if (r.status === "SUCCESS") {
    lines.push("Saved to:");
    for (const file of r.savedFiles) lines.push(`- ${file}`);
    lines.push(`Metadata path: ${r.metadataPath}`);
  } else {
    if (r.timedOut) lines.push("Error: polling timed out before the task reached a terminal status");
    else if (r.error) lines.push(`Error: ${r.error}`);
  }

  if (r._notice) lines.push(r._notice.message);

  return `${lines.join("\n")}\n`;
}

export function printReport(r: Report): void {
  process.stdout.write(formatReport(r));
}

export function reportFromTask(task: Task, resource: string): Pick<Report, "taskId" | "type"> {
  return {
    taskId: task.id,
    type: task.type || resource,
  };
}
