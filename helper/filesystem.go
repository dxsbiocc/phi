package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

type fileSystem struct {
	guard *pathGuard
}

const maxReadRangeBytes = 8*1024*1024 + 1

type statResult struct {
	Kind       string `json:"kind"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
}

type readRangeResult struct {
	Content   []byte `json:"content"`
	BytesRead int    `json:"bytesRead"`
	EOF       bool   `json:"eof"`
}

type writeResult struct {
	Hash string `json:"hash"`
}

type listEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type listResult struct {
	Entries    []listEntry `json:"entries"`
	NextCursor string      `json:"nextCursor,omitempty"`
}

func newFileSystem(root string) (*fileSystem, error) {
	guard, err := newPathGuard(root)
	if err != nil {
		return nil, err
	}
	return &fileSystem{guard: guard}, nil
}

func entryKind(info os.FileInfo) string {
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	if info.IsDir() {
		return "directory"
	}
	if info.Mode().IsRegular() {
		return "file"
	}
	return "other"
}

func (fs *fileSystem) stat(path string, includeModifiedAt bool) (statResult, error) {
	target, err := fs.guard.existing(path)
	if err != nil {
		return statResult{}, err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return statResult{}, err
	}
	result := statResult{Kind: entryKind(info), Size: info.Size()}
	if includeModifiedAt {
		result.ModifiedAt = info.ModTime().UTC().Format(time.RFC3339Nano)
	}
	return result, nil
}

func (fs *fileSystem) readRange(path string, offset int64, length int) (readRangeResult, error) {
	if offset < 0 || length < 0 || length > maxReadRangeBytes {
		return readRangeResult{}, invalidArgument(
			"range offset must be non-negative and length must be between 0 and %d", maxReadRangeBytes,
		)
	}
	target, err := fs.guard.existing(path)
	if err != nil {
		return readRangeResult{}, err
	}
	file, err := os.Open(target)
	if err != nil {
		return readRangeResult{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return readRangeResult{}, err
	}
	content := make([]byte, length)
	bytesRead, err := file.ReadAt(content, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return readRangeResult{}, err
	}
	return readRangeResult{
		Content: content[:bytesRead], BytesRead: bytesRead, EOF: offset+int64(bytesRead) >= info.Size(),
	}, nil
}

func hashBytes(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

const casLockTimeout = 30 * time.Second
const casLockStale = 120 * time.Second

func processExists(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || (!errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH))
}

func removeStaleLock(lockPath string, info os.FileInfo) (bool, error) {
	ownerPath := filepath.Join(lockPath, "owner")
	owner, _ := os.ReadFile(ownerPath)
	parts := strings.SplitN(string(bytes.TrimSpace(owner)), ":", 2)
	pid, parseErr := strconv.Atoi(parts[0])
	validPID := len(parts) == 2 && parts[1] != "" && parseErr == nil && pid > 0
	if validPID && processExists(pid) {
		return false, nil
	}
	if !validPID && time.Since(info.ModTime()) <= casLockStale {
		return false, nil
	}
	if len(owner) > 0 {
		current, err := os.ReadFile(ownerPath)
		if err != nil || !bytes.Equal(current, owner) {
			return false, nil
		}
		if err := os.Remove(ownerPath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return false, nil
			}
			return false, err
		}
	}
	if err := os.Remove(lockPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return true, nil
		}
		return false, errors.New("workspace atomic write lock could not be recovered")
	}
	return true, nil
}

func newLockOwnerValue() (string, error) {
	token := make([]byte, 16)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	return strconv.Itoa(os.Getpid()) + ":" + hex.EncodeToString(token) + "\n", nil
}

func writeLockOwner(lockPath, ownerValue string) error {
	owner, err := os.OpenFile(
		filepath.Join(lockPath, "owner"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600,
	)
	if err != nil {
		return err
	}
	if _, err = owner.WriteString(ownerValue); err != nil {
		owner.Close()
		return err
	}
	return owner.Close()
}

func releaseOwnedLock(lockPath, ownerValue string) {
	ownerPath := filepath.Join(lockPath, "owner")
	current, err := os.ReadFile(ownerPath)
	if err != nil || string(current) != ownerValue {
		return
	}
	if err := os.Remove(ownerPath); err != nil {
		return
	}
	_ = os.Remove(lockPath)
}

func acquireWriteLock(target string) (func(), error) {
	lockName := ".phi-cas-" + hashBytes([]byte(target))[:32] + ".lock"
	lockPath := filepath.Join(filepath.Dir(target), lockName)
	deadline := time.Now().Add(casLockTimeout)
	for {
		if err := os.Mkdir(lockPath, 0o700); err == nil {
			break
		} else if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		info, err := os.Lstat(lockPath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		if !info.IsDir() {
			return nil, errors.New("workspace atomic write lock is not a directory")
		}
		removed, err := removeStaleLock(lockPath, info)
		if err != nil {
			return nil, err
		}
		if removed {
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("workspace atomic write lock timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
	ownerValue, err := newLockOwnerValue()
	if err != nil {
		_ = os.Remove(lockPath)
		return nil, err
	}
	if err := writeLockOwner(lockPath, ownerValue); err != nil {
		releaseOwnedLock(lockPath, ownerValue)
		_ = os.Remove(lockPath)
		return nil, err
	}
	return func() {
		releaseOwnedLock(lockPath, ownerValue)
	}, nil
}

func assertExpectedHash(target string, expectedHash *string) error {
	if expectedHash == nil {
		return nil
	}
	current, err := os.ReadFile(target)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err != nil || hashBytes(current) != *expectedHash {
		return newDomainError("HASH_MISMATCH", "file does not match the expected hash")
	}
	return nil
}

func (fs *fileSystem) writeAtomic(path string, content []byte, expectedHash *string) (writeResult, error) {
	target, err := fs.guard.writable(path)
	if err != nil {
		return writeResult{}, err
	}
	release, err := acquireWriteLock(target)
	if err != nil {
		return writeResult{}, err
	}
	defer release()
	lockedTarget, err := fs.guard.writable(path)
	if err != nil {
		return writeResult{}, err
	}
	if lockedTarget != target {
		return writeResult{}, outsideRoot()
	}
	if err := assertExpectedHash(target, expectedHash); err != nil {
		return writeResult{}, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".phi-write-*")
	if err != nil {
		return writeResult{}, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := writeAndSync(temporary, content); err != nil {
		return writeResult{}, err
	}
	if err := assertExpectedHash(target, expectedHash); err != nil {
		return writeResult{}, err
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return writeResult{}, err
	}
	return writeResult{Hash: hashBytes(content)}, nil
}

func writeAndSync(file *os.File, content []byte) error {
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func (fs *fileSystem) list(path, cursor string, limit int) (listResult, error) {
	if limit < 1 || limit > 1000 {
		return listResult{}, invalidArgument("list limit must be between 1 and 1000")
	}
	target, err := fs.guard.existing(path)
	if err != nil {
		return listResult{}, err
	}
	directoryEntries, err := os.ReadDir(target)
	if err != nil {
		return listResult{}, err
	}
	entries := make([]listEntry, 0, len(directoryEntries))
	for _, entry := range directoryEntries {
		entryPath := filepath.Join(target, entry.Name())
		info, infoErr := os.Lstat(entryPath)
		if infoErr != nil {
			return listResult{}, infoErr
		}
		relative, relErr := filepath.Rel(fs.guard.root, entryPath)
		if relErr != nil {
			return listResult{}, relErr
		}
		entries = append(entries, listEntry{
			Name: entry.Name(), Path: filepath.ToSlash(relative), Kind: entryKind(info),
		})
	}
	sort.Slice(entries, func(left, right int) bool {
		return compareNames(entries[left].Name, entries[right].Name) < 0
	})
	return paginate(entries, cursor, limit), nil
}

func compareNames(left, right string) int {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	for index := 0; index < min(len(leftUnits), len(rightUnits)); index++ {
		if leftUnits[index] < rightUnits[index] {
			return -1
		}
		if leftUnits[index] > rightUnits[index] {
			return 1
		}
	}
	if len(leftUnits) < len(rightUnits) {
		return -1
	}
	if len(leftUnits) > len(rightUnits) {
		return 1
	}
	return 0
}

func paginate(entries []listEntry, cursor string, limit int) listResult {
	start := 0
	if cursor != "" {
		start = sort.Search(len(entries), func(index int) bool {
			return compareNames(entries[index].Name, cursor) > 0
		})
	}
	end := min(start+limit, len(entries))
	page := append([]listEntry(nil), entries[start:end]...)
	result := listResult{Entries: page}
	if end < len(entries) && len(page) > 0 {
		result.NextCursor = page[len(page)-1].Name
	}
	return result
}

func (fs *fileSystem) mkdirp(path string) error {
	_, err := fs.guard.mkdirp(path)
	return err
}

func (fs *fileSystem) remove(path string, recursive, force bool) error {
	target, err := fs.guard.existing(path)
	if err != nil {
		if force && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if filepath.Clean(target) == fs.guard.root {
		return invalidArgument("cannot remove the workspace root")
	}
	if recursive {
		return os.RemoveAll(target)
	}
	err = os.Remove(target)
	if force && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
