// Package cmdpath derives a command path from a v2 API operation.
//
// The rule is mechanical so that a newly published endpoint gets its command
// name without anyone writing it down:
//
//   - The literal path segments after /v2/ are the command path; path
//     parameters ({id}) are dropped (they become positional arguments).
//   - The HTTP method picks the verb that ends the path:
//     POST on a collection is create, GET on a collection is list,
//     GET on an item (a path ending in a parameter) is get,
//     DELETE on an item is delete, and GET on a path ending in /stream is
//     stream.
//   - A GET on a collection that returns one object instead of a list
//     (GET /v2/balance) is get; the caller says so with Operation.Singleton,
//     because only the response schema can tell.
//
// Examples:
//
//	POST   /v2/print/analyze      print analyze create
//	GET    /v2/tasks              tasks list
//	GET    /v2/tasks/{id}         tasks get
//	GET    /v2/tasks/{id}/stream  tasks stream
//	DELETE /v2/tasks/{id}         tasks delete
//	GET    /v2/animations/library animations library list
//	GET    /v2/balance            balance get (Singleton)
//
// A parameter is dropped wherever it sits, so GET /v2/x/{id}/{format} is
// "x get" like GET /v2/x/{id}; two operations that land on one command path
// are for the caller to catch. The shapes the rule has no verb for (any
// method but GET, POST and DELETE, a POST on an item, a DELETE on a
// collection, a GET of /v2/stream, a path that starts with a parameter, a
// segment that is neither lowercase kebab-case nor a whole {parameter}) are
// an error rather than a guessed name, so the generator stops and a person
// decides.
package cmdpath

import (
	"fmt"
	"regexp"
	"strings"
)

// Verbs that end a derived command path.
const (
	VerbCreate = "create"
	VerbList   = "list"
	VerbGet    = "get"
	VerbDelete = "delete"
	VerbStream = "stream"
)

// Operation is the part of an API operation the naming rule reads.
type Operation struct {
	// Method is the HTTP method, in any case ("post", "GET").
	Method string
	// Path is the OpenAPI path template. Both "/v2/tasks/{id}" and
	// "/openapi/v2/tasks/{id}" are accepted.
	Path string
	// Singleton marks a GET on a path that ends in a literal segment and
	// returns a single object rather than a list, such as GET /v2/balance.
	// It is read only for that case.
	Singleton bool
}

var (
	literalSegment = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	paramSegment   = regexp.MustCompile(`^\{[^{}/]+\}$`)
)

// For returns the command path of op, verb last: ["print", "analyze",
// "create"] for POST /v2/print/analyze.
func For(op Operation) ([]string, error) {
	rest, ok := strings.CutPrefix(strings.TrimPrefix(op.Path, "/openapi"), "/v2/")
	if !ok {
		return nil, fmt.Errorf("%s %s: path is not under /v2/", op.Method, op.Path)
	}
	var literals []string
	endsInParam := false
	for _, seg := range strings.Split(rest, "/") {
		switch {
		case paramSegment.MatchString(seg):
			if len(literals) == 0 {
				return nil, fmt.Errorf("%s %s: path starts with a parameter", op.Method, op.Path)
			}
			endsInParam = true
		case literalSegment.MatchString(seg):
			literals = append(literals, seg)
			endsInParam = false
		default:
			return nil, fmt.Errorf("%s %s: segment %q is neither lowercase kebab-case nor a {parameter}", op.Method, op.Path, seg)
		}
	}

	method := strings.ToUpper(op.Method)
	last := literals[len(literals)-1]
	switch {
	case method == "GET" && !endsInParam && last == VerbStream:
		if len(literals) == 1 {
			break // /v2/stream names no resource to stream
		}
		return withVerb(literals[:len(literals)-1], VerbStream), nil
	case method == "GET" && endsInParam:
		return withVerb(literals, VerbGet), nil
	case method == "GET" && op.Singleton:
		return withVerb(literals, VerbGet), nil
	case method == "GET":
		return withVerb(literals, VerbList), nil
	case method == "POST" && !endsInParam:
		return withVerb(literals, VerbCreate), nil
	case method == "DELETE" && endsInParam:
		return withVerb(literals, VerbDelete), nil
	}
	return nil, fmt.Errorf("%s %s: no naming rule for this method on this path", op.Method, op.Path)
}

// Name is the dotted form used in the output envelope's "command" field:
// "print.analyze.create".
func Name(path []string) string { return strings.Join(path, ".") }

func withVerb(literals []string, verb string) []string {
	out := make([]string, 0, len(literals)+1)
	out = append(out, literals...)
	return append(out, verb)
}
