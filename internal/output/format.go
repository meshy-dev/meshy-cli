package output

import "strings"

// Format is how the envelope is rendered on stdout.
type Format string

// Formats.
const (
	JSON   Format = "json"
	Pretty Format = "pretty"
	NDJSON Format = "ndjson"
)

// ParseFormat reads a --format value, in any case.
func ParseFormat(s string) (Format, error) {
	switch f := Format(strings.ToLower(s)); f {
	case JSON, Pretty, NDJSON:
		return f, nil
	}
	return "", Errorf(CodeUsage, "invalid --format %q: expected json, pretty or ndjson", s)
}

// DefaultFormat is the format when --format is not given: pretty for a
// person at a terminal, json for a pipe, a file or a subprocess.
func DefaultFormat(stdoutIsTerminal bool) Format {
	if stdoutIsTerminal {
		return Pretty
	}
	return JSON
}
