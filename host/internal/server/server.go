// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package server is the MCP endpoint of MCP for Thunderbird: a go-sdk server
// over Streamable HTTP whose tools mirror what the add-on has enabled, and
// whose calls go to Thunderbird through the native-messaging bridge.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/bridge"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/catalogue"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/files"
)

// Name is the MCP server name clients see.
const Name = "mcp-for-thunderbird"

// Version is reported to MCP clients; main sets it from its build version.
var Version = "0.0.0-dev"

// Server holds the go-sdk server, the bridge to Thunderbird and the
// connection details the HTTP guard checks.
type Server struct {
	// Log receives start/stop, client-connect and error-code lines only.
	// It defaults to stderr; set it before serving.
	Log *log.Logger

	b             *bridge.Bridge
	attachmentDir func() string
	mcp           *mcp.Server

	mu      sync.Mutex
	conn    *connfile.Conn
	enabled map[string]bool
	clients map[string]bool
	// clientsFull is set once the overflow line has been logged.
	clientsFull bool
}

// New builds a server with no tools; call SetTools with the add-on's list.
func New(b *bridge.Bridge, conn *connfile.Conn, attachmentDir func() string) *Server {
	s := &Server{
		Log:           log.New(os.Stderr, Name+": ", log.LstdFlags),
		b:             b,
		attachmentDir: attachmentDir,
		conn:          conn,
		enabled:       map[string]bool{},
		clients:       map[string]bool{},
	}
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: Name, Title: "MCP for Thunderbird", Version: Version},
		&mcp.ServerOptions{
			// Advertise tools with list_changed even while none are enabled,
			// so clients subscribe and learn when the user enables some.
			Capabilities: &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{ListChanged: true}},
			InitializedHandler: func(_ context.Context, req *mcp.InitializedRequest) {
				name := "unknown"
				if p := req.Session.InitializeParams(); p != nil && p.ClientInfo != nil && p.ClientInfo.Name != "" {
					name = p.ClientInfo.Name
				}
				s.noteClient(name)
			},
		})
	return s
}

// SetTools adds and removes tools so the server offers exactly
// catalogue.Filter(enabled); the SDK then sends notifications/tools/list_changed.
// It never calls into the bridge, so it is safe on the bridge reader goroutine.
func (s *Server) SetTools(enabled []string) {
	want := catalogue.Filter(enabled)
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := map[string]bool{}
	for _, t := range want {
		keep[t.Name] = true
	}
	var remove []string
	for name := range s.enabled {
		if !keep[name] {
			remove = append(remove, name)
			delete(s.enabled, name)
		}
	}
	if len(remove) > 0 {
		s.mcp.RemoveTools(remove...)
	}
	for _, t := range want {
		if s.enabled[t.Name] {
			continue
		}
		s.mcp.AddTool(toMCP(t), s.handler(t.Name))
		s.enabled[t.Name] = true
	}
}

func toMCP(t catalogue.Tool) *mcp.Tool {
	destructive := t.Destructive
	openWorld := t.Name == "mail_send"
	return &mcp.Tool{
		Name:        t.Name,
		Description: t.Description,
		InputSchema: t.Input,
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    t.ReadOnly,
			DestructiveHint: &destructive,
			IdempotentHint:  t.Idempotent,
			OpenWorldHint:   &openWorld,
		},
	}
}

// Handler is the MCP endpoint at /mcp behind Guard. The guard checks the
// token current at each request, so rotation takes effect immediately for
// new requests while streams already open continue.
func (s *Server) Handler() http.Handler {
	h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.mcp },
		&mcp.StreamableHTTPOptions{MaxRequestBodyBytes: MaxBody})
	mux := http.NewServeMux()
	mux.Handle("/mcp", h)
	s.mu.Lock()
	port := s.conn.Port
	s.mu.Unlock()
	return guard(s.Token, port, mux)
}

// Token is the current bearer token.
func (s *Server) Token() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.Token
}

// URL is the MCP endpoint address.
func (s *Server) URL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return "http://127.0.0.1:" + strconv.Itoa(s.conn.Port) + "/mcp"
}

// Rotate replaces the token and saves the connection file.
func (s *Server) Rotate() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return connfile.Rotate(s.conn)
}

// Clear forgets the port and token and saves the connection file, so
// nothing can use them once the host stops (ruling R33). The guard then
// authorises nothing.
func (s *Server) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.Port, s.conn.Token = 0, ""
	return connfile.Save(s.conn)
}

// maxClientNames bounds the client names logged.
const maxClientNames = 256

// Attachment limits per message.
const (
	maxAttachments     = 20
	maxAttachmentTotal = files.MaxSize // 50 MiB across all attachments
)

// errorCodes are the shared error codes an add-on result may carry.
var errorCodes = map[string]bool{"paused": true, "not_enabled": true, "excluded": true,
	"not_found": true, "invalid_argument": true, "refused": true, "too_large": true, "thunderbird_error": true}

// composeTools take attachments from the attachment folder.
var composeTools = map[string]bool{"mail_draft": true, "mail_compose": true, "mail_send": true}

func (s *Server) handler(tool string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		client := "unknown"
		if ci := req.ClientInfo(); ci != nil && ci.Name != "" {
			client = ci.Name
		}
		s.noteClient(client)

		args := req.Params.Arguments
		if len(args) == 0 || string(args) == "null" {
			args = json.RawMessage(`{}`)
		}
		var blobs [][]byte
		if composeTools[tool] {
			var err error
			if args, blobs, err = s.resolveAttachments(args); err != nil {
				return s.toolError(tool, err), nil
			}
		}

		res, err := s.b.Call(ctx, tool, args, client, blobs)
		if err != nil {
			return s.toolError(tool, err), nil
		}
		content := res.Content
		if len(content) == 0 {
			content = json.RawMessage(`null`)
		}
		if res.Save != nil {
			path, err := files.Save(s.attachmentDir(), res.Save.Name, res.Save.Data)
			if err != nil {
				return s.toolError(tool, fileError(err, "")), nil
			}
			content = withSaved(content, path)
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(content)}}}, nil
	}
}

// resolveAttachments reads each named file from the attachment folder and
// rewrites args.attachments to [{name, blob}], where blob is the index of
// the file's data in the call's blobs list.
func (s *Server) resolveAttachments(args json.RawMessage) (json.RawMessage, [][]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(args, &obj); err != nil {
		return nil, nil, bridge.CallError{Code: "invalid_argument", Message: "Arguments must be an object"}
	}
	raw, ok := obj["attachments"]
	if !ok || string(raw) == "null" {
		return args, nil, nil
	}
	var names []string
	if err := json.Unmarshal(raw, &names); err != nil {
		return nil, nil, bridge.CallError{Code: "invalid_argument", Message: "attachments must be a list of file names"}
	}
	if len(names) > maxAttachments {
		return nil, nil, bridge.CallError{Code: "too_large", Message: "Too many attachments (max 20)"}
	}
	type ref struct {
		Name string `json:"name"`
		Blob int    `json:"blob"`
	}
	refs := make([]ref, 0, len(names))
	blobs := make([][]byte, 0, len(names))
	dir := s.attachmentDir()
	total := 0
	for i, name := range names {
		data, base, err := files.ReadForDraft(dir, name)
		if err != nil {
			return nil, nil, fileError(err, name)
		}
		if total += len(data); total > maxAttachmentTotal {
			return nil, nil, bridge.CallError{Code: "too_large", Message: "Attachments exceed 50 MiB in total"}
		}
		refs = append(refs, ref{Name: base, Blob: i})
		blobs = append(blobs, data)
	}
	obj["attachments"], _ = json.Marshal(refs)
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, nil, err
	}
	return out, blobs, nil
}

// fileError maps attachment-folder errors to the shared error codes.
func fileError(err error, name string) error {
	switch {
	case errors.Is(err, files.ErrOutside):
		return bridge.CallError{Code: "refused", Message: "Attachments can only come from the attachment folder"}
	case errors.Is(err, files.ErrNoDir):
		return bridge.CallError{Code: "invalid_argument", Message: "No attachment folder is set in MCP for Thunderbird options"}
	case errors.Is(err, files.ErrTooLarge):
		return bridge.CallError{Code: "too_large", Message: "Attachment is larger than 50 MiB"}
	case errors.Is(err, fs.ErrNotExist) && name != "":
		return bridge.CallError{Code: "not_found", Message: "No file named " + strconv.Quote(name) + " in the attachment folder"}
	}
	return bridge.CallError{Code: "thunderbird_error", Message: "Could not use the attachment folder"}
}

// withSaved merges {"saved": path} into an object result, or wraps any other
// result as {"result": ..., "saved": path}.
func withSaved(content json.RawMessage, path string) json.RawMessage {
	var obj map[string]json.RawMessage
	if json.Unmarshal(content, &obj) != nil || obj == nil {
		obj = map[string]json.RawMessage{"result": content}
	}
	obj["saved"], _ = json.Marshal(path)
	out, _ := json.Marshal(obj)
	return out
}

// toolError turns err into an MCP tool error "<code>: <message>" and logs
// only the tool name and error code.
func (s *Server) toolError(tool string, err error) *mcp.CallToolResult {
	var ce bridge.CallError
	if !errors.As(err, &ce) {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			ce = bridge.CallError{Code: "thunderbird_error", Message: "The request was cancelled"}
		} else {
			ce = bridge.CallError{Code: "thunderbird_error", Message: "Internal error"}
		}
	}
	if !errorCodes[ce.Code] {
		ce.Code = "thunderbird_error"
	}
	s.Log.Printf("tool %s: error %s", tool, ce.Code)
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: ce.Code + ": " + ce.Message}}}
}

// noteClient logs a client name the first time it is seen. Once
// maxClientNames names are known it logs one overflow line and no more.
func (s *Server) noteClient(name string) {
	name = safeName(name)
	s.mu.Lock()
	line := ""
	switch {
	case s.clients[name]:
	case len(s.clients) < maxClientNames:
		s.clients[name] = true
		line = "client connected: " + name
	case !s.clientsFull:
		s.clientsFull = true
		line = "client connected: further client names not logged"
	}
	s.mu.Unlock()
	if line != "" {
		s.Log.Print(line)
	}
}

// safeName keeps a client-supplied name to one short printable line.
func safeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return -1
	}, name)
	if r := []rune(name); len(r) > 64 {
		name = string(r[:64])
	}
	if name == "" {
		return "unknown"
	}
	return name
}
