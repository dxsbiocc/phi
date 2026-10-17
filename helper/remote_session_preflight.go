package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"
)

type remoteManifestPreflight struct {
	Path   string
	Size   int
	SHA256 string
}

type remoteJournalPreflight struct {
	JournalPath   string
	OmpSessionID  string
	Cwd           string
	HeaderVersion int
	FileIdentity  string
	Fingerprint   string
	Verification  string
}

type remoteSessionPreflight struct {
	Manifest remoteManifestPreflight
	Journal  remoteJournalPreflight
}

func statField(info os.FileInfo, name string) (uint64, bool) {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return 0, false
	}
	field := value.FieldByName(name)
	if !field.IsValid() {
		return 0, false
	}
	switch field.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return field.Uint(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return uint64(field.Int()), true
	default:
		return 0, false
	}
}

func privateRemoteFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	uid, uidOK := statField(info, "Uid")
	links, linksOK := statField(info, "Nlink")
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !uidOK ||
		int(uid) != os.Getuid() || !linksOK || links != 1 || info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("remote session file is not private")
	}
	return info, nil
}

func statIdentity(info os.FileInfo) (string, string, error) {
	dev, devOK := statField(info, "Dev")
	ino, inoOK := statField(info, "Ino")
	if !devOK || !inoOK {
		return "", "", fmt.Errorf("remote session file identity is unavailable")
	}
	stable := fmt.Sprintf("%d:%d", dev, ino)
	metadata := fmt.Sprintf("%s:%d:%d", stable, info.Size(), info.ModTime().UnixNano())
	return stable, metadata, nil
}

func preflightHash(parts ...[]byte) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = hash.Write(part)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func preflightPathInside(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func validateManagedParents(root, path string) error {
	root = filepath.Clean(root)
	if !preflightPathInside(root, path) {
		return fmt.Errorf("remote session path escapes runtime root")
	}
	current := root
	relative, _ := filepath.Rel(root, filepath.Dir(path))
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("remote session path is invalid")
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		uid, uidOK := statField(info, "Uid")
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !uidOK ||
			int(uid) != os.Getuid() || info.Mode().Perm() != 0o700 {
			return fmt.Errorf("remote session directory is not private")
		}
	}
	return nil
}

func readExactPrivateFile(root, path string, maximum int) ([]byte, os.FileInfo, error) {
	if err := validateManagedParents(root, path); err != nil {
		return nil, nil, err
	}
	before, err := privateRemoteFile(path)
	if err != nil {
		return nil, nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	content, readErr := io.ReadAll(io.LimitReader(file, int64(maximum+1)))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(content) > maximum {
		return nil, nil, fmt.Errorf("remote session file exceeds its bound")
	}
	after, err := privateRemoteFile(path)
	if err != nil {
		return nil, nil, err
	}
	beforeIdentity, beforeMetadata, err := statIdentity(before)
	if err != nil {
		return nil, nil, err
	}
	afterIdentity, afterMetadata, err := statIdentity(after)
	if err != nil || beforeIdentity != afterIdentity || beforeMetadata != afterMetadata {
		return nil, nil, fmt.Errorf("remote session file changed while read")
	}
	return content, before, nil
}

func readPrivatePrefix(root, path string, maximum int) ([]byte, os.FileInfo, error) {
	if err := validateManagedParents(root, path); err != nil {
		return nil, nil, err
	}
	before, err := privateRemoteFile(path)
	if err != nil {
		return nil, nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	content, readErr := io.ReadAll(io.LimitReader(file, int64(maximum)))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, nil, fmt.Errorf("remote session prefix could not be read")
	}
	after, err := privateRemoteFile(path)
	if err != nil {
		return nil, nil, err
	}
	beforeIdentity, beforeMetadata, err := statIdentity(before)
	if err != nil {
		return nil, nil, err
	}
	afterIdentity, afterMetadata, err := statIdentity(after)
	if err != nil || beforeIdentity != afterIdentity || beforeMetadata != afterMetadata {
		return nil, nil, fmt.Errorf("remote session file changed while read")
	}
	return content, before, nil
}

func parseJournalHeader(prefix []byte) (map[string]any, []byte, []byte, error) {
	line := func(offset int) (map[string]any, int, error) {
		end := -1
		for index := offset; index < len(prefix) && index < 16385; index++ {
			if prefix[index] == '\n' {
				end = index
				break
			}
		}
		if end < 0 || end >= 16384 {
			return nil, 0, fmt.Errorf("incomplete bounded journal header")
		}
		var value map[string]any
		if err := json.Unmarshal(prefix[offset:end], &value); err != nil {
			return nil, 0, fmt.Errorf("invalid journal header")
		}
		return value, end, nil
	}
	first, firstEnd, err := line(0)
	if err != nil {
		return nil, nil, nil, err
	}
	start := 0
	if first["type"] == "title" {
		if firstEnd != 255 || first["v"] != float64(1) {
			return nil, nil, nil, fmt.Errorf("invalid journal title slot")
		}
		_, titleOK := first["title"].(string)
		updatedAt, updatedOK := first["updatedAt"].(string)
		padding, paddingOK := first["pad"].(string)
		source, hasSource := first["source"]
		if !titleOK || !updatedOK || !paddingOK || strings.Trim(padding, " ") != "" ||
			(hasSource && source != "auto" && source != "user") {
			return nil, nil, nil, fmt.Errorf("invalid journal title slot")
		}
		if _, err := time.Parse(time.RFC3339Nano, updatedAt); err != nil {
			return nil, nil, nil, fmt.Errorf("invalid journal title slot")
		}
		for key := range first {
			if key != "type" && key != "v" && key != "title" && key != "source" &&
				key != "updatedAt" && key != "pad" {
				return nil, nil, nil, fmt.Errorf("invalid journal title slot")
			}
		}
		start = firstEnd + 1
	}
	header := first
	headerEnd := firstEnd
	if start != 0 {
		header, headerEnd, err = line(start)
		if err != nil {
			return nil, nil, nil, err
		}
	}
	return header, prefix[start:headerEnd], prefix[:headerEnd+1], nil
}

func sameProjectDirectory(first, second string) bool {
	firstInfo, firstErr := os.Lstat(first)
	secondInfo, secondErr := os.Lstat(second)
	if firstErr != nil || secondErr != nil || !firstInfo.IsDir() || !secondInfo.IsDir() ||
		firstInfo.Mode()&os.ModeSymlink != 0 || secondInfo.Mode()&os.ModeSymlink != 0 {
		return false
	}
	firstDev, firstDevOK := statField(firstInfo, "Dev")
	firstIno, firstInoOK := statField(firstInfo, "Ino")
	secondDev, secondDevOK := statField(secondInfo, "Dev")
	secondIno, secondInoOK := statField(secondInfo, "Ino")
	return firstDevOK && firstInoOK && secondDevOK && secondInoOK &&
		firstDev == secondDev && firstIno == secondIno
}

func runRemoteSessionPreflight(root, projectRoot, manifestPath, manifestHash string, manifestBytes int, journalPath, sessionID string) (remoteSessionPreflight, error) {
	var result remoteSessionPreflight
	manifest, _, err := readExactPrivateFile(root, manifestPath, 16*1024)
	if err != nil {
		return result, err
	}
	actualManifestHash := preflightHash(manifest)
	if len(manifest) != manifestBytes || actualManifestHash != manifestHash {
		return result, fmt.Errorf("remote session manifest identity differs")
	}
	journalPrefix, journalInfo, err := readPrivatePrefix(root, journalPath, 16385)
	if err != nil {
		return result, err
	}
	if len(journalPrefix) == 0 {
		return result, fmt.Errorf("remote journal is empty")
	}
	header, headerBytes, prefixBytes, err := parseJournalHeader(journalPrefix)
	if err != nil {
		return result, err
	}
	id, idOK := header["id"].(string)
	cwd, cwdOK := header["cwd"].(string)
	timestamp, timestampOK := header["timestamp"].(string)
	if header["type"] != "session" || header["version"] != float64(3) ||
		!idOK || id != sessionID || !cwdOK || !timestampOK {
		return result, fmt.Errorf("remote journal identity differs")
	}
	if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
		return result, fmt.Errorf("remote journal timestamp is invalid")
	}
	if cwd != projectRoot {
		if runtime.GOOS != "darwin" || !strings.HasPrefix(projectRoot, "/private/") ||
			cwd != strings.TrimPrefix(projectRoot, "/private") ||
			!sameProjectDirectory(projectRoot, cwd) {
			return result, fmt.Errorf("remote journal project differs")
		}
	}
	stable, metadata, err := statIdentity(journalInfo)
	if err != nil {
		return result, err
	}
	result.Manifest = remoteManifestPreflight{Path: manifestPath, Size: len(manifest), SHA256: actualManifestHash}
	result.Journal = remoteJournalPreflight{
		JournalPath: journalPath, OmpSessionID: id, Cwd: projectRoot, HeaderVersion: 3,
		FileIdentity: preflightHash([]byte(stable), []byte{0}, headerBytes),
		Fingerprint:  preflightHash([]byte(metadata), []byte{0}, prefixBytes),
		Verification: "bounded-header",
	}
	return result, nil
}

func remoteSessionPreflightCLI(args []string, output, errorOutput io.Writer) error {
	flags := flag.NewFlagSet("remote-session-preflight", flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	root := flags.String("root", "", "runtime root")
	projectRoot := flags.String("project-root", "", "canonical project root")
	manifest := flags.String("manifest", "", "remote manifest")
	manifestHash := flags.String("manifest-sha256", "", "expected manifest sha256")
	manifestBytes := flags.Int("manifest-bytes", 0, "expected manifest bytes")
	journal := flags.String("journal", "", "remote journal")
	sessionID := flags.String("session-id", "", "expected OMP session id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *root == "" || *projectRoot == "" || *manifest == "" ||
		*journal == "" || len(*manifestHash) != 64 || *manifestBytes < 1 || *sessionID == "" {
		return invalidArgument("remote-session-preflight requires its complete identity")
	}
	for _, character := range *manifestHash {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return invalidArgument("remote-session-preflight manifest hash is invalid")
		}
	}
	result, err := runRemoteSessionPreflight(
		*root, *projectRoot, *manifest, *manifestHash, *manifestBytes, *journal, *sessionID,
	)
	if err != nil {
		return err
	}
	document := map[string]any{
		"manifest": map[string]any{
			"path": result.Manifest.Path, "size": result.Manifest.Size, "sha256": result.Manifest.SHA256,
		},
		"journal": map[string]any{
			"journalPath":   result.Journal.JournalPath,
			"ompSessionId":  result.Journal.OmpSessionID,
			"cwd":           result.Journal.Cwd,
			"headerVersion": result.Journal.HeaderVersion,
			"fileIdentity":  result.Journal.FileIdentity,
			"fingerprint":   result.Journal.Fingerprint,
			"verification":  result.Journal.Verification,
		},
	}
	return json.NewEncoder(output).Encode(document)
}
