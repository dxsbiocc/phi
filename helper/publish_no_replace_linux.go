//go:build linux

package main

import (
	"errors"
	"syscall"
	"unsafe"
)

const renameNoReplace = 1

func publishNoReplace(source, destination string) error {
	sourcePointer, err := syscall.BytePtrFromString(source)
	if err != nil {
		return err
	}
	destinationPointer, err := syscall.BytePtrFromString(destination)
	if err != nil {
		return err
	}
	atCurrentWorkingDirectory := -100
	_, _, callError := syscall.Syscall6(
		renameat2SystemCall,
		uintptr(atCurrentWorkingDirectory),
		uintptr(unsafe.Pointer(sourcePointer)),
		uintptr(atCurrentWorkingDirectory),
		uintptr(unsafe.Pointer(destinationPointer)),
		renameNoReplace,
		0,
	)
	if callError == 0 {
		return nil
	}
	if !errors.Is(callError, syscall.ENOSYS) && !errors.Is(callError, syscall.EINVAL) &&
		!errors.Is(callError, syscall.EOPNOTSUPP) {
		return callError
	}
	return linkNoReplace(source, destination)
}
