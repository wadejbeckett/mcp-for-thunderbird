// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package bridge multiplexes tool calls between the MCP server and the
// Thunderbird add-on over native-messaging frames.
package bridge

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
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

// ErrProtocol is wrapped by WaitHello's error when the add-on speaks
// another protocol version; the welcome ok:false has already been sent.
var ErrProtocol = errors.New("protocol mismatch")

// Hello is the add-on's opening message. Thunderbird is Thunderbird's
// version, for the log; an add-on older than the field sends none.
type Hello struct {
	Protocol      int      `json:"protocol"`
	Version       string   `json:"version"`
	Instance      string   `json:"instance"`
	Tools         []string `json:"tools"`
	AttachmentDir string   `json:"attachmentDir"`
	Thunderbird   string   `json:"thunderbird"`
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
// MayHaveCompleted is set when the call reached Thunderbird (or was being
// written to it) before the host stopped waiting: a timeout, a cancelled
// request or Thunderbird closing. The action may then have happened, so a
// call that changes mail must not be repeated blindly.
type CallError struct {
	Code             string `json:"code"`
	Message          string `json:"message"`
	MayHaveCompleted bool   `json:"-"`
	cause            error
}

func (e CallError) Error() string { return e.Code + ": " + e.Message }

// Unwrap returns the cause, such as context.Canceled.
func (e CallError) Unwrap() error { return e.cause }

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
	Thunderbird   string          `json:"thunderbird,omitempty"`
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

	// writes feeds the one writer goroutine. It is unbuffered: a frame the
	// writer has not taken was never sent, so a caller that gives up
	// before then knows nothing reached Thunderbird.
	writes chan writeReq

	mu          sync.Mutex
	pending     map[string]chan outcome
	closed      bool
	mismatched  bool // the add-on speaks another protocol: serve nothing
	helloed     bool // a hello was accepted; later ones are ignored
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
	b := &Bridge{
		in: in, out: out, hostVersion: hostVersion,
		pending:     map[string]chan outcome{},
		callTimeout: defaultCallTimeout,
		helloCh:     make(chan helloOutcome, 1),
		done:        make(chan struct{}),
		writes:      make(chan writeReq),
	}
	go b.writeLoop()
	return b
}

// writeReq is one frame for the writer goroutine; its result arrives on
// done (buffered, so the writer never waits for a caller that gave up).
type writeReq struct {
	raw  []byte
	done chan error
}

// writeLoop writes frames one at a time, so no frame is interleaved with
// another. A write blocked on a stalled Thunderbird holds up only this
// goroutine: callers wait for it with their own deadline.
func (b *Bridge) writeLoop() {
	for {
		select {
		case w := <-b.writes:
			w.done <- nativemsg.Write(b.out, w.raw)
		case <-b.done:
			return
		}
	}
}

var (
	errWriteTimeout = errors.New("bridge: Thunderbird is not reading")
	errClosed       = errors.New("bridge: Thunderbird closed")
)

// write hands raw to the writer goroutine and waits for it, until expire
// fires, ctx ends or the add-on's stream closes. taken reports whether the
// writer took the frame: if it did, the frame may have reached Thunderbird
// even when write gives up.
func (b *Bridge) write(ctx context.Context, expire <-chan time.Time, raw []byte) (taken bool, err error) {
	if len(raw) > nativemsg.MaxOutgoing {
		return false, nativemsg.ErrTooLarge
	}
	w := writeReq{raw: raw, done: make(chan error, 1)}
	// A select picks at random among ready cases, so a caller that has
	// already given up is turned away before the writer is offered the
	// frame: otherwise a cancelled call could still be sent.
	select {
	case <-expire:
		return false, errWriteTimeout
	case <-ctx.Done():
		return false, ctx.Err()
	case <-b.done:
		return false, errClosed
	default:
	}
	select {
	case b.writes <- w:
	case <-expire:
		return false, errWriteTimeout
	case <-ctx.Done():
		return false, ctx.Err()
	case <-b.done:
		return false, errClosed
	}
	select {
	case err := <-w.done:
		return true, err
	case <-expire:
		return true, errWriteTimeout
	case <-ctx.Done():
		return true, ctx.Err()
	case <-b.done:
		return true, errClosed
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

// send writes a frame that answers the add-on (welcome, token, clients),
// giving up after the call timeout if Thunderbird is not reading.
func (b *Bridge) send(f frame) error {
	raw, err := json.Marshal(f)
	if err != nil {
		return err
	}
	timer := time.NewTimer(b.timeout())
	defer timer.Stop()
	_, err = b.write(context.Background(), timer.C, raw)
	return err
}

func (b *Bridge) timeout() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.callTimeout
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
//
// Sending the blobs and the call frame has one call timeout; waiting for
// the answer has another, started once the call frame is written, so a
// large attachment does not eat into Thunderbird's time to answer. A
// failure before the call frame was taken by the writer means nothing
// was asked of Thunderbird. A timeout, cancellation or close after that
// sets CallError.MayHaveCompleted: the action may or may not have happened.
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

	if client == "" {
		client = "unknown"
	}
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	sendTimer := time.NewTimer(timeout)
	defer sendTimer.Stop()

	var blobIDs []string
	for _, blob := range blobs {
		bid := newID()
		blobIDs = append(blobIDs, bid)
		// Blobs alone do nothing in Thunderbird, so a failure here is a
		// failure before anything happened.
		if err := b.sendBlob(ctx, sendTimer.C, bid, blob); err != nil {
			return Result{}, sendErr(ctx, err, false)
		}
	}
	raw, err := json.Marshal(frame{Type: "call", ID: id, Tool: tool, Args: args, Client: client, Blobs: blobIDs})
	if err != nil {
		return Result{}, err
	}
	if taken, err := b.write(ctx, sendTimer.C, raw); err != nil {
		return Result{}, sendErr(ctx, err, taken)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case o := <-ch:
		return o.res, o.err
	case <-timer.C:
		return Result{}, uncertain(tbErr("Thunderbird did not answer in 60 s"), nil)
	case <-ctx.Done():
		return Result{}, uncertain(CallError{Code: "thunderbird_error", Message: "The request was cancelled"}, ctx.Err())
	}
}

// uncertain marks e as a call that reached Thunderbird before the host
// stopped waiting for it.
func uncertain(e CallError, cause error) CallError {
	e.MayHaveCompleted = true
	e.cause = cause
	return e
}

// sendErr maps a failure to write a call's frames. taken reports whether
// the call frame itself had been taken by the writer.
func sendErr(ctx context.Context, err error, taken bool) error {
	var e CallError
	switch {
	case errors.Is(err, nativemsg.ErrTooLarge):
		return CallError{Code: "too_large", Message: "Request is too large to send to Thunderbird"}
	case errors.Is(err, errWriteTimeout):
		e = tbErr("Thunderbird did not answer in 60 s")
	case ctx.Err() != nil && errors.Is(err, ctx.Err()):
		if !taken {
			return ctx.Err()
		}
		e = CallError{Code: "thunderbird_error", Message: "The request was cancelled", cause: ctx.Err()}
	default:
		// The pipe closed: either before the writer took the frame, or
		// with the write failing, so the frame never arrived whole.
		if !errors.Is(err, errClosed) {
			taken = false
		}
		e = tbErr("Thunderbird closed")
	}
	if taken {
		return uncertain(e, e.cause)
	}
	return e
}

func (b *Bridge) sendBlob(ctx context.Context, expire <-chan time.Time, id string, data []byte) error {
	seq := 0
	for {
		n := len(data)
		if n > blobChunk {
			n = blobChunk
		}
		last := n == len(data)
		f := frame{Type: "blob", Blob: id, Seq: &seq, Last: &last, Data: base64.StdEncoding.EncodeToString(data[:n])}
		raw, err := json.Marshal(f)
		if err != nil {
			return err
		}
		if _, err := b.write(ctx, expire, raw); err != nil {
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
		// Every pending call's frame was written (or was being written)
		// before Thunderbird went: it may have acted on it.
		ch <- outcome{err: uncertain(tbErr("Thunderbird closed"), nil)}
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
	if b.mismatched {
		// After a protocol mismatch only token and clients requests are
		// answered, empty, so the add-on's pages do not wait for nothing.
		onTools, onConfig, onRotate = nil, nil, nil
		onToken = func() (string, string) { return "", "" }
		onClients = func([]string) []ClientStatus { return nil }
	}
	b.mu.Unlock()

	switch f.Type {
	case "hello":
		// Once a hello has been accepted, a later one changes nothing,
		// whatever protocol it names.
		b.mu.Lock()
		if b.helloed {
			b.mu.Unlock()
			return
		}
		if f.Protocol == ProtocolVersion && !b.mismatched {
			b.helloed = true
		}
		b.mu.Unlock()
		if f.Protocol != ProtocolVersion {
			b.mu.Lock()
			b.mismatched = true
			b.mu.Unlock()
			msg := fmt.Sprintf("Unsupported protocol %d; this host speaks protocol %d. Update MCP for Thunderbird.", f.Protocol, ProtocolVersion)
			_ = b.SendWelcome(0, msg)
			b.deliverHello(helloOutcome{err: fmt.Errorf("%w: %s", ErrProtocol, msg)})
			return
		}
		b.deliverHello(helloOutcome{h: Hello{Protocol: f.Protocol, Version: f.Version,
			Instance: f.Instance, Tools: f.Tools, AttachmentDir: f.AttachmentDir, Thunderbird: f.Thunderbird}})
	case "tools":
		if onTools != nil {
			onTools(f.Tools)
		}
	case "config":
		if onConfig != nil {
			onConfig(f.AttachmentDir)
		}
	case "rotate_token":
		// Run in the read loop, not in a goroutine, so a token_request
		// the add-on sends right after is answered with the new key (or
		// with none, when the host refused the rotation).
		if onRotate != nil {
			onRotate()
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
