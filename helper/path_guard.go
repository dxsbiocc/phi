package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const maxPathBytes = 4096

type pathGuard struct {
	root      string
	rootAlias string
}

func newPathGuard(root string) (*pathGuard, error) {
	if root == "" {
		return nil, invalidArgument("workspace root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, invalidArgument("workspace root must be a directory")
	}
	return &pathGuard{root: filepath.Clean(canonical), rootAlias: filepath.Clean(absolute)}, nil
}

func (guard *pathGuard) candidate(path string) (string, error) {
	if path == "" || len(path) > maxPathBytes || strings.ContainsRune(path, '\x00') {
		return "", invalidArgument("path is empty or exceeds %d bytes", maxPathBytes)
	}
	target := filepath.Clean(path)
	if !filepath.IsAbs(target) {
		target = filepath.Join(guard.root, target)
	} else if !guard.contains(target) && pathInside(guard.rootAlias, target) {
		relative, err := filepath.Rel(guard.rootAlias, target)
		if err != nil {
			return "", outsideRoot()
		}
		target = filepath.Join(guard.root, relative)
	}
	if !guard.contains(target) {
		return "", outsideRoot()
	}
	return target, nil
}

func (guard *pathGuard) contains(path string) bool {
	return pathInside(guard.root, path)
}

func pathInside(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	outside := relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator))
	return err == nil && !outside && !filepath.IsAbs(relative)
}

func (guard *pathGuard) existing(path string) (string, error) {
	target, err := guard.candidate(path)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	if !guard.contains(canonical) {
		return "", outsideRoot()
	}
	return target, nil
}

func (guard *pathGuard) writable(path string) (string, error) {
	target, err := guard.candidate(path)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		return "", err
	}
	if !guard.contains(parent) {
		return "", outsideRoot()
	}
	canonical, err := filepath.EvalSymlinks(target)
	if err == nil && !guard.contains(canonical) {
		return "", outsideRoot()
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(target)), nil
}

func (guard *pathGuard) mkdirp(path string) (string, error) {
	target, err := guard.candidate(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(guard.root, target)
	if err != nil {
		return "", err
	}
	current := guard.root
	for _, part := range strings.Split(relative, string(os.PathSeparator)) {
		if part == "." || part == "" {
			continue
		}
		if err := os.Mkdir(filepath.Join(current, part), 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", err
		}
		current, err = filepath.EvalSymlinks(filepath.Join(current, part))
		if err != nil {
			return "", err
		}
		if !guard.contains(current) {
			return "", outsideRoot()
		}
		info, err := os.Stat(current)
		if err != nil || !info.IsDir() {
			return "", outsideRoot()
		}
	}
	return current, nil
}
