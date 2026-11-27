package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestCommittedCatalogIsCurrent fails when internal/catalog/catalog.json is
// not what the committed spec and overlay generate, so CI catches a spec or
// overlay change without its regenerated catalog.
func TestCommittedCatalogIsCurrent(t *testing.T) {
	root := filepath.Join("..", "..")
	want, err := generate(root)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(root, catalogFile))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale; run go generate ./internal/catalog", catalogFile)
	}
}
