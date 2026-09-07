/**
 * Root command. Wires global flags and attaches every subcommand.
 *
 * The per-endpoint commands are registered but hidden from the root help.
 * They remain fully supported — `meshy resources` indexes them and
 * `meshy <resource> --help` documents each one. The root help leads with the
 * short list instead, because it is read on every invocation (an agent pays
 * for the whole surface each time it runs `--help`), and because a caller who
 * wants one model should not have to pick an endpoint first.
 */

import { Command } from "commander";
import { VERSION } from "./internal/version.js";
import { REFRESH_COMMAND, runRefreshCommand } from "./internal/update-notifier.js";
import {
  mirrorGlobalOptionsToDescendants,
  registerRootGlobalOptions,
  walkCommands,
} from "./internal/global-options.js";
import { analyzePrintabilityCommand } from "./cmd/analyze-printability.js";
import { animateCommand } from "./cmd/animate.js";
import { animationCatalogCommand } from "./cmd/animation-catalog.js";
import { apiCommand } from "./cmd/api.js";
import { authCommand } from "./cmd/auth.js";
import { balanceCommand } from "./cmd/balance.js";
import { convertCommand } from "./cmd/convert.js";
import { creativeLabCommand } from "./cmd/creative-lab.js";
import { deleteCommand } from "./cmd/delete.js";
import { downloadCommand } from "./cmd/download.js";
import { imageTo3dCommand } from "./cmd/image-to-3d.js";
import { imageToImageCommand } from "./cmd/image-to-image.js";
import { makeCommand } from "./cmd/make.js";
import { multiColorPrintCommand } from "./cmd/multi-color-print.js";
import { multiImageTo3dCommand } from "./cmd/multi-image-to-3d.js";
import { projectCommand } from "./cmd/project.js";
import { remeshCommand } from "./cmd/remesh.js";
import { repairPrintabilityCommand } from "./cmd/repair-printability.js";
import { resizeCommand } from "./cmd/resize.js";
import { resourcesCommand } from "./cmd/resources.js";
import { retextureCommand } from "./cmd/retexture.js";
import { riggingCommand } from "./cmd/rigging.js";
import { showcasesCommand } from "./cmd/showcases.js";
import { textTo3dCommand } from "./cmd/text-to-3d.js";
import { textToImageCommand } from "./cmd/text-to-image.js";
import { textToMotionCommand } from "./cmd/text-to-motion.js";
import { uvUnwrapCommand } from "./cmd/uv-unwrap.js";

/**
 * Commands added in S1. They only speak the v1 envelope; the error exit uses
 * this set to pick the schema when a parse error happens before any action.
 */
export const V1_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "uv-unwrap",
  "creative-lab",
  "animation-catalog",
  "showcases",
  "download",
  "project",
  "inspect",
  "mesh",
  "slicer",
  "doctor",
]);

/**
 * Commands that never need the authenticated API. The background update check
 * is skipped for them so local work spawns no network child.
 */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "resources",
  "project",
  "inspect",
  "mesh",
  "slicer",
  "doctor",
  "download",
  "animation-catalog",
  REFRESH_COMMAND,
]);

const ROOT_LONG = `meshy-cli — command-line interface for the Meshy AI API.

USAGE:
    meshy make <prompt | image> [-o <path>]  # the short path to a model
    meshy <resource> <action> [flags]        # one endpoint at a time — meshy resources
    meshy api <METHOD> <PATH> [--data <json>]

EXAMPLES:
    # one command, one model (sync: returns when the model is done)
    meshy make "a red sports car" -o car.glb
    meshy make ./cat.png -o out/cat/
    meshy make "a red sports car" --dry-run        # steps + estimate, no spend
    meshy make "a red sports car" --max-credits 25 # refuse if the estimate is over

    # every endpoint, one at a time
    meshy resources                                # index of every command
    meshy text-to-3d create --mode preview --prompt "a red sports car"
    meshy image-to-3d get <task-id>
    meshy delete <task-id>                         # unified: works for any task

    # escape hatch for endpoints without a dedicated subcommand
    meshy api GET /balance
    meshy api POST /text-to-3d --data '{"mode":"preview","prompt":"car"}'

AUTHENTICATION:
    auth login                       open the browser for OAuth login (loopback + PKCE)
    auth login --with-key msy_...    paste an existing API key instead of the browser flow
    auth status                      which credential is in effect, and does it work
    auth list                        stored profiles
    auth use <profile>               switch the active profile
    auth logout [--all]              forget the stored credential

    Resolution order: --api-key > MESHY_API_KEY > --api-key-file > stored profile. The
    env var stays ahead of the stored credential so CI is never overridden by
    whatever a developer logged into on that machine. Non-production --base-url-v1
    uses a separate credentials.dev.json, so staging cannot clobber a production login.

RESOURCE COMMANDS:
    All endpoint commands stay available and stay supported — they are indexed
    by \`meshy resources\` instead of listed here, so this help does not grow
    with the API. \`meshy resources --help\` also carries the shared
    create/get/list/wait/stream/delete verb contract.

GLOBAL FLAGS (accepted at any position in the command line):
    --api-key <key>          override MESHY_API_KEY
    --base-url-v1 <url>      override MESHY_BASE_URL_V1
    --base-url-v2 <url>      override MESHY_BASE_URL_V2
    --base-url-creative-lab <url>  override the Creative Lab base (default: <v1 origin>/openapi/creative-lab)
    --format <fmt>           json (default) | pretty | ndjson
    --output-schema <s>      legacy (default for existing commands) | v1 (stable envelope; new commands)
    --output, -o <path>      download task artifacts to a file or directory,
                             write meta.json alongside, and replace stdout
                             with a status report (without -o: stdout keeps
                             the JSON summary).
    --api-key-file <path>    read MESHY_API_KEY from an explicit dotenv-style file
                             (only that key; never auto-discovered; do not use Node's --env-file)
    --workspace <dir>        confine every written file to this directory
    --no-update-check        skip the background npm version check
    --verbose, -v            enable debug logging to stderr
    --log-level <level>      debug | info | warn | error | silent

ENVIRONMENT:
    MESHY_API_KEY                      required unless a profile is stored
    MESHY_CONFIG_DIR                   default: ~/.config/meshy
    MESHY_CREDENTIALS_PATH             exact credentials file (wins over the above)
    MESHY_BASE_URL_V1                  default: https://api.meshy.ai/openapi/v1
    MESHY_BASE_URL_V2                  default: https://api.meshy.ai/openapi/v2
    MESHY_BASE_URL_CREATIVE_LAB        default: derived from the v1 origin
    MESHY_OAUTH_AUTHORIZE_URL          override the OAuth authorize page (staging/testing)
    MESHY_CLI_NO_BROWSER               set to 1 to skip browser open (headless/agent use)
    MESHY_POLL_INTERVAL_MS             default: 3000
    MESHY_READ_TIMEOUT_MS              default: 120000
    MESHY_LOG_LEVEL                    default: warn
    MESHY_CLI_NO_UPDATE_NOTIFIER       set to disable update checks

Docs: https://docs.meshy.ai/`;

export function buildRootCommand(): Command {
  const program = new Command();
  program
    .name("meshy-cli")
    .description(ROOT_LONG)
    .version(VERSION, "-V, --version")
    .showHelpAfterError();

  registerRootGlobalOptions(program);

  // Listed in the root help.
  program.addCommand(makeCommand);
  program.addCommand(authCommand);
  program.addCommand(balanceCommand);
  program.addCommand(resourcesCommand);
  program.addCommand(apiCommand);

  // Registered and supported, but indexed by `meshy resources` rather than
  // printed on every --help. Hiding is a help-text decision only: these keep
  // working exactly as before, and the surface tests walk them either way.
  for (const cmd of [
    textTo3dCommand,
    imageTo3dCommand,
    multiImageTo3dCommand,
    remeshCommand,
    convertCommand,
    resizeCommand,
    riggingCommand,
    animateCommand,
    retextureCommand,
    textToImageCommand,
    textToMotionCommand,
    imageToImageCommand,
    multiColorPrintCommand,
    analyzePrintabilityCommand,
    repairPrintabilityCommand,
    deleteCommand,
    uvUnwrapCommand,
    creativeLabCommand,
    animationCatalogCommand,
    showcasesCommand,
    downloadCommand,
    projectCommand,
  ]) {
    program.addCommand(cmd, { hidden: true });
  }

  // Hidden self-command used by the detached background cache-refresh child.
  // commander v13: .command(name, { hidden: true }) with NO description arg.
  program.command(REFRESH_COMMAND, { hidden: true }).action(async () => {
    await runRefreshCommand();
  });

  mirrorGlobalOptionsToDescendants(program);

  // Parse errors (unknown option/command, missing argument) must reach the
  // unified exit in index.ts instead of Commander's own process.exit(1), so
  // every command in the tree throws CommanderError. addCommand() does not
  // inherit this setting, hence the walk.
  walkCommands(program, (cmd) => {
    cmd.exitOverride();
  });

  return program;
}
