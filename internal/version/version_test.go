package version

import (
	"regexp"
	"testing"
)

func TestUserAgent(t *testing.T) {
	cases := []struct{ goos, goarch, want string }{
		{"windows", "amd64", "meshy-cli/1.0.0 (win32 x64; go1.27.0)"},
		{"linux", "amd64", "meshy-cli/1.0.0 (linux x64; go1.27.0)"},
		{"darwin", "arm64", "meshy-cli/1.0.0 (darwin arm64; go1.27.0)"},
		{"darwin", "amd64", "meshy-cli/1.0.0 (darwin x64; go1.27.0)"},
		{"linux", "arm64", "meshy-cli/1.0.0 (linux arm64; go1.27.0)"},
		{"windows", "arm64", "meshy-cli/1.0.0 (win32 arm64; go1.27.0)"},
		{"windows", "386", "meshy-cli/1.0.0 (win32 ia32; go1.27.0)"},
	}
	for _, c := range cases {
		if got := userAgent("1.0.0", c.goos, c.goarch, "go1.27.0"); got != c.want {
			t.Errorf("userAgent(%s/%s) = %q, want %q", c.goos, c.goarch, got, c.want)
		}
	}
}

// The running binary's own User-Agent has the documented shape.
func TestUserAgentOfThisBuild(t *testing.T) {
	re := regexp.MustCompile(`^meshy-cli/\S+ \((win32|darwin|linux|[a-z]+) [a-z0-9]+; go\S+\)$`)
	if got := UserAgent(); !re.MatchString(got) {
		t.Errorf("UserAgent() = %q", got)
	}
}
