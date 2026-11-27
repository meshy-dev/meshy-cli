package build

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Extensions the public spec may carry. Anything else under x- fails the
// build: the spec is published, and only these are meant for clients.
var allowedExtensions = []string{"x-meshy-scopes", "x-meshy-pagination", "x-meshy-stream", "x-meshy-union"}

// ticketID matches an issue-tracker key such as ABC-123. Spec text is written
// for users and agents and never names one.
var ticketID = regexp.MustCompile(`\b[A-Z]{2,5}-[0-9]+\b`)

var httpMethods = []string{"get", "put", "post", "delete", "patch", "head", "options", "trace"}

// lockFile is spec/lock.json: the spec's version and digest, and where it
// was merged from.
type lockFile struct {
	Version string          `json:"version"`
	SHA256  string          `json:"sha256"`
	Sources json.RawMessage `json:"sources"`
}

// spec is a decoded OpenAPI document. Numbers stay json.Number so the
// catalog repeats them exactly as the spec writes them.
type spec struct {
	root map[string]any
}

func decodeJSON(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing data after the JSON document")
	}
	return v, nil
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// checkSpec runs the checks that need no knowledge of what is internal: the
// lock matches the file, only allowed extensions appear, no text names an
// issue-tracker key, and every operation is a /v2/ operation with an
// operationId.
func checkSpec(specBytes, lockBytes []byte) (*spec, *lockFile, []string) {
	var problems []string
	var lock lockFile
	if err := json.Unmarshal(lockBytes, &lock); err != nil {
		return nil, nil, []string{"spec/lock.json: " + err.Error()}
	}
	if got := sha256Hex(specBytes); got != lock.SHA256 {
		problems = append(problems, fmt.Sprintf("spec/lock.json: sha256 %s, but spec/openapi.v2.json hashes to %s", lock.SHA256, got))
	}
	v, err := decodeJSON(specBytes)
	if err != nil {
		return nil, nil, append(problems, "spec/openapi.v2.json: "+err.Error())
	}
	root, ok := v.(map[string]any)
	if !ok {
		return nil, nil, append(problems, "spec/openapi.v2.json: not a JSON object")
	}
	s := &spec{root: root}
	if ver, _ := s.get("info", "version").(string); ver != lock.Version {
		problems = append(problems, fmt.Sprintf("spec/lock.json: version %q, but the spec's info.version is %q", lock.Version, ver))
	}
	if oa, _ := root["openapi"].(string); !strings.HasPrefix(oa, "3.1.") {
		problems = append(problems, fmt.Sprintf("spec: openapi %q, want 3.1.x", oa))
	}
	walk(root, "", func(at string, key string, val any) {
		if key != "" && strings.HasPrefix(key, "x-") && !slices.Contains(allowedExtensions, key) {
			problems = append(problems, fmt.Sprintf("spec %s: extension %s is not allowed", at, key))
		}
		if str, ok := val.(string); ok {
			if m := ticketID.FindString(str); m != "" {
				problems = append(problems, fmt.Sprintf("spec %s: text names %q, which looks like an issue key", at, m))
			}
		}
	})

	ids := map[string]string{}
	paths, _ := root["paths"].(map[string]any)
	for _, p := range sortedKeys(paths) {
		if !strings.HasPrefix(p, "/v2/") {
			problems = append(problems, fmt.Sprintf("spec: path %s is not under /v2/", p))
		}
		item, _ := paths[p].(map[string]any)
		for _, m := range httpMethods {
			op, ok := item[m].(map[string]any)
			if !ok {
				continue
			}
			id, _ := op["operationId"].(string)
			where := strings.ToUpper(m) + " " + p
			switch {
			case id == "":
				problems = append(problems, where+": no operationId")
			case ids[id] != "":
				problems = append(problems, fmt.Sprintf("%s: operationId %s also names %s", where, id, ids[id]))
			default:
				ids[id] = where
			}
		}
	}
	return s, &lock, problems
}

// walk calls fn for every object key (with its value) and every array
// element (with an empty key), depth first, in sorted key order.
func walk(v any, at string, fn func(at, key string, val any)) {
	switch x := v.(type) {
	case map[string]any:
		for _, k := range sortedKeys(x) {
			p := at + "/" + strings.ReplaceAll(strings.ReplaceAll(k, "~", "~0"), "/", "~1")
			fn(p, k, x[k])
			walk(x[k], p, fn)
		}
	case []any:
		for i, e := range x {
			p := fmt.Sprintf("%s/%d", at, i)
			fn(p, "", e)
			walk(e, p, fn)
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func (s *spec) get(path ...string) any {
	var cur any = s.root
	for _, p := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

// ref follows one local JSON pointer.
func (s *spec) ref(r string) (any, error) {
	rest, ok := strings.CutPrefix(r, "#/")
	if !ok {
		return nil, fmt.Errorf("$ref %q is not a local reference", r)
	}
	var cur any = s.root
	for _, p := range strings.Split(rest, "/") {
		p = strings.ReplaceAll(strings.ReplaceAll(p, "~1", "/"), "~0", "~")
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("$ref %q does not resolve", r)
		}
		if cur, ok = m[p]; !ok {
			return nil, fmt.Errorf("$ref %q does not resolve", r)
		}
	}
	return cur, nil
}

// resolve follows $ref until it reaches an object without one. Sibling keys
// of a $ref (OpenAPI 3.1 allows description and summary there) are laid
// over the target.
func (s *spec) resolve(n any) (map[string]any, error) {
	m, _ := n.(map[string]any)
	var over []map[string]any
	seen := map[string]bool{}
	for m != nil {
		r, ok := m["$ref"].(string)
		if !ok {
			break
		}
		if seen[r] {
			return nil, fmt.Errorf("$ref cycle at %s", r)
		}
		seen[r] = true
		over = append(over, m)
		t, err := s.ref(r)
		if err != nil {
			return nil, err
		}
		m, _ = t.(map[string]any)
	}
	if len(over) == 0 || m == nil {
		return m, nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	for i := len(over) - 1; i >= 0; i-- {
		for k, v := range over[i] {
			if k != "$ref" {
				out[k] = v
			}
		}
	}
	return out, nil
}

// inline returns a deep copy of n with every $ref replaced by its target.
func (s *spec) inline(n any) (any, error) {
	return s.inlineSeen(n, nil)
}

func (s *spec) inlineSeen(n any, stack []string) (any, error) {
	switch x := n.(type) {
	case map[string]any:
		if r, ok := x["$ref"].(string); ok {
			if slices.Contains(stack, r) {
				return nil, fmt.Errorf("recursive schema at %s", r)
			}
			m, err := s.resolve(x)
			if err != nil {
				return nil, err
			}
			return s.inlineSeen(m, append(slices.Clone(stack), r))
		}
		out := make(map[string]any, len(x))
		for k, v := range x {
			c, err := s.inlineSeen(v, stack)
			if err != nil {
				return nil, err
			}
			out[k] = c
		}
		return out, nil
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			c, err := s.inlineSeen(v, stack)
			if err != nil {
				return nil, err
			}
			out[i] = c
		}
		return out, nil
	}
	return n, nil
}

// refName is the component name a schema node points at ("RigTask"), or "".
func refName(n any) string {
	m, _ := n.(map[string]any)
	r, _ := m["$ref"].(string)
	name, ok := strings.CutPrefix(r, "#/components/schemas/")
	if !ok {
		return ""
	}
	return name
}
