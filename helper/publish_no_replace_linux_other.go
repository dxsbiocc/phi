//go:build linux && !amd64 && !arm64

package main

const renameat2SystemCall = ^uintptr(0)
