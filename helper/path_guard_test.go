package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathGuardContainsPathsAndSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "inside.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	guard, err := newPathGuard(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := guard.existing("inside.txt"); err != nil {
		t.Fatalf("inside path rejected: %v", err)
	}
	if _, err := guard.existing(filepath.Join(root, "inside.txt")); err != nil {
		t.Fatalf("absolute inside path rejected: %v", err)
	}
	_, err = guard.existing("../outside")
	assertDomainCode(t, err, "PATH_OUTSIDE_ROOT")
	_, err = guard.existing(filepath.Join(outside, "secret"))
	assertDomainCode(t, err, "PATH_OUTSIDE_ROOT")
	_, err = guard.existing("escape")
	assertDomainCode(t, err, "PATH_OUTSIDE_ROOT")
	_, err = guard.writable("escape/new.txt")
	assertDomainCode(t, err, "PATH_OUTSIDE_ROOT")
}

func TestPathGuardAllowsSafeDirectoryCreation(t *testing.T) {
	guard, err := newPathGuard(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path, err := guard.mkdirp("nested/deeper")
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatalf("created path is not a directory: info=%v err=%v", info, err)
	}
}

func TestPathGuardRejectsExcessivePathLength(t *testing.T) {
	guard, err := newPathGuard(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = guard.writable(strings.Repeat("a", maxPathBytes+1))
	assertDomainCode(t, err, "INVALID_ARGUMENT")
}

func assertDomainCode(t *testing.T, err error, code string) {
	t.Helper()
	var domainErr *domainError
	if !errors.As(err, &domainErr) || domainErr.code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}
