package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/meshy-dev/meshy-cli/internal/output"
	"github.com/meshy-dev/meshy-cli/internal/version"
)

type run struct {
	code   int
	stdout string
	stderr string
}

// envelope decodes stdout as exactly one JSON document.
func (r run) envelope(t *testing.T) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(r.stdout))
	var env map[string]any
	if err := dec.Decode(&env); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, r.stdout)
	}
	if dec.More() {
		t.Fatalf("stdout holds more than one document:\n%s", r.stdout)
	}
	return env
}

func runCLI(t *testing.T, terminal bool, args []string, extra ...*cobra.Command) run {
	t.Helper()
	return runCtx(t, context.Background(), terminal, args, extra...)
}

func runCtx(t *testing.T, ctx context.Context, terminal bool, args []string, extra ...*cobra.Command) run {
	t.Helper()
	var out, errOut bytes.Buffer
	code := execute(ctx, Options{
		Args:             args,
		Stdout:           &out,
		Stderr:           &errOut,
		Getenv:           func(string) string { return "" },
		StdoutIsTerminal: terminal,
	}, extra...)
	return run{code, out.String(), errOut.String()}
}

// echoCommand reports the globals it saw.
func echoCommand() *cobra.Command {
	return &cobra.Command{
		Use:  "echo",
		Args: cobra.NoArgs,
		RunE: RunE(func(ctx context.Context, inv *Invocation, args []string) (any, []output.Warning, error) {
			return map[string]any{
				"profile":   inv.Globals.Profile,
				"workspace": inv.Globals.Workspace,
				"debug":     inv.Globals.Debug,
				"format":    string(inv.Format),
			}, nil, nil
		}),
	}
}

// printGroup is a group with one subcommand. Commands cache their parents'
// flags, so each run needs a fresh tree.
func printGroup() *cobra.Command {
	group := &cobra.Command{Use: "print"}
	group.AddCommand(echoCommand())
	return group
}

func failingCommand(name string, err error) *cobra.Command {
	return &cobra.Command{
		Use: name,
		RunE: RunE(func(context.Context, *Invocation, []string) (any, []output.Warning, error) {
			return nil, nil, err
		}),
	}
}

func TestVersion(t *testing.T) {
	for _, flag := range []string{"--version", "-V"} {
		r := runCLI(t, false, []string{flag})
		if r.code != 0 || r.stdout != version.Version+"\n" {
			t.Errorf("%s: code %d, stdout %q; want 0 and %q", flag, r.code, r.stdout, version.Version+"\n")
		}
	}
}

func TestHelp(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {}} {
		r := runCLI(t, false, args)
		if r.code != 0 {
			t.Errorf("%q: exit %d", args, r.code)
		}
		for _, flag := range []string{"--profile", "--format", "--workspace", "--debug", "--version"} {
			if !strings.Contains(r.stdout, flag) {
				t.Errorf("%q: help does not mention %s:\n%s", args, flag, r.stdout)
			}
		}
	}
}

func TestUsageErrors(t *testing.T) {
	cases := []struct {
		args    []string
		command string
		message string
	}{
		{[]string{"bogus"}, "meshy", `unknown command "bogus" for "meshy"`},
		{[]string{"--bogus"}, "meshy", "unknown flag: --bogus"},
		{[]string{"print", "bogsu"}, "print", `unknown command "bogsu" for "meshy print"`},
		{[]string{"print", "ehco"}, "print", `did you mean "echo"?`},
		{[]string{"print", "echo", "extra"}, "print.echo", `unknown command "extra"`},
		{[]string{"print", "echo", "--format", "yaml"}, "print.echo", `invalid --format "yaml"`},
		{[]string{"--format", "yaml", "bogus"}, "meshy", `unknown command "bogus"`},
	}
	for _, c := range cases {
		// On a terminal too: an invalid typed --format falls back to JSON.
		for _, terminal := range []bool{false, true} {
			args := c.args
			if terminal {
				if !strings.Contains(strings.Join(args, " "), "--format") {
					continue
				}
			}
			r := runCLI(t, terminal, args, printGroup())
			if r.code != output.ExitUsage {
				t.Errorf("%q: exit %d, want %d", args, r.code, output.ExitUsage)
				continue
			}
			env := r.envelope(t)
			errObj, _ := env["error"].(map[string]any)
			if env["ok"] != false || env["command"] != c.command || errObj["code"] != "usage" ||
				!strings.Contains(errObj["message"].(string), c.message) {
				t.Errorf("%q: envelope %v; want usage error on %q containing %q", args, env, c.command, c.message)
			}
			if !strings.HasPrefix(r.stderr, "error: ") {
				t.Errorf("%q: stderr %q, want an error line", args, r.stderr)
			}
		}
	}
}

// A run that fails before its action still prints in a valid typed --format.
func TestUsageErrorKeepsTypedFormat(t *testing.T) {
	r := runCLI(t, true, []string{"--format", "ndjson", "bogus"})
	if r.code != output.ExitUsage || strings.Count(r.stdout, "\n") != 1 ||
		!strings.HasPrefix(r.stdout, `{"schema_version":"meshy.cli/v2","command":"meshy","ok":false,`) {
		t.Errorf("ndjson on a terminal: exit %d, stdout %q; want one envelope line", r.code, r.stdout)
	}
	r = runCLI(t, false, []string{"--format", "pretty", "bogus"})
	if r.code != output.ExitUsage || r.stdout != "" || !strings.HasPrefix(r.stderr, "error: unknown command") {
		t.Errorf("pretty in a pipe: exit %d, stdout %q, stderr %q; want only the error on stderr", r.code, r.stdout, r.stderr)
	}
}

func TestGroupAloneShowsHelp(t *testing.T) {
	r := runCLI(t, false, []string{"print"}, printGroup())
	if r.code != 0 || !strings.Contains(r.stdout, "echo") {
		t.Errorf("code %d, stdout %q; want the group's help and exit 0", r.code, r.stdout)
	}
}

func TestGlobalFlagsAnyPosition(t *testing.T) {
	for _, args := range [][]string{
		{"--profile", "work", "--workspace", "/w", "--debug", "--format", "json", "print", "echo"},
		{"print", "--profile", "work", "echo", "--workspace", "/w", "--debug", "--format", "json"},
		{"print", "echo", "--profile=work", "--workspace=/w", "--debug", "--format=JSON"},
	} {
		r := runCLI(t, true, args, printGroup())
		if r.code != 0 {
			t.Fatalf("%q: exit %d, stderr %s", args, r.code, r.stderr)
		}
		env := r.envelope(t)
		want := map[string]any{"profile": "work", "workspace": "/w", "debug": true, "format": "json"}
		result, _ := env["result"].(map[string]any)
		for k, v := range want {
			if result[k] != v {
				t.Errorf("%q: result.%s = %v, want %v", args, k, result[k], v)
			}
		}
		if env["schema_version"] != "meshy.cli/v2" || env["command"] != "print.echo" || env["ok"] != true {
			t.Errorf("%q: envelope %v", args, env)
		}
		if !strings.Contains(r.stderr, "level=DEBUG") || !strings.Contains(r.stderr, "user_agent=") {
			t.Errorf("%q: --debug wrote no debug line to stderr: %q", args, r.stderr)
		}
	}
}

func TestDefaultFormat(t *testing.T) {
	// A pipe gets JSON, a terminal gets the pretty view; no debug output.
	r := runCLI(t, false, []string{"echo"}, echoCommand())
	if env := r.envelope(t); env["ok"] != true || r.stderr != "" {
		t.Errorf("piped: envelope %v, stderr %q", env, r.stderr)
	}
	r = runCLI(t, true, []string{"echo"}, echoCommand())
	if r.code != 0 || !strings.Contains(r.stdout, "format: pretty\n") || strings.Contains(r.stdout, "{") {
		t.Errorf("terminal: code %d, stdout %q; want the pretty view", r.code, r.stdout)
	}
	r = runCLI(t, false, []string{"echo", "--format", "ndjson"}, echoCommand())
	if strings.Count(r.stdout, "\n") != 1 || !strings.HasPrefix(r.stdout, `{"schema_version":"meshy.cli/v2"`) {
		t.Errorf("ndjson: stdout %q; want one line", r.stdout)
	}
}

func TestActionErrors(t *testing.T) {
	typed := &output.Error{
		Code:     output.CodeTimedOut,
		Message:  "still running",
		Result:   map[string]any{"task_id": "t1"},
		Warnings: []output.Warning{{Code: "poll_retried", Message: "a poll failed"}},
	}
	cases := []struct {
		err  error
		code string
		exit int
	}{
		{typed, "timed_out", output.ExitTimedOut},
		{errors.Join(errors.New("context"), typed), "timed_out", output.ExitTimedOut},
		{context.Canceled, "interrupted", output.ExitInterrupted},
		{errors.New("unexpected"), "internal", output.ExitGeneric},
	}
	for _, c := range cases {
		r := runCLI(t, false, []string{"fail"}, failingCommand("fail", c.err))
		if r.code != c.exit {
			t.Errorf("%v: exit %d, want %d", c.err, r.code, c.exit)
		}
		env := r.envelope(t)
		errObj, _ := env["error"].(map[string]any)
		if errObj["code"] != c.code || env["command"] != "fail" || env["ok"] != false {
			t.Errorf("%v: envelope %v", c.err, env)
		}
		if c.err == typed {
			result, _ := env["result"].(map[string]any)
			warnings, _ := env["warnings"].([]any)
			if result["task_id"] != "t1" || len(warnings) != 1 {
				t.Errorf("partial result or warnings lost: %v", env)
			}
		}
	}
}

func TestInterruptedRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	waiting := &cobra.Command{
		Use: "wait",
		RunE: RunE(func(ctx context.Context, _ *Invocation, _ []string) (any, []output.Warning, error) {
			cancel() // as a Ctrl-C would
			<-ctx.Done()
			return nil, nil, ctx.Err()
		}),
	}
	r := runCtx(t, ctx, false, []string{"wait"}, waiting)
	if r.code != output.ExitInterrupted {
		t.Errorf("exit %d, want %d", r.code, output.ExitInterrupted)
	}
}
