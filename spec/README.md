# spec/

`openapi.v2.json` is the OpenAPI 3.1 description of the Meshy API v2 that the
CLI's API commands are generated from. It covers the v2 operations the API
reference documents: every create, the `/v2/tasks` routes, `/v2/balance`,
`/v2/usage/tasks` and `/v2/animations/library`. Its descriptions are the API
reference's.

`lock.json` pins it: `version` is the spec's `info.version`, `sha256` the
digest of `openapi.v2.json` as committed, and `sources` the versions it was
merged from.

The spec is produced outside this repository. To update it, replace both files
together (never edit `openapi.v2.json` by hand), then regenerate the command
catalog:

```sh
go generate ./internal/catalog
```

`go test ./...` fails when `lock.json` does not match the spec, when the spec
carries an extension other than `x-meshy-scopes`, `x-meshy-pagination`,
`x-meshy-stream` and `x-meshy-union`, when its text names an issue-tracker key,
or when `internal/catalog/catalog.json` is not what the spec and
`overlay/cli.yaml` generate.
