/**
 * balance — one-shot GET /balance: the total, and its split into monthly
 * credits (expiring at monthly_resets_at) and permanent credits.
 */

import { Command } from "commander";
import { emitResult, openCommand, rejectOutputFlag, saveRawJson } from "../internal/command-helpers.js";
import { buildRuntime } from "../internal/runtime.js";

export const balanceCommand = new Command("balance")
  .description("Show the current API key's credit balance")
  .option("--save-json <file>", "also save the raw API response to this file (never overwrites)")
  .action(async (opts: { saveJson?: string }, thisCmd: Command) => {
    const opened = openCommand(thisCmd, "balance");
    rejectOutputFlag(opened, opts.saveJson);
    const runtime = await buildRuntime(opened.flags);
    const { balance, raw } = await runtime.client.balance.getWithRaw();
    const saved = opts.saveJson ? saveRawJson(opts.saveJson, raw, { workspace: opened.flags.workspaceRoot }) : null;
    await emitResult(opened, {
        balance: balance.balance,
        monthly_credits: balance.monthly_credits ?? null,
        permanent_credits: balance.permanent_credits ?? null,
        monthly_resets_at: balance.monthly_resets_at ?? null,
        saved_json: saved,
    });
  });
