package output

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// The exit-code table scripts depend on, written out independently of the
// map it checks.
func TestExitCode(t *testing.T) {
	want := map[Code]int{
		"usage": 2, "auth": 3, "validation": 4, "not_found": 5, "rate_limit": 6,
		"network": 7, "timed_out": 8, "credit": 9, "server": 1, "task_failed": 1,
		"submission_unknown": 10, "local_io": 11, "check_failed": 12, "check_unknown": 13,
		"conflict": 14, "interrupted": 130, "protocol": 1, "operation_conflict": 2, "internal": 1,
	}
	if len(want) != len(exitCodes) {
		t.Errorf("exitCodes has %d codes, want %d", len(exitCodes), len(want))
	}
	for code, exit := range want {
		if got := ExitCode(code); got != exit {
			t.Errorf("ExitCode(%q) = %d, want %d", code, got, exit)
		}
	}
	if got := ExitCode("no_such_code"); got != 1 {
		t.Errorf("ExitCode(unknown) = %d, want 1", got)
	}
}

func TestCodeForHTTPStatus(t *testing.T) {
	want := map[int]Code{
		400: "validation", 422: "validation", 401: "auth", 402: "credit", 404: "not_found",
		409: "conflict", 429: "rate_limit", 403: "server", 500: "server", 503: "server",
	}
	for status, code := range want {
		if got := CodeForHTTPStatus(status); got != code {
			t.Errorf("CodeForHTTPStatus(%d) = %q, want %q", status, got, code)
		}
	}
}

func TestSuccessEnvelopeJSON(t *testing.T) {
	b, err := Marshal(Success("tasks.get", map[string]any{"url": "https://x.test/a?b=1&c=<2>"}, nil), JSON)
	if err != nil {
		t.Fatal(err)
	}
	want := `{
  "schema_version": "meshy.cli/v2",
  "command": "tasks.get",
  "ok": true,
  "result": {
    "url": "https://x.test/a?b=1&c=<2>"
  },
  "error": null,
  "warnings": []
}
`
	if string(b) != want {
		t.Errorf("got\n%s\nwant\n%s", b, want)
	}
}

func TestFailureEnvelopeJSON(t *testing.T) {
	e := &Error{
		Code:       CodeRateLimit,
		Message:    "slow down",
		HTTPStatus: 429,
		Recovery:   &Recovery{Action: "wait"},
		Result:     map[string]string{"task_id": "t1"},
		Warnings:   []Warning{{Code: "w", Message: "m"}},
	}
	b, err := Marshal(Failure("rigging.create", e), NDJSON)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"schema_version":"meshy.cli/v2","command":"rigging.create","ok":false,"result":{"task_id":"t1"},` +
		`"error":{"code":"rate_limit","message":"slow down","http_status":429,"retryable":false,"recovery":{"action":"wait","automatic":false}},` +
		`"warnings":[{"code":"w","message":"m"}]}` + "\n"
	if string(b) != want {
		t.Errorf("got\n%s\nwant\n%s", b, want)
	}

	// No HTTP response: http_status is null, hint and details are left out.
	b, _ = Marshal(Failure("meshy", Errorf(CodeUsage, "bad flag")), NDJSON)
	want = `{"schema_version":"meshy.cli/v2","command":"meshy","ok":false,"result":null,` +
		`"error":{"code":"usage","message":"bad flag","http_status":null,"retryable":false,"recovery":null},"warnings":[]}` + "\n"
	if string(b) != want {
		t.Errorf("got\n%s\nwant\n%s", b, want)
	}
}

func TestPrinter(t *testing.T) {
	cases := []struct {
		name         string
		format       Format
		fail         bool
		stdout       string
		stderrSubstr []string
	}{
		{"json success", JSON, false, "{\n  \"schema_version\": \"meshy.cli/v2\",", nil},
		{"ndjson success", NDJSON, false, `{"schema_version":"meshy.cli/v2","command":"c","ok":true,"result":{"n":1},"error":null,"warnings":[{"code":"w","message":"careful"}]}` + "\n", nil},
		{"pretty success", Pretty, false, "n: 1\n", []string{"warning: careful\n"}},
		{"json failure", JSON, true, "{\n  \"schema_version\": \"meshy.cli/v2\",", []string{"error: boom\n", "hint: meshy auth login\n"}},
		{"pretty failure", Pretty, true, "", []string{"error: boom\n", "hint: meshy auth login\n", "warning: careful\n"}},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		p := Printer{Format: c.format, Stdout: &out, Stderr: &errOut}
		warnings := []Warning{{Code: "w", Message: "careful"}}
		var err error
		if c.fail {
			err = p.Failure("c", &Error{Code: CodeAuth, Message: "boom", Hint: "meshy auth login", Warnings: warnings})
		} else {
			err = p.Success("c", map[string]int{"n": 1}, warnings)
		}
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if c.stdout == "" && out.Len() != 0 || !strings.HasPrefix(out.String(), c.stdout) {
			t.Errorf("%s: stdout = %q, want prefix %q", c.name, out.String(), c.stdout)
		}
		for _, s := range c.stderrSubstr {
			if !strings.Contains(errOut.String(), s) {
				t.Errorf("%s: stderr = %q, want it to contain %q", c.name, errOut.String(), s)
			}
		}
		if len(c.stderrSubstr) == 0 && errOut.Len() != 0 {
			t.Errorf("%s: stderr = %q, want empty", c.name, errOut.String())
		}
	}
}

func TestPretty(t *testing.T) {
	type task struct {
		ID     string         `json:"id"`
		Status string         `json:"status"`
		Error  any            `json:"error"`
		Tags   []string       `json:"tags"`
		Output map[string]any `json:"output"`
		Empty  []string       `json:"empty"`
		Files  []any          `json:"files"`
	}
	v := task{
		ID: "t1", Status: "SUCCEEDED", Tags: []string{"a", "b"},
		Output: map[string]any{"model_urls": map[string]string{"glb": "https://x.test/m.glb"}},
		Empty:  []string{},
		Files:  []any{map[string]any{"key": "glb", "bytes": 12}},
	}
	var out bytes.Buffer
	if err := writePretty(&out, v); err != nil {
		t.Fatal(err)
	}
	want := `id: t1
status: SUCCEEDED
error: -
tags:
  - a
  - b
output:
  model_urls:
    glb: https://x.test/m.glb
empty: []
files:
  - bytes: 12
    key: glb
`
	if out.String() != want {
		t.Errorf("got\n%s\nwant\n%s", out.String(), want)
	}

	out.Reset()
	if err := writePretty(&out, nil); err != nil || out.String() != "-\n" {
		t.Errorf("writePretty(nil) = %q, %v", out.String(), err)
	}
}

func TestParseFormat(t *testing.T) {
	for in, want := range map[string]Format{"json": JSON, "PRETTY": Pretty, "ndjson": NDJSON} {
		if got, err := ParseFormat(in); err != nil || got != want {
			t.Errorf("ParseFormat(%q) = %q, %v", in, got, err)
		}
	}
	_, err := ParseFormat("yaml")
	if e, ok := errors.AsType[*Error](err); !ok || e.Code != CodeUsage {
		t.Errorf("ParseFormat(yaml) error = %v, want a usage error", err)
	}
	if DefaultFormat(true) != Pretty || DefaultFormat(false) != JSON {
		t.Error("DefaultFormat: want pretty on a terminal, json otherwise")
	}
}

func TestClassify(t *testing.T) {
	typed := &Error{Code: CodeNotFound, Message: "gone"}
	if got := Classify(fmt.Errorf("get: %w", typed)); got != typed {
		t.Errorf("Classify(wrapped *Error) = %+v, want the *Error itself", got)
	}
	if got := Classify(fmt.Errorf("poll: %w", context.Canceled)); got.Code != CodeInterrupted || got.ExitCode() != 130 {
		t.Errorf("Classify(canceled) = %+v, want interrupted / 130", got)
	}
	if got := Classify(errors.New("disk on fire")); got.Code != CodeInternal || got.ExitCode() != 1 || got.Message != "disk on fire" {
		t.Errorf("Classify(plain) = %+v, want internal / 1", got)
	}
}
