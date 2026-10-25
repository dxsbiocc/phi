package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestKernelPathsMatchSharedGoldenVectors(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "tests", "fixtures", "kernel-lifecycle-paths.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		RuntimeRoot   string `json:"runtimeRoot"`
		KernelVersion string `json:"kernelVersion"`
		Stem          string `json:"stem"`
	}
	if err := json.Unmarshal(content, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		t.Run(vector.Stem, func(t *testing.T) {
			paths, err := deriveKernelPaths(vector.RuntimeRoot, vector.KernelVersion, 501)
			if err != nil {
				t.Fatal(err)
			}
			root := filepath.Join("/tmp", "phi-k-501")
			if paths.directory != root || paths.socket != filepath.Join(root, vector.Stem+".sock") ||
				paths.token != filepath.Join(root, vector.Stem+".token") ||
				paths.lock != filepath.Join(root, vector.Stem+".lock") {
				t.Fatalf("derived paths = %+v", paths)
			}
		})
	}
}

func TestKernelDirectoryRejectsUnsafeOwnershipModeAndSymlinks(t *testing.T) {
	uid := os.Getuid()
	t.Run("creates private directory", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "kernel")
		if err := ensureKernelDirectory(directory, uid); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("mode = %o, want 700", info.Mode().Perm())
		}
	})

	t.Run("wrong mode", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "kernel")
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		assertAttachExitCode(t, ensureKernelDirectory(directory, uid), exitUnsafeKernelPath)
	})

	t.Run("wrong owner", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "kernel")
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		assertAttachExitCode(t, validateKernelDirectory(directory, uid+1), exitUnsafeKernelPath)
	})

	t.Run("symlink", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target")
		if err := os.Mkdir(target, 0o700); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(root, "kernel")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		assertAttachExitCode(t, ensureKernelDirectory(link, uid), exitUnsafeKernelPath)
	})
}

func assertAttachExitCode(t *testing.T, err error, code int) {
	t.Helper()
	if err == nil {
		t.Fatal("expected error")
	}
	var attachErr *attachError
	if !errors.As(err, &attachErr) || attachErr.exitCode != code {
		t.Fatalf("error = %T %v, want attach exit code %d", err, err, code)
	}
}

func TestBridgeWritesPreambleAndCopiesBytesBothWays(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()

	serverDone := make(chan error, 1)
	go func() {
		defer serverConnection.Close()
		reader := bufio.NewReader(serverConnection)
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			serverDone <- readErr
			return
		}
		if line != "{\"phiKernelAttach\":1,\"token\":\""+strings.Repeat("a", 64)+"\"}\n" {
			serverDone <- errors.New("unexpected preamble: " + line)
			return
		}
		payload := make([]byte, len("client bytes\x00\xff"))
		if _, readErr := io.ReadFull(reader, payload); readErr != nil {
			serverDone <- readErr
			return
		}
		if string(payload) != "client bytes\x00\xff" {
			serverDone <- errors.New("unexpected client payload")
			return
		}
		_, writeErr := serverConnection.Write([]byte("kernel bytes\x00\xfe"))
		serverDone <- writeErr
	}()

	inputReader, inputWriter := io.Pipe()
	var output strings.Builder
	bridgeDone := make(chan error, 1)
	go func() {
		bridgeDone <- bridgeKernel(clientConnection, strings.Repeat("a", 64), inputReader, &output)
	}()
	if _, err := inputWriter.Write([]byte("client bytes\x00\xff")); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-bridgeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not close when the kernel side closed")
	}
	_ = inputWriter.Close()
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if output.String() != "kernel bytes\x00\xfe" {
		t.Fatalf("output = %q", output.String())
	}
}

func TestBridgeReportsTokenMismatchWhenPreambleIsRejected(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()
	go func() {
		reader := bufio.NewReader(serverConnection)
		_, _ = reader.ReadString('\n')
		_ = serverConnection.Close()
	}()

	inputReader, inputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- bridgeKernel(clientConnection, strings.Repeat("b", 64), inputReader, io.Discard)
	}()
	select {
	case err := <-done:
		assertAttachExitCode(t, err, exitTokenMismatch)
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not notice rejected preamble")
	}
	_ = inputWriter.Close()
}

func TestParseAttachOptionsAcceptsOnlyExplicitValidatedInputs(t *testing.T) {
	options, err := parseAttachOptions([]string{
		"--kernel", "/opt/phi/kernel",
		"--runtime-root", "/srv/phi runtime",
		"--kernel-version", "1.2.3",
		"--grace-ms", "4500",
		"--env", "PATH=/usr/bin",
		"--env", "TOKEN=value=with=equals",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if options.kernel != "/opt/phi/kernel" || options.runtimeRoot != "/srv/phi runtime" ||
		options.kernelVersion != "1.2.3" || options.graceMs == nil || *options.graceMs != 4500 {
		t.Fatalf("options = %+v", options)
	}
	if strings.Join(options.environment, "|") != "PATH=/usr/bin|TOKEN=value=with=equals" {
		t.Fatalf("environment = %q", options.environment)
	}

	for _, args := range [][]string{
		{"--kernel", "relative", "--runtime-root", "/runtime", "--kernel-version", "1"},
		{"--kernel", "/kernel\x00bad", "--runtime-root", "/runtime", "--kernel-version", "1"},
		{"--kernel", "/kernel", "--runtime-root", "relative", "--kernel-version", "1"},
		{"--kernel", "/kernel", "--runtime-root", "/runtime\x00bad", "--kernel-version", "1"},
		{"--kernel", "/kernel", "--runtime-root", "/runtime", "--kernel-version", ""},
		{"--kernel", "/kernel", "--runtime-root", "/runtime", "--kernel-version", "1", "--grace-ms", "0"},
		{"--kernel", "/kernel", "--runtime-root", "/runtime", "--kernel-version", "1", "--env", "BROKEN"},
		{"--kernel", "/kernel", "--runtime-root", "/runtime", "--kernel-version", "1", "--env", "A-B=value"},
		{"--kernel", "/kernel", "--runtime-root", "/runtime", "--kernel-version", "1", "--env", "A=one", "--env", "A=two"},
	} {
		if _, err := parseAttachOptions(args, io.Discard); err == nil {
			t.Fatalf("parseAttachOptions(%q) succeeded", args)
		}
	}
}

func TestTokenFileIsPrivateAndMalformedTokensAreDistinct(t *testing.T) {
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "kernel.token")
	token, err := replaceTokenFile(tokenPath, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 64 {
		t.Fatalf("token length = %d", len(token))
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode = %o, want 600", info.Mode().Perm())
	}
	read, err := readTokenFile(tokenPath, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	if read != token {
		t.Fatalf("read token = %q, want %q", read, token)
	}

	if err := os.WriteFile(tokenPath, []byte("not-a-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = readTokenFile(tokenPath, os.Getuid())
	assertAttachExitCode(t, err, exitTokenMismatch)
}

func TestConcurrentAttachInvocationsSpawnKernelOnce(t *testing.T) {
	options := attachOptions{
		kernel: "/fake/kernel", runtimeRoot: filepath.Join("/runtime", t.Name()), kernelVersion: "1.0.0",
	}
	paths, err := deriveKernelPaths(options.runtimeRoot, options.kernelVersion, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{paths.socket, paths.token, paths.lock, paths.log} {
		_ = os.Remove(path)
		t.Cleanup(func() { _ = os.Remove(path) })
	}

	var ready atomic.Bool
	var spawnCount atomic.Int32
	neverExited := make(chan error)
	dependencies := attachDependencies{
		uid:            os.Getuid(),
		startupTimeout: 2 * time.Second,
		retryDelay:     time.Millisecond,
		connect: func(paths kernelPaths, uid int) (net.Conn, string, bool, error) {
			if !ready.Load() {
				return nil, "", false, nil
			}
			token, err := readTokenFile(paths.token, uid)
			if err != nil {
				return nil, "", false, err
			}
			client, server := net.Pipe()
			go func() {
				reader := bufio.NewReader(server)
				_, _ = reader.ReadString('\n')
				_, _ = server.Write([]byte("ready"))
				_ = server.Close()
			}()
			return client, token, true, nil
		},
		spawn: func(attachOptions, kernelPaths) (spawnedKernel, error) {
			spawnCount.Add(1)
			ready.Store(true)
			return spawnedKernel{pid: 4242, exited: neverExited}, nil
		},
	}

	const invocationCount = 8
	var wait sync.WaitGroup
	wait.Add(invocationCount)
	errorsByInvocation := make(chan error, invocationCount)
	statuses := make(chan string, invocationCount)
	for index := 0; index < invocationCount; index++ {
		go func() {
			defer wait.Done()
			var diagnostics bytes.Buffer
			err := attachKernel(options, strings.NewReader(""), io.Discard, &diagnostics, dependencies)
			errorsByInvocation <- err
			statuses <- diagnostics.String()
		}()
	}
	wait.Wait()
	close(errorsByInvocation)
	close(statuses)
	for err := range errorsByInvocation {
		if err != nil {
			t.Fatal(err)
		}
	}
	if spawnCount.Load() != 1 {
		t.Fatalf("spawn count = %d, want 1", spawnCount.Load())
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
	if spawnedStatuses != 1 || attachedStatuses != invocationCount-1 {
		t.Fatalf("statuses: spawned=%d attached=%d", spawnedStatuses, attachedStatuses)
	}
}

func TestKernelLogSinkCapsOutputAndDrainsTheProducer(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "kernel.log")
	if err := prepareKernelLog(logPath, os.Getuid()); err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte("x"), maxKernelLogBytes+4096)
	if err := logSinkCLI([]string{"--path", logPath}, bytes.NewReader(content), io.Discard); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != maxKernelLogBytes {
		t.Fatalf("log size = %d, want %d", info.Size(), maxKernelLogBytes)
	}
}

func TestKernelStartupFailureIncludesBoundedLogTail(t *testing.T) {
	options := attachOptions{
		kernel: "/fake/kernel", runtimeRoot: filepath.Join("/runtime", t.Name()), kernelVersion: "1.0.0",
	}
	paths, err := deriveKernelPaths(options.runtimeRoot, options.kernelVersion, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{paths.socket, paths.token, paths.lock, paths.log} {
		_ = os.Remove(path)
		t.Cleanup(func() { _ = os.Remove(path) })
	}
	dependencies := attachDependencies{
		uid:            os.Getuid(),
		startupTimeout: time.Second,
		retryDelay:     time.Millisecond,
		connect: func(kernelPaths, int) (net.Conn, string, bool, error) {
			return nil, "", false, nil
		},
		spawn: func(_ attachOptions, paths kernelPaths) (spawnedKernel, error) {
			if err := os.WriteFile(paths.log, []byte("startup diagnostic\n"), 0o600); err != nil {
				return spawnedKernel{}, err
			}
			return spawnedKernel{}, errors.New("exec failed")
		},
	}
	err = attachKernel(options, strings.NewReader(""), io.Discard, io.Discard, dependencies)
	assertAttachExitCode(t, err, exitKernelStartFailure)
	if !strings.Contains(err.Error(), "startup diagnostic") {
		t.Fatalf("startup error omits log tail: %v", err)
	}
}

func TestDetachedKernelCommandUsesOnlyExplicitEnvironmentAndLifecycleArguments(t *testing.T) {
	graceMs := 1234
	options := attachOptions{
		kernel:        "/opt/phi/kernel",
		runtimeRoot:   "/opt/phi/runtime",
		kernelVersion: "1.2.3",
		graceMs:       &graceMs,
		environment:   []string{"PATH=/usr/bin", "HOME=/srv/phi"},
	}
	paths := kernelPaths{socket: "/tmp/phi-k-501/a.sock", token: "/tmp/phi-k-501/a.token"}
	stdin := strings.NewReader("")
	var logs bytes.Buffer
	command := newDetachedKernelCommand("/opt/phi/phi-helper", options, paths, stdin, &logs)
	wantArgs := []string{
		"/opt/phi/phi-helper", "internal-exec-kernel", "/opt/phi/kernel",
		"--listen", paths.socket, "--token-file", paths.token, "--grace-ms", "1234",
	}
	if strings.Join(command.Args, "\x00") != strings.Join(wantArgs, "\x00") {
		t.Fatalf("args = %q, want %q", command.Args, wantArgs)
	}
	if strings.Join(command.Env, "\x00") != "PATH=/usr/bin\x00HOME=/srv/phi" {
		t.Fatalf("environment = %q", command.Env)
	}
	if command.Stdin != stdin || command.Stdout != &logs || command.Stderr != &logs {
		t.Fatal("kernel stdio is not explicitly wired")
	}
	if command.SysProcAttr == nil || !command.SysProcAttr.Setsid {
		t.Fatal("kernel command does not start in a detached session")
	}
}
