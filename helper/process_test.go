package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestProcessBoundsCombinedOutput(t *testing.T) {
	runner := newProcessRunner(mustGuard(t, t.TempDir()))
	result, err := runner.run(context.Background(), runParams{
		Command:        []string{"/bin/sh", "-c", "printf abcdefgh; printf ijklmnop >&2"},
		Cwd:            ".",
		MaxOutputBytes: intPointer(10),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Stdout)+len(result.Stderr) != 10 || !result.Truncated {
		t.Fatalf("unexpected bounded output: %+v", result)
	}
}

func TestProcessCancellationTerminatesGroup(t *testing.T) {
	root := t.TempDir()
	runner := newProcessRunner(mustGuard(t, root))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan commandResult, 1)
	go func() {
		result, _ := runner.run(ctx, runParams{
			Command: []string{
				"/bin/sh", "-c",
				`/bin/sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' >/dev/null 2>&1 & wait`,
			},
			Cwd: ".",
		})
		done <- result
	}()
	pid := waitForPIDFile(t, filepath.Join(root, "child.pid"))
	cancel()
	select {
	case result := <-done:
		if result.TerminationReason != "cancelled" || result.Signal == nil {
			t.Fatalf("unexpected cancellation result: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled process did not exit")
	}
	waitForProcessGone(t, pid)
}

func TestProcessTimeout(t *testing.T) {
	runner := newProcessRunner(mustGuard(t, t.TempDir()))
	result, err := runner.run(context.Background(), runParams{
		Command:   []string{"/bin/sh", "-c", "sleep 30"},
		Cwd:       ".",
		TimeoutMs: intPointer(50),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.TerminationReason != "timeout" || result.Signal == nil {
		t.Fatalf("unexpected timeout result: %+v", result)
	}
}

func TestProcessRejectsOutputLimitAboveResponseBudget(t *testing.T) {
	runner := newProcessRunner(mustGuard(t, t.TempDir()))
	_, err := runner.run(context.Background(), runParams{
		Command: []string{"/bin/sh", "-c", "true"}, Cwd: ".",
		MaxOutputBytes: intPointer(maxCapturedOutput + 1),
	})
	var domainErr *domainError
	if !errors.As(err, &domainErr) || domainErr.code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %v, want INVALID_ARGUMENT", err)
	}
}

func mustGuard(t *testing.T, root string) *pathGuard {
	t.Helper()
	guard, err := newPathGuard(root)
	if err != nil {
		t.Fatal(err)
	}
	return guard
}

func intPointer(value int) *int { return &value }

func waitForPIDFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(content)))
			if parseErr == nil {
				return pid
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
	return 0
}

func waitForProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("process %d survived group termination", pid)
}
