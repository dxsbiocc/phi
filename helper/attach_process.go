package main

import (
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

func spawnKernelProcess(options attachOptions, paths kernelPaths) (spawnedKernel, error) {
	if err := prepareKernelLog(paths.log, os.Getuid()); err != nil {
		return spawnedKernel{}, err
	}
	logReader, logWriter, err := os.Pipe()
	if err != nil {
		return spawnedKernel{}, err
	}
	closePipes := func() {
		_ = logReader.Close()
		_ = logWriter.Close()
	}
	helperExecutable, err := os.Executable()
	if err != nil {
		closePipes()
		return spawnedKernel{}, err
	}
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		closePipes()
		return spawnedKernel{}, err
	}
	defer devNull.Close()

	logSink := exec.Command(helperExecutable, "internal-log-sink", "--path", paths.log)
	logSink.Env = []string{}
	logSink.Stdin = logReader
	logSink.Stdout = devNull
	logSink.Stderr = devNull
	logSink.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := logSink.Start(); err != nil {
		closePipes()
		return spawnedKernel{}, err
	}
	_ = logReader.Close()
	_ = logSink.Process.Release()

	kernel := newDetachedKernelCommand(helperExecutable, options, paths, devNull, logWriter)
	if err := kernel.Start(); err != nil {
		_ = logWriter.Close()
		return spawnedKernel{}, err
	}
	_ = logWriter.Close()
	exited := make(chan error, 1)
	go func() { exited <- kernel.Wait() }()
	return spawnedKernel{pid: kernel.Process.Pid, exited: exited}, nil
}

func newDetachedKernelCommand(
	helperExecutable string,
	options attachOptions,
	paths kernelPaths,
	input io.Reader,
	logs io.Writer,
) *exec.Cmd {
	kernelArgs := []string{
		"internal-exec-kernel", options.kernel,
		"--listen", paths.socket,
		"--token-file", paths.token,
	}
	if options.graceMs != nil {
		kernelArgs = append(kernelArgs, "--grace-ms", strconv.Itoa(*options.graceMs))
	}
	kernel := exec.Command(helperExecutable, kernelArgs...)
	kernel.Env = append([]string(nil), options.environment...)
	kernel.Stdin = input
	kernel.Stdout = logs
	kernel.Stderr = logs
	kernel.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return kernel
}

func prepareKernelLog(path string, uid int) error {
	flags := syscall.O_WRONLY | syscall.O_CLOEXEC | syscall.O_NOFOLLOW
	created := false
	info, inspectErr := os.Lstat(path)
	var fileDescriptor int
	var err error
	if os.IsNotExist(inspectErr) {
		fileDescriptor, err = syscall.Open(path, flags|syscall.O_CREAT|syscall.O_EXCL, 0o600)
		created = err == nil
	} else if inspectErr != nil {
		return newAttachError(exitUnsafeKernelPath, "cannot inspect kernel log", inspectErr)
	} else {
		if err := validatePrivateFile(info, uid, 0o600, "kernel log"); err != nil {
			return err
		}
		fileDescriptor, err = syscall.Open(path, flags|syscall.O_TRUNC, 0)
	}
	if err != nil {
		return newAttachError(exitUnsafeKernelPath, "cannot open kernel log", err)
	}
	file := os.NewFile(uintptr(fileDescriptor), path)
	defer file.Close()
	if created {
		if err := file.Chmod(0o600); err != nil {
			return newAttachError(exitUnsafeKernelPath, "cannot secure kernel log", err)
		}
	}
	info, err = file.Stat()
	if err != nil {
		return newAttachError(exitUnsafeKernelPath, "cannot inspect kernel log", err)
	}
	return validatePrivateFile(info, uid, 0o600, "kernel log")
}

func logSinkCLI(args []string, input io.Reader, errorOutput io.Writer) error {
	flags := flag.NewFlagSet("internal-log-sink", flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	path := flags.String("path", "", "kernel log path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !filepath.IsAbs(*path) || flags.NArg() != 0 {
		return invalidArgument("internal-log-sink requires exactly one absolute --path")
	}
	fileDescriptor, err := syscall.Open(
		*path,
		syscall.O_WRONLY|syscall.O_TRUNC|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fileDescriptor), *path)
	defer file.Close()
	if _, err := io.Copy(file, io.LimitReader(input, maxKernelLogBytes)); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, input)
	return err
}

func internalKernelExecCLI(args []string) error {
	if len(args) < 1 || !filepath.IsAbs(args[0]) {
		return invalidArgument("internal-exec-kernel requires an absolute executable")
	}
	syscall.Umask(0o077)
	return syscall.Exec(args[0], args, os.Environ())
}
