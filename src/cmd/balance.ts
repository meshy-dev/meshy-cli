/**
 * balance — one-shot GET /balance
 */

import { Command } from "commander";
import { emit } from "../internal/output.js";
import { buildRuntime, readGlobalFlags } from "../internal/runtime.js";

export const balanceCommand = new Command("balance")
  .description("Show the current API key's credit balance")
  .action(async (_opts: Record<string, unknown>, thisCmd: Command) => {
    const runtime = await buildRuntime(readGlobalFlags(thisCmd));
    const balance = await runtime.client.balance.get();
    emit(balance, { format: runtime.flags.format, file: runtime.flags.output });
  });
