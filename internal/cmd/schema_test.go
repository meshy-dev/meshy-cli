package cmd

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/meshy-dev/meshy-cli/internal/catalog/build"
)

func TestSchemaList(t *testing.T) {
	r := runCLI(t, false, []string{"schema"}, newSchemaCommand())
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stdout)
	}
	env := r.envelope(t)
	result := env["result"].(map[string]any)
	cmds := result["commands"].([]any)
	var names []string
	for _, c := range cmds {
		names = append(names, c.(map[string]any)["command"].(string))
	}
	for _, want := range []string{"rigging.create", "print.analyze.create", "tasks.get", "tasks.list", "balance.get", "usage.tasks.list", "animations.library.list"} {
		if !slices.Contains(names, want) {
			t.Errorf("schema lists no %s", want)
		}
	}
	if spec := result["spec"].(map[string]any); spec["version"] == "" || spec["sha256"] == "" {
		t.Errorf("spec = %v", spec)
	}
}

func TestSchemaCommand(t *testing.T) {
	for _, args := range [][]string{{"schema", "rigging", "create"}, {"schema", "rigging.create"}} {
		r := runCLI(t, false, args, newSchemaCommand())
		if r.code != 0 {
			t.Fatalf("%v: exit %d: %s", args, r.code, r.stdout)
		}
		res := r.envelope(t)["result"].(map[string]any)
		if res["command"] != "rigging.create" || res["method"] != "POST" || res["path"] != "/v2/rigging" || res["usage"] != "meshy rigging create" {
			t.Errorf("%v: result = %v", args, res)
		}
		var flags []string
		for _, f := range res["flags"].([]any) {
			f := f.(map[string]any)
			flags = append(flags, f["name"].(string))
			if f["name"] == "--model-url" && (f["description"] == "" || f["schema"].(map[string]any)["type"] != "string") {
				t.Errorf("--model-url = %v", f)
			}
		}
		if !slices.Contains(flags, "--model-url") || !slices.Contains(flags, "--input-task-id") {
			t.Errorf("flags = %v", flags)
		}
		if got := res["exclusive"].([]any); len(got) != 1 || len(got[0].([]any)) != 2 {
			t.Errorf("exclusive = %v", got)
		}
		if scopes := res["scopes"].([]any); !slices.Contains(scopes, any("task:task:create")) {
			t.Errorf("scopes = %v", scopes)
		}
	}

	r := runCLI(t, false, []string{"schema", "tasks", "get"}, newSchemaCommand())
	res := r.envelope(t)["result"].(map[string]any)
	if res["usage"] != "meshy tasks get <id>" || len(res["arguments"].([]any)) != 1 {
		t.Errorf("tasks get = %v", res)
	}
}

func TestSchemaUnknownCommand(t *testing.T) {
	r := runCLI(t, false, []string{"schema", "rigging", "nope"}, newSchemaCommand())
	if r.code != 2 {
		t.Fatalf("exit %d, want 2", r.code)
	}
	e := r.envelope(t)["error"].(map[string]any)
	if e["code"] != "usage" || !strings.Contains(e["message"].(string), "rigging nope") {
		t.Errorf("error = %v", e)
	}
}

// TestOverlayReservesTheCommandTree keeps overlay/cli.yaml in step with the
// code: every flag the root defines and every hand-written command must be
// reserved there, or the generator could not stop a generated flag or
// command from taking the same name.
func TestOverlayReservesTheCommandTree(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "overlay", "cli.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	flags, commands, err := build.Reserved(b)
	if err != nil {
		t.Fatal(err)
	}

	root := newRoot(&Invocation{}, builtins()...)
	root.InitDefaultHelpFlag()
	defined := map[string]bool{}
	root.Flags().VisitAll(func(f *pflag.Flag) { defined[f.Name] = true })
	root.PersistentFlags().VisitAll(func(f *pflag.Flag) { defined[f.Name] = true })
	for name := range defined {
		if !slices.Contains(flags, name) {
			t.Errorf("flag --%s is not reserved under cli_flags in overlay/cli.yaml", name)
		}
	}

	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, sub := range c.Commands() {
			path := strings.Join(strings.Fields(sub.CommandPath())[1:], " ")
			if !sub.HasSubCommands() && !slices.Contains(commands, path) {
				t.Errorf("command %q is not listed under commands in overlay/cli.yaml", path)
			}
			walk(sub)
		}
	}
	walk(root)
}

// Execute, the entry point main calls, registers schema.
func TestExecuteHasSchema(t *testing.T) {
	var out, errOut strings.Builder
	code := Execute(t.Context(), Options{
		Args:   []string{"schema", "balance", "get"},
		Stdout: &out,
		Stderr: &errOut,
		Getenv: func(string) string { return "" },
	})
	if code != 0 || !strings.Contains(out.String(), `"command": "balance.get"`) {
		t.Fatalf("exit %d\n%s%s", code, out.String(), errOut.String())
	}
}
