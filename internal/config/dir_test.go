package config

import (
	"path/filepath"
	"runtime"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDirOverride(t *testing.T) {
	got, err := Dir(env(map[string]string{DirEnv: "  /tmp/meshy-test  "}))
	if err != nil || got != "/tmp/meshy-test" {
		t.Fatalf("Dir = %q, %v; want /tmp/meshy-test", got, err)
	}
}

func TestDirDefault(t *testing.T) {
	home := t.TempDir()
	// os.UserHomeDir reads USERPROFILE on Windows and HOME elsewhere.
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	} else {
		t.Setenv("HOME", home)
	}
	for _, blank := range []string{"", "   "} {
		got, err := Dir(env(map[string]string{DirEnv: blank}))
		if err != nil {
			t.Fatal(err)
		}
		if want := filepath.Join(home, ".config", "meshy"); got != want {
			t.Errorf("Dir with %s=%q = %q, want %q", DirEnv, blank, got, want)
		}
	}
}
