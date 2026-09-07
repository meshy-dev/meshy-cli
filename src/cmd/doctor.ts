/**
 * doctor — environment diagnosis with a strictly local default.
 *
 * Exit policy: the default run always exits 0, whatever it finds — a warning
 * about a missing credential *is* the diagnosis, not a failure of the command.
 * `--check-api` is different: the caller asked whether the account works, so
 * a credential that cannot be resolved or is rejected exits 3 and a transport
 * failure exits 7, each with the full report kept in `result` (D-024).
 */

import { Command } from "commander";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson } from "../internal/command-helpers.js";
import { runDoctorDetailed, type DoctorApiFailure } from "../internal/doctor.js";
import { classifyError, CliError, type CliErrorCode } from "../internal/errors.js";
import { buildLocalRuntime } from "../internal/runtime.js";

interface DoctorCommandOptions {
  checkApi?: boolean;
  checkSlicers?: boolean;
  saveJson?: string;
}

/**
 * Map a --check-api failure onto the exit contract. Anything that stops a
 * credential from being resolved (none found, unusable key file, corrupt
 * profile store) is `auth`; a rejected credential stays `auth`; a transport
 * failure stays `network`; other API answers keep their own classification.
 */
export function apiCheckFailure(failure: DoctorApiFailure, result: Record<string, unknown>): CliError {
  const classified = classifyError(failure.error);
  const code: CliErrorCode = failure.stage === "credentials" ? "auth" : classified.code;
  return new CliError({
    code,
    message: `--check-api failed: ${classified.message}`,
    httpStatus: classified.httpStatus,
    retryable: classified.retryable,
    recovery: classified.recovery,
    hint: classified.hint,
    result,
    cause: failure.error,
  });
}

/** Build a fresh `doctor` command (tests parse a new tree per run). */
export function buildDoctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Diagnose the local environment: versions, credential sources (presence only, values never read), base URLs, workspace. " +
        "No network by default; --check-api makes one free GET /balance, --check-slicers runs slicer detection",
    )
    .option("--check-api", "resolve the credential like an API command and call GET /balance once (free); exit 3 if no credential works, 7 if unreachable")
    .option("--check-slicers", "detect installed slicers (local only)")
    .option("--save-json <file>", "save the report to this file (never overwrites)")
    .action(async (opts: DoctorCommandOptions, thisCmd: Command) => {
      const opened = openCommand(thisCmd, "doctor", "v1");
      rejectOutputFlagForV1(opened, opts.saveJson);
      buildLocalRuntime(opened.flags);
      const { report, apiFailure } = await runDoctorDetailed({
        flags: opened.flags,
        checkApi: Boolean(opts.checkApi),
        checkSlicers: Boolean(opts.checkSlicers),
      });
      const saved = opts.saveJson ? saveRawJson(opts.saveJson, report, { workspace: opened.flags.workspace }) : null;
      const result: Record<string, unknown> = { ...report, saved_json: saved };
      if (opts.checkApi && report.api_ready !== true) {
        throw apiCheckFailure(apiFailure ?? { stage: "balance", error: new Error("--check-api did not complete") }, result);
      }
      await emitResult(opened, result, result);
    });
}

export const doctorCommand = buildDoctorCommand();
