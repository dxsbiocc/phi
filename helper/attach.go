package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	exitKernelStartFailure = 70
	exitUnsafeKernelPath   = 71
	exitTokenMismatch      = 72

	maxKernelLogBytes = 1024 * 1024
)

type attachError struct {
	exitCode int
	message  string
	cause    error
}

func (err *attachError) Error() string {
	if err.cause == nil {
		return "phi-helper attach: " + err.message
	}
	return fmt.Sprintf("phi-helper attach: %s: %v", err.message, err.cause)
}

func (err *attachError) Unwrap() error { return err.cause }

func newAttachError(exitCode int, message string, cause error) error {
	return &attachError{exitCode: exitCode, message: message, cause: cause}
}

type kernelPaths struct {
	directory string
	socket    string
	token     string
	lock      string
	log       string
}

type spawnedKernel struct {
	pid    int
	exited <-chan error
}

type attachDependencies struct {
	uid            int
	startupTimeout time.Duration
	retryDelay     time.Duration
	connect        func(kernelPaths, int) (net.Conn, string, bool, error)
	spawn          func(attachOptions, kernelPaths) (spawnedKernel, error)
}

type attachOptions struct {
	kernel        string
	runtimeRoot   string
	kernelVersion string
	graceMs       *int
	environment   []string
}

type repeatedStringFlag []string

func (values *repeatedStringFlag) String() string { return strings.Join(*values, ",") }

func (values *repeatedStringFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type optionalPositiveIntFlag struct {
	value int
	set   bool
}

func (value *optionalPositiveIntFlag) String() string {
	if !value.set {
		return ""
	}
	return strconv.Itoa(value.value)
}

func (value *optionalPositiveIntFlag) Set(raw string) error {
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fmt.Errorf("must be a positive integer")
	}
	value.value = parsed
	value.set = true
	return nil
}

func parseAttachOptions(args []string, errorOutput io.Writer) (attachOptions, error) {
	flags := flag.NewFlagSet("attach", flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	var options attachOptions
	var environment repeatedStringFlag
	var graceMs optionalPositiveIntFlag
	flags.StringVar(&options.kernel, "kernel", "", "absolute kernel executable path")
	flags.StringVar(&options.runtimeRoot, "runtime-root", "", "absolute Phi runtime root")
	flags.StringVar(&options.kernelVersion, "kernel-version", "", "kernel version")
	flags.Var(&graceMs, "grace-ms", "kernel disconnect grace period in milliseconds")
	flags.Var(&environment, "env", "explicit kernel environment entry KEY=VALUE (repeatable)")
	if err := flags.Parse(args); err != nil {
		return attachOptions{}, invalidArgument("invalid attach arguments: %v", err)
	}
	if flags.NArg() != 0 || !filepath.IsAbs(options.kernel) || !filepath.IsAbs(options.runtimeRoot) ||
		strings.ContainsRune(options.kernel, '\x00') || strings.ContainsRune(options.runtimeRoot, '\x00') ||
		options.kernelVersion == "" || strings.ContainsRune(options.kernelVersion, '\x00') {
		return attachOptions{}, invalidArgument(
			"attach requires absolute --kernel and --runtime-root paths and a non-empty --kernel-version",
		)
	}
	seenEnvironment := make(map[string]struct{}, len(environment))
	for _, entry := range environment {
		separator := strings.IndexByte(entry, '=')
		if separator <= 0 || !validEnvironmentName(entry[:separator]) ||
			strings.ContainsAny(entry[separator+1:], "\x00\r\n") {
			return attachOptions{}, invalidArgument("--env must use a valid KEY=VALUE entry")
		}
		name := entry[:separator]
		if _, duplicate := seenEnvironment[name]; duplicate {
			return attachOptions{}, invalidArgument("--env contains duplicate key %s", name)
		}
		seenEnvironment[name] = struct{}{}
	}
	options.environment = append([]string(nil), environment...)
	if graceMs.set {
		options.graceMs = &graceMs.value
	}
	return options, nil
}

func validEnvironmentName(name string) bool {
	if name == "" || !isEnvironmentNameStart(name[0]) {
		return false
	}
	for index := 1; index < len(name); index++ {
		character := name[index]
		if !isEnvironmentNameStart(character) && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}

func isEnvironmentNameStart(character byte) bool {
	return character == '_' || character >= 'A' && character <= 'Z' ||
		character >= 'a' && character <= 'z'
}

func deriveKernelPaths(runtimeRoot, kernelVersion string, uid int) (kernelPaths, error) {
	if !filepath.IsAbs(runtimeRoot) {
		return kernelPaths{}, invalidArgument("runtime root must be absolute")
	}
	if kernelVersion == "" {
		return kernelPaths{}, invalidArgument("kernel version is required")
	}
	digest := sha256.Sum256([]byte(runtimeRoot + "\x00" + kernelVersion))
	stem := hex.EncodeToString(digest[:])[:16]
	directory := filepath.Join("/tmp", fmt.Sprintf("phi-k-%d", uid))
	return kernelPaths{
		directory: directory,
		socket:    filepath.Join(directory, stem+".sock"),
		token:     filepath.Join(directory, stem+".token"),
		lock:      filepath.Join(directory, stem+".lock"),
		log:       filepath.Join(directory, stem+".log"),
	}, nil
}

func ensureKernelDirectory(directory string, uid int) error {
	if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
		return newAttachError(exitUnsafeKernelPath, "cannot create private kernel directory", err)
	}
	return validateKernelDirectory(directory, uid)
}

func validateKernelDirectory(directory string, uid int) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return newAttachError(exitUnsafeKernelPath, "cannot inspect private kernel directory", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return newAttachError(exitUnsafeKernelPath, "unsafe kernel directory (must be a real directory)", nil)
	}
	if info.Mode().Perm() != 0o700 {
		return newAttachError(
			exitUnsafeKernelPath,
			fmt.Sprintf("unsafe kernel directory mode %04o (want 0700)", info.Mode().Perm()),
			nil,
		)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return newAttachError(exitUnsafeKernelPath, "unsafe kernel directory owner", nil)
	}
	return nil
}

func replaceTokenFile(path string, uid int) (string, error) {
	if info, err := os.Lstat(path); err == nil {
		if err := validatePrivateFile(info, uid, 0o600, "token file"); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", newAttachError(exitUnsafeKernelPath, "cannot inspect token file", err)
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot generate attach token", err)
	}
	token := hex.EncodeToString(random)
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot create attach token", err)
	}
	temporary := file.Name()
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot secure attach token", err)
	}
	if _, err := io.WriteString(file, token+"\n"); err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot write attach token", err)
	}
	if err := file.Sync(); err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot sync attach token", err)
	}
	if err := file.Close(); err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot close attach token", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return "", newAttachError(exitKernelStartFailure, "cannot publish attach token", err)
	}
	removeTemporary = false
	return token, nil
}

func readTokenFile(path string, uid int) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", newAttachError(exitTokenMismatch, "attach token is missing", err)
		}
		return "", newAttachError(exitUnsafeKernelPath, "cannot inspect token file", err)
	}
	if err := validatePrivateFile(info, uid, 0o600, "token file"); err != nil {
		return "", err
	}
	if info.Size() != 64 && info.Size() != 65 {
		return "", newAttachError(exitTokenMismatch, "attach token is malformed", nil)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", newAttachError(exitTokenMismatch, "cannot read attach token", err)
	}
	token := strings.TrimSuffix(string(content), "\n")
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return "", newAttachError(exitTokenMismatch, "attach token is malformed", err)
	}
	return token, nil
}

func validatePrivateFile(info os.FileInfo, uid int, mode os.FileMode, description string) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != mode {
		return newAttachError(exitUnsafeKernelPath, "unsafe "+description, nil)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return newAttachError(exitUnsafeKernelPath, "unsafe "+description+" owner", nil)
	}
	return nil
}

type lockedKernelFile struct {
	file *os.File
}

func acquireKernelLock(path string, uid int, timeout time.Duration) (*lockedKernelFile, error) {
	flags := syscall.O_RDWR | syscall.O_CLOEXEC | syscall.O_NOFOLLOW
	fileDescriptor, err := syscall.Open(path, flags|syscall.O_CREAT|syscall.O_EXCL, 0o600)
	created := err == nil
	if errors.Is(err, syscall.EEXIST) {
		fileDescriptor, err = syscall.Open(path, flags, 0)
	}
	if err != nil {
		return nil, newAttachError(exitUnsafeKernelPath, "cannot open kernel lock", err)
	}
	file := os.NewFile(uintptr(fileDescriptor), path)
	if created {
		if err := file.Chmod(0o600); err != nil {
			_ = file.Close()
			return nil, newAttachError(exitUnsafeKernelPath, "cannot secure kernel lock", err)
		}
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, newAttachError(exitUnsafeKernelPath, "cannot inspect kernel lock", err)
	}
	if err := validatePrivateFile(info, uid, 0o600, "kernel lock"); err != nil {
		_ = file.Close()
		return nil, err
	}

	deadline := time.Now().Add(timeout)
	for {
		err = syscall.Flock(fileDescriptor, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return &lockedKernelFile{file: file}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = file.Close()
			return nil, newAttachError(exitKernelStartFailure, "cannot lock kernel startup", err)
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, newAttachError(exitKernelStartFailure, "timed out waiting for kernel startup lock", nil)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (lock *lockedKernelFile) release() {
	if lock == nil || lock.file == nil {
		return
	}
	_ = syscall.Flock(int(lock.file.Fd()), syscall.LOCK_UN)
	_ = lock.file.Close()
	lock.file = nil
}

func attachKernel(
	options attachOptions,
	input io.Reader,
	output, errorOutput io.Writer,
	dependencies attachDependencies,
) error {
	paths, err := deriveKernelPaths(options.runtimeRoot, options.kernelVersion, dependencies.uid)
	if err != nil {
		return err
	}
	if err := ensureKernelDirectory(paths.directory, dependencies.uid); err != nil {
		return err
	}
	connection, token, found, err := dependencies.connect(paths, dependencies.uid)
	if err != nil {
		return err
	}
	if found {
		if err := writeAttachStatus(errorOutput, "attached", 0); err != nil {
			_ = connection.Close()
			return err
		}
		return bridgeKernel(connection, token, input, output)
	}

	startupTimeout := dependencies.startupTimeout
	if startupTimeout <= 0 {
		startupTimeout = 30 * time.Second
	}
	retryDelay := dependencies.retryDelay
	if retryDelay <= 0 {
		retryDelay = 50 * time.Millisecond
	}
	lock, err := acquireKernelLock(paths.lock, dependencies.uid, startupTimeout+time.Second)
	if err != nil {
		return err
	}
	defer func() { lock.release() }()

	connection, token, found, err = dependencies.connect(paths, dependencies.uid)
	if err != nil {
		return err
	}
	if found {
		lock.release()
		if err := writeAttachStatus(errorOutput, "attached", 0); err != nil {
			_ = connection.Close()
			return err
		}
		return bridgeKernel(connection, token, input, output)
	}
	if err := removeStaleSocket(paths.socket, dependencies.uid); err != nil {
		return err
	}
	token, err = replaceTokenFile(paths.token, dependencies.uid)
	if err != nil {
		return err
	}
	process, err := dependencies.spawn(options, paths)
	if err != nil {
		return kernelStartFailure(paths.log, "kernel failed to start", err)
	}

	deadline := time.NewTimer(startupTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(retryDelay)
	defer ticker.Stop()
	for {
		connection, token, found, err = dependencies.connect(paths, dependencies.uid)
		if err != nil {
			return err
		}
		if found {
			lock.release()
			if err := writeAttachStatus(errorOutput, "spawned", process.pid); err != nil {
				_ = connection.Close()
				return err
			}
			return bridgeKernel(connection, token, input, output)
		}
		select {
		case processErr := <-process.exited:
			return kernelStartFailure(paths.log, "kernel exited before its socket was ready", processErr)
		case <-deadline.C:
			return kernelStartFailure(paths.log, "kernel socket did not become ready within the startup timeout", nil)
		case <-ticker.C:
		}
	}
}

func attachCLI(args []string, input io.Reader, output, errorOutput io.Writer) error {
	options, err := parseAttachOptions(args, errorOutput)
	if err != nil {
		return err
	}
	return attachKernel(options, input, output, errorOutput, defaultAttachDependencies())
}

func defaultAttachDependencies() attachDependencies {
	return attachDependencies{
		uid:            os.Getuid(),
		startupTimeout: 30 * time.Second,
		retryDelay:     50 * time.Millisecond,
		connect:        connectExistingKernel,
		spawn:          spawnKernelProcess,
	}
}

func writeAttachStatus(output io.Writer, state string, pid int) error {
	status := struct {
		State string `json:"state"`
		PID   int    `json:"pid,omitempty"`
	}{State: state, PID: pid}
	encoded, err := json.Marshal(status)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "PHI_HELPER_ATTACH_STATUS=%s\n", encoded)
	return err
}

func kernelStartFailure(logPath, message string, cause error) error {
	tail := readKernelLogTail(logPath, 8*1024)
	if tail != "" {
		message += "\nkernel log tail:\n" + tail
	}
	return newAttachError(exitKernelStartFailure, message, cause)
}

func readKernelLogTail(path string, limit int64) string {
	fileDescriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return ""
	}
	file := os.NewFile(uintptr(fileDescriptor), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	start := info.Size() - limit
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	content, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(content))
}
