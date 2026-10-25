package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"syscall"
	"time"
)

func connectExistingKernel(paths kernelPaths, uid int) (net.Conn, string, bool, error) {
	info, err := os.Lstat(paths.socket)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, "", false, nil
		}
		return nil, "", false, newAttachError(exitUnsafeKernelPath, "cannot inspect kernel socket", err)
	}
	if err := validateKernelSocket(info, uid); err != nil {
		return nil, "", false, err
	}
	connection, err := net.DialTimeout("unix", paths.socket, 250*time.Millisecond)
	if err != nil {
		return nil, "", false, nil
	}
	token, err := readTokenFile(paths.token, uid)
	if err != nil {
		_ = connection.Close()
		return nil, "", false, err
	}
	return connection, token, true, nil
}

func validateKernelSocket(info os.FileInfo, uid int) error {
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm()&0o077 != 0 {
		return newAttachError(exitUnsafeKernelPath, "unsafe kernel socket", nil)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return newAttachError(exitUnsafeKernelPath, "kernel socket is owned by another user", nil)
	}
	return nil
}

func removeStaleSocket(path string, uid int) error {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return newAttachError(exitUnsafeKernelPath, "cannot inspect stale kernel socket", err)
	}
	if err := validateKernelSocket(info, uid); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return newAttachError(exitKernelStartFailure, "cannot remove stale kernel socket", err)
	}
	return nil
}

type attachPreamble struct {
	PhiKernelAttach int    `json:"phiKernelAttach"`
	Token           string `json:"token"`
}

type bridgeResult struct {
	written int64
	err     error
}

func bridgeKernel(connection net.Conn, token string, input io.Reader, output io.Writer) error {
	preamble, err := json.Marshal(attachPreamble{PhiKernelAttach: 1, Token: token})
	if err != nil {
		return err
	}
	preamble = append(preamble, '\n')
	if _, err := io.Copy(connection, bytes.NewReader(preamble)); err != nil {
		_ = connection.Close()
		return newAttachError(exitTokenMismatch, "kernel rejected attach token", err)
	}

	fromKernel := make(chan bridgeResult, 1)
	toKernel := make(chan bridgeResult, 1)
	go func() {
		written, copyErr := io.Copy(output, connection)
		fromKernel <- bridgeResult{written: written, err: copyErr}
	}()
	go func() {
		written, copyErr := io.Copy(connection, input)
		toKernel <- bridgeResult{written: written, err: copyErr}
	}()

	select {
	case result := <-fromKernel:
		_ = connection.Close()
		if result.written == 0 {
			return newAttachError(exitTokenMismatch, "kernel rejected attach token", result.err)
		}
		return result.err
	case result := <-toKernel:
		_ = connection.Close()
		return result.err
	}
}
