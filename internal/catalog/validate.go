package catalog

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/meshy-dev/meshy-cli/internal/output"
)

// WarnUnknownValue is the warning code for a value outside a parameter's
// known values. The value is sent anyway: the server decides, so a model or
// format added after this release still works.
const WarnUnknownValue = "unknown_value"

// Request is one call of a command, keyed by wire name. Values are what JSON
// decoding yields (string, bool, a number, []any, map[string]any, nil); Go
// integer and float types are accepted for numbers too.
type Request struct {
	Path   map[string]string
	Query  map[string]any
	Header map[string]any
	Body   map[string]any
}

// Problem is one reason a request was refused before it was sent.
type Problem struct {
	// Param is the flag or argument the problem is about, as the user types
	// it ("--model-url", "<id>").
	Param   string `json:"param"`
	Message string `json:"message"`
}

// Validate checks req against the command before anything is sent. It
// refuses a request with a missing required parameter, a value of the wrong
// JSON type, or two parameters of an exclusive group; the error is an
// *output.Error with code usage whose details list every problem. A value
// outside the known values of an enum is not refused: it comes back as a
// warning and is sent as is.
func (c *Command) Validate(req Request) ([]output.Warning, error) {
	var problems []Problem
	var warnings []output.Warning

	for _, a := range c.Args {
		if v, ok := req.Path[a.Field]; !ok || v == "" {
			problems = append(problems, Problem{Param: "<" + a.Name + ">", Message: "missing"})
		}
	}
	for i := range c.Params {
		p := &c.Params[i]
		v, ok := lookup(req, p)
		label := "--" + p.Name
		if !ok {
			if p.Required {
				problems = append(problems, Problem{Param: label, Message: "missing; it is required"})
			}
			continue
		}
		for _, msg := range checkType(p.Schema, v, "") {
			problems = append(problems, Problem{Param: label, Message: msg})
		}
		for _, msg := range checkEnum(p.Schema, v, "") {
			warnings = append(warnings, output.Warning{Code: WarnUnknownValue, Message: label + ": " + msg})
		}
	}
	for _, group := range c.Exclusive {
		var sent []string
		for _, field := range group {
			if p := c.Param(field); p != nil {
				if v, ok := lookup(req, p); ok && isSent(v) {
					sent = append(sent, "--"+p.Name)
				}
			}
		}
		if len(sent) > 1 {
			problems = append(problems, Problem{
				Param:   strings.Join(sent, ", "),
				Message: "send at most one of " + strings.Join(sent, ", "),
			})
		}
	}

	if len(problems) == 0 {
		return warnings, nil
	}
	msgs := make([]string, len(problems))
	for i, p := range problems {
		msgs[i] = p.Param + ": " + p.Message
	}
	return warnings, &output.Error{
		Code:     output.CodeUsage,
		Message:  c.Name() + ": " + strings.Join(msgs, "; "),
		Details:  map[string]any{"problems": problems},
		Warnings: warnings,
	}
}

// isSent says whether a value counts as sent for an exclusive group: null and
// a blank string do not, as the API treats them (a prompt of only spaces
// counts as not sent).
func isSent(v any) bool {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s) != ""
	}
	return v != nil
}

func lookup(req Request, p *Param) (any, bool) {
	var m map[string]any
	switch p.In {
	case InQuery:
		m = req.Query
	case InHeader:
		m = req.Header
	case InBody:
		m = req.Body
	}
	v, ok := m[p.Field]
	return v, ok
}

// checkType reports where v does not have the JSON type s asks for, and a
// missing required property of a nested object. It reads type, items,
// properties and required; a schema without a type, and every other keyword
// (enum, minimum, maxLength, format, …), is left to the server.
func checkType(s map[string]any, v any, at string) []string {
	if v == nil {
		if nullable(s) || len(schemaTypes(s)) == 0 {
			return nil
		}
		return []string{at + "must not be null"}
	}
	types := schemaTypes(s)
	if len(types) == 0 {
		return nil
	}
	got := jsonType(v)
	if !slices.Contains(types, got) && !(got == "integer" && slices.Contains(types, "number")) {
		return []string{fmt.Sprintf("%swant %s, got %s", at, strings.Join(types, " or "), describe(v, got))}
	}
	switch got {
	case "array":
		items, _ := s["items"].(map[string]any)
		if items == nil {
			return nil
		}
		var out []string
		for i, x := range v.([]any) {
			out = append(out, checkType(items, x, fmt.Sprintf("%s[%d]: ", strings.TrimSuffix(at, ": "), i))...)
		}
		return out
	case "object":
		obj := v.(map[string]any)
		props, _ := s["properties"].(map[string]any)
		var out []string
		if req, ok := s["required"].([]any); ok {
			for _, r := range req {
				if name, ok := r.(string); ok {
					if _, present := obj[name]; !present {
						out = append(out, fmt.Sprintf("%s%s is required", prefix(at), name))
					}
				}
			}
		}
		keys := make([]string, 0, len(obj))
		for k := range obj {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			ps, ok := props[k].(map[string]any)
			if !ok {
				continue
			}
			out = append(out, checkType(ps, obj[k], prefix(at)+k+": ")...)
		}
		return out
	}
	return nil
}

// checkEnum reports values outside an enum, recursing like checkType.
func checkEnum(s map[string]any, v any, at string) []string {
	if v == nil {
		return nil
	}
	if e, ok := s["enum"].([]any); ok && !containsValue(e, v) {
		return []string{fmt.Sprintf("%s%s is not one of the known values (%s); sending it anyway", at, display(v), list(e))}
	}
	switch x := v.(type) {
	case []any:
		items, _ := s["items"].(map[string]any)
		if items == nil {
			return nil
		}
		var out []string
		for _, it := range x {
			out = append(out, checkEnum(items, it, at)...)
		}
		return out
	case map[string]any:
		props, _ := s["properties"].(map[string]any)
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		var out []string
		for _, k := range keys {
			if ps, ok := props[k].(map[string]any); ok {
				out = append(out, checkEnum(ps, x[k], prefix(at)+k+": ")...)
			}
		}
		return out
	}
	return nil
}

func prefix(at string) string {
	if at == "" {
		return ""
	}
	return strings.TrimSuffix(at, ": ") + "."
}

// jsonType is the JSON Schema type of a decoded value; a whole number is
// "integer".
func jsonType(v any) string {
	switch x := v.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case json.Number:
		if _, err := x.Int64(); err == nil {
			return "integer"
		}
		if f, err := x.Float64(); err == nil && f == math.Trunc(f) && !math.IsInf(f, 0) {
			return "integer"
		}
		return "number"
	case float64:
		if x == math.Trunc(x) && !math.IsInf(x, 0) {
			return "integer"
		}
		return "number"
	case float32:
		return jsonType(float64(x))
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return "integer"
	}
	return fmt.Sprintf("%T", v)
}

func describe(v any, t string) string {
	switch t {
	case "string":
		return fmt.Sprintf("the string %q", v)
	case "array", "object":
		return "an " + t
	}
	return fmt.Sprintf("%s %s", article(t), display(v))
}

func article(t string) string {
	if strings.IndexByte("aeiou", t[0]) >= 0 {
		return "an " + t
	}
	return "a " + t
}

func display(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

func list(e []any) string {
	parts := make([]string, len(e))
	for i, x := range e {
		parts[i] = display(x)
	}
	return strings.Join(parts, ", ")
}

func containsValue(e []any, v any) bool {
	for _, x := range e {
		if equalValue(x, v) {
			return true
		}
	}
	return false
}

// equalValue compares two decoded scalars; numbers compare by value whatever
// their Go type.
func equalValue(a, b any) bool {
	if fa, ok := number(a); ok {
		fb, ok := number(b)
		return ok && fa == fb
	}
	return a == b
}

func number(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int8:
		return float64(x), true
	case int16:
		return float64(x), true
	case int32:
		return float64(x), true
	case int64:
		return float64(x), true
	case uint:
		return float64(x), true
	case uint8:
		return float64(x), true
	case uint16:
		return float64(x), true
	case uint32:
		return float64(x), true
	case uint64:
		return float64(x), true
	}
	return 0, false
}
