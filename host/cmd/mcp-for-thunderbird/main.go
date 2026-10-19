// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command mcp-for-thunderbird is the local host for MCP for Thunderbird.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/bridge"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/server"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

// AddonID is the add-on Thunderbird names as argv[2] when it starts the
// host for native messaging.
const AddonID = "mcp-for-thunderbird@wadejbeckett.github.io"

// shutdownGrace bounds how long open HTTP streams may hold up exit after
// Thunderbird closes the pipe; the whole stop stays under 2 s.
const shutdownGrace = 500 * time.Millisecond

// logger writes to stderr only: stdout belongs to native-messaging frames.
var logger = log.New(os.Stderr, "mcp-for-thunderbird: ", log.LstdFlags)

func main() {
	if len(os.Args) >= 3 && os.Args[2] == AddonID {
		ignoreSIGPIPE()
		if err := RunNative(os.Stdin, os.Stdout); err != nil {
			logger.Printf("stopped: %v", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
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

var tokenRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// RunNative serves MCP for the add-on that started the host, until the
// add-on closes stdin. It writes nothing to stdout except framed messages.
func RunNative(stdin io.Reader, stdout io.Writer) error {
	server.Version = Version
	b := bridge.New(stdin, stdout, Version)

	// Callbacks are registered before the first read so no message after
	// hello is lost. They run on the bridge reader goroutine (tools, config)
	// or their own goroutine, and never call Bridge.Call.
	var (
		mu       sync.Mutex
		srv      *server.Server
		tools    []string
		attDir   string
		gotTools bool
	)
	b.OnTools(func(t []string) {
		mu.Lock()
		defer mu.Unlock()
		if srv != nil {
			srv.SetTools(t)
			return
		}
		tools, gotTools = t, true
	})
	b.OnConfig(func(dir string) {
		mu.Lock()
		attDir = dir
		mu.Unlock()
	})
	current := func() *server.Server {
		mu.Lock()
		defer mu.Unlock()
		return srv
	}
	b.OnRotate(func() {
		if s := current(); s != nil {
			if err := s.Rotate(); err != nil {
				logger.Printf("token rotation failed: %v", err)
				return
			}
			logger.Printf("token rotated")
		}
	})
	b.OnTokenRequest(func() (string, string) {
		if s := current(); s != nil {
			return s.Token(), s.URL()
		}
		return "", ""
	})
	// Client detection and setup arrive with Task 18.
	b.OnClients(func([]string) []bridge.ClientStatus { return []bridge.ClientStatus{} })

	hello, err := b.WaitHello(context.Background())
	if err != nil {
		return err
	}
	logger.Printf("started, add-on %s, protocol %d", safe(hello.Version), hello.Protocol)

	conn, err := connfile.Load(hello.Instance)
	if err != nil || !tokenRE.MatchString(conn.Token) {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			logger.Printf("connection file unreadable; creating a new one")
		}
		conn = &connfile.Conn{Instance: hello.Instance, Token: connfile.NewToken()}
	}
	ln, port, err := connfile.PickPort(conn.Port)
	if err != nil {
		_ = b.SendWelcome(0, "No free port between 47110 and 47119")
		return err
	}
	conn.Port = port
	conn.PID = os.Getpid()
	if err := connfile.Save(conn); err != nil {
		ln.Close()
		_ = b.SendWelcome(0, "Could not write the connection file")
		return err
	}

	mu.Lock()
	if !gotTools {
		tools = hello.Tools
	}
	if attDir == "" {
		attDir = hello.AttachmentDir
	}
	srv = server.New(b, conn, func() string { mu.Lock(); defer mu.Unlock(); return attDir })
	srv.Log = logger
	srv.SetTools(tools)
	handler := srv.Handler()
	mu.Unlock()

	hs := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ErrorLog: logger}
	serveErr := make(chan error, 1)
	go func() { serveErr <- hs.Serve(ln) }()
	logger.Printf("listening on 127.0.0.1:%d", port)
	if err := b.SendWelcome(port, ""); err != nil {
		hs.Close()
		return err
	}

	select {
	case <-b.Done():
	case err := <-serveErr:
		logger.Printf("HTTP server failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := hs.Shutdown(ctx); err != nil {
		hs.Close()
	}
	logger.Printf("stopped")
	return nil
}

// safe keeps an add-on-supplied version string to a short printable token.
func safe(s string) string {
	if len(s) > 32 {
		s = s[:32]
	}
	out := []rune{}
	for _, r := range s {
		if r > ' ' && r < 0x7f {
			out = append(out, r)
		}
	}
	return string(out)
}
