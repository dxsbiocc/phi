package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultMaxOutput  = 8 * 1024 * 1024
	maxCapturedOutput = 8 * 1024 * 1024
	killGracePeriod   = 500 * time.Millisecond
	maxTimeoutMs      = (1<<63 - 1) / int64(time.Millisecond)
)

type runParams struct {
	Command        []string          `json:"command"`
	Cwd            string            `json:"cwd"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutMs      *int              `json:"timeoutMs,omitempty"`
	MaxOutputBytes *int              `json:"maxOutputBytes,omitempty"`
}

type commandResult struct {
	Stdout            string  `json:"stdout"`
	Stderr            string  `json:"stderr"`
	Code              *int    `json:"code"`
	Signal            *string `json:"signal"`
	Truncated         bool    `json:"truncated"`
	StdoutTruncated   bool    `json:"stdoutTruncated"`
	StderrTruncated   bool    `json:"stderrTruncated"`
	TerminationReason string  `json:"terminationReason,omitempty"`
}

type outputCapture struct {
	mu              sync.Mutex
	stdout          bytes.Buffer
	stderr          bytes.Buffer
	remaining       int
	stdoutTruncated bool
	stderrTruncated bool
}

type captureWriter struct {
	capture *outputCapture
	stream  string
}

func newOutputCapture(limit int) *outputCapture {
	return &outputCapture{remaining: limit}
}

func (writer captureWriter) Write(content []byte) (int, error) {
	written := len(content)
	writer.capture.mu.Lock()
	defer writer.capture.mu.Unlock()
	keep := min(len(content), writer.capture.remaining)
	if keep > 0 {
		if writer.stream == "stdout" {
			_, _ = writer.capture.stdout.Write(content[:keep])
		} else {
			_, _ = writer.capture.stderr.Write(content[:keep])
		}
		writer.capture.remaining -= keep
	}
	if keep < len(content) {
		if writer.stream == "stdout" {
			writer.capture.stdoutTruncated = true
		} else {
			writer.capture.stderrTruncated = true
		}
	}
	return written, nil
}

func (capture *outputCapture) result() commandResult {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return commandResult{
		Stdout: capture.stdout.String(), Stderr: capture.stderr.String(),
		Truncated:       capture.stdoutTruncated || capture.stderrTruncated,
		StdoutTruncated: capture.stdoutTruncated, StderrTruncated: capture.stderrTruncated,
	}
}

type managedProcess struct {
	cmd             *exec.Cmd
	capture         *outputCapture
	done            chan struct{}
	terminationDone chan struct{}
	terminationOnce sync.Once
	mu              sync.Mutex
	result          commandResult
	waitErr         error
	reason          string
	terminating     bool
}

type processRunner struct {
	guard *pathGuard
}

func newProcessRunner(guard *pathGuard) *processRunner {
	return &processRunner{guard: guard}
}

func (runner *processRunner) start(params runParams) (*managedProcess, error) {
	limit, err := validateRunParams(params)
	if err != nil {
		return nil, err
	}
	cwd, err := runner.guard.existing(params.Cwd)
	if err != nil {
		return nil, err
	}
	command := exec.Command(params.Command[0], params.Command[1:]...)
	command.Dir = cwd
	command.Env = mergedEnvironment(params.Env)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	capture := newOutputCapture(limit)
	command.Stdout = captureWriter{capture: capture, stream: "stdout"}
	command.Stderr = captureWriter{capture: capture, stream: "stderr"}
	command.Stdin = nil
	if err := command.Start(); err != nil {
		return nil, err
	}
	process := &managedProcess{
		cmd: command, capture: capture, done: make(chan struct{}), terminationDone: make(chan struct{}),
	}
	go process.wait()
	return process, nil
}

func validateRunParams(params runParams) (int, error) {
	if len(params.Command) == 0 || params.Command[0] == "" || params.Cwd == "" {
		return 0, invalidArgument("command and cwd are required")
	}
	limit := defaultMaxOutput
	if params.MaxOutputBytes != nil {
		limit = *params.MaxOutputBytes
	}
	if limit < 0 || limit > maxCapturedOutput {
		return 0, invalidArgument(
			"maxOutputBytes must be between 0 and %d", maxCapturedOutput,
		)
	}
	if params.TimeoutMs != nil && (*params.TimeoutMs <= 0 || int64(*params.TimeoutMs) > maxTimeoutMs) {
		return 0, invalidArgument("timeoutMs must be between 1 and %d", maxTimeoutMs)
	}
	return limit, nil
}

func mergedEnvironment(overrides map[string]string) []string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			values[entry[:index]] = entry[index+1:]
		}
	}
	for name, value := range overrides {
		values[name] = value
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	environment := make([]string, 0, len(names))
	for _, name := range names {
		environment = append(environment, name+"="+values[name])
	}
	return environment
}

func (process *managedProcess) wait() {
	err := process.cmd.Wait()
	result := process.capture.result()
	status, ok := process.cmd.ProcessState.Sys().(syscall.WaitStatus)
	if ok && status.Signaled() {
		signal := signalName(status.Signal())
		result.Signal = &signal
	} else if process.cmd.ProcessState != nil {
		code := process.cmd.ProcessState.ExitCode()
		result.Code = &code
	}
	process.mu.Lock()
	result.TerminationReason = process.reason
	process.result = result
	process.waitErr = err
	process.mu.Unlock()
	close(process.done)
}

func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	default:
		return fmt.Sprintf("SIG%d", signal)
	}
}

func (process *managedProcess) terminate(reason string) {
	process.terminationOnce.Do(func() {
		process.mu.Lock()
		process.reason = reason
		process.terminating = true
		process.mu.Unlock()
		signalProcessGroup(process.cmd.Process.Pid, syscall.SIGTERM)
		go func() {
			timer := time.NewTimer(killGracePeriod)
			defer timer.Stop()
			<-timer.C
			signalProcessGroup(process.cmd.Process.Pid, syscall.SIGKILL)
			close(process.terminationDone)
		}()
	})
}

func signalProcessGroup(pid int, signal syscall.Signal) {
	if err := syscall.Kill(-pid, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		_ = syscall.Kill(pid, signal)
	}
}

func (process *managedProcess) await() (commandResult, error) {
	<-process.done
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.waitErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(process.waitErr, &exitErr) {
			return commandResult{}, process.waitErr
		}
	}
	return process.result, nil
}

func (process *managedProcess) awaitTermination() {
	process.mu.Lock()
	terminating := process.terminating
	process.mu.Unlock()
	if terminating {
		<-process.terminationDone
	}
}

func (process *managedProcess) query() (commandResult, bool) {
	select {
	case <-process.done:
		result, _ := process.await()
		return result, false
	default:
		return commandResult{}, true
	}
}

func (runner *processRunner) run(ctx context.Context, params runParams) (commandResult, error) {
	process, err := runner.start(params)
	if err != nil {
		return commandResult{}, err
	}
	var timeout <-chan time.Time
	var timer *time.Timer
	if params.TimeoutMs != nil {
		timer = time.NewTimer(time.Duration(*params.TimeoutMs) * time.Millisecond)
		timeout = timer.C
		defer timer.Stop()
	}
	select {
	case <-process.done:
	case <-ctx.Done():
		process.terminate("cancelled")
	case <-timeout:
		process.terminate("timeout")
	}
	result, err := process.await()
	process.awaitTermination()
	return result, err
}
