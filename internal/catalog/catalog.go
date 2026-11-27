// Package catalog is the generated description of every API command: what
// each command sends, its parameters and their JSON Schemas, and what it gets
// back. cmd/catalog-gen writes catalog.json from spec/openapi.v2.json and
// overlay/cli.yaml; this package embeds it.
//
// Do not edit catalog.json by hand: change the spec or the overlay and run
// `go generate ./internal/catalog`.
package catalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
)

//go:generate go run ../../cmd/catalog-gen

//go:embed catalog.json
var embedded []byte

// Parameter locations.
const (
	InPath   = "path"
	InQuery  = "query"
	InHeader = "header"
	InBody   = "body"
)

// Response kinds.
const (
	ResponseObject = "object" // one JSON object
	ResponseList   = "list"   // a JSON array, or an object whose data is one
	ResponseStream = "stream" // Server-Sent Events
	ResponseEmpty  = "empty"  // no body
)

// Catalog is every generated command.
type Catalog struct {
	Spec SpecInfo `json:"spec"`
	// Scopes is the union of every command's scopes, sorted.
	Scopes   []string  `json:"scopes"`
	Commands []Command `json:"commands"`
}

// SpecInfo names the spec the catalog was generated from.
type SpecInfo struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

// Command is one API operation as a CLI command.
type Command struct {
	// Path is the command path, verb last: ["print", "analyze", "create"].
	Path        []string `json:"path"`
	OperationID string   `json:"operation_id"`
	Method      string   `json:"method"`
	// HTTPPath is the operation's path template under the API base URL,
	// such as /v2/tasks/{id}.
	HTTPPath    string `json:"http_path"`
	Summary     string `json:"summary,omitempty"`
	Description string `json:"description,omitempty"`
	// Scopes are the OAuth scopes the operation needs.
	Scopes     []string    `json:"scopes,omitempty"`
	Pagination *Pagination `json:"pagination,omitempty"`
	// Stream describes the events of a Server-Sent Events response.
	Stream *Stream `json:"stream,omitempty"`
	// Args are the path parameters, in path order; they are positional.
	Args []Param `json:"args,omitempty"`
	// Params are the query, header and body parameters, sorted by flag name.
	Params []Param `json:"params,omitempty"`
	// BodyDescription is the request body's own description.
	BodyDescription string `json:"body_description,omitempty"`
	// Exclusive lists groups of parameters (by wire name) of which a request
	// may send at most one.
	Exclusive [][]string `json:"exclusive,omitempty"`
	Response  Response   `json:"response"`
}

// Pagination says how a list command pages.
type Pagination struct {
	Kind string `json:"kind"`
	// Max is the largest page size.
	Max int `json:"max"`
	// Params are the query parameters that page.
	Params []string `json:"params,omitempty"`
}

// Stream describes a Server-Sent Events response.
type Stream struct {
	// ErrorEvent is the event name that carries an error and ends the stream.
	ErrorEvent string `json:"error_event,omitempty"`
	// TerminalEvents are the task statuses after which the stream closes.
	TerminalEvents []string `json:"terminal_events,omitempty"`
	Ordering       string   `json:"ordering,omitempty"`
	Reconnect      string   `json:"reconnect,omitempty"`
	Cancel         string   `json:"cancel,omitempty"`
}

// Response is what a successful call returns.
type Response struct {
	// Status is the success HTTP status, such as 200 or 202.
	Status int `json:"status"`
	// Kind is one of the Response* constants.
	Kind string `json:"kind"`
	// Schema names the body's schema in the spec ("RigTask"), with a "[]"
	// suffix for an array of them.
	Schema string `json:"schema,omitempty"`
}

// Param is one parameter of a command.
type Param struct {
	// Name is the flag name without dashes, or the argument name for a path
	// parameter.
	Name string `json:"name"`
	// Field is the name on the wire: the body field, query parameter, header
	// or path parameter.
	Field       string `json:"field"`
	In          string `json:"in"`
	Required    bool   `json:"required,omitempty"`
	Description string `json:"description,omitempty"`
	// Schema is the parameter's JSON Schema with every $ref resolved and its
	// own description moved to Description.
	Schema map[string]any `json:"schema"`
}

// Name is the dotted command name used in the output envelope:
// "print.analyze.create".
func (c *Command) Name() string { return strings.Join(c.Path, ".") }

// Param returns the parameter whose wire name is field, or nil.
func (c *Command) Param(field string) *Param {
	for i := range c.Params {
		if c.Params[i].Field == field {
			return &c.Params[i]
		}
	}
	return nil
}

var (
	loadOnce sync.Once
	loaded   *Catalog
	loadErr  error
)

// Load returns the embedded catalog.
func Load() (*Catalog, error) {
	loadOnce.Do(func() {
		loaded, loadErr = Parse(embedded)
	})
	return loaded, loadErr
}

// Parse decodes a catalog.json.
func Parse(b []byte) (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	return &c, nil
}

// Find returns the command whose path is path, or nil.
func (c *Catalog) Find(path []string) *Command {
	for i := range c.Commands {
		if slices.Equal(c.Commands[i].Path, path) {
			return &c.Commands[i]
		}
	}
	return nil
}

func schemaTypes(s map[string]any) []string {
	var out []string
	switch t := s["type"].(type) {
	case string:
		if t != "null" {
			out = append(out, t)
		}
	case []any:
		for _, x := range t {
			if x, ok := x.(string); ok && x != "null" {
				out = append(out, x)
			}
		}
	}
	return out
}

func nullable(s map[string]any) bool {
	switch t := s["type"].(type) {
	case string:
		return t == "null"
	case []any:
		for _, x := range t {
			if x == "null" {
				return true
			}
		}
	}
	return false
}
