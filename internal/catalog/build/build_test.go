package build

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/meshy-dev/meshy-cli/internal/catalog"
)

type obj = map[string]any

// fixture is a small spec with one operation of each shape the generator
// handles: a create with a body and a header, a paged list, an item get, a
// delete, a stream, a singleton and a bare-array list.
func fixture() obj {
	created := obj{"202": obj{"description": "created", "content": obj{"application/json": obj{"schema": obj{"$ref": "#/components/schemas/Widget"}}}}}
	return obj{
		"openapi": "3.1.0",
		"info":    obj{"title": "test", "version": "v1+abc"},
		"paths": obj{
			"/v2/widgets": obj{
				"post": obj{
					"operationId":    "createWidget",
					"summary":        "Create a widget",
					"x-meshy-scopes": []any{"widget:create"},
					"parameters":     []any{obj{"$ref": "#/components/parameters/Metadata"}},
					"requestBody": obj{"content": obj{"application/json": obj{"schema": obj{
						"type":        "object",
						"description": "Send model_url or input_task_id.",
						"required":    []any{"count"},
						"properties": obj{
							"model_url":     obj{"type": "string", "description": "A model. More text."},
							"input_task_id": obj{"type": "string"},
							"count":         obj{"type": "integer", "minimum": 1},
							"style":         obj{"$ref": "#/components/schemas/Style"},
						},
					}}}},
					"responses": created,
				},
				"get": obj{
					"operationId":        "listWidgets",
					"x-meshy-scopes":     []any{"widget:read"},
					"x-meshy-pagination": obj{"kind": "PAGE", "max": 100, "params": []any{"page_num"}},
					"parameters":         []any{obj{"name": "page_num", "in": "query", "schema": obj{"type": "integer"}}},
					"responses": obj{"200": obj{"description": "ok", "content": obj{"application/json": obj{"schema": obj{
						"type": "object", "properties": obj{"data": obj{"type": "array", "items": obj{"$ref": "#/components/schemas/Widget"}}},
					}}}}},
				},
			},
			"/v2/widgets/{id}": obj{
				"parameters": []any{obj{"name": "id", "in": "path", "required": true, "description": "The widget.", "schema": obj{"type": "string"}}},
				"get": obj{
					"operationId": "getWidget",
					"responses":   obj{"200": obj{"description": "ok", "content": obj{"application/json": obj{"schema": obj{"$ref": "#/components/schemas/Widget"}}}}},
				},
				"delete": obj{
					"operationId": "deleteWidget",
					"responses":   obj{"200": obj{"description": "deleted"}},
				},
			},
			"/v2/widgets/{id}/stream": obj{
				"parameters": []any{obj{"name": "id", "in": "path", "required": true, "schema": obj{"type": "string"}}},
				"get": obj{
					"operationId":    "streamWidget",
					"x-meshy-stream": obj{"error_event": "error", "terminal_events": []any{"DONE"}},
					"responses":      obj{"200": obj{"description": "events", "content": obj{"text/event-stream": obj{"schema": obj{"type": "string"}}}}},
				},
			},
			"/v2/account": obj{"get": obj{
				"operationId": "getAccount",
				"responses":   obj{"200": obj{"description": "ok", "content": obj{"application/json": obj{"schema": obj{"$ref": "#/components/schemas/Widget"}}}}},
			}},
			"/v2/library": obj{"get": obj{
				"operationId": "listLibrary",
				"responses": obj{"200": obj{"description": "ok", "content": obj{"application/json": obj{"schema": obj{
					"type": "array", "items": obj{"$ref": "#/components/schemas/Widget"},
				}}}}},
			}},
		},
		"components": obj{
			"schemas": obj{
				"Widget": obj{"type": "object"},
				"Style":  obj{"type": "string", "enum": []any{"a", "b"}, "description": "The style."},
			},
			"parameters": obj{"Metadata": obj{"name": "X-Meshy-Metadata", "in": "header", "description": "Your tags.", "schema": obj{"type": "string"}}},
		},
	}
}

const fixtureOverlay = `
cli_flags:
  - name: help
  - name: format
commands:
  - schema
operations:
  createWidget:
    exclusive:
      - [model_url, input_task_id]
`

func inputs(t *testing.T, spec obj, overlay string) Inputs {
	t.Helper()
	b, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	version, _ := spec["info"].(obj)["version"].(string)
	lock, _ := json.Marshal(obj{"version": version, "sha256": sha256Hex(b), "sources": obj{}})
	return Inputs{Spec: b, Lock: lock, Overlay: []byte(overlay)}
}

func build(t *testing.T, in Inputs) *catalog.Catalog {
	t.Helper()
	out, err := Build(in)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	cat, err := catalog.Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

func names(cat *catalog.Catalog) []string {
	var out []string
	for i := range cat.Commands {
		out = append(out, strings.Join(cat.Commands[i].Path, " "))
	}
	return out
}

func TestBuildFixture(t *testing.T) {
	cat := build(t, inputs(t, fixture(), fixtureOverlay))

	want := []string{"account get", "library list", "widgets create", "widgets delete", "widgets get", "widgets list", "widgets stream"}
	if got := names(cat); !slices.Equal(got, want) {
		t.Fatalf("commands = %q, want %q", got, want)
	}
	if !slices.Equal(cat.Scopes, []string{"widget:create", "widget:read"}) {
		t.Errorf("scopes = %q", cat.Scopes)
	}
	if cat.Spec.Version != "v1+abc" {
		t.Errorf("spec version = %q", cat.Spec.Version)
	}

	create := cat.Find([]string{"widgets", "create"})
	var flags []string
	for _, p := range create.Params {
		flags = append(flags, p.Name+"="+p.In+":"+p.Field)
	}
	wantFlags := []string{"count=body:count", "input-task-id=body:input_task_id", "metadata=header:X-Meshy-Metadata", "model-url=body:model_url", "style=body:style"}
	if !slices.Equal(flags, wantFlags) {
		t.Errorf("create flags = %q, want %q", flags, wantFlags)
	}
	if p := create.Param("count"); !p.Required || p.Schema["minimum"] == nil {
		t.Errorf("count = %+v, want required with its minimum kept", p)
	}
	style := create.Param("style")
	if style.Description != "The style." || style.Schema["description"] != nil || len(style.Schema["enum"].([]any)) != 2 {
		t.Errorf("style = %+v, want the $ref inlined and its description moved out", style)
	}
	if got := create.Param("model_url").Description; got != "A model. More text." {
		t.Errorf("model_url description = %q", got)
	}
	if create.BodyDescription != "Send model_url or input_task_id." {
		t.Errorf("body description = %q", create.BodyDescription)
	}
	if !slices.EqualFunc(create.Exclusive, [][]string{{"model_url", "input_task_id"}}, slices.Equal) {
		t.Errorf("exclusive = %q", create.Exclusive)
	}
	if create.Response != (catalog.Response{Status: 202, Kind: catalog.ResponseObject, Schema: "Widget"}) {
		t.Errorf("create response = %+v", create.Response)
	}

	get := cat.Find([]string{"widgets", "get"})
	if len(get.Args) != 1 || get.Args[0].Name != "id" || !get.Args[0].Required || get.Args[0].Description != "The widget." {
		t.Errorf("get args = %+v", get.Args)
	}
	list := cat.Find([]string{"widgets", "list"})
	if list.Response.Kind != catalog.ResponseList || list.Pagination == nil || list.Pagination.Max != 100 {
		t.Errorf("list = %+v / %+v", list.Response, list.Pagination)
	}
	if r := cat.Find([]string{"library", "list"}).Response; r.Kind != catalog.ResponseList || r.Schema != "Widget[]" {
		t.Errorf("library response = %+v", r)
	}
	if r := cat.Find([]string{"account", "get"}).Response; r.Kind != catalog.ResponseObject {
		t.Errorf("account response = %+v", r)
	}
	if r := cat.Find([]string{"widgets", "delete"}).Response; r.Kind != catalog.ResponseEmpty {
		t.Errorf("delete response = %+v", r)
	}
	st := cat.Find([]string{"widgets", "stream"})
	if st.Response.Kind != catalog.ResponseStream || st.Stream == nil || st.Stream.ErrorEvent != "error" {
		t.Errorf("stream = %+v / %+v", st.Response, st.Stream)
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	in := inputs(t, fixture(), fixtureOverlay)
	a, err := Build(in)
	if err != nil {
		t.Fatal(err)
	}
	for range 5 {
		b, err := Build(in)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a, b) {
			t.Fatal("two builds of the same inputs differ")
		}
	}
}

func paths(s obj) obj  { return s["paths"].(obj) }
func create(s obj) obj { return paths(s)["/v2/widgets"].(obj)["post"].(obj) }
func createProps(s obj) obj {
	return create(s)["requestBody"].(obj)["content"].(obj)["application/json"].(obj)["schema"].(obj)["properties"].(obj)
}
func createSchema(s obj) obj {
	return create(s)["requestBody"].(obj)["content"].(obj)["application/json"].(obj)["schema"].(obj)
}

func TestBuildRejects(t *testing.T) {
	cases := []struct {
		name    string
		spec    func(s obj)
		overlay string
		lock    func(in *Inputs)
		want    string
	}{
		{name: "lock digest", lock: func(in *Inputs) { in.Lock = bytes.Replace(in.Lock, []byte(`"sha256":"`), []byte(`"sha256":"0`), 1) }, want: "hashes to"},
		{name: "lock version", spec: func(s obj) { s["info"].(obj)["version"] = "v2" }, lock: func(in *Inputs) {
			in.Lock = bytes.Replace(in.Lock, []byte(`"version":"v2"`), []byte(`"version":"v1"`), 1)
		}, want: "info.version"},
		{name: "extension", spec: func(s obj) { create(s)["x-meshy-gate"] = "g" }, want: "extension x-meshy-gate is not allowed"},
		{name: "issue key in text", spec: func(s obj) { create(s)["description"] = "See ABC-123." }, want: `"ABC-123"`},
		{name: "path outside v2", spec: func(s obj) { paths(s)["/v1/widgets"] = obj{} }, want: "not under /v2/"},
		{name: "duplicate operationId", spec: func(s obj) {
			paths(s)["/v2/account"].(obj)["get"].(obj)["operationId"] = "createWidget"
		}, want: "operationId createWidget also names"},
		{name: "no operationId", spec: func(s obj) { delete(create(s), "operationId") }, want: "no operationId"},
		{name: "body composition", spec: func(s obj) { createSchema(s)["oneOf"] = []any{obj{"type": "object"}} }, want: "uses oneOf"},
		{name: "required field not defined", spec: func(s obj) { createSchema(s)["required"] = []any{"nope"} }, want: "requires nope"},
		{name: "two params one flag", spec: func(s obj) { createProps(s)["metadata"] = obj{"type": "string"} }, want: "would both be --metadata"},
		{name: "flag not kebab", spec: func(s obj) { createProps(s)["Count"] = obj{"type": "string"} }, want: "not kebab-case"},
		{name: "no naming rule", spec: func(s obj) {
			paths(s)["/v2/widgets/{id}"].(obj)["post"] = obj{"operationId": "postWidget", "responses": obj{"200": obj{"description": "ok"}}}
		}, want: "no naming rule"},
		{name: "two operations one command", spec: func(s obj) {
			paths(s)["/v2/widgets/{key}"] = obj{"get": obj{
				"operationId": "getWidget2",
				"parameters":  []any{obj{"name": "key", "in": "path", "required": true, "schema": obj{"type": "string"}}},
				"responses":   obj{"200": obj{"description": "ok"}},
			}}
		}, want: `both make the command "widgets get"`},
		{name: "undeclared path parameter", spec: func(s obj) { delete(paths(s)["/v2/widgets/{id}"].(obj), "parameters") }, want: "{id} is not declared"},
		{name: "cookie parameter", spec: func(s obj) {
			create(s)["parameters"] = []any{obj{"name": "c", "in": "cookie", "schema": obj{"type": "string"}}}
		}, want: `in "cookie"`},
		{name: "no 2xx", spec: func(s obj) { create(s)["responses"] = obj{"400": obj{"description": "bad"}} }, want: "no 2xx response"},
		{name: "recursive schema", spec: func(s obj) {
			s["components"].(obj)["schemas"].(obj)["Style"] = obj{"type": "object", "properties": obj{"next": obj{"$ref": "#/components/schemas/Style"}}}
		}, want: "recursive schema"},
		{name: "unknown pagination key", spec: func(s obj) {
			paths(s)["/v2/widgets"].(obj)["get"].(obj)["x-meshy-pagination"].(obj)["cursor"] = "c"
		}, want: "x-meshy-pagination"},
		{name: "flag clashes with a CLI flag", spec: func(s obj) { createProps(s)["format"] = obj{"type": "string"} }, want: "has the name of the CLI's own --format"},
		{name: "hand-written command clash", overlay: strings.Replace(fixtureOverlay, "  - schema\n", "  - schema\n  - widgets get\n", 1), want: `"widgets get" has the path of a generated command`},
		{name: "unknown operation", overlay: fixtureOverlay + "  createGadget:\n    exclusive: [[a, b]]\n", want: "createGadget is not an operation"},
		{name: "unknown exclusive field", overlay: strings.Replace(fixtureOverlay, "[model_url, input_task_id]", "[model_url, image_url]", 1), want: "exclusive field image_url is not a parameter"},
		{name: "exclusive of one", overlay: strings.Replace(fixtureOverlay, "[model_url, input_task_id]", "[model_url]", 1), want: "two or more fields"},
		{name: "unknown overlay key", overlay: fixtureOverlay + "aliases: {}\n", want: "field aliases not found"},
		{name: "per-command flag key", overlay: strings.Replace(fixtureOverlay, "  - name: format\n", "  - name: format\n    on: [\"*.create\"]\n", 1), want: "field on not found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := fixture()
			if c.spec != nil {
				c.spec(s)
			}
			ov := fixtureOverlay
			if c.overlay != "" {
				ov = c.overlay
			}
			in := inputs(t, s, ov)
			if c.lock != nil {
				c.lock(&in)
			}
			_, err := Build(in)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("Build error = %v, want one containing %q", err, c.want)
			}
		})
	}
}

// TestRepoSpec builds the committed spec and overlay and checks the command
// set the CLI ships.
func TestRepoSpec(t *testing.T) {
	var in Inputs
	for _, f := range []struct {
		path string
		dst  *[]byte
	}{{"spec/openapi.v2.json", &in.Spec}, {"spec/lock.json", &in.Lock}, {"overlay/cli.yaml", &in.Overlay}} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", f.path))
		if err != nil {
			t.Fatal(err)
		}
		*f.dst = b
	}
	cat := build(t, in)
	want := []string{
		"animations create", "animations library list", "balance get", "convert create",
		"image-to-3d create", "image-to-image create", "multi-image-to-3d create",
		"print analyze create", "print multi-color create", "print repair create", "print split create",
		"relief create", "remesh create", "resize create", "retexture create",
		"rigging check create", "rigging create",
		"tasks delete", "tasks get", "tasks list", "tasks stream",
		"text-to-3d create", "text-to-image create", "text-to-motion create",
		"usage tasks list", "uv-unwrap create",
	}
	if got := names(cat); !slices.Equal(got, want) {
		t.Fatalf("commands =\n%q\nwant\n%q", got, want)
	}
}
