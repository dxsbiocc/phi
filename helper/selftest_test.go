package main

import "testing"

func TestSelftestExercisesRequiredCapabilities(t *testing.T) {
	result := runSelftest()
	if !result.OK {
		t.Fatalf("selftest failed: %+v", result)
	}
	if !result.Checks.FileSystem || !result.Checks.ProcessGroup || !result.Checks.OutputLimit {
		t.Fatalf("selftest omitted a required check: %+v", result.Checks)
	}
}
