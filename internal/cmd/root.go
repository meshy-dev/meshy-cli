// Package cmd builds the command tree and runs one invocation: it parses the
// global flags, runs the command, and turns its result or error into exactly
// one envelope and an exit code.
package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"github.com/spf13/cobra"

	"github.com/meshy-dev/meshy-cli/internal/output"
	"github.com/meshy-dev/meshy-cli/internal/version"
)

// rootName is the command's name in help and the envelope of a run that
// found no command.
const rootName = "meshy"

// Globals are the flags every command accepts, at any position.
type Globals struct {
	// Profile names the stored credential profile to use; empty means the
	// active one.
	Profile string
	// Format is --format as typed; empty when it was not given.
	Format string
	// Workspace, when set, is the directory the files the CLI writes must
	// stay inside; the commands that write files enforce it.
	Workspace string
	// Debug logs request and decision details to stderr.
	Debug bool
}

// Options are the process-level inputs of one run.
type Options struct {
	Args             []string
	Stdout           io.Writer
	Stderr           io.Writer
	Getenv           func(string) string
	StdoutIsTerminal bool
}

// Invocation is what a running command can read about its run.
type Invocation struct {
	Globals Globals
	// Format is the resolved output format.
	Format output.Format
	// Command is the dotted command path, the envelope's "command".
	Command string
	Log     *slog.Logger
	Stdout  io.Writer
	Stderr  io.Writer
	Getenv  func(string) string

	stdoutIsTerminal bool
	// started is set once a command's action runs; an untyped error before
	// that came from parsing the command line.
	started bool
}

type invocationKey struct{}

// FromContext returns the invocation of a command's context.
func FromContext(ctx context.Context) *Invocation {
	inv, _ := ctx.Value(invocationKey{}).(*Invocation)
	return inv
}

// Action is a command body. Its result and warnings become the success
// envelope; an error becomes the failure envelope (return an *output.Error to
// choose the code, keep partial state in Result, or add warnings).
type Action func(ctx context.Context, inv *Invocation, args []string) (result any, warnings []output.Warning, err error)

// RunE adapts an Action to a cobra command.
func RunE(action Action) func(*cobra.Command, []string) error {
	return func(c *cobra.Command, args []string) error {
		inv := FromContext(c.Context())
		inv.started = true
		inv.Command = commandName(c)
		format, err := inv.resolveFormat()
		if err != nil {
			return err
		}
		inv.Format = format
		if inv.Globals.Debug {
			inv.Log = newLogger(inv.Stderr, slog.LevelDebug)
		}
		inv.Log.Debug("run", "command", inv.Command, "version", version.Version,
			"user_agent", version.UserAgent(), "format", string(format))
		result, warnings, err := action(c.Context(), inv, args)
		if err != nil {
			return err
		}
		return inv.printer().Success(inv.Command, result, warnings)
	}
}

// Execute runs one invocation and returns its exit code.
func Execute(ctx context.Context, o Options) int {
	return execute(ctx, o, builtins()...)
}

func execute(ctx context.Context, o Options, extra ...*cobra.Command) int {
	inv := &Invocation{
		Log:              newLogger(o.Stderr, slog.LevelWarn),
		Stdout:           o.Stdout,
		Stderr:           o.Stderr,
		Getenv:           o.Getenv,
		stdoutIsTerminal: o.StdoutIsTerminal,
	}
	root := newRoot(inv, extra...)
	root.SetArgs(o.Args)
	root.SetOut(o.Stdout)
	root.SetErr(o.Stderr)
	found, err := root.ExecuteContextC(context.WithValue(ctx, invocationKey{}, inv))
	if err == nil {
		return output.ExitOK
	}
	return inv.fail(found, err)
}

func newRoot(inv *Invocation, extra ...*cobra.Command) *cobra.Command {
	root := &cobra.Command{
		Use:     rootName,
		Short:   "Meshy command-line interface",
		Long:    "Meshy command-line interface for the Meshy API.\n\nOutput: pretty on a terminal, JSON otherwise (--format to choose).\nEnvironment: MESHY_CONFIG_DIR overrides the configuration directory (default ~/.config/meshy).",
		Version: version.Version,
		// Errors and usage are printed once, by fail.
		SilenceErrors: true,
		SilenceUsage:  true,
		CompletionOptions: cobra.CompletionOptions{
			DisableDefaultCmd: true,
		},
	}
	root.SetVersionTemplate("{{.Version}}\n")
	// Defined here so cobra does not add its own -v shorthand.
	root.Flags().BoolP("version", "V", false, "print the version")

	g := root.PersistentFlags()
	g.StringVar(&inv.Globals.Profile, "profile", "", "stored credential profile to use (default: the active one)")
	g.StringVar(&inv.Globals.Format, "format", "", "output format: json, pretty or ndjson (default: pretty on a terminal, json otherwise)")
	g.StringVar(&inv.Globals.Workspace, "workspace", "", "confine every file the CLI writes to this directory")
	g.BoolVar(&inv.Globals.Debug, "debug", false, "log debug details to stderr")

	for _, c := range extra {
		root.AddCommand(c)
	}
	asGroups(root)
	return root
}

// asGroups makes the root, and every other command that only groups
// subcommands, print its help when run alone and fail with a usage error on
// any argument (an unknown subcommand). Left alone, cobra rejects an unknown
// subcommand only at a root that has subcommands, and prints help with exit 0
// everywhere else.
func asGroups(root *cobra.Command) {
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, sub := range c.Commands() {
			walk(sub)
		}
		if c == root || (!c.Runnable() && c.HasSubCommands()) {
			asGroup(c)
		}
	}
	walk(root)
}

func asGroup(c *cobra.Command) {
	if c.SuggestionsMinimumDistance <= 0 {
		c.SuggestionsMinimumDistance = 2 // cobra's default for the root
	}
	c.Args = func(c *cobra.Command, args []string) error {
		if len(args) == 0 {
			return nil
		}
		msg := fmt.Sprintf("unknown command %q for %q", args[0], c.CommandPath())
		if s := c.SuggestionsFor(args[0]); len(s) > 0 {
			msg += fmt.Sprintf("; did you mean %q?", s[0])
		}
		return output.Errorf(output.CodeUsage, "%s", msg)
	}
	c.RunE = func(c *cobra.Command, args []string) error { return c.Help() }
}

// fail prints the failure envelope of err and returns its exit code.
func (inv *Invocation) fail(found *cobra.Command, err error) int {
	var e *output.Error
	if typed, ok := errors.AsType[*output.Error](err); ok {
		e = typed
	} else if !inv.started {
		// An untyped error before any action ran came from cobra's parsing:
		// an unknown command or flag, a missing argument.
		e = &output.Error{Code: output.CodeUsage, Message: err.Error(), Err: err}
	} else {
		e = output.Classify(err)
	}
	if inv.Command == "" {
		inv.Command = commandName(found)
	}
	if inv.Format == "" {
		// The command never reached its action: use --format if it parses,
		// json if it was typed but is invalid (a script typed it), and the
		// terminal rule otherwise.
		if f, perr := inv.resolveFormat(); perr == nil {
			inv.Format = f
		} else {
			inv.Format = output.JSON
		}
	}
	if perr := inv.printer().Failure(inv.Command, e); perr != nil {
		fmt.Fprintf(inv.Stderr, "error: writing the error envelope: %v\n", perr)
	}
	return e.ExitCode()
}

func (inv *Invocation) resolveFormat() (output.Format, error) {
	if inv.Globals.Format == "" {
		return output.DefaultFormat(inv.stdoutIsTerminal), nil
	}
	return output.ParseFormat(inv.Globals.Format)
}

func (inv *Invocation) printer() output.Printer {
	return output.Printer{Format: inv.Format, Stdout: inv.Stdout, Stderr: inv.Stderr}
}

// commandName is the dotted path below the root ("tasks.get"), or the root's
// name when no command was found.
func commandName(c *cobra.Command) string {
	if c == nil || !c.HasParent() {
		return rootName
	}
	parts := strings.Fields(c.CommandPath())
	return strings.Join(parts[1:], ".")
}

func newLogger(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: level}))
}
