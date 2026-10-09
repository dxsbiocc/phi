package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type selftestChecks struct {
	FileSystem   bool `json:"fs"`
	ProcessGroup bool `json:"processGroup"`
	OutputLimit  bool `json:"outputLimit"`
}

type selftestResult struct {
	OK      bool           `json:"ok"`
	Version string         `json:"version"`
	Checks  selftestChecks `json:"checks"`
	Error   string         `json:"error,omitempty"`
}

func runSelftest() selftestResult {
	result := selftestResult{Version: helperVersion}
	root, err := os.MkdirTemp("", "phi-helper-selftest-*")
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer os.RemoveAll(root)
	fs, err := newFileSystem(root)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if err := selftestFileSystem(fs); err != nil {
		result.Error = err.Error()
		return result
	}
	result.Checks.FileSystem = true
	runner := newProcessRunner(fs.guard)
	if err := selftestProcessGroup(runner); err != nil {
		result.Error = err.Error()
		return result
	}
	result.Checks.ProcessGroup = true
	if err := selftestOutputLimit(runner); err != nil {
		result.Error = err.Error()
		return result
	}
	result.Checks.OutputLimit = true
	result.OK = true
	return result
}

func selftestFileSystem(fs *fileSystem) error {
	written, err := fs.writeAtomic("probe.txt", []byte("phi"), nil)
	if err != nil {
		return err
	}
	content, err := os.ReadFile(filepath.Join(fs.guard.root, "probe.txt"))
	if err != nil {
		return err
	}
	if string(content) != "phi" || written.Hash != hashBytes(content) {
		return fmt.Errorf("filesystem verification failed")
	}
	return nil
}

func selftestProcessGroup(runner *processRunner) error {
	process, err := runner.start(runParams{Command: []string{"/bin/sh", "-c", "sleep 30"}, Cwd: "."})
	if err != nil {
		return err
	}
	pid := process.cmd.Process.Pid
	group, err := syscall.Getpgid(pid)
	if err != nil {
		process.terminate("terminated")
		_, _ = process.await()
		process.awaitTermination()
		return err
	}
	process.terminate("terminated")
	if _, err := process.await(); err != nil {
		return err
	}
	process.awaitTermination()
	if group != pid {
		return fmt.Errorf("process was not its process-group leader")
	}
	return nil
}

func selftestOutputLimit(runner *processRunner) error {
	limit := 8
	result, err := runner.run(context.Background(), runParams{
		Command: []string{"/bin/sh", "-c", "printf 0123456789abcdef"},
		Cwd:     ".", MaxOutputBytes: &limit,
	})
	if err != nil {
		return err
	}
	if len(result.Stdout)+len(result.Stderr) != limit || !result.Truncated {
		return fmt.Errorf("output limit verification failed")
	}
	return nil
}
