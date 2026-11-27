// Package config locates the CLI's configuration directory.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DirEnv overrides the configuration directory.
const DirEnv = "MESHY_CONFIG_DIR"

// Dir is where the CLI keeps its files (credentials, the operations journal):
// $MESHY_CONFIG_DIR when set, otherwise ~/.config/meshy on every platform,
// Windows and macOS included. The 0.x releases use the same directory, so
// both read the same files.
//
// The override is used as given; a relative value is relative to the working
// directory, as it is in 0.x.
func Dir(getenv func(string) string) (string, error) {
	if dir := strings.TrimSpace(getenv(DirEnv)); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("%w; set %s", err, DirEnv)
	}
	return filepath.Join(home, ".config", "meshy"), nil
}
