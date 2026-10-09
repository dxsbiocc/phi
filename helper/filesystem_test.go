package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFileSystemAtomicWriteDetectsHashConflict(t *testing.T) {
	root := t.TempDir()
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	first, err := fs.writeAtomic("result.txt", []byte("first"), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := fs.writeAtomic("result.txt", []byte("second"), &first.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if second.Hash == first.Hash {
		t.Fatal("hash did not change")
	}
	_, err = fs.writeAtomic("result.txt", []byte("stale"), &first.Hash)
	var domainErr *domainError
	if !errors.As(err, &domainErr) || domainErr.code != "HASH_MISMATCH" {
		t.Fatalf("error = %v, want HASH_MISMATCH", err)
	}
	content, err := os.ReadFile(filepath.Join(root, "result.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, []byte("second")) {
		t.Fatalf("content = %q, want second", content)
	}
}

func TestFileSystemReadsRangesAndListsStablePages(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{"beta.txt": "b", "alpha.txt": "0123456789", "ä.txt": "u"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	rangeResult, err := fs.readRange("alpha.txt", 3, 4)
	if err != nil {
		t.Fatal(err)
	}
	if string(rangeResult.Content) != "3456" || rangeResult.BytesRead != 4 || rangeResult.EOF {
		t.Fatalf("unexpected range result: %+v", rangeResult)
	}
	first, err := fs.list(".", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	second, err := fs.list(".", first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if first.Entries[0].Name != "alpha.txt" || first.Entries[1].Name != "beta.txt" {
		t.Fatalf("unexpected first page: %+v", first)
	}
	if second.Entries[0].Name != "nested" || second.Entries[1].Name != "ä.txt" || second.NextCursor != "" {
		t.Fatalf("unexpected second page: %+v", second)
	}
}

func TestFileSystemRejectsOversizedRangeBeforeAllocation(t *testing.T) {
	root := t.TempDir()
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.readRange("empty", 0, maxReadRangeBytes); err != nil {
		t.Fatalf("adapter-compatible range rejected: %v", err)
	}
	_, err = fs.readRange("missing", 0, maxReadRangeBytes+1)
	var domainErr *domainError
	if !errors.As(err, &domainErr) || domainErr.code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %v, want INVALID_ARGUMENT", err)
	}
}
