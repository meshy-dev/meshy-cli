/**
 * project — local bookkeeping for `meshy_output/` folders.
 *
 *   init          create a project folder (+ metadata.json) under a root
 *   record        add/merge a task entry with its files
 *   show          normalised view of one project's metadata.json
 *   list          the history.json index reconciled with the folders on disk
 *   rebuild-index regenerate history.json from the folders
 *
 * Every subcommand is local: no API key, no network, no OAuth refresh.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { emitResult, openCommand } from "../internal/command-helpers.js";
import { UsageError } from "../internal/errors.js";
import { collect } from "../internal/flags.js";
import { initProject, listProjects, readProject, rebuildIndex, recordTask } from "../internal/project-store.js";
import { warning, type Warning } from "../internal/result.js";
import { buildLocalRuntime } from "../internal/runtime.js";

const DEFAULT_ROOT = "meshy_output";

function rootFrom(opts: { root?: string }, cwd = process.cwd()): string {
  return resolvePath(cwd, opts.root ?? DEFAULT_ROOT);
}

const initCommand = new Command("init")
  .description("Create a project folder with metadata.json under the output root (default ./meshy_output)")
  .option("--root <dir>", `output root (default: ./${DEFAULT_ROOT})`)
  .option("--name <text>", "project name (kept verbatim in metadata; the folder gets a safe slug)")
  .option("--task-id <id>", "root task id when already known (can be added later with record)")
  .option("--task-type <type>", "task type used for the folder slug when no name is given")
  .action(async (opts: { root?: string; name?: string; taskId?: string; taskType?: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "project.init", "v1");
    buildLocalRuntime(opened.flags);
    const res = initProject(rootFrom(opts), { name: opts.name, taskId: opts.taskId ?? null, taskType: opts.taskType ?? null });
    const warnings: Warning[] = [];
    if (!res.index.updated) warnings.push(warning("index_dirty", `metadata.json written but history.json was not updated: ${res.index.error}; run \`meshy project rebuild-index --root ${res.root}\``));
    await emitResult(opened, res, { root: res.root, project_dir: res.project_dir, folder: res.folder, metadata: res.metadata, index: res.index }, { warnings });
  });

const recordCommand = new Command("record")
  .description("Record a task (and its files) in a project's metadata.json; (task_id, stage) is merged, not duplicated")
  .requiredOption("--project <dir>", "project directory created by init")
  .requiredOption("--task-id <id>", "task id")
  .requiredOption("--stage <name>", "stage label, e.g. preview | refine | rigged | complete")
  .option("--resource <id>", "resource id (text-to-3d, rigging, creative-lab.lamp.build, …)")
  .option("--task-type <type>", "server task type when known")
  .option("--parent-task-id <id>", "task this one was derived from")
  .option("--status <status>", "last known status")
  .option("--file <relative-path>", "file inside the project to attach (repeatable)", collect)
  .option("--task-json <relative-path>", "task snapshot file inside the project")
  .option("--operation-id <id>", "journal operation id that created the task")
  .option("--root <dir>", "output root holding history.json (default: the project's parent)")
  .action(
    async (
      opts: { project: string; taskId: string; stage: string; resource?: string; taskType?: string; parentTaskId?: string; status?: string; file?: string[]; taskJson?: string; operationId?: string; root?: string },
      thisCmd: Command,
    ) => {
      const opened = openCommand(thisCmd, "project.record", "v1");
      buildLocalRuntime(opened.flags);
      const projectDir = resolvePath(opts.project);
      if (!existsSync(join(projectDir, "metadata.json"))) {
        throw new UsageError(`${projectDir} has no metadata.json; run \`meshy project init\` first`);
      }
      const res = recordTask(
        projectDir,
        {
          taskId: opts.taskId,
          stage: opts.stage,
          resource: opts.resource ?? null,
          taskType: opts.taskType ?? null,
          parentTaskId: opts.parentTaskId ?? null,
          status: opts.status ?? null,
          files: opts.file ?? [],
          taskJson: opts.taskJson ?? null,
          operationId: opts.operationId ?? null,
        },
        { root: opts.root ? resolvePath(opts.root) : undefined },
      );
      const warnings: Warning[] = [];
      const missing = (opts.file ?? []).filter((f) => !existsSync(join(projectDir, f)));
      if (missing.length) warnings.push(warning("recorded_file_missing", `recorded file(s) not present in the project yet: ${missing.join(", ")}`));
      if (res.migrated_from_legacy) warnings.push(warning("metadata_migrated", "legacy metadata.json migrated to schema_version 2 (backup kept beside it)"));
      if (!res.index.updated) warnings.push(warning("index_dirty", `metadata.json committed but history.json was not updated: ${res.index.error}; run \`meshy project rebuild-index\``));
      await emitResult(opened, res, { project_dir: res.project_dir, action: res.action, entry: res.entry, task_count: res.metadata.tasks.length, index: res.index, migrated_from_legacy: res.migrated_from_legacy }, { warnings });
    },
  );

const showCommand = new Command("show")
  .description("Show a project's metadata.json (legacy files are shown in the v2 shape without being rewritten)")
  .requiredOption("--project <dir>", "project directory")
  .action(async (opts: { project: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "project.show", "v1");
    buildLocalRuntime(opened.flags);
    const read = readProject(opts.project);
    const files = read.metadata.tasks.flatMap((t) => t.files.map((f) => ({ task_id: t.task_id, stage: t.stage, file: f, present: existsSync(join(read.path, f)) })));
    await emitResult(opened, read.metadata, { project_dir: read.path, legacy_format: read.legacy, metadata: read.metadata, files });
  });

const listCommand = new Command("list")
  .description("List projects from history.json and report folders missing from the index")
  .option("--root <dir>", `output root (default: ./${DEFAULT_ROOT})`)
  .action(async (opts: { root?: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "project.list", "v1");
    buildLocalRuntime(opened.flags);
    const res = listProjects(rootFrom(opts));
    const warnings: Warning[] = [];
    if (res.index_dirty) warnings.push(warning("index_dirty", "history.json does not match the folders on disk; run `meshy project rebuild-index`"));
    await emitResult(opened, res.projects, res, { warnings });
  });

const rebuildCommand = new Command("rebuild-index")
  .description("Regenerate history.json from the project folders (the previous index is backed up)")
  .option("--root <dir>", `output root (default: ./${DEFAULT_ROOT})`)
  .action(async (opts: { root?: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "project.rebuild-index", "v1");
    buildLocalRuntime(opened.flags);
    const res = rebuildIndex(rootFrom(opts));
    const warnings: Warning[] = res.skipped.map((s) => warning("project_skipped", `${s.folder}: ${s.reason}`));
    await emitResult(opened, res, res, { warnings });
  });

export const projectCommand = new Command("project")
  .description("Local meshy_output project folders: init | record | show | list | rebuild-index (no API key needed)")
  .addCommand(initCommand)
  .addCommand(recordCommand)
  .addCommand(showCommand)
  .addCommand(listCommand)
  .addCommand(rebuildCommand);
