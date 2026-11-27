// Package build turns the public v2 spec and the CLI overlay into the
// command catalog. cmd/catalog-gen runs it; its output is
// internal/catalog/catalog.json.
//
// Every operation in the spec becomes one command. The command path comes
// from internal/cmdpath; each query parameter, header parameter and
// top-level body field becomes a flag named after it in kebab case (a
// header's leading "X-Meshy-" is dropped); each path parameter becomes a
// positional argument. Anything the rules cannot place (a body that is not
// a JSON object, two parameters that would share a flag name, a flag or
// command the overlay also claims) fails the build, so a person decides
// rather than the generator guessing.
package build

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/meshy-dev/meshy-cli/internal/catalog"
	"github.com/meshy-dev/meshy-cli/internal/cmdpath"
)

// Inputs are the generator's three source files.
type Inputs struct {
	Spec    []byte // spec/openapi.v2.json
	Lock    []byte // spec/lock.json
	Overlay []byte // overlay/cli.yaml
}

var (
	flagName  = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	pathParam = regexp.MustCompile(`\{([^{}/]+)\}`)
)

// Build returns catalog.json for the inputs. The same inputs always give the
// same bytes. The error lists every problem found, one per line.
func Build(in Inputs) ([]byte, error) {
	s, lock, problems := checkSpec(in.Spec, in.Lock)
	if s == nil {
		return nil, joinProblems(problems)
	}
	o, err := parseOverlay(in.Overlay)
	if err != nil {
		return nil, joinProblems(append(problems, err.Error()))
	}

	var cmds []catalog.Command
	paths, _ := s.root["paths"].(map[string]any)
	for _, p := range sortedKeys(paths) {
		item, _ := paths[p].(map[string]any)
		for _, m := range httpMethods {
			op, ok := item[m].(map[string]any)
			if !ok {
				continue
			}
			c, errs := s.command(p, m, item, op)
			problems = append(problems, errs...)
			if c != nil {
				cmds = append(cmds, *c)
			}
		}
	}
	slices.SortFunc(cmds, func(a, b catalog.Command) int { return strings.Compare(a.Name(), b.Name()) })
	for i := 1; i < len(cmds); i++ {
		if cmds[i].Name() == cmds[i-1].Name() {
			problems = append(problems, fmt.Sprintf("%s %s and %s %s both make the command %q",
				cmds[i-1].Method, cmds[i-1].HTTPPath, cmds[i].Method, cmds[i].HTTPPath, strings.Join(cmds[i].Path, " ")))
		}
	}
	problems = append(problems, applyOverlay(o, cmds)...)
	if len(problems) > 0 {
		return nil, joinProblems(problems)
	}

	cat := catalog.Catalog{
		Spec:     catalog.SpecInfo{Version: lock.Version, SHA256: lock.SHA256},
		Scopes:   []string{},
		Commands: cmds,
	}
	for _, c := range cmds {
		for _, sc := range c.Scopes {
			if !slices.Contains(cat.Scopes, sc) {
				cat.Scopes = append(cat.Scopes, sc)
			}
		}
	}
	slices.Sort(cat.Scopes)

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(cat); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func joinProblems(ps []string) error {
	return errors.New(strings.Join(ps, "\n"))
}

// command builds the command for one operation.
func (s *spec) command(p, method string, item, op map[string]any) (*catalog.Command, []string) {
	where := strings.ToUpper(method) + " " + p
	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, where+": "+fmt.Sprintf(format, args...))
	}

	c := &catalog.Command{
		OperationID: str(op["operationId"]),
		Method:      strings.ToUpper(method),
		HTTPPath:    p,
		Summary:     str(op["summary"]),
		Description: str(op["description"]),
		Scopes:      strings_(op["x-meshy-scopes"]),
	}
	if pg, ok := op["x-meshy-pagination"]; ok {
		c.Pagination = &catalog.Pagination{}
		if err := roundTrip(pg, c.Pagination); err != nil {
			fail("x-meshy-pagination: %v", err)
		}
	}
	if st, ok := op["x-meshy-stream"]; ok {
		c.Stream = &catalog.Stream{}
		if err := roundTrip(st, c.Stream); err != nil {
			fail("x-meshy-stream: %v", err)
		}
	}

	resp, err := s.response(op)
	if err != nil {
		fail("%v", err)
		return nil, problems
	}
	c.Response = resp

	path, err := cmdpath.For(cmdpath.Operation{Method: method, Path: p, Singleton: resp.Kind == catalog.ResponseObject})
	if err != nil {
		fail("%v", err)
		return nil, problems
	}
	c.Path = path

	// parameters: path-level ones first, an operation-level one with the
	// same name and location replaces it
	declared := map[string]map[string]any{}
	var order []string
	for _, list := range []any{item["parameters"], op["parameters"]} {
		ps, _ := list.([]any)
		for _, raw := range ps {
			prm, err := s.resolve(raw)
			if err != nil {
				fail("parameter: %v", err)
				continue
			}
			key := str(prm["in"]) + " " + str(prm["name"])
			if _, dup := declared[key]; !dup {
				order = append(order, key)
			}
			declared[key] = prm
		}
	}

	for _, m := range pathParam.FindAllStringSubmatch(p, -1) {
		prm, ok := declared["path "+m[1]]
		if !ok {
			fail("path parameter {%s} is not declared", m[1])
			continue
		}
		param, err := s.param(prm, m[1], catalog.InPath)
		if err != nil {
			fail("%v", err)
			continue
		}
		param.Required = true
		c.Args = append(c.Args, param)
	}
	for _, key := range order {
		prm := declared[key]
		in, field := str(prm["in"]), str(prm["name"])
		var name string
		switch in {
		case catalog.InPath:
			if !strings.Contains(p, "{"+field+"}") {
				fail("path parameter %s is not in the path", field)
			}
			continue
		case catalog.InQuery:
			name = kebab(field)
		case catalog.InHeader:
			name = kebab(strings.TrimPrefix(strings.ToLower(field), "x-meshy-"))
		default:
			fail("parameter %s is in %q, which the CLI does not send", field, in)
			continue
		}
		param, err := s.param(prm, name, in)
		if err != nil {
			fail("%v", err)
			continue
		}
		c.Params = append(c.Params, param)
	}

	body, desc, err := s.body(op)
	if err != nil {
		fail("%v", err)
	}
	c.BodyDescription = desc
	c.Params = append(c.Params, body...)

	slices.SortFunc(c.Params, func(a, b catalog.Param) int { return strings.Compare(a.Name, b.Name) })
	for i, prm := range c.Params {
		if !flagName.MatchString(prm.Name) {
			fail("%s %s gives the flag name %q, which is not kebab-case", prm.In, prm.Field, prm.Name)
		}
		if i > 0 && c.Params[i-1].Name == prm.Name {
			fail("%s %s and %s %s would both be --%s", c.Params[i-1].In, c.Params[i-1].Field, prm.In, prm.Field, prm.Name)
		}
		if prm.Name == "help" {
			fail("%s %s would be --help", prm.In, prm.Field)
		}
	}
	if len(problems) > 0 {
		return nil, problems
	}
	return c, nil
}

// param builds a path, query or header parameter.
func (s *spec) param(prm map[string]any, name, in string) (catalog.Param, error) {
	field := str(prm["name"])
	sch, err := s.inline(prm["schema"])
	if err != nil {
		return catalog.Param{}, fmt.Errorf("parameter %s: %w", field, err)
	}
	schema, _ := sch.(map[string]any)
	if schema == nil {
		return catalog.Param{}, fmt.Errorf("parameter %s has no schema", field)
	}
	desc := str(prm["description"])
	if desc == "" {
		desc = str(schema["description"])
	}
	delete(schema, "description")
	if d, _ := prm["deprecated"].(bool); d {
		schema["deprecated"] = true
	}
	required, _ := prm["required"].(bool)
	return catalog.Param{Name: name, Field: field, In: in, Required: required, Description: desc, Schema: schema}, nil
}

// body turns the request body's top-level properties into parameters.
func (s *spec) body(op map[string]any) ([]catalog.Param, string, error) {
	if op["requestBody"] == nil {
		return nil, "", nil
	}
	rb, err := s.resolve(op["requestBody"])
	if err != nil {
		return nil, "", fmt.Errorf("requestBody: %w", err)
	}
	content, _ := rb["content"].(map[string]any)
	for _, mt := range sortedKeys(content) {
		if mt != "application/json" {
			return nil, "", fmt.Errorf("request body %s: only application/json is supported", mt)
		}
	}
	media, _ := content["application/json"].(map[string]any)
	if media == nil {
		return nil, "", fmt.Errorf("requestBody has no application/json content")
	}
	root, err := s.resolve(media["schema"])
	if err != nil {
		return nil, "", fmt.Errorf("request body: %w", err)
	}
	for _, k := range []string{"allOf", "oneOf", "anyOf"} {
		if _, ok := root[k]; ok {
			return nil, "", fmt.Errorf("request body uses %s; only a plain object maps to flags", k)
		}
	}
	if t := root["type"]; t != "object" {
		return nil, "", fmt.Errorf("request body is %v, not an object", t)
	}
	required := strings_(root["required"])
	props, _ := root["properties"].(map[string]any)
	for _, r := range required {
		if _, ok := props[r]; !ok {
			return nil, "", fmt.Errorf("request body requires %s, which it does not define", r)
		}
	}
	var out []catalog.Param
	for _, field := range sortedKeys(props) {
		sch, err := s.inline(props[field])
		if err != nil {
			return nil, "", fmt.Errorf("body field %s: %w", field, err)
		}
		schema, _ := sch.(map[string]any)
		if schema == nil {
			return nil, "", fmt.Errorf("body field %s has no schema", field)
		}
		desc := str(schema["description"])
		delete(schema, "description")
		out = append(out, catalog.Param{
			Name:        kebab(field),
			Field:       field,
			In:          catalog.InBody,
			Required:    slices.Contains(required, field),
			Description: desc,
			Schema:      schema,
		})
	}
	return out, str(root["description"]), nil
}

// response describes the operation's success response: the lowest 2xx.
func (s *spec) response(op map[string]any) (catalog.Response, error) {
	responses, _ := op["responses"].(map[string]any)
	for _, code := range sortedKeys(responses) {
		status, err := strconv.Atoi(code)
		if err != nil || status < 200 || status > 299 {
			continue
		}
		r, err := s.resolve(responses[code])
		if err != nil {
			return catalog.Response{}, fmt.Errorf("response %s: %w", code, err)
		}
		out := catalog.Response{Status: status}
		content, _ := r["content"].(map[string]any)
		switch {
		case len(content) == 0:
			out.Kind = catalog.ResponseEmpty
		case content["text/event-stream"] != nil:
			out.Kind = catalog.ResponseStream
		case content["application/json"] != nil:
			media, _ := content["application/json"].(map[string]any)
			sch, err := s.resolve(media["schema"])
			if err != nil {
				return catalog.Response{}, fmt.Errorf("response %s: %w", code, err)
			}
			out.Kind = catalog.ResponseObject
			out.Schema = refName(media["schema"])
			if sch["type"] == "array" {
				out.Kind = catalog.ResponseList
				if n := refName(sch["items"]); n != "" {
					out.Schema = n + "[]"
				}
			} else if props, ok := sch["properties"].(map[string]any); ok && op["x-meshy-pagination"] != nil {
				if data, err := s.resolve(props["data"]); err == nil && data["type"] == "array" {
					out.Kind = catalog.ResponseList
				}
			}
		default:
			return catalog.Response{}, fmt.Errorf("response %s: no JSON or event-stream content", code)
		}
		return out, nil
	}
	return catalog.Response{}, fmt.Errorf("no 2xx response")
}

func kebab(s string) string { return strings.ReplaceAll(s, "_", "-") }

func str(v any) string { s, _ := v.(string); return s }

func strings_(v any) []string {
	xs, _ := v.([]any)
	var out []string
	for _, x := range xs {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// roundTrip decodes a generic JSON value into a typed struct, refusing
// fields the struct does not know.
func roundTrip(v any, into any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	return dec.Decode(into)
}
