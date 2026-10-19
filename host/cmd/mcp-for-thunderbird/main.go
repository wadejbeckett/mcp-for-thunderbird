// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command mcp-for-thunderbird is the local host for MCP for Thunderbird.
package main

import (
	"fmt"
	"io"
	"os"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}

// run dispatches on args and returns the process exit code.
func run(args []string, out io.Writer) int {
	if len(args) == 1 && args[0] == "version" {
		fmt.Fprintf(out, "mcp-for-thunderbird %s\n", Version)
		return 0
	}
	fmt.Fprintln(os.Stderr, "usage: mcp-for-thunderbird version")
	return 2
}
