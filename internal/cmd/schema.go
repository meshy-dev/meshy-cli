package cmd

import (
	"context"
	"strings"

	"github.com/spf13/cobra"

	"github.com/meshy-dev/meshy-cli/internal/catalog"
	"github.com/meshy-dev/meshy-cli/internal/output"
)

// builtins are the hand-written commands every run registers. Each one's
// path is listed under commands in overlay/cli.yaml, so a generated command
// cannot take it.
func builtins() []*cobra.Command {
	return []*cobra.Command{newSchemaCommand()}
}

func newSchemaCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "schema [command]",
		Short: "Show what an API command sends and returns",
		Long: "Without a command, list every API command. With one (\"rigging create\" or\n" +
			"\"rigging.create\"), show its flags with their full descriptions and JSON\n" +
			"Schemas, its arguments, the groups of flags it refuses together, the\n" +
			"OAuth scopes it needs and the shape of its response.",
		Example: "  meshy schema\n  meshy schema rigging create\n  meshy schema tasks.get",
		RunE:    RunE(runSchema),
	}
}

func runSchema(_ context.Context, _ *Invocation, args []string) (any, []output.Warning, error) {
	cat, err := catalog.Load()
	if err != nil {
		return nil, nil, err
	}
	if len(args) == 0 {
		return schemaList(cat), nil, nil
	}
	path := args
	if len(args) == 1 && strings.Contains(args[0], ".") {
		path = strings.Split(args[0], ".")
	}
	c := cat.Find(path)
	if c == nil {
		return nil, nil, &output.Error{
			Code:    output.CodeUsage,
			Message: "no API command " + strings.Join(path, " "),
			Hint:    "meshy schema",
		}
	}
	return schemaOf(c), nil, nil
}

type schemaListView struct {
	Spec     catalog.SpecInfo  `json:"spec"`
	Commands []schemaListEntry `json:"commands"`
}

type schemaListEntry struct {
	Command string `json:"command"`
	Usage   string `json:"usage"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	Summary string `json:"summary"`
}

func schemaList(cat *catalog.Catalog) schemaListView {
	v := schemaListView{Spec: cat.Spec, Commands: []schemaListEntry{}}
	for i := range cat.Commands {
		c := &cat.Commands[i]
		v.Commands = append(v.Commands, schemaListEntry{
			Command: c.Name(),
			Usage:   usage(c),
			Method:  c.Method,
			Path:    c.HTTPPath,
			Summary: c.Summary,
		})
	}
	return v
}

type schemaView struct {
	Command            string              `json:"command"`
	Usage              string              `json:"usage"`
	OperationID        string              `json:"operation_id"`
	Method             string              `json:"method"`
	Path               string              `json:"path"`
	Summary            string              `json:"summary"`
	Description        string              `json:"description"`
	RequestDescription string              `json:"request_description,omitempty"`
	Scopes             []string            `json:"scopes"`
	Arguments          []schemaParam       `json:"arguments"`
	Flags              []schemaParam       `json:"flags"`
	Exclusive          [][]string          `json:"exclusive"`
	Pagination         *catalog.Pagination `json:"pagination"`
	Stream             *catalog.Stream     `json:"stream"`
	Response           catalog.Response    `json:"response"`
}

type schemaParam struct {
	// Name is "--model-url" for a flag, "<id>" for an argument.
	Name        string         `json:"name"`
	Field       string         `json:"field"`
	In          string         `json:"in"`
	Required    bool           `json:"required"`
	Description string         `json:"description"`
	Schema      map[string]any `json:"schema"`
}

func schemaOf(c *catalog.Command) schemaView {
	v := schemaView{
		Command:            c.Name(),
		Usage:              usage(c),
		OperationID:        c.OperationID,
		Method:             c.Method,
		Path:               c.HTTPPath,
		Summary:            c.Summary,
		Description:        c.Description,
		RequestDescription: c.BodyDescription,
		Scopes:             nonNilStrings(c.Scopes),
		Arguments:          []schemaParam{},
		Flags:              []schemaParam{},
		Exclusive:          [][]string{},
		Pagination:         c.Pagination,
		Stream:             c.Stream,
		Response:           c.Response,
	}
	for _, a := range c.Args {
		v.Arguments = append(v.Arguments, schemaParam{"<" + a.Name + ">", a.Field, a.In, true, a.Description, a.Schema})
	}
	for _, p := range c.Params {
		v.Flags = append(v.Flags, schemaParam{"--" + p.Name, p.Field, p.In, p.Required, p.Description, p.Schema})
	}
	for _, group := range c.Exclusive {
		flags := make([]string, 0, len(group))
		for _, field := range group {
			if p := c.Param(field); p != nil {
				flags = append(flags, "--"+p.Name)
			}
		}
		v.Exclusive = append(v.Exclusive, flags)
	}
	return v
}

// usage is the command line of c: "meshy tasks get <id>".
func usage(c *catalog.Command) string {
	parts := append([]string{rootName}, c.Path...)
	for _, a := range c.Args {
		parts = append(parts, "<"+a.Name+">")
	}
	return strings.Join(parts, " ")
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
