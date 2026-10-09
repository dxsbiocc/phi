package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

//go:embed VERSION
var embeddedVersion string

var helperVersion = strings.TrimSpace(embeddedVersion)

func main() {
	if err := runCLI(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runCLI(args []string, input io.Reader, output, errorOutput io.Writer) error {
	if len(args) == 1 && args[0] == "--version" {
		_, err := fmt.Fprintln(output, helperVersion)
		return err
	}
	if len(args) == 1 && args[0] == "--selftest" {
		result := runSelftest()
		if err := json.NewEncoder(output).Encode(result); err != nil {
			return err
		}
		if !result.OK {
			return fmt.Errorf("selftest failed: %s", result.Error)
		}
		return nil
	}
	if len(args) > 0 && args[0] == "serve" {
		return serveCLI(args[1:], input, output, errorOutput)
	}
	return fmt.Errorf("usage: phi-helper [--version|--selftest|serve --root <path>]")
}

func serveCLI(args []string, input io.Reader, output, errorOutput io.Writer) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	root := flags.String("root", "", "workspace root")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || flags.NArg() != 0 {
		return invalidArgument("serve requires exactly one --root path")
	}
	server, err := newRPCServer(*root)
	if err != nil {
		return err
	}
	return server.serve(input, output)
}
