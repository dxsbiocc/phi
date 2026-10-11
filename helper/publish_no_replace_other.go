//go:build !linux

package main

func publishNoReplace(source, destination string) error {
	return linkNoReplace(source, destination)
}
