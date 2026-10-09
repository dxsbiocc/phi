package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestVersionComesFromEmbeddedVersionFile(t *testing.T) {
	var output bytes.Buffer
	if err := runCLI([]string{"--version"}, strings.NewReader(""), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(output.String()) != helperVersion || helperVersion == "" {
		t.Fatalf("version output = %q, embedded version = %q", output.String(), helperVersion)
	}
}

func TestSelftestCLIPrintsOneJSONLine(t *testing.T) {
	var output bytes.Buffer
	if err := runCLI([]string{"--selftest"}, strings.NewReader(""), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("selftest output is not one line: %q", output.String())
	}
	var result selftestResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("selftest failed: %+v", result)
	}
}
