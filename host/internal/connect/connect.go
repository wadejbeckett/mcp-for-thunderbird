// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package connect is connect mode: the stdio MCP server every AI app
// launches. It holds no tools of its own. It mirrors the tools of the shared
// native-mode server (the one Thunderbird started) and forwards each call to
// it over Streamable HTTP, using the port and token in the connection file.
package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/catalogue"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/server"
)

// ClosedMessage is the error of any tool call while Thunderbird (the
// upstream server) is not reachable.
const ClosedMessage = "Thunderbird is not running. Start Thunderbird to use MCP for Thunderbird."

// Instructions are the server instructions. A client may read them once
// and keep them, so they stay true whether or not Thunderbird is running.
const Instructions = "MCP for Thunderbird gives access to mail in Thunderbird. If no mail tools are listed, start Thunderbird; they appear automatically."

// LostMessage is the tool error when a call that changes mail was sent but
// its reply was lost; it is not repeated.
const LostMessage = "thunderbird_error: Connection lost; the action may or may not have happened"

// PollInterval is how often the proxy checks whether the upstream server has
// appeared, gone away or rotated its token.
const PollInterval = 5 * time.Second

const (
	connectTimeout = 5 * time.Second
	listTimeout    = 5 * time.Second
	pingTimeout    = 3 * time.Second
)

var (
	errUnavailable = errors.New("upstream unavailable")
	errRejected    = errors.New("upstream rejected the access key")
	errLost        = errors.New("connection lost after the call was sent")
	// errStale refuses a request whose address is no longer the live
	// host's; it is reported as a dial failure, since nothing was sent.
	errStale = errors.New("the connection file no longer names a running host at this address")
)

// RejectedMessage is the tool error when the upstream refuses the token even
// after the connection file was re-read.
const RejectedMessage = "MCP for Thunderbird rejected the access key. Restart Thunderbird, then restart this app."

// logOutput is where the proxy logs (stderr); tests replace it.
var logOutput io.Writer = os.Stderr

// Run serves MCP on stdin/stdout until stdin closes or ctx ends. instance
// selects a connection file; empty means the most recently updated one.
func Run(ctx context.Context, stdin io.Reader, stdout io.Writer, instance string) error {
	return run(ctx, stdin, stdout, instance, PollInterval)
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

func run(ctx context.Context, stdin io.Reader, stdout io.Writer, instance string, poll time.Duration) error {
	return newProxy(instance, poll).serve(ctx, stdin, stdout)
}

func newProxy(instance string, poll time.Duration) *proxy {
	return &proxy{
		instance:   instance,
		poll:       poll,
		logger:     log.New(logOutput, "mcp-for-thunderbird: ", log.LstdFlags),
		registered: map[string][]byte{},
		name:       "unknown",
	}
}

// serve runs the stdio server until stdin closes or ctx ends.
func (p *proxy) serve(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	p.srv = mcp.NewServer(&mcp.Implementation{Name: server.Name, Title: "MCP for Thunderbird", Version: server.Version},
		&mcp.ServerOptions{
			Instructions: Instructions,
			// Advertise list_changed even with no tools, so clients learn
			// when Thunderbird starts and tools appear.
			Capabilities: &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{ListChanged: true}},
		})
	p.srv.AddReceivingMiddleware(p.middleware(ctx))
	defer func() { cancel(); p.close() }()

	err := p.srv.Run(ctx, &mcp.IOTransport{Reader: io.NopCloser(stdin), Writer: nopWriteCloser{stdout}})
	if err != nil && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, context.Canceled)) {
		return nil
	}
	return err
}

type proxy struct {
	instance string
	poll     time.Duration
	srv      *mcp.Server
	logger   *log.Logger

	mu         sync.Mutex
	sess       *mcp.ClientSession
	conn       *connfile.Conn
	name       string // downstream client name, passed upstream
	registered map[string][]byte
	polling    bool
	closed     bool
	lastFail   string // last logged connection failure, to log changes only

	saw401 atomic.Bool
	connMu sync.Mutex // serialises connection attempts
	syncMu sync.Mutex // serialises tool re-syncs
	pollWG sync.WaitGroup
}

// middleware answers the two methods whose behaviour depends on upstream
// availability: initialize (connect first, so the first tools/list is
// already mirrored) and tools/call (closed copy when there is no upstream).
func (p *proxy) middleware(ctx context.Context) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(c context.Context, method string, req mcp.Request) (mcp.Result, error) {
			switch method {
			case "initialize", "server/discover":
				// "initialize" is the handshake of older protocol versions;
				// "server/discover" is its sessionless replacement. Both
				// carry the client name and return the instructions.
				if name := clientName(req); name != "" {
					p.mu.Lock()
					p.name = name
					p.mu.Unlock()
				}
				p.tryConnect(c)
				p.sync(c)
				p.startPolling(ctx)
				return next(c, method, req)
			case "tools/call":
				if p.session() == nil {
					p.tryConnect(c)
					p.sync(c)
				}
				if p.session() == nil {
					if p.saw401.Load() {
						return rejectedResult(), nil
					}
					return closedResult(), nil
				}
				// Every call is forwarded by name, mirrored or not: the mirror
				// only answers tools/list and can lag the upstream (a
				// background re-sync may remove the tools just before a
				// reconnect, or between this check and a dispatch). The
				// upstream answers for the tool, or the call gets the closed
				// copy if the upstream has gone.
				r, ok := req.(*mcp.CallToolRequest)
				if !ok || r.Params == nil {
					return next(c, method, req)
				}
				res, err := p.handler(r.Params.Name)(c, r)
				if err != nil {
					return nil, err
				}
				if res != nil && res.Content == nil {
					res.Content = []mcp.Content{} // never "content": null
				}
				return res, err
			}
			return next(c, method, req)
		}
	}
}

// clientName is the downstream client's self-reported name, or "".
func clientName(req mcp.Request) string {
	if ip, ok := req.GetParams().(*mcp.InitializeParams); ok && ip != nil && ip.ClientInfo != nil {
		return ip.ClientInfo.Name
	}
	if ci, ok := req.(interface{ ClientInfo() *mcp.Implementation }); ok {
		if info := ci.ClientInfo(); info != nil {
			return info.Name
		}
	}
	return ""
}

func closedResult() *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: ClosedMessage}}}
}

func rejectedResult() *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: RejectedMessage}}}
}

// noteConnect logs a connection failure when it differs from the last one
// logged, and a recovery once. It never logs the token or mail content.
func (p *proxy) noteConnect(err error) {
	msg := ""
	if err != nil {
		msg = "upstream not reachable: " + err.Error()
		if p.saw401.Load() {
			msg = "upstream rejected the access key"
		}
	}
	p.mu.Lock()
	same := p.lastFail == msg
	p.lastFail = msg
	p.mu.Unlock()
	if same {
		return
	}
	if msg == "" {
		p.logger.Print("connected to upstream")
	} else {
		p.logger.Print(msg)
	}
}

func (p *proxy) session() *mcp.ClientSession {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sess
}

// authRT adds the bearer token and notes a 401. Before every request it
// re-reads the session's connection file: the token goes only to the
// address a live host's file names right now. If the host has gone, its
// port may belong to another program (ruling R33), so the request is
// refused as a dial failure and nothing is sent.
type authRT struct{ p *proxy }

func (a authRT) RoundTrip(r *http.Request) (*http.Response, error) {
	tok, ok := a.p.liveToken(r.URL)
	if !ok {
		if r.Body != nil {
			r.Body.Close()
		}
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errStale}
	}
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && resp.StatusCode == http.StatusUnauthorized {
		a.p.saw401.Store(true)
	}
	return resp, err
}

// liveToken re-reads the current session's connection file and returns its
// token if the file is usable (live host, port in range) and names exactly
// the address u points at.
func (p *proxy) liveToken(u *url.URL) (string, bool) {
	p.mu.Lock()
	cur := p.conn
	p.mu.Unlock()
	if cur == nil {
		return "", false
	}
	c, err := connfile.Load(cur.Instance)
	if err != nil || connfile.Usable(c) != nil ||
		u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() != strconv.Itoa(c.Port) {
		return "", false
	}
	p.mu.Lock()
	if p.conn == cur {
		p.conn = c
	}
	p.mu.Unlock()
	return c.Token, true
}

// loadConn returns the usable connection file to connect to: the named
// instance's, or the newest usable one. A file whose host has gone or
// whose port is outside 47110-47119 is never used.
func (p *proxy) loadConn() (*connfile.Conn, error) {
	if p.instance == "" {
		return connfile.Newest()
	}
	c, err := connfile.Load(p.instance)
	if err != nil {
		return nil, err
	}
	if err := connfile.Usable(c); err != nil {
		return nil, err
	}
	return c, nil
}

// tryConnect connects upstream if there is no session, with a short timeout.
func (p *proxy) tryConnect(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	p.noteConnect(p.connect(ctx))
}

// connect opens an upstream session unless one exists. On a 401 it re-reads
// the connection file and tries once more (the token was rotated).
func (p *proxy) connect(ctx context.Context) error {
	p.connMu.Lock()
	defer p.connMu.Unlock()
	if p.session() != nil {
		return nil
	}
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		var conn *connfile.Conn
		if conn, err = p.loadConn(); err != nil {
			return err
		}
		p.saw401.Store(false)
		p.mu.Lock()
		p.conn = conn
		name := p.name
		p.mu.Unlock()

		client := mcp.NewClient(&mcp.Implementation{Name: name, Version: server.Version}, &mcp.ClientOptions{
			ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) { go p.sync(context.Background()) },
		})
		tr := &mcp.StreamableClientTransport{
			Endpoint: fmt.Sprintf("http://127.0.0.1:%d/mcp", conn.Port),
			HTTPClient: &http.Client{
				Transport: authRT{p},
				// Never follow a redirect: the bearer token must go to the
				// connection file's address and nowhere else.
				CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			},
			MaxRetries: -1,
		}
		var cs *mcp.ClientSession
		if cs, err = client.Connect(ctx, tr, nil); err == nil {
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				cs.Close()
				return errUnavailable
			}
			p.sess = cs
			p.mu.Unlock()
			go func() { _ = cs.Wait(); p.drop(cs) }()
			return nil
		}
		if !p.saw401.Load() {
			break
		}
	}
	return err
}

// drop forgets cs if it is still the current session and removes the
// mirrored tools in the background.
func (p *proxy) drop(cs *mcp.ClientSession) {
	p.mu.Lock()
	was := p.sess == cs
	if was {
		p.sess = nil
	}
	p.mu.Unlock()
	_ = cs.Close()
	if was {
		go p.sync(context.Background())
	}
}

// sync makes the stdio server's tools equal the upstream's: add new or
// changed, remove gone. Nothing is touched when nothing differs, so the
// downstream client gets list_changed only for real changes.
func (p *proxy) sync(ctx context.Context) {
	p.syncMu.Lock()
	defer p.syncMu.Unlock()

	want := map[string]*mcp.Tool{}
	if cs := p.session(); cs != nil {
		lctx, cancel := context.WithTimeout(ctx, listTimeout)
		defer cancel()
		for t, err := range cs.Tools(lctx, nil) {
			if err != nil {
				return // keep what is registered; the poll will retry
			}
			want[t.Name] = t
		}
	}
	p.mu.Lock()
	var remove []string
	for name := range p.registered {
		if _, ok := want[name]; !ok {
			remove = append(remove, name)
			delete(p.registered, name)
		}
	}
	var add []*mcp.Tool
	for name, t := range want {
		sig, _ := json.Marshal(t)
		if old, ok := p.registered[name]; ok && bytes.Equal(old, sig) {
			continue
		}
		p.registered[name] = sig
		add = append(add, t)
	}
	p.mu.Unlock()
	if len(remove) > 0 {
		p.srv.RemoveTools(remove...)
	}
	for _, t := range add {
		p.srv.AddTool(t, p.handler(t.Name))
	}
}

func (p *proxy) handler(tool string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.Params.Arguments
		if len(args) == 0 || string(args) == "null" {
			args = json.RawMessage(`{}`)
		}
		res, err := p.callUpstream(ctx, tool, args)
		switch {
		case errors.Is(err, errUnavailable):
			return closedResult(), nil
		case errors.Is(err, errRejected):
			return rejectedResult(), nil
		case errors.Is(err, errLost):
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: LostMessage}}}, nil
		}
		return res, err
	}
}

// callUpstream forwards one call. After a transport failure it drops the
// session, re-reads the connection file, reconnects and retries once, but
// only when repeating the call is safe: the request was refused unsent (a
// dial failure or a 401), or the tool only reads. A call that changes mail
// and may have reached Thunderbird is never repeated (errLost).
func (p *proxy) callUpstream(ctx context.Context, tool string, args json.RawMessage) (*mcp.CallToolResult, error) {
	for attempt := 0; attempt < 2; attempt++ {
		cs := p.session()
		if cs == nil {
			err := p.connect(ctx)
			p.noteConnect(err)
			if err != nil {
				if p.saw401.Swap(false) {
					return nil, errRejected
				}
				return nil, errUnavailable
			}
			if cs = p.session(); cs == nil {
				return nil, errUnavailable
			}
			go p.sync(context.Background())
		}
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
		if err == nil {
			return res, nil
		}
		var je *jsonrpc.Error
		if ctx.Err() != nil || (errors.As(err, &je) && !transportFailed(err)) {
			return nil, err
		}
		// Transport failure: the old session may belong to a Thunderbird
		// that restarted (new port or token). Drop it, re-read the
		// connection file and retry once if that is safe.
		was401 := p.saw401.Swap(false)
		p.drop(cs)
		if !was401 && !dialFailed(err) && !readOnly(tool) {
			return nil, errLost
		}
		if attempt == 1 {
			if was401 {
				return nil, errRejected
			}
			return nil, errUnavailable
		}
	}
	return nil, errUnavailable
}

// transportFailed reports whether err is an HTTP transport failure. The
// SDK wraps those in a JSON-RPC "rejected by transport" error so the
// session survives; for the proxy they mean the upstream may have gone,
// unlike a JSON-RPC error the upstream itself answered.
func transportFailed(err error) bool {
	var ue *url.Error
	return errors.As(err, &ue)
}

// dialFailed reports whether err means no connection was made, so the
// request was never sent: only then is any call safe to repeat.
func dialFailed(err error) bool {
	var oe *net.OpError
	for e := err; errors.As(e, &oe); e = oe.Err {
		if oe.Op == "dial" {
			return true
		}
	}
	return false
}

// readOnly reports whether tool only reads, so repeating it is harmless.
// Unknown names count as changing mail.
func readOnly(tool string) bool {
	for _, t := range catalogue.All() {
		if t.Name == tool {
			return t.ReadOnly
		}
	}
	return false
}

func (p *proxy) startPolling(ctx context.Context) {
	p.mu.Lock()
	if p.polling || p.closed {
		p.mu.Unlock()
		return
	}
	p.polling = true
	p.mu.Unlock()
	p.pollWG.Add(1)
	go func() {
		defer p.pollWG.Done()
		t := time.NewTicker(p.poll)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				p.pollOnce(ctx)
			}
		}
	}()
}

func (p *proxy) pollOnce(ctx context.Context) {
	cs := p.session()
	if cs == nil {
		if p.connectQuiet(ctx) {
			p.sync(ctx)
		}
		return
	}
	pctx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := cs.Ping(pctx, nil); err != nil && ctx.Err() == nil {
		was401 := p.saw401.Swap(false)
		p.drop(cs)
		if was401 && p.connectQuiet(ctx) {
			p.sync(ctx)
		}
	}
}

func (p *proxy) connectQuiet(ctx context.Context) bool {
	cctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	err := p.connect(cctx)
	p.noteConnect(err)
	return err == nil
}

func (p *proxy) close() {
	p.mu.Lock()
	p.closed = true
	cs := p.sess
	p.sess = nil
	p.mu.Unlock()
	if cs != nil {
		_ = cs.Close()
	}
	p.pollWG.Wait()
}
