package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type pluginFixture struct {
	t       *testing.T
	home    string
	project string
	plugins string
}

// newPluginFixture creates a canonical HOME with a project below it carrying
// an .omp marker, so the guard resolves <project>/.omp/plugins.
func newPluginFixture(t *testing.T) *pluginFixture {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	project := filepath.Join(home, "project")
	plugins := filepath.Join(project, ".omp", "plugins")
	if err := os.MkdirAll(plugins, 0o700); err != nil {
		t.Fatal(err)
	}
	return &pluginFixture{t: t, home: home, project: project, plugins: plugins}
}

func (f *pluginFixture) write(path, content string) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *pluginFixture) packageJSON(content string) {
	f.write(filepath.Join(f.plugins, "package.json"), content)
}

func (f *pluginFixture) lock(content string) {
	f.write(filepath.Join(f.plugins, "omp-plugins.lock.json"), content)
}

func (f *pluginFixture) plugin(name, manifest string) string {
	root := filepath.Join(f.plugins, "node_modules", filepath.FromSlash(name))
	f.write(filepath.Join(root, "package.json"), manifest)
	return root
}

func (f *pluginFixture) mustAccept() {
	f.t.Helper()
	if err := assertNoProjectPluginToolsOnHost(f.project); err != nil {
		f.t.Fatalf("expected accept, got %v", err)
	}
}

func (f *pluginFixture) mustRefuse(fragment string) {
	f.t.Helper()
	err := assertNoProjectPluginToolsOnHost(f.project)
	if err == nil {
		f.t.Fatalf("expected refusal containing %q, got accept", fragment)
	}
	if !strings.Contains(err.Error(), fragment) {
		f.t.Fatalf("error %q does not contain %q", err, fragment)
	}
}

const toolPluginManifest = `{"name":"p","omp":{"tools":["tool.ts"]}}`

func TestPluginGuardAcceptsProjectWithoutAnyMarker(t *testing.T) {
	home, _ := filepath.EvalSymlinks(t.TempDir())
	t.Setenv("HOME", home)
	project := filepath.Join(home, "bare")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := assertNoProjectPluginToolsOnHost(project); err != nil {
		t.Fatalf("expected accept, got %v", err)
	}
}

func TestPluginGuardAcceptsEmptyPluginRoot(t *testing.T) {
	newPluginFixture(t).mustAccept()
}

func TestPluginGuardFindsPluginsRootViaGitMarker(t *testing.T) {
	home, _ := filepath.EvalSymlinks(t.TempDir())
	t.Setenv("HOME", home)
	project := filepath.Join(home, "repo", "nested")
	plugins := filepath.Join(home, "repo", ".omp", "plugins")
	for _, dir := range []string{project, plugins, filepath.Join(home, "repo", ".git")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(plugins, "node_modules", "p")
	for path, content := range map[string]string{
		filepath.Join(plugins, "package.json"): `{"dependencies":{"p":"1"}}`,
		filepath.Join(root, "package.json"):    toolPluginManifest,
		filepath.Join(root, "tool.ts"):         "export {}",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	err := assertNoProjectPluginToolsOnHost(project)
	if err == nil || !strings.Contains(err.Error(), "project plugin tools are not allowed") {
		t.Fatalf("expected refusal through .git ancestor, got %v", err)
	}
}

func TestPluginGuardRefusesEnabledToolModule(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	root := f.plugin("p", toolPluginManifest)
	f.write(filepath.Join(root, "tool.ts"), "export {}")
	f.mustRefuse("project plugin tools are not allowed")
}

func TestPluginGuardRefusesScopedPackageAndDirectoryIndex(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"@scope/p":"1"}}`)
	root := f.plugin("@scope/p", `{"pi":{"tools":"tools"}}`)
	f.write(filepath.Join(root, "tools", "index.mjs"), "export {}")
	f.mustRefuse("project plugin tools are not allowed")
}

func TestPluginGuardAcceptsMissingToolModule(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	f.plugin("p", toolPluginManifest)
	f.mustAccept()
}

func TestPluginGuardAcceptsPluginWithoutManifestKey(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	root := f.plugin("p", `{"name":"p"}`)
	f.write(filepath.Join(root, "tool.ts"), "export {}")
	f.mustAccept()
}

func TestPluginGuardSkipsPluginDisabledByLockOrOverride(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	root := f.plugin("p", toolPluginManifest)
	f.write(filepath.Join(root, "tool.ts"), "export {}")
	f.lock(`{"plugins":{"p":{"enabled":false}}}`)
	f.mustAccept()
	f.lock(`{"plugins":{"p":{"enabled":true}}}`)
	f.mustRefuse("project plugin tools are not allowed")
	f.write(filepath.Join(f.project, ".claude", "plugin-overrides.json"), `{"disabled":["p"]}`)
	f.mustAccept()
}

func TestPluginGuardFeatureSelection(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	root := f.plugin("p", `{"omp":{"features":{"a":{"default":true,"tools":["a.ts"]},"b":{"tools":["b.ts"]}}}}`)
	f.write(filepath.Join(root, "b.ts"), "export {}")
	// Default feature "a" has no module; "b" is not selected.
	f.mustAccept()
	f.lock(`{"plugins":{"p":{"enabled":true,"enabledFeatures":["b"]}}}`)
	f.mustRefuse("project plugin tools are not allowed")
	// A project override replaces the lock selection.
	f.write(filepath.Join(f.project, ".omp", "plugin-overrides.json"), `{"features":{"p":["a"]}}`)
	f.mustAccept()
}

func TestPluginGuardSkipsUndeclaredRealDirectoryButInspectsSymlink(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{}}`)
	f.lock(`{"plugins":{"p":{"enabled":true}}}`)
	root := f.plugin("p", toolPluginManifest)
	f.write(filepath.Join(root, "tool.ts"), "export {}")
	f.mustAccept()
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(f.home, "elsewhere")
	f.write(filepath.Join(target, "package.json"), toolPluginManifest)
	f.write(filepath.Join(target, "tool.ts"), "export {}")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}
	f.mustRefuse("project plugin tools are not allowed")
}

func TestPluginGuardRefusesInvalidPackageName(t *testing.T) {
	for _, name := range []string{"../escape", "UPPER", "a/b/c", ""} {
		f := newPluginFixture(t)
		f.packageJSON(`{"dependencies":{"` + name + `":"1"}}`)
		f.mustRefuse("invalid package name")
	}
}

func TestPluginGuardRefusesMalformedMetadata(t *testing.T) {
	cases := map[string]func(*pluginFixture){
		"invalid JSON":           func(f *pluginFixture) { f.packageJSON(`{`) },
		"project plugin package": func(f *pluginFixture) { f.packageJSON(`[]`) },
		"dependencies":           func(f *pluginFixture) { f.packageJSON(`{"dependencies":[]}`) },
		"plugin runtime":         func(f *pluginFixture) { f.lock(`[]`) },
		"runtime states":         func(f *pluginFixture) { f.lock(`{"plugins":[]}`) },
		"runtime state for p":    func(f *pluginFixture) { f.lock(`{"plugins":{"p":1}}`) },
		"enabled features for p": func(f *pluginFixture) { f.lock(`{"plugins":{"p":{"enabledFeatures":"x"}}}`) },
		"manifest for p":         func(f *pluginFixture) { f.packageJSON(`{"dependencies":{"p":"1"}}`); f.plugin("p", `{"omp":1}`) },
		"tools for p": func(f *pluginFixture) {
			f.packageJSON(`{"dependencies":{"p":"1"}}`)
			f.plugin("p", `{"omp":{"tools":[1]}}`)
		},
		"features for p": func(f *pluginFixture) {
			f.packageJSON(`{"dependencies":{"p":"1"}}`)
			f.plugin("p", `{"omp":{"features":[]}}`)
		},
		"invalid tool entry": func(f *pluginFixture) {
			f.packageJSON(`{"dependencies":{"p":"1"}}`)
			f.plugin("p", `{"omp":{"tools":[""]}}`)
		},
		"invalid manifest for p": func(f *pluginFixture) { f.packageJSON(`{"dependencies":{"p":"1"}}`); f.plugin("p", `[]`) },
	}
	for fragment, setup := range cases {
		f := newPluginFixture(t)
		setup(f)
		f.mustRefuse(fragment)
	}
}

func TestPluginGuardIgnoresMalformedOverridesFile(t *testing.T) {
	f := newPluginFixture(t)
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	root := f.plugin("p", toolPluginManifest)
	f.write(filepath.Join(root, "tool.ts"), "export {}")
	f.write(filepath.Join(f.project, ".omp", "plugin-overrides.json"), `{"disabled":"p"}`)
	f.mustRefuse("project plugin tools are not allowed")
}

func TestPluginGuardRefusesSymlinkedMetadata(t *testing.T) {
	f := newPluginFixture(t)
	real := filepath.Join(f.home, "real-package.json")
	f.write(real, `{"dependencies":{}}`)
	if err := os.Symlink(real, filepath.Join(f.plugins, "package.json")); err != nil {
		t.Fatal(err)
	}
	f.mustRefuse("cannot inspect project plugin metadata")
}

func TestPluginGuardRefusesDirectoryInPlaceOfMetadata(t *testing.T) {
	f := newPluginFixture(t)
	if err := os.Mkdir(filepath.Join(f.plugins, "package.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	f.mustRefuse("cannot inspect project plugin metadata")
}

func TestPluginGuardEnforcesMetadataSizeBound(t *testing.T) {
	f := newPluginFixture(t)
	padding := strings.Repeat(" ", maxPluginJSONBytes)
	f.packageJSON(`{"dependencies":{}}` + padding)
	f.mustRefuse("cannot inspect project plugin metadata")
	// Exactly at the bound is still accepted.
	f.packageJSON(`{"dependencies":{}}` + strings.Repeat(" ", maxPluginJSONBytes-len(`{"dependencies":{}}`)))
	f.mustAccept()
}

func TestPluginGuardRefusesNonCanonicalOrSymlinkedProjectRoot(t *testing.T) {
	f := newPluginFixture(t)
	link := filepath.Join(f.home, "link")
	if err := os.Symlink(f.project, link); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{link, f.project + "/missing/..", filepath.Join(f.home, "missing"), "relative"} {
		if err := assertNoProjectPluginToolsOnHost(root); err == nil || !strings.Contains(err.Error(), "active project plugin root") {
			t.Fatalf("root %q: expected root refusal, got %v", root, err)
		}
	}
	file := filepath.Join(f.home, "file")
	f.write(file, "x")
	if err := assertNoProjectPluginToolsOnHost(file); err == nil {
		t.Fatal("file as project root was accepted")
	}
}

func TestPluginGuardCLI(t *testing.T) {
	f := newPluginFixture(t)
	var output, errors bytes.Buffer
	if err := projectPluginGuardCLI([]string{"--root", f.project}, &output, &errors); err != nil {
		t.Fatal(err)
	}
	if output.String() != "{\"ok\":true}\n" {
		t.Fatalf("output = %q", output.String())
	}
	for _, args := range [][]string{{}, {"--root", ""}, {"--root", f.project, "extra"}, {"--unknown"}} {
		if err := projectPluginGuardCLI(args, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
			t.Fatalf("args %v accepted", args)
		}
	}
	f.packageJSON(`{"dependencies":{"p":"1"}}`)
	root := f.plugin("p", toolPluginManifest)
	f.write(filepath.Join(root, "tool.ts"), "export {}")
	output.Reset()
	if err := projectPluginGuardCLI([]string{"--root", f.project}, &output, &errors); err == nil || output.Len() != 0 {
		t.Fatalf("tool plugin accepted: err=%v output=%q", err, output.String())
	}
}

func TestRunCLIDispatchesProjectPluginGuard(t *testing.T) {
	f := newPluginFixture(t)
	var output bytes.Buffer
	if err := runCLI([]string{"project-plugin-guard", "--root", f.project}, strings.NewReader(""), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if output.String() != "{\"ok\":true}\n" {
		t.Fatalf("output = %q", output.String())
	}
}
