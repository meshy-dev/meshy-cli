// Package output prints the CLI's one machine contract: every command writes
// exactly one envelope to stdout, with the same six top-level keys.
//
//	{
//	  "schema_version": "meshy.cli/v2",
//	  "command": "tasks.get",
//	  "ok": true,
//	  "result": { … },
//	  "error": null,
//	  "warnings": []
//	}
//
// "command" is the command path joined with dots ("print.analyze.create"),
// "meshy" when no command was found. "ok" says whether the CLI operation
// completed; "result" is shaped per command and may be non-null on a failure
// (the state that must survive it). "error" is null on success and otherwise
// {code, message, http_status, retryable, recovery[, hint][, details]}, with
// code from the closed vocabulary in errors.go. "warnings" is always a list
// of {code, message}.
//
// The keys are those of the 0.x releases' meshy.cli/v1 envelope; the schema
// version moved to meshy.cli/v2 with the move to the v2 API, whose objects
// "result" now carries as the API returns them.
//
// Formats: json is the envelope indented by two spaces, ndjson the envelope
// on one line, and pretty a view of "result" for a person (warnings and
// errors go to stderr; a failure prints nothing on stdout). Progress, logs and
// warnings never go to stdout.
package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// SchemaVersion is the value of every envelope's schema_version.
const SchemaVersion = "meshy.cli/v2"

// Warning is a non-fatal note carried in the envelope.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Envelope is the object printed on stdout.
type Envelope struct {
	SchemaVersion string     `json:"schema_version"`
	Command       string     `json:"command"`
	OK            bool       `json:"ok"`
	Result        any        `json:"result"`
	Error         *ErrorBody `json:"error"`
	Warnings      []Warning  `json:"warnings"`
}

// ErrorBody is the envelope's "error".
type ErrorBody struct {
	Code       Code      `json:"code"`
	Message    string    `json:"message"`
	HTTPStatus *int      `json:"http_status"`
	Retryable  bool      `json:"retryable"`
	Recovery   *Recovery `json:"recovery"`
	Hint       string    `json:"hint,omitempty"`
	Details    any       `json:"details,omitempty"`
}

// Success is the envelope of a completed command.
func Success(command string, result any, warnings []Warning) Envelope {
	return Envelope{
		SchemaVersion: SchemaVersion,
		Command:       command,
		OK:            true,
		Result:        result,
		Warnings:      nonNil(warnings),
	}
}

// Failure is the envelope of a failed command.
func Failure(command string, e *Error) Envelope {
	body := &ErrorBody{
		Code:      e.Code,
		Message:   e.Message,
		Retryable: e.Retryable,
		Recovery:  e.Recovery,
		Hint:      e.Hint,
		Details:   e.Details,
	}
	if e.HTTPStatus != 0 {
		status := e.HTTPStatus
		body.HTTPStatus = &status
	}
	return Envelope{
		SchemaVersion: SchemaVersion,
		Command:       command,
		Result:        e.Result,
		Error:         body,
		Warnings:      nonNil(e.Warnings),
	}
}

func nonNil(w []Warning) []Warning {
	if w == nil {
		return []Warning{}
	}
	return w
}

// Printer writes envelopes in one format.
type Printer struct {
	Format Format
	Stdout io.Writer
	Stderr io.Writer
}

// Success prints the envelope of a completed command.
func (p Printer) Success(command string, result any, warnings []Warning) error {
	env := Success(command, result, warnings)
	if p.Format == Pretty {
		if err := writePretty(p.Stdout, env.Result); err != nil {
			return err
		}
		p.warnings(env.Warnings)
		return nil
	}
	return p.writeJSON(env)
}

// Failure prints a failed command: the message and hint on stderr in every
// format, and the envelope on stdout unless the format is pretty.
func (p Printer) Failure(command string, e *Error) error {
	env := Failure(command, e)
	fmt.Fprintf(p.Stderr, "error: %s\n", e.Message)
	if e.Hint != "" {
		fmt.Fprintf(p.Stderr, "hint: %s\n", e.Hint)
	}
	if p.Format == Pretty {
		p.warnings(env.Warnings)
		return nil
	}
	return p.writeJSON(env)
}

func (p Printer) warnings(ws []Warning) {
	for _, w := range ws {
		fmt.Fprintf(p.Stderr, "warning: %s\n", w.Message)
	}
}

func (p Printer) writeJSON(env Envelope) error {
	b, err := Marshal(env, p.Format)
	if err != nil {
		return err
	}
	_, err = p.Stdout.Write(b)
	return err
}

// Marshal encodes v as one json (indented) or ndjson (single-line) document,
// newline-terminated. HTML characters are not escaped, so a URL's & stays &.
func Marshal(v any, f Format) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if f != NDJSON {
		enc.SetIndent("", "  ")
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
