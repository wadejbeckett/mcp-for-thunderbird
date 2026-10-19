// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package bridge multiplexes tool calls between the MCP server and the
// Thunderbird add-on over native-messaging frames.
package bridge

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/nativemsg"
)

// ProtocolVersion is the native message protocol this host speaks.
const ProtocolVersion = 1

// blobChunk is the raw size of one blob piece. The brief asks for 768 KiB,
// but base64 of 768 KiB is already exactly 1 MiB before the JSON envelope, so
// the frame would exceed nativemsg.MaxOutgoing. 760 KiB raw (about 1013 KiB
// encoded) leaves room for the envelope while a 2 MiB blob is still 3 chunks.
const blobChunk = 760 * 1024

const defaultCallTimeout = 60 * time.Second

// Hello is the add-on's opening message.
type Hello struct {
	Protocol      int      `json:"protocol"`
	Version       string   `json:"version"`
	Instance      string   `json:"instance"`
	Tools         []string `json:"tools"`
	AttachmentDir string   `json:"attachmentDir"`
}

// SaveFile is an attachment the host is asked to write to disk.
type SaveFile struct {
	Name string
	Data []byte
}

// Result is a successful tool result.
type Result struct {
	Content json.RawMessage
	Save    *SaveFile
}

// CallError is a failed tool call, coded as in the shared contract.
type CallError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e CallError) Error() string { return e.Code + ": " + e.Message }

// ClientStatus describes one MCP client's detection/configuration state.
type ClientStatus struct {
	Name       string `json:"name"`
	Found      bool   `json:"found"`
	Configured bool   `json:"configured"`
	Error      string `json:"error,omitempty"`
}

// frame is the union of every native message in either direction.
type frame struct {
	Type          string          `json:"type"`
	ID            string          `json:"id,omitempty"`
	Tool          string          `json:"tool,omitempty"`
	Args          json.RawMessage `json:"args,omitempty"`
	Client        string          `json:"client,omitempty"`
	Blobs         []string        `json:"blobs,omitempty"`
	Blob          string          `json:"blob,omitempty"`
	Seq           *int            `json:"seq"`
	Last          *bool           `json:"last"`
	Data          string          `json:"data,omitempty"`
	Protocol      int             `json:"protocol,omitempty"`
	Version       string          `json:"version,omitempty"`
	Instance      string          `json:"instance,omitempty"`
	Tools         []string        `json:"tools,omitempty"`
	AttachmentDir string          `json:"attachmentDir,omitempty"`
	OK            *bool           `json:"ok,omitempty"`
	Content       json.RawMessage `json:"content,omitempty"`
	Save          *struct {
		Name string `json:"name"`
		Data string `json:"data"`
	} `json:"save,omitempty"`
	Error json.RawMessage `json:"error,omitempty"`
	Port  *int            `json:"port,omitempty"`
	Req   string          `json:"req,omitempty"`
	// Clients is a name list on clients_configure and a status list on
	// clients_result, so it is decoded separately by each path.
	Clients json.RawMessage `json:"clients,omitempty"`
	Token   string          `json:"token,omitempty"`
	URL     string          `json:"url,omitempty"`
}

type outcome struct {
	res Result
	err error
}

// Bridge carries calls to the add-on and routes replies back by id.
type Bridge struct {
	in          io.Reader
	out         io.Writer
	hostVersion string

	wmu sync.Mutex // serialises writers

	mu          sync.Mutex
	pending     map[string]chan outcome
	closed      bool
	callTimeout time.Duration
	onTools     func([]string)
	onConfig    func(string)
	onRotate    func()
	onToken     func() (string, string)
	onClients   func([]string) []ClientStatus

	startOnce sync.Once
	helloCh   chan helloOutcome
	done      chan struct{}
}

type helloOutcome struct {
	h   Hello
	err error
}

// New creates a bridge over the add-on's stdin and stdout. Register callbacks,
// then call Start (WaitHello and Call start it implicitly).
func New(in io.Reader, out io.Writer, hostVersion string) *Bridge {
	return &Bridge{
		in: in, out: out, hostVersion: hostVersion,
		pending:     map[string]chan outcome{},
		callTimeout: defaultCallTimeout,
		helloCh:     make(chan helloOutcome, 1),
		done:        make(chan struct{}),
	}
}

// SetCallTimeout overrides the per-call timeout (default 60 s).
func (b *Bridge) SetCallTimeout(d time.Duration) {
	b.mu.Lock()
	b.callTimeout = d
	b.mu.Unlock()
}

func (b *Bridge) OnTools(f func([]string))              { b.mu.Lock(); b.onTools = f; b.mu.Unlock() }
func (b *Bridge) OnConfig(f func(attachmentDir string)) { b.mu.Lock(); b.onConfig = f; b.mu.Unlock() }
func (b *Bridge) OnRotate(f func())                     { b.mu.Lock(); b.onRotate = f; b.mu.Unlock() }
func (b *Bridge) OnTokenRequest(f func() (token, url string)) {
	b.mu.Lock()
	b.onToken = f
	b.mu.Unlock()
}
func (b *Bridge) OnClients(f func(configure []string) []ClientStatus) {
	b.mu.Lock()
	b.onClients = f
	b.mu.Unlock()
}

// Start launches the reader goroutine once.
func (b *Bridge) Start() { b.startOnce.Do(func() { go b.readLoop() }) }

// Done is closed when the add-on's stream has ended.
func (b *Bridge) Done() <-chan struct{} { return b.done }

// WaitHello blocks until the add-on's hello arrives. A hello with another
// protocol version is answered with welcome ok:false and returns an error.
func (b *Bridge) WaitHello(ctx context.Context) (Hello, error) {
	b.Start()
	select {
	case o := <-b.helloCh:
		return o.h, o.err
	case <-ctx.Done():
		return Hello{}, ctx.Err()
	}
}

func (b *Bridge) send(f frame) error {
	raw, err := json.Marshal(f)
	if err != nil {
		return err
	}
	b.wmu.Lock()
	defer b.wmu.Unlock()
	return nativemsg.Write(b.out, raw)
}

// SendWelcome answers the hello. A non-empty errMsg makes the welcome ok:false.
func (b *Bridge) SendWelcome(port int, errMsg string) error {
	ok := errMsg == ""
	return b.send(frame{Type: "welcome", Protocol: ProtocolVersion, Version: b.hostVersion,
		Port: &port, OK: &ok, Error: welcomeError(errMsg)})
}

// welcomeError encodes the welcome's error as a bare JSON string, unlike
// result errors, which are {code, message} objects.
func welcomeError(msg string) json.RawMessage {
	if msg == "" {
		return nil
	}
	raw, _ := json.Marshal(msg)
	return raw
}

func newID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw[:])
}

func tbErr(msg string) CallError { return CallError{Code: "thunderbird_error", Message: msg} }

// Call sends a tool call (after any blobs) and waits for its result.
func (b *Bridge) Call(ctx context.Context, tool string, args json.RawMessage, client string, blobs [][]byte) (Result, error) {
	b.Start()
	id := newID()
	ch := make(chan outcome, 1)
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return Result{}, tbErr("Thunderbird closed")
	}
	b.pending[id] = ch
	timeout := b.callTimeout
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var blobIDs []string
	for _, blob := range blobs {
		bid := newID()
		blobIDs = append(blobIDs, bid)
		if err := b.sendBlob(bid, blob); err != nil {
			return Result{}, sendErr(err)
		}
	}
	if client == "" {
		client = "unknown"
	}
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	if err := b.send(frame{Type: "call", ID: id, Tool: tool, Args: args, Client: client, Blobs: blobIDs}); err != nil {
		return Result{}, sendErr(err)
	}
	select {
	case o := <-ch:
		return o.res, o.err
	case <-timer.C:
		return Result{}, tbErr("Thunderbird did not answer in 60 s")
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

func sendErr(err error) error {
	if err == nativemsg.ErrTooLarge {
		return CallError{Code: "too_large", Message: "Request is too large to send to Thunderbird"}
	}
	return tbErr("Thunderbird closed")
}

func (b *Bridge) sendBlob(id string, data []byte) error {
	seq := 0
	for {
		n := len(data)
		if n > blobChunk {
			n = blobChunk
		}
		last := n == len(data)
		f := frame{Type: "blob", Blob: id, Seq: &seq, Last: &last, Data: base64.StdEncoding.EncodeToString(data[:n])}
		if err := b.send(f); err != nil {
			return err
		}
		if last {
			return nil
		}
		data = data[n:]
		seq++
	}
}

func (b *Bridge) readLoop() {
	for {
		raw, err := nativemsg.Read(b.in)
		if err != nil {
			b.shutdown()
			return
		}
		var f frame
		if json.Unmarshal(raw, &f) != nil {
			continue // ignore malformed frames; never log their content
		}
		b.dispatch(f)
	}
}

func (b *Bridge) shutdown() {
	b.mu.Lock()
	b.closed = true
	pend := b.pending
	b.pending = map[string]chan outcome{}
	b.mu.Unlock()
	for _, ch := range pend {
		ch <- outcome{err: tbErr("Thunderbird closed")}
	}
	select {
	case b.helloCh <- helloOutcome{err: fmt.Errorf("Thunderbird closed before hello")}:
	default:
	}
	close(b.done)
}

func (b *Bridge) dispatch(f frame) {
	b.mu.Lock()
	onTools, onConfig, onRotate, onToken, onClients := b.onTools, b.onConfig, b.onRotate, b.onToken, b.onClients
	b.mu.Unlock()

	switch f.Type {
	case "hello":
		if f.Protocol != ProtocolVersion {
			msg := fmt.Sprintf("Unsupported protocol %d; this host speaks protocol %d. Update MCP for Thunderbird.", f.Protocol, ProtocolVersion)
			_ = b.SendWelcome(0, msg)
			b.deliverHello(helloOutcome{err: fmt.Errorf("%s", msg)})
			return
		}
		b.deliverHello(helloOutcome{h: Hello{Protocol: f.Protocol, Version: f.Version,
			Instance: f.Instance, Tools: f.Tools, AttachmentDir: f.AttachmentDir}})
	case "tools":
		if onTools != nil {
			onTools(f.Tools)
		}
	case "config":
		if onConfig != nil {
			onConfig(f.AttachmentDir)
		}
	case "rotate_token":
		if onRotate != nil {
			go onRotate()
		}
	case "token_request":
		if onToken != nil {
			go func() {
				tok, url := onToken()
				_ = b.send(frame{Type: "token", Token: tok, URL: url})
			}()
		}
	case "clients_detect", "clients_configure":
		if onClients != nil {
			var names []string
			if f.Type == "clients_configure" {
				_ = json.Unmarshal(f.Clients, &names)
				if names == nil {
					names = []string{}
				}
			}
			req := f.Req
			go func() {
				st := onClients(names)
				if st == nil {
					st = []ClientStatus{}
				}
				raw, _ := json.Marshal(st)
				_ = b.send(frame{Type: "clients_result", Req: req, Clients: raw})
			}()
		}
	case "result":
		b.mu.Lock()
		ch := b.pending[f.ID]
		delete(b.pending, f.ID)
		b.mu.Unlock()
		if ch == nil {
			return // late answer for a call that already timed out
		}
		ch <- toOutcome(f)
	}
}

func (b *Bridge) deliverHello(o helloOutcome) {
	select {
	case b.helloCh <- o:
	default: // only the first hello is awaited
	}
}

func toOutcome(f frame) outcome {
	if f.OK == nil || !*f.OK {
		e := CallError{Code: "thunderbird_error", Message: "Thunderbird returned an error"}
		var re CallError
		if json.Unmarshal(f.Error, &re) == nil && re.Code != "" {
			e = re
		}
		return outcome{err: e}
	}
	res := Result{Content: f.Content}
	if f.Save != nil {
		data, err := base64.StdEncoding.DecodeString(f.Save.Data)
		if err != nil {
			return outcome{err: tbErr("Thunderbird sent an undecodable attachment")}
		}
		res.Save = &SaveFile{Name: f.Save.Name, Data: data}
	}
	return outcome{res: res}
}
