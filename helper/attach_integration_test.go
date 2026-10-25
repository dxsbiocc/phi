package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestConcurrentAttachProcessesSpawnOneListeningKernel(t *testing.T) {
	uid := os.Getuid()
	directory := filepath.Join("/tmp", fmt.Sprintf("phi-k-%d", uid))
	if err := ensureKernelDirectory(directory, uid); err != nil {
		t.Fatal(err)
	}
	preflightPath := filepath.Join(directory, fmt.Sprintf("p%x.sock", os.Getpid()))
	_ = os.Remove(preflightPath)
	preflight, err := net.Listen("unix", preflightPath)
	if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
		t.Skipf("sandbox does not permit Unix listeners: %v", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	_ = preflight.Close()
	_ = os.Remove(preflightPath)

	const attachCount = 8
	temporary := t.TempDir()
	helperBinary := filepath.Join(temporary, "phi-helper")
	contextWithTimeout, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	build := exec.CommandContext(
		contextWithTimeout,
		filepath.Join(runtime.GOROOT(), "bin", "go"),
		"build", "-trimpath", "-o", helperBinary, ".",
	)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v\n%s", err, output)
	}

	fakeKernel := filepath.Join(temporary, "fake-kernel")
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec \"$PHI_FAKE_TEST_BINARY\" -test.run=^TestFakeListeningKernelProcess$ -- \"$@\"\n"
	if err := os.WriteFile(fakeKernel, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	counterPath := filepath.Join(temporary, "spawn-count")

	runtimeRoot := filepath.Join("/tmp", fmt.Sprintf("phi-helper-it-%d", time.Now().UnixNano()))
	kernelVersion := "integration-1"
	paths, err := deriveKernelPaths(runtimeRoot, kernelVersion, uid)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{paths.socket, paths.token, paths.lock, paths.log} {
		_ = os.Remove(path)
		t.Cleanup(func() { _ = os.Remove(path) })
	}

	var wait sync.WaitGroup
	wait.Add(attachCount)
	errorsByAttach := make(chan error, attachCount)
	statuses := make(chan string, attachCount)
	for index := 0; index < attachCount; index++ {
		go func() {
			defer wait.Done()
			var standardOutput bytes.Buffer
			var standardError bytes.Buffer
			command := exec.CommandContext(
				contextWithTimeout,
				helperBinary,
				"attach",
				"--kernel", fakeKernel,
				"--runtime-root", runtimeRoot,
				"--kernel-version", kernelVersion,
				"--grace-ms", "5000",
				"--env", "PHI_FAKE_KERNEL=1",
				"--env", "PHI_FAKE_TEST_BINARY="+testBinary,
				"--env", "PHI_FAKE_COUNTER="+counterPath,
				"--env", fmt.Sprintf("PHI_FAKE_EXPECTED=%d", attachCount),
			)
			command.Stdin = strings.NewReader("")
			command.Stdout = &standardOutput
			command.Stderr = &standardError
			runErr := command.Run()
			if runErr != nil {
				runErr = fmt.Errorf("%w; stdout=%q stderr=%q", runErr, standardOutput.String(), standardError.String())
			}
			errorsByAttach <- runErr
			statuses <- standardError.String()
		}()
	}
	wait.Wait()
	close(errorsByAttach)
	close(statuses)
	for err := range errorsByAttach {
		if err != nil {
			t.Fatal(err)
		}
	}
	counter, err := os.ReadFile(counterPath)
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Count(strings.TrimSpace(string(counter)), "\n") + 1; lines != 1 {
		t.Fatalf("fake kernel spawn count = %d, counter = %q", lines, counter)
	}
	spawnedStatuses := 0
	attachedStatuses := 0
	for status := range statuses {
		if strings.Contains(status, `"state":"spawned"`) {
			spawnedStatuses++
		}
		if strings.Contains(status, `"state":"attached"`) {
			attachedStatuses++
		}
	}
	if spawnedStatuses != 1 || attachedStatuses != attachCount-1 {
		t.Fatalf("statuses: spawned=%d attached=%d", spawnedStatuses, attachedStatuses)
	}
}

func TestFakeListeningKernelProcess(t *testing.T) {
	if os.Getenv("PHI_FAKE_KERNEL") != "1" {
		return
	}
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		t.Fatal("fake kernel arguments are missing -- separator")
	}
	arguments := os.Args[separator+1:]
	value := func(name string) string {
		for index := 0; index+1 < len(arguments); index++ {
			if arguments[index] == name {
				return arguments[index+1]
			}
		}
		return ""
	}
	socketPath := value("--listen")
	tokenPath := value("--token-file")
	if socketPath == "" || tokenPath == "" {
		t.Fatalf("missing lifecycle paths in %q", arguments)
	}
	counter, err := os.OpenFile(os.Getenv("PHI_FAKE_COUNTER"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fmt.Fprintf(counter, "%d\n", os.Getpid())
	_ = counter.Close()
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	if unixListener, ok := listener.(*net.UnixListener); ok {
		if err := unixListener.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	tokenContent, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimSpace(string(tokenContent))
	expected, err := strconv.Atoi(os.Getenv("PHI_FAKE_EXPECTED"))
	if err != nil || expected <= 0 {
		t.Fatalf("invalid expected connection count: %v", err)
	}
	for index := 0; index < expected; index++ {
		connection, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		line, err := bufio.NewReader(connection).ReadBytes('\n')
		if err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		var preamble attachPreamble
		if err := json.Unmarshal(line, &preamble); err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		if preamble.PhiKernelAttach != 1 || preamble.Token != token {
			_ = connection.Close()
			t.Fatalf("invalid attach preamble: %+v", preamble)
		}
		_, _ = connection.Write([]byte("ready"))
		_ = connection.Close()
	}
}
