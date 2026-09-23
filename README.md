# meshy-cli

The command line for the [Meshy AI API](https://docs.meshy.ai/): text-to-3D,
image-to-3D, text-to-motion, remesh, convert, resize, UV unwrap, rigging,
animation, retexture, 2D images, multi-color print, Creative Lab products, plus
the local helpers a 3D-printing or agent workflow needs. Built for people and
AI agents: a terminal gets a readable view, a pipe or an agent gets JSON.

## Install

Requires Node 22.12+. No Python, no other runtime.

```bash
npm i -g meshy-cli       # installs `meshy` and `meshy-cli`
meshy doctor             # checks the environment, no network
```

The same build is published as [`@meshy-ai/cli`](https://www.npmjs.com/package/@meshy-ai/cli).
**Install one, not both**: they share the `meshy` binary and npm refuses the
second with `EEXIST` (`npm uninstall -g @meshy-ai/cli && npm i -g meshy-cli` to
switch). If `meshy --version` reports 0.1.x on Node 22, reinstall: 0.2.0–0.3.1
declared `node >=24` by mistake, and npm silently picked 0.1.3 instead.

## Log in

```bash
meshy auth login                                # browser sign-in, stored for you
meshy auth login --with-key msy_your_key_here   # or paste an API key
meshy auth status
```

In CI, set `MESHY_API_KEY` instead; it wins over a stored login. Get a key at
<https://www.meshy.ai/settings/api>.

## Quick start

One command, one model. `make` chains the documented flow — a prompt runs
text-to-3D preview then refine; an image runs one textured image-to-3D task:

```bash
meshy make "a lovely baby husky"
meshy make ./cat.png -o out/cat/                # -o downloads the result
meshy make "a red sports car" --dry-run         # steps and credit estimate, no spend
```

```text
✓ [1/2] text-to-3d preview (geometry)                 01a0c94c-…   1m 27s
✓ [2/2] text-to-3d refine (textures)                  01a0c94d-…   5m 36s

✓ SUCCEEDED  text-to-3d-refine
Task     01a0c94d-eaba-710e-b5b7-da5b2f620c95
Took     7m 03s
Credits  ~30 (estimate for the whole chain)
Assets   glb, fbx · textures: base_color, metallic, normal, roughness · thumbnail

tip: download it now:  meshy download --resource text-to-3d --task-id 01a0c94d-… --all --output-dir ./a-lovely-baby-husky
```

Every Meshy endpoint is also a command of its own, with the same verbs:

```bash
meshy text-to-3d create --mode preview --prompt "a red sports car"
meshy image-to-3d create --image-url ./cat.png --async     # returns the task id at once
meshy image-to-3d wait <task-id> -o out/cat/
meshy text-to-3d list
meshy download --resource text-to-3d --task-id <task-id> --list
meshy balance
meshy resources                                            # every command
```

`create / get / list / wait / stream / delete` work the same way on every
resource; `meshy <resource> --help` documents each one, and
`meshy api GET /balance` reaches any endpoint the CLI does not model yet.

## For scripts and agents

stdout is the result and nothing else; progress and messages go to stderr.
Piped, redirected or run by an agent, the output is JSON automatically. Ask for
the stable envelope explicitly and the shape never depends on how you are run:

```bash
meshy text-to-3d create --mode preview --prompt "a cactus" --async --output-schema v1 --format json \
  | jq -r .result.submission.task_id
```

Exit codes are stable (`3` auth, `8` timed out, `10` submission unknown, …), and
a create is sent exactly once, never retried behind your back. The envelope,
the create/wait/stream semantics and the full exit-code table are in
[docs/scripting.md](https://github.com/meshy-dev/meshy-cli/blob/main/docs/scripting.md).

## Documentation

- [Using meshy-cli](https://github.com/meshy-dev/meshy-cli/blob/main/docs/usage.md)
  — auth in depth, `make`, every resource, downloads, projects, printing
  helpers, media inputs, what the terminal shows, global flags, environment
  variables
- [Scripts and agents](https://github.com/meshy-dev/meshy-cli/blob/main/docs/scripting.md)
  — the v1 envelope, create / wait / stream guarantees, exit codes, the agent skill
- [Developing](https://github.com/meshy-dev/meshy-cli/blob/main/docs/development.md)
  — building from source, project layout, design notes
- [Meshy API reference](https://docs.meshy.ai/en/api/) — parameters and credit costs

## License

MIT — see [LICENSE](LICENSE).
