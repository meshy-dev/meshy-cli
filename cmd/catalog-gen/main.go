// Command catalog-gen writes internal/catalog/catalog.json from
// spec/openapi.v2.json, spec/lock.json and overlay/cli.yaml. Paths are
// relative to the module root, found by walking up from the working
// directory to go.mod, so `go generate ./internal/catalog` works. A test in
// this package fails when the committed catalog is stale.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/meshy-dev/meshy-cli/internal/catalog/build"
)

// Files, relative to the module root.
const (
	specFile    = "spec/openapi.v2.json"
	lockFile    = "spec/lock.json"
	overlayFile = "overlay/cli.yaml"
	catalogFile = "internal/catalog/catalog.json"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "catalog-gen:", err)
		os.Exit(1)
	}
}

func run() error {
	root, err := moduleRoot()
	if err != nil {
		return err
	}
	out, err := generate(root)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, catalogFile), out, 0o644)
}

// generate builds the catalog from the files under root.
func generate(root string) ([]byte, error) {
	var in build.Inputs
	for _, f := range []struct {
		name string
		dst  *[]byte
	}{{specFile, &in.Spec}, {lockFile, &in.Lock}, {overlayFile, &in.Overlay}} {
		b, err := os.ReadFile(filepath.Join(root, f.name))
		if err != nil {
			return nil, err
		}
		*f.dst = b
	}
	return build.Build(in)
}

func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("no go.mod above the working directory")
		}
		dir = parent
	}
}
