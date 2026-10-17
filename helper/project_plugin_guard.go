package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

const maxPluginJSONBytes = 512 * 1024

var (
	pluginIndexNames   = []string{"index.ts", "index.js", "index.mjs", "index.cjs"}
	projectConfigDirs  = []string{".omp", ".claude", ".codex", ".gemini"}
	packageNamePattern = regexp.MustCompile("^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")
)

type pluginRuntimeState struct {
	enabled         bool
	enabledFeatures []string
}

type projectPluginOverrides struct {
	disabled map[string]bool
	features map[string][]string
}

func pluginObject(value any, label string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("cannot inspect project plugins: invalid %s", label)
	}
	return object, nil
}

func pluginStringArray(value any, label string) ([]string, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("cannot inspect project plugins: invalid %s", label)
	}
	result := make([]string, 0, len(raw))
	for _, entry := range raw {
		text, ok := entry.(string)
		if !ok {
			return nil, fmt.Errorf("cannot inspect project plugins: invalid %s", label)
		}
		result = append(result, text)
	}
	return result, nil
}

func readPluginJSON(path string) (any, bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, false, fmt.Errorf("cannot inspect project plugin metadata: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false, fmt.Errorf("cannot inspect project plugin metadata: %s", path)
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxPluginJSONBytes+1))
	if err != nil || len(content) > maxPluginJSONBytes {
		return nil, false, fmt.Errorf("cannot inspect project plugin metadata: %s", path)
	}
	var value any
	if err := json.Unmarshal(content, &value); err != nil {
		return nil, false, fmt.Errorf("cannot inspect project plugin metadata: invalid JSON at %s", path)
	}
	return value, true, nil
}

func canonicalDirectory(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("cannot inspect the active project plugin root")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("cannot inspect the active project plugin root")
	}
	absolute, err := filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("cannot inspect the active project plugin root")
	}
	return filepath.Clean(absolute), nil
}

func activeProjectPluginsRoot(projectRoot string) (string, error) {
	start, err := canonicalDirectory(projectRoot)
	if err != nil || start != filepath.Clean(projectRoot) {
		return "", fmt.Errorf("cannot inspect the active project plugin root")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot inspect the active project plugin root")
	}
	if resolved, resolveErr := filepath.EvalSymlinks(home); resolveErr == nil {
		home = resolved
	}
	home, err = filepath.Abs(home)
	if err != nil {
		return "", fmt.Errorf("cannot inspect the active project plugin root")
	}
	walk := func(marker string, directory bool) string {
		for current := start; current != filepath.Clean(home); current = filepath.Dir(current) {
			target := filepath.Join(current, marker)
			info, statErr := os.Stat(target)
			if statErr == nil && (!directory || info.IsDir()) {
				return filepath.Join(current, ".omp", "plugins")
			}
			parent := filepath.Dir(current)
			if parent == current {
				break
			}
		}
		return ""
	}
	if root := walk(".omp", true); root != "" {
		return root, nil
	}
	return walk(".git", false), nil
}

func pluginRuntimeStates(value any, present bool) (map[string]pluginRuntimeState, error) {
	states := make(map[string]pluginRuntimeState)
	if !present {
		return states, nil
	}
	root, err := pluginObject(value, "plugin runtime configuration")
	if err != nil {
		return nil, err
	}
	rawPlugins := any(map[string]any{})
	if value, ok := root["plugins"]; ok {
		rawPlugins = value
	}
	plugins, err := pluginObject(rawPlugins, "plugin runtime states")
	if err != nil {
		return nil, err
	}
	for name, raw := range plugins {
		state, err := pluginObject(raw, "runtime state for "+name)
		if err != nil {
			return nil, err
		}
		var enabledFeatures []string
		if selected, ok := state["enabledFeatures"]; ok && selected != nil {
			enabledFeatures, err = pluginStringArray(selected, "enabled features for "+name)
			if err != nil {
				return nil, err
			}
		}
		enabled, _ := state["enabled"].(bool)
		states[name] = pluginRuntimeState{enabled: enabled, enabledFeatures: enabledFeatures}
	}
	return states, nil
}

func emptyProjectPluginOverrides() projectPluginOverrides {
	return projectPluginOverrides{disabled: make(map[string]bool), features: make(map[string][]string)}
}

func parseProjectPluginOverrides(value any) (projectPluginOverrides, error) {
	result := emptyProjectPluginOverrides()
	root, err := pluginObject(value, "project plugin overrides")
	if err != nil {
		return result, err
	}
	if raw, ok := root["disabled"]; ok {
		names, err := pluginStringArray(raw, "disabled project plugins")
		if err != nil {
			return result, err
		}
		for _, name := range names {
			result.disabled[name] = true
		}
	}
	if raw, ok := root["features"]; ok {
		features, err := pluginObject(raw, "project plugin features")
		if err != nil {
			return result, err
		}
		for name, selected := range features {
			values, err := pluginStringArray(selected, "project features for "+name)
			if err != nil {
				return result, err
			}
			result.features[name] = values
		}
	}
	return result, nil
}

func loadProjectPluginOverrides(projectRoot string) projectPluginOverrides {
	for _, directory := range projectConfigDirs {
		value, present, err := readPluginJSON(filepath.Join(projectRoot, directory, "plugin-overrides.json"))
		if err != nil || !present {
			continue
		}
		parsed, err := parseProjectPluginOverrides(value)
		if err == nil {
			return parsed
		}
	}
	return emptyProjectPluginOverrides()
}

func pluginToolEntries(manifest map[string]any, selected []string, pluginName string) ([]string, error) {
	var entries []string
	if raw, ok := manifest["tools"]; ok && raw != nil {
		if text, ok := raw.(string); ok {
			entries = append(entries, text)
		} else {
			values, err := pluginStringArray(raw, "tools for "+pluginName)
			if err != nil {
				return nil, err
			}
			entries = append(entries, values...)
		}
	}
	rawFeatures, hasFeatures := manifest["features"]
	if !hasFeatures {
		return entries, nil
	}
	features, err := pluginObject(rawFeatures, "features for "+pluginName)
	if err != nil {
		return nil, err
	}
	if selected == nil {
		for name, raw := range features {
			feature, err := pluginObject(raw, "feature for "+pluginName)
			if err != nil {
				return nil, err
			}
			if enabled, _ := feature["default"].(bool); enabled {
				selected = append(selected, name)
			}
		}
	}
	for _, name := range selected {
		raw, ok := features[name]
		if !ok {
			continue
		}
		feature, err := pluginObject(raw, "feature "+name+" for "+pluginName)
		if err != nil {
			return nil, err
		}
		if tools, ok := feature["tools"]; ok {
			values, err := pluginStringArray(tools, "feature tools for "+pluginName+"/"+name)
			if err != nil {
				return nil, err
			}
			entries = append(entries, values...)
		}
	}
	return entries, nil
}

func resolvePluginToolModule(pluginRoot, entry string) (string, bool, error) {
	if entry == "" {
		return "", false, fmt.Errorf("cannot inspect project plugins: invalid tool entry")
	}
	joined := filepath.Clean(filepath.Join(pluginRoot, entry))
	info, err := os.Stat(joined)
	if err == nil && info.Mode().IsRegular() {
		return joined, true, nil
	}
	if err == nil && info.IsDir() {
		for _, name := range pluginIndexNames {
			index := filepath.Join(joined, name)
			if indexInfo, indexErr := os.Stat(index); indexErr == nil && indexInfo.Mode().IsRegular() {
				return index, true, nil
			}
		}
	}
	if err != nil && !os.IsNotExist(err) {
		return "", false, fmt.Errorf("cannot inspect project plugin tool entry: %s", joined)
	}
	return "", false, nil
}

func assertNoProjectPluginToolsOnHost(projectRoot string) error {
	pluginsRoot, err := activeProjectPluginsRoot(projectRoot)
	if err != nil || pluginsRoot == "" {
		return err
	}
	packageValue, packagePresent, err := readPluginJSON(filepath.Join(pluginsRoot, "package.json"))
	if err != nil {
		return err
	}
	lockValue, lockPresent, err := readPluginJSON(filepath.Join(pluginsRoot, "omp-plugins.lock.json"))
	if err != nil {
		return err
	}
	dependencies := make(map[string]bool)
	if packagePresent {
		root, err := pluginObject(packageValue, "project plugin package")
		if err != nil {
			return err
		}
		raw := any(map[string]any{})
		if value, ok := root["dependencies"]; ok {
			raw = value
		}
		values, err := pluginObject(raw, "dependencies")
		if err != nil {
			return err
		}
		for name := range values {
			dependencies[name] = true
		}
	}
	states, err := pluginRuntimeStates(lockValue, lockPresent)
	if err != nil {
		return err
	}
	names := make(map[string]bool)
	for name := range dependencies {
		names[name] = true
	}
	for name := range states {
		names[name] = true
	}
	overrides := loadProjectPluginOverrides(projectRoot)
	for name := range names {
		if !packageNamePattern.MatchString(name) {
			return fmt.Errorf("cannot inspect project plugins: invalid package name %q", name)
		}
		pluginRoot := filepath.Join(pluginsRoot, "node_modules", filepath.FromSlash(name))
		if packagePresent && !dependencies[name] {
			info, lstatErr := os.Lstat(pluginRoot)
			if lstatErr != nil || info.Mode()&os.ModeSymlink == 0 {
				continue
			}
		}
		pluginValue, present, err := readPluginJSON(filepath.Join(pluginRoot, "package.json"))
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		state, hasState := states[name]
		if (hasState && !state.enabled) || overrides.disabled[name] {
			continue
		}
		pluginPackage, err := pluginObject(pluginValue, "manifest for "+name)
		if err != nil {
			return err
		}
		rawManifest, ok := pluginPackage["omp"]
		if !ok {
			rawManifest, ok = pluginPackage["pi"]
		}
		if !ok {
			continue
		}
		manifest, err := pluginObject(rawManifest, "manifest for "+name)
		if err != nil {
			return err
		}
		selected, ok := overrides.features[name]
		if !ok && hasState {
			selected = state.enabledFeatures
		}
		entries, err := pluginToolEntries(manifest, selected, name)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			modulePath, resolved, err := resolvePluginToolModule(pluginRoot, entry)
			if err != nil {
				return err
			}
			if resolved {
				return fmt.Errorf("cannot start Phi RPC: project plugin tools are not allowed; plugin %q resolves %q to %q. OMP imports project plugin tool modules before Phi guards can run.", name, entry, modulePath)
			}
		}
	}
	return nil
}

func projectPluginGuardCLI(args []string, output, errorOutput io.Writer) error {
	flags := flag.NewFlagSet("project-plugin-guard", flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	root := flags.String("root", "", "canonical project root")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || flags.NArg() != 0 {
		return invalidArgument("project-plugin-guard requires exactly one --root path")
	}
	if err := assertNoProjectPluginToolsOnHost(*root); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]bool{"ok": true})
}
