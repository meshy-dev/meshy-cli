# Developing meshy-cli

## Install from source

```bash
# straight from git (`prepare` builds dist for you)
npm i -g git+https://github.com/meshy-dev/meshy-cli.git

# or clone for local development
pnpm install
pnpm build
node dist/index.js --help
pnpm link --global       # exposes `meshy` / `meshy-cli` on $PATH
pnpm typecheck && pnpm test   # `pnpm test` rebuilds dist first (subprocess tests run it)
```

## Project layout

```
meshy-cli/
├── src/
│   ├── index.ts             # CLI entry: update-check policy, SIGINT, unified error exit
│   ├── root.ts              # root command + global flag wiring
│   ├── cmd/                 # make, auth, balance, resources, api, one file per endpoint,
│   │                        # uv-unwrap, creative-lab, animation-catalog, showcases,
│   │                        # download, project, inspect, mesh, slicer, doctor
│   ├── client/
│   │   ├── resource-registry.ts  # every resource: path, family, verbs, billing, media fields
│   │   ├── transport.ts     # per-family HTTP transport (auth scope, deadlines, redirects)
│   │   ├── endpoints/       # TaskEndpoint + balance / catalog / showcases
│   │   └── types.ts         # Zod task schemas
│   └── internal/
│       ├── result.ts / errors.ts   # v1 envelope, error codes, exit codes
│       ├── task-command.ts  # create/get/list/wait/stream/delete factory
│       ├── operation-store.ts      # submission journal (single POST, unknown outcomes)
│       ├── stream.ts / poll.ts     # SSE parser + cancellable polling
│       ├── artifacts.ts / download.ts  # asset keys, safe downloads, legacy -o
│       ├── project-store.ts # meshy_output metadata + history
│       ├── inspect.ts / obj-transform.ts / slicers.ts / doctor.ts
│       ├── config.ts / runtime.ts / env-file.ts / credentials.ts / oauth.ts
│       └── atomic-file.ts / paths.ts / lock.ts
├── tests/                   # node:test unit, contract and black-box tests
├── skills/                  # agent-facing skill (published)
├── docs/skill-parity/       # baseline, contracts, matrix, decisions, verification
├── package.json
└── README.md
```

## Design notes

- **Two layers, one of them opinion-free.** `make` chains endpoints; the
  resource commands expose them one at a time. `make` picks its chain from the
  input type alone and stops there.
- **Plan first, then spend.** `make` computes the whole chain before creating
  anything, so `--dry-run` and a real run share one code path and one estimate.
- **One POST, journaled.** Every billable create is recorded before it is sent;
  a lost answer is reported as unknown, never re-sent.
- **One registry.** `src/client/resource-registry.ts` is the only place a path,
  API family, verb set or media field is declared; commands, the `resources`
  index and the transport all read from it.
- **Credentials have a scope.** The API credential goes to the API origins it
  was resolved for and nowhere else — not to asset hosts, not to the public
  catalog, not across redirects.
- **`--data` escape hatch.** Every `create` accepts a raw JSON object (or
  `@file.json`) that merges with structured flags (flags win, explicit `false`
  and `0` survive).
- **Stdout is reserved for command output.** Logs, progress and errors' prose go
  to stderr so pipes (`| jq`, `-o file`) stay clean.

## Skill-parity documentation

`docs/skill-parity/` records how this release covers the execution capabilities
of the Meshy Skills without Python: the frozen baseline, the endpoint contracts,
the capability matrix, design decisions, migration notes with every intentional
difference, and the verification record.

Design decisions, one `D-NNN` entry each, live in
[`skill-parity/decisions.md`](skill-parity/decisions.md).
