package cmdpath

import (
	"slices"
	"strings"
	"testing"
)

func TestFor(t *testing.T) {
	cases := []struct {
		op   Operation
		want string
	}{
		{Operation{Method: "POST", Path: "/v2/print/analyze"}, "print analyze create"},
		{Operation{Method: "post", Path: "/openapi/v2/rigging"}, "rigging create"},
		{Operation{Method: "POST", Path: "/v2/text-to-3d"}, "text-to-3d create"},
		{Operation{Method: "GET", Path: "/v2/tasks"}, "tasks list"},
		{Operation{Method: "GET", Path: "/v2/tasks/{id}"}, "tasks get"},
		{Operation{Method: "get", Path: "/openapi/v2/tasks/{task_id}"}, "tasks get"},
		{Operation{Method: "GET", Path: "/v2/tasks/{id}/stream"}, "tasks stream"},
		{Operation{Method: "DELETE", Path: "/v2/tasks/{id}"}, "tasks delete"},
		{Operation{Method: "GET", Path: "/v2/animations/library"}, "animations library list"},
		{Operation{Method: "GET", Path: "/v2/usage/tasks"}, "usage tasks list"},
		{Operation{Method: "GET", Path: "/v2/balance", Singleton: true}, "balance get"},
		// Singleton is read only for a GET on a collection.
		{Operation{Method: "GET", Path: "/v2/tasks/{id}", Singleton: true}, "tasks get"},
		{Operation{Method: "POST", Path: "/v2/rigging", Singleton: true}, "rigging create"},
		// A parameter in the middle is dropped; the literals around it stay.
		{Operation{Method: "GET", Path: "/v2/animations/{id}/clips"}, "animations clips list"},
		// "stream" is the verb only on a GET; a POST to it is an ordinary create.
		{Operation{Method: "POST", Path: "/v2/events/stream"}, "events stream create"},
	}
	for _, c := range cases {
		got, err := For(c.op)
		if err != nil {
			t.Errorf("For(%s %s): %v", c.op.Method, c.op.Path, err)
			continue
		}
		if !slices.Equal(got, strings.Fields(c.want)) {
			t.Errorf("For(%s %s) = %q, want %q", c.op.Method, c.op.Path, got, c.want)
		}
	}
}

func TestForRejects(t *testing.T) {
	cases := []Operation{
		{Method: "GET", Path: "/v1/tasks"},
		{Method: "GET", Path: "/openapi/v1/balance"},
		{Method: "GET", Path: "/openapi/creative-lab/keycap/v1/tasks"},
		{Method: "GET", Path: "tasks"},
		{Method: "GET", Path: "/v2/"},
		{Method: "GET", Path: "/v2/tasks/"},
		{Method: "GET", Path: "/v2//tasks"},
		{Method: "GET", Path: "/v2/{id}"},
		{Method: "GET", Path: "/v2/stream"},
		{Method: "GET", Path: "/v2/Tasks"},
		{Method: "GET", Path: "/v2/text_to_3d"},
		{Method: "GET", Path: "/v2/tasks/{id"},
		{Method: "GET", Path: "/v2/tasks/x{id}"},
		{Method: "POST", Path: "/v2/tasks/{id}"},
		{Method: "PUT", Path: "/v2/tasks/{id}"},
		{Method: "PATCH", Path: "/v2/tasks/{id}"},
		{Method: "DELETE", Path: "/v2/tasks"},
	}
	for _, op := range cases {
		if got, err := For(op); err == nil {
			t.Errorf("For(%s %s) = %q, want an error", op.Method, op.Path, got)
		}
	}
}

func TestName(t *testing.T) {
	if got := Name([]string{"print", "analyze", "create"}); got != "print.analyze.create" {
		t.Errorf("Name = %q", got)
	}
}
