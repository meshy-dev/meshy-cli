// Package version holds the build's version and the User-Agent it sends.
package version

import (
	"fmt"
	"runtime"
)

// Version is the CLI version, set at build time with
// -ldflags "-X github.com/meshy-dev/meshy-cli/internal/version.Version=1.2.3".
// A plain `go build` reports 0.0.0-dev.
var Version = "0.0.0-dev"

// UserAgent is the User-Agent the CLI sends:
//
//	meshy-cli/<version> (<platform> <arch>; go<version>)
//
// Platform and arch use Node's names (win32 x64, darwin arm64, linux x64),
// the names the 0.x releases sent, so the server-side readers that take the
// platform from inside the parentheses keep working unchanged.
func UserAgent() string {
	return userAgent(Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
}

func userAgent(version, goos, goarch, goVersion string) string {
	return fmt.Sprintf("meshy-cli/%s (%s %s; %s)", version, nodePlatform(goos), nodeArch(goarch), goVersion)
}

// nodePlatform maps GOOS to Node's process.platform; the names that agree are
// passed through.
func nodePlatform(goos string) string {
	if goos == "windows" {
		return "win32"
	}
	return goos
}

// nodeArch maps GOARCH to Node's process.arch; the names that agree (arm64,
// arm, s390x, riscv64, loong64, …) are passed through.
func nodeArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	case "ppc64le":
		return "ppc64"
	case "mipsle":
		return "mipsel"
	}
	return goarch
}
