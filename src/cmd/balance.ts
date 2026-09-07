/**
 * balance — one-shot GET /balance
 */

import { Command } from "commander";
import { emitResult, openCommand, rejectOutputFlagForV1, saveRawJson } from "../internal/command-helpers.js";
import { buildRuntime } from "../internal/runtime.js";

export const balanceCommand = new Command("balance")
  .description("Show the current API key's credit balance")
  .option("--save-json <file>", "v1: also save the raw API response to this file (never overwrites)")
  .action(async (opts: { saveJson?: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "balance", "legacy");
    rejectOutputFlagForV1(opened, opts.saveJson);
    const runtime = await buildRuntime(opened.flags);
    const { balance, raw } = await runtime.client.balance.getWithRaw();
    const saved = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspace }) : null;
    await emitResult(opened, balance, { balance: balance.balance, saved_json: saved }, { legacyFile: opened.flags.output });
  });
