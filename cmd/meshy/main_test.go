package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/meshy-dev/meshy-cli/internal/version"
)

// The test binary doubles as the CLI: with runMainEnv set it runs main with
// the arguments it was given, so the tests see the real exit code and streams.
const runMainEnv = "MESHY_CLI_TEST_RUN_MAIN"

func TestMain(m *testing.M) {
	if os.Getenv(runMainEnv) == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

func runMain(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = append(os.Environ(), runMainEnv+"=1")
	var out, errOut strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
		return exitErr.ExitCode(), out.String(), errOut.String()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, out.String(), errOut.String()
}

func TestVersionFlag(t *testing.T) {
	code, stdout, _ := runMain(t, "--version")
	if code != 0 || stdout != version.Version+"\n" {
		t.Errorf("exit %d, stdout %q", code, stdout)
	}
}

// A pipe gets one JSON envelope on stdout, the message on stderr, and the
// usage exit code.
func TestUnknownCommand(t *testing.T) {
	code, stdout, stderr := runMain(t, "no-such-command")
	if code != 2 {
		t.Errorf("exit %d, want 2", code)
	}
	var env struct {
		SchemaVersion string `json:"schema_version"`
		OK            bool   `json:"ok"`
		Error         struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(stdout), &env); err != nil {
		t.Fatalf("stdout is not one JSON document: %v\n%s", err, stdout)
	}
	if env.SchemaVersion != "meshy.cli/v2" || env.OK || env.Error.Code != "usage" {
		t.Errorf("envelope %+v", env)
	}
	if !strings.HasPrefix(stderr, "error: ") {
		t.Errorf("stderr %q", stderr)
	}
}
