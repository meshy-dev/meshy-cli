package catalog

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/meshy-dev/meshy-cli/internal/output"
)

type obj = map[string]any

func testCommand() *Command {
	return &Command{
		Path: []string{"widgets", "create"},
		Args: []Param{{Name: "id", Field: "id", In: InPath, Required: true, Schema: obj{"type": "string"}}},
		Params: []Param{
			{Name: "count", Field: "count", In: InBody, Required: true, Schema: obj{"type": "integer", "minimum": json.Number("1")}},
			{Name: "height", Field: "height", In: InBody, Schema: obj{"type": []any{"number", "null"}}},
			{Name: "fingers", Field: "fingers", In: InBody, Schema: obj{"type": "boolean"}},
			{Name: "model", Field: "model", In: InBody, Schema: obj{"type": "string", "enum": []any{"a", "b"}}},
			{Name: "formats", Field: "formats", In: InBody, Schema: obj{"type": "array", "items": obj{"type": "string", "enum": []any{"glb", "fbx"}}}},
			{Name: "fps", Field: "fps", In: InBody, Schema: obj{"type": "integer", "enum": []any{json.Number("24"), json.Number("30")}}},
			{Name: "post", Field: "post", In: InBody, Schema: obj{
				"type":       []any{"object", "null"},
				"required":   []any{"op"},
				"properties": obj{"op": obj{"type": "string", "enum": []any{"x"}}, "fps": obj{"type": "integer"}},
			}},
			{Name: "model-url", Field: "model_url", In: InBody, Schema: obj{"type": "string"}},
			{Name: "input-task-id", Field: "input_task_id", In: InBody, Schema: obj{"type": []any{"string", "null"}}},
			{Name: "page", Field: "page", In: InQuery, Schema: obj{"type": "integer"}},
			{Name: "metadata", Field: "X-Meshy-Metadata", In: InHeader, Schema: obj{"type": "string"}},
		},
		Exclusive: [][]string{{"model_url", "input_task_id"}},
	}
}

func valid() Request {
	return Request{Path: map[string]string{"id": "t1"}, Body: obj{"count": json.Number("2")}}
}

func TestValidateAccepts(t *testing.T) {
	cases := []struct {
		name string
		edit func(r *Request)
	}{
		{"minimal", func(r *Request) {}},
		{"integer for a number", func(r *Request) { r.Body["height"] = 2 }},
		{"float for a number", func(r *Request) { r.Body["height"] = 1.75 }},
		{"null where nullable", func(r *Request) { r.Body["height"] = nil }},
		{"whole json.Number for an integer", func(r *Request) { r.Body["count"] = json.Number("3.0") }},
		{"Go int for an integer", func(r *Request) { r.Body["count"] = int64(3) }},
		{"boolean", func(r *Request) { r.Body["fingers"] = true }},
		{"nested object", func(r *Request) { r.Body["post"] = obj{"op": "x", "fps": 30} }},
		{"one of an exclusive group", func(r *Request) { r.Body["model_url"] = "https://x/y.glb" }},
		{"null does not count as sent", func(r *Request) {
			r.Body["model_url"] = "https://x/y.glb"
			r.Body["input_task_id"] = nil
		}},
		{"query and header", func(r *Request) {
			r.Query = obj{"page": 2}
			r.Header = obj{"X-Meshy-Metadata": "a=b"}
		}},
		{"below the documented minimum (the server decides)", func(r *Request) { r.Body["count"] = 0 }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := valid()
			c.edit(&r)
			warnings, err := testCommand().Validate(r)
			if err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if len(warnings) != 0 {
				t.Fatalf("warnings = %v", warnings)
			}
		})
	}
}

func TestValidateRefuses(t *testing.T) {
	cases := []struct {
		name string
		edit func(r *Request)
		want []Problem
	}{
		{"missing required flag", func(r *Request) { delete(r.Body, "count") },
			[]Problem{{"--count", "missing; it is required"}}},
		{"missing argument", func(r *Request) { r.Path = nil },
			[]Problem{{"<id>", "missing"}}},
		{"string for an integer", func(r *Request) { r.Body["count"] = "two" },
			[]Problem{{"--count", `want integer, got the string "two"`}}},
		{"fraction for an integer", func(r *Request) { r.Body["count"] = 2.5 },
			[]Problem{{"--count", "want integer, got a number 2.5"}}},
		{"string for a boolean", func(r *Request) { r.Body["fingers"] = "yes" },
			[]Problem{{"--fingers", `want boolean, got the string "yes"`}}},
		{"null where not nullable", func(r *Request) { r.Body["fingers"] = nil },
			[]Problem{{"--fingers", "must not be null"}}},
		{"array item of the wrong type", func(r *Request) { r.Body["formats"] = []any{"glb", 3} },
			[]Problem{{"--formats", "[1]: want string, got an integer 3"}}},
		{"nested required", func(r *Request) { r.Body["post"] = obj{"fps": 30} },
			[]Problem{{"--post", "op is required"}}},
		{"nested type", func(r *Request) { r.Body["post"] = obj{"op": "x", "fps": "thirty"} },
			[]Problem{{"--post", `fps: want integer, got the string "thirty"`}}},
		{"query type", func(r *Request) { r.Query = obj{"page": "two"} },
			[]Problem{{"--page", `want integer, got the string "two"`}}},
		{"both of an exclusive group", func(r *Request) {
			r.Body["model_url"] = "https://x/y.glb"
			r.Body["input_task_id"] = "t0"
		}, []Problem{{"--model-url, --input-task-id", "send at most one of --model-url, --input-task-id"}}},
		{"every problem at once", func(r *Request) {
			delete(r.Body, "count")
			r.Body["fingers"] = 1
		}, []Problem{{"--count", "missing; it is required"}, {"--fingers", "want boolean, got an integer 1"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := valid()
			c.edit(&r)
			_, err := testCommand().Validate(r)
			e, ok := errors.AsType[*output.Error](err)
			if !ok {
				t.Fatalf("Validate error = %v, want an *output.Error", err)
			}
			if e.Code != output.CodeUsage || e.ExitCode() != 2 {
				t.Errorf("code = %s, exit %d; want usage, exit 2", e.Code, e.ExitCode())
			}
			got := e.Details.(map[string]any)["problems"].([]Problem)
			if len(got) != len(c.want) {
				t.Fatalf("problems = %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("problem %d = %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

// Known values are a hint: a value outside them is sent with a warning, so a
// model or format added to the API after this release still works.
func TestValidateWarnsOnUnknownValues(t *testing.T) {
	r := valid()
	r.Body["model"] = "c"
	r.Body["formats"] = []any{"glb", "usdz"}
	r.Body["fps"] = 60
	r.Body["post"] = obj{"op": "y"}
	warnings, err := testCommand().Validate(r)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	want := []string{
		`--model: "c" is not one of the known values ("a", "b"); sending it anyway`,
		`--formats: "usdz" is not one of the known values ("glb", "fbx"); sending it anyway`,
		`--fps: 60 is not one of the known values (24, 30); sending it anyway`,
		`--post: op: "y" is not one of the known values ("x"); sending it anyway`,
	}
	var got []string
	for _, w := range warnings {
		if w.Code != WarnUnknownValue {
			t.Errorf("warning code = %q", w.Code)
		}
		got = append(got, w.Message)
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("warnings =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}

	// a known value, whatever its Go number type, warns nothing
	r = valid()
	r.Body["fps"] = 30.0
	if warnings, _ := testCommand().Validate(r); len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
}

// The embedded catalog refuses what the API refuses outright.
func TestEmbeddedCatalogValidates(t *testing.T) {
	cat, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	rig := cat.Find([]string{"rigging", "create"})
	if rig == nil {
		t.Fatal("no rigging create command")
	}
	_, err = rig.Validate(Request{Body: obj{"model_url": "https://x/y.glb", "input_task_id": "t0"}})
	if e, ok := errors.AsType[*output.Error](err); !ok || !strings.Contains(e.Message, "send at most one of --input-task-id, --model-url") {
		t.Fatalf("Validate = %v", err)
	}
	warnings, err := rig.Validate(Request{Body: obj{"model_url": "https://x/y.glb", "skeleton_template": "new_rig"}})
	if err != nil || len(warnings) != 1 {
		t.Fatalf("Validate = %v, %v; want one warning", warnings, err)
	}
	get := cat.Find([]string{"tasks", "get"})
	if _, err := get.Validate(Request{}); err == nil {
		t.Fatal("tasks get without <id> passed")
	}
}
