package main

import "fmt"

type domainError struct {
	code    string
	message string
}

func (err *domainError) Error() string { return err.message }

func newDomainError(code, format string, args ...any) error {
	return &domainError{code: code, message: fmt.Sprintf(format, args...)}
}

func invalidArgument(format string, args ...any) error {
	return newDomainError("INVALID_ARGUMENT", format, args...)
}

func outsideRoot() error {
	return newDomainError("PATH_OUTSIDE_ROOT", "path is outside the workspace root")
}
