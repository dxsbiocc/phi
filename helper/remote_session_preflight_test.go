package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const preflightSessionID = "omp-session-1"

type preflightFixture struct {
	t        *testing.T
	root     string
	project  string
	manifest string
	journal  string
	content  []byte
}

func newPreflightFixture(t *testing.T) *preflightFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "runtime")
	f := &preflightFixture{
		t:        t,
		root:     root,
		project:  filepath.Join(base, "project"),
		manifest: filepath.Join(root, "sessions", "s1", "manifest.json"),
		journal:  filepath.Join(root, "sessions", "s1", "journals", "j.jsonl"),
		content:  []byte(`{"schema":1}`),
	}
	for _, dir := range []string{
		f.project, root, filepath.Join(root, "sessions"), filepath.Join(root, "sessions", "s1"),
		filepath.Join(root, "sessions", "s1", "journals"),
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	f.writePrivate(f.manifest, f.content)
	f.writePrivate(f.journal, []byte(f.header(preflightSessionID, f.project, 3, time.Now().UTC().Format(time.RFC3339Nano))+"\n{\"type\":\"message\"}\n"))
	return f
}

func (f *preflightFixture) header(id, cwd string, version int, timestamp string) string {
	encoded, err := json.Marshal(map[string]any{
		"type": "session", "version": version, "id": id, "timestamp": timestamp, "cwd": cwd,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return string(encoded)
}

func (f *preflightFixture) writePrivate(path string, content []byte) {
	f.t.Helper()
	if err := os.WriteFile(path, content, 0o600); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *preflightFixture) run() (remoteSessionPreflight, error) {
	return f.runWith(f.content, preflightSessionID)
}

func (f *preflightFixture) runWith(manifest []byte, sessionID string) (remoteSessionPreflight, error) {
	return runRemoteSessionPreflight(
		f.root, f.project, f.manifest, preflightHash(manifest), len(manifest), f.journal, sessionID,
	)
}

func (f *preflightFixture) mustRefuse(fragment string) {
	f.t.Helper()
	_, err := f.run()
	if err == nil {
		f.t.Fatalf("expected refusal containing %q, got accept", fragment)
	}
	if !strings.Contains(err.Error(), fragment) {
		f.t.Fatalf("error %q does not contain %q", err, fragment)
	}
}

func TestPreflightAcceptsAndReportsIdentity(t *testing.T) {
	f := newPreflightFixture(t)
	result, err := f.run()
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.Path != f.manifest || result.Manifest.Size != len(f.content) ||
		result.Manifest.SHA256 != preflightHash(f.content) {
		t.Fatalf("manifest identity = %+v", result.Manifest)
	}
	journal := result.Journal
	if journal.JournalPath != f.journal || journal.OmpSessionID != preflightSessionID ||
		journal.Cwd != f.project || journal.HeaderVersion != 3 || journal.Verification != "bounded-header" ||
		len(journal.FileIdentity) != 64 || len(journal.Fingerprint) != 64 {
		t.Fatalf("journal identity = %+v", journal)
	}
	again, err := f.run()
	if err != nil || again.Journal.FileIdentity != journal.FileIdentity ||
		again.Journal.Fingerprint != journal.Fingerprint {
		t.Fatalf("identity is not stable for an unchanged journal: %+v %v", again, err)
	}
}

func TestPreflightFingerprintChangesWhenHeaderPrefixChanges(t *testing.T) {
	f := newPreflightFixture(t)
	first, _ := f.run()
	f.writePrivate(f.journal, []byte(f.header(preflightSessionID, f.project, 3, "2030-01-01T00:00:00Z")+"\n"))
	second, err := f.run()
	if err != nil {
		t.Fatal(err)
	}
	if first.Journal.Fingerprint == second.Journal.Fingerprint {
		t.Fatal("fingerprint did not change with the journal header")
	}
}

func titleSlot(t *testing.T, mutate func(map[string]any)) string {
	t.Helper()
	slot := map[string]any{"type": "title", "v": 1, "title": "t", "updatedAt": "2030-01-01T00:00:00Z", "pad": ""}
	if mutate != nil {
		mutate(slot)
	}
	raw, err := json.Marshal(slot)
	if err != nil {
		t.Fatal(err)
	}
	fill := 255 - len(raw)
	if fill < 0 {
		t.Fatal("title slot too large")
	}
	slot["pad"] = slot["pad"].(string) + strings.Repeat(" ", fill)
	raw, _ = json.Marshal(slot)
	return string(raw)
}

func TestPreflightAcceptsFixedWidthTitleSlot(t *testing.T) {
	f := newPreflightFixture(t)
	slot := titleSlot(t, nil)
	if len(slot) != 255 {
		t.Fatalf("title slot width = %d", len(slot))
	}
	f.writePrivate(f.journal, []byte(slot+"\n"+f.header(preflightSessionID, f.project, 3, "2030-01-01T00:00:00Z")+"\n"))
	if _, err := f.run(); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightRefusesInvalidTitleSlots(t *testing.T) {
	cases := map[string]func(map[string]any){
		"version":       func(s map[string]any) { s["v"] = 2 },
		"source":        func(s map[string]any) { s["source"] = "other" },
		"updatedAt":     func(s map[string]any) { s["updatedAt"] = "yesterday" },
		"unknown key":   func(s map[string]any) { s["extra"] = true },
		"missing title": func(s map[string]any) { delete(s, "title") },
		"non-space pad": func(s map[string]any) { s["pad"] = "x" },
	}
	for name, mutate := range cases {
		f := newPreflightFixture(t)
		slot := titleSlot(t, mutate)
		f.writePrivate(f.journal, []byte(slot+"\n"+f.header(preflightSessionID, f.project, 3, "2030-01-01T00:00:00Z")+"\n"))
		if _, err := f.run(); err == nil {
			t.Fatalf("%s: invalid title slot accepted", name)
		}
	}
	// A title slot that is not exactly 255 bytes wide.
	f := newPreflightFixture(t)
	short := `{"type":"title","v":1,"title":"t","updatedAt":"2030-01-01T00:00:00Z","pad":""}`
	f.writePrivate(f.journal, []byte(short+"\n"+f.header(preflightSessionID, f.project, 3, "2030-01-01T00:00:00Z")+"\n"))
	f.mustRefuse("invalid journal title slot")
}

func TestPreflightRefusesManifestIdentityMismatch(t *testing.T) {
	f := newPreflightFixture(t)
	if _, err := f.runWith([]byte(`{"schema":2}`), preflightSessionID); err == nil ||
		!strings.Contains(err.Error(), "manifest identity differs") {
		t.Fatalf("hash mismatch: %v", err)
	}
	size := len(f.content)
	_, err := runRemoteSessionPreflight(f.root, f.project, f.manifest, preflightHash(f.content), size+1, f.journal, preflightSessionID)
	if err == nil || !strings.Contains(err.Error(), "manifest identity differs") {
		t.Fatalf("size mismatch: %v", err)
	}
}

func TestPreflightRefusesMissingFiles(t *testing.T) {
	f := newPreflightFixture(t)
	if err := os.Remove(f.journal); err != nil {
		t.Fatal(err)
	}
	f.mustRefuse("no such file")
	g := newPreflightFixture(t)
	if err := os.Remove(g.manifest); err != nil {
		t.Fatal(err)
	}
	g.mustRefuse("no such file")
}

func TestPreflightRefusesNonPrivateFiles(t *testing.T) {
	for _, path := range []string{"manifest", "journal"} {
		for _, mode := range []os.FileMode{0o644, 0o640, 0o700, 0o400} {
			f := newPreflightFixture(t)
			target := f.manifest
			if path == "journal" {
				target = f.journal
			}
			if err := os.Chmod(target, mode); err != nil {
				t.Fatal(err)
			}
			f.mustRefuse("not private")
		}
	}
}

func TestPreflightRefusesSymlinkedAndHardLinkedFiles(t *testing.T) {
	f := newPreflightFixture(t)
	real := f.manifest + ".real"
	if err := os.Rename(f.manifest, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, f.manifest); err != nil {
		t.Fatal(err)
	}
	f.mustRefuse("not private")

	g := newPreflightFixture(t)
	if err := os.Link(g.journal, g.journal+".alias"); err != nil {
		t.Fatal(err)
	}
	g.mustRefuse("not private")

	h := newPreflightFixture(t)
	other := filepath.Join(h.root, "other")
	if err := os.WriteFile(other, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(h.journal); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, h.journal); err != nil {
		t.Fatal(err)
	}
	h.mustRefuse("not private")
}

func TestPreflightRefusesUnsafeParentDirectories(t *testing.T) {
	f := newPreflightFixture(t)
	if err := os.Chmod(filepath.Dir(f.manifest), 0o755); err != nil {
		t.Fatal(err)
	}
	f.mustRefuse("directory is not private")

	g := newPreflightFixture(t)
	sessions := filepath.Join(g.root, "sessions")
	moved := filepath.Join(g.root, "sessions-real")
	if err := os.Rename(sessions, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, sessions); err != nil {
		t.Fatal(err)
	}
	g.mustRefuse("directory is not private")

	h := newPreflightFixture(t)
	if err := os.Chmod(filepath.Dir(h.journal), 0o750); err != nil {
		t.Fatal(err)
	}
	h.mustRefuse("directory is not private")
}

func TestPreflightRefusesPathsOutsideRuntimeRoot(t *testing.T) {
	f := newPreflightFixture(t)
	outside := filepath.Join(filepath.Dir(f.root), "outside.json")
	f.writePrivate(outside, f.content)
	_, err := runRemoteSessionPreflight(f.root, f.project, outside, preflightHash(f.content), len(f.content), f.journal, preflightSessionID)
	if err == nil || !strings.Contains(err.Error(), "escapes runtime root") {
		t.Fatalf("outside manifest: %v", err)
	}
	traversal := filepath.Join(f.root, "sessions", "..", "..", "outside.json")
	_, err = runRemoteSessionPreflight(f.root, f.project, traversal, preflightHash(f.content), len(f.content), f.journal, preflightSessionID)
	if err == nil {
		t.Fatal("traversing manifest path accepted")
	}
	_, err = runRemoteSessionPreflight(f.root, f.project, f.root, preflightHash(f.content), len(f.content), f.journal, preflightSessionID)
	if err == nil {
		t.Fatal("runtime root itself accepted as manifest")
	}
}

func TestPreflightEnforcesBounds(t *testing.T) {
	f := newPreflightFixture(t)
	big := bytes.Repeat([]byte("a"), 16*1024+1)
	f.writePrivate(f.manifest, big)
	if _, err := f.runWith(big, preflightSessionID); err == nil || !strings.Contains(err.Error(), "exceeds its bound") {
		t.Fatalf("oversize manifest: %v", err)
	}
	atBound := bytes.Repeat([]byte("a"), 16*1024)
	f.writePrivate(f.manifest, atBound)
	if _, err := f.runWith(atBound, preflightSessionID); err != nil {
		t.Fatalf("manifest at the bound: %v", err)
	}

	g := newPreflightFixture(t)
	g.writePrivate(g.journal, nil)
	g.mustRefuse("journal is empty")

	h := newPreflightFixture(t)
	h.writePrivate(h.journal, []byte(strings.Repeat("x", 16385)))
	h.mustRefuse("incomplete bounded journal header")

	i := newPreflightFixture(t)
	i.writePrivate(i.journal, []byte(i.header(preflightSessionID, i.project, 3, "2030-01-01T00:00:00Z")))
	i.mustRefuse("incomplete bounded journal header")
}

func TestPreflightRefusesJournalIdentityDifferences(t *testing.T) {
	cases := map[string]struct {
		header   func(*preflightFixture) string
		fragment string
	}{
		"session id": {func(f *preflightFixture) string {
			return f.header("another", f.project, 3, "2030-01-01T00:00:00Z")
		}, "journal identity differs"},
		"version": {func(f *preflightFixture) string {
			return f.header(preflightSessionID, f.project, 2, "2030-01-01T00:00:00Z")
		}, "journal identity differs"},
		"timestamp": {func(f *preflightFixture) string {
			return f.header(preflightSessionID, f.project, 3, "not-a-time")
		}, "timestamp is invalid"},
		"cwd": {func(f *preflightFixture) string {
			return f.header(preflightSessionID, f.project+"-other", 3, "2030-01-01T00:00:00Z")
		}, "journal project differs"},
		"not json": {func(f *preflightFixture) string { return "not json" }, "invalid journal header"},
		"not a session": {func(f *preflightFixture) string {
			return `{"type":"message","version":3,"id":"` + preflightSessionID + `","timestamp":"2030-01-01T00:00:00Z","cwd":"` + f.project + `"}`
		}, "journal identity differs"},
		"missing fields": {func(f *preflightFixture) string { return `{"type":"session","version":3}` }, "journal identity differs"},
	}
	for name, tc := range cases {
		f := newPreflightFixture(t)
		f.writePrivate(f.journal, []byte(tc.header(f)+"\n"))
		_, err := f.run()
		if err == nil || !strings.Contains(err.Error(), tc.fragment) {
			t.Fatalf("%s: err = %v, want %q", name, err, tc.fragment)
		}
	}
	f := newPreflightFixture(t)
	if _, err := f.runWith(f.content, "different-session"); err == nil ||
		!strings.Contains(err.Error(), "journal identity differs") {
		t.Fatalf("expected session id mismatch, got %v", err)
	}
}

func TestPreflightDarwinPrivatePrefixAlias(t *testing.T) {
	f := newPreflightFixture(t)
	if runtime.GOOS != "darwin" || !strings.HasPrefix(f.project, "/private/") {
		t.Skip("the /private alias only exists on macOS temp directories")
	}
	alias := strings.TrimPrefix(f.project, "/private")
	f.writePrivate(f.journal, []byte(f.header(preflightSessionID, alias, 3, "2030-01-01T00:00:00Z")+"\n"))
	if _, err := f.run(); err != nil {
		t.Fatalf("aliased cwd on %s: %v", runtime.GOOS, err)
	}
}

func TestPreflightIdentityHelpers(t *testing.T) {
	if !preflightPathInside("/a", "/a/b") || preflightPathInside("/a", "/a") ||
		preflightPathInside("/a", "/ab") || preflightPathInside("/a", "/a/../b") {
		t.Fatal("preflightPathInside is wrong")
	}
	if preflightHash([]byte("a"), []byte("b")) != preflightHash([]byte("ab")) {
		t.Fatal("preflightHash must hash the concatenation")
	}
}

func TestPreflightCLI(t *testing.T) {
	f := newPreflightFixture(t)
	args := func(overrides map[string]string) []string {
		values := map[string]string{
			"--root": f.root, "--project-root": f.project, "--manifest": f.manifest,
			"--manifest-sha256": preflightHash(f.content), "--manifest-bytes": fmt.Sprint(len(f.content)),
			"--journal": f.journal, "--session-id": preflightSessionID,
		}
		for key, value := range overrides {
			values[key] = value
		}
		var result []string
		for key, value := range values {
			result = append(result, key, value)
		}
		return result
	}
	var output bytes.Buffer
	if err := remoteSessionPreflightCLI(args(nil), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("output is not one line: %q", output.String())
	}
	var document struct {
		Manifest struct {
			Path   string `json:"path"`
			Size   int    `json:"size"`
			SHA256 string `json:"sha256"`
		} `json:"manifest"`
		Journal map[string]any `json:"journal"`
	}
	if err := json.Unmarshal(output.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if document.Manifest.SHA256 != preflightHash(f.content) || document.Journal["ompSessionId"] != preflightSessionID ||
		document.Journal["headerVersion"] != float64(3) || document.Journal["verification"] != "bounded-header" {
		t.Fatalf("document = %+v", document)
	}
	for name, overrides := range map[string]map[string]string{
		"no root":           {"--root": ""},
		"no project":        {"--project-root": ""},
		"no manifest":       {"--manifest": ""},
		"no journal":        {"--journal": ""},
		"no session":        {"--session-id": ""},
		"short hash":        {"--manifest-sha256": "abc"},
		"uppercase hash":    {"--manifest-sha256": strings.ToUpper(preflightHash(f.content))},
		"non-hex hash":      {"--manifest-sha256": strings.Repeat("g", 64)},
		"zero manifest len": {"--manifest-bytes": "0"},
		"wrong hash":        {"--manifest-sha256": strings.Repeat("0", 64)},
		"wrong session":     {"--session-id": "other"},
	} {
		output.Reset()
		if err := remoteSessionPreflightCLI(args(overrides), &output, &bytes.Buffer{}); err == nil || output.Len() != 0 {
			t.Fatalf("%s: accepted (err=%v output=%q)", name, err, output.String())
		}
	}
	if err := remoteSessionPreflightCLI(append(args(nil), "extra"), &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("positional argument accepted")
	}
	if err := remoteSessionPreflightCLI([]string{"--bogus"}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("unknown flag accepted")
	}
	if err := runCLI(append([]string{"remote-session-preflight"}, args(nil)...), strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
		t.Fatalf("runCLI dispatch: %v", err)
	}
}
