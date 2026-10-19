// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Command echohost is a THROWAWAY spike native messaging host (Task 2).
// It is never shipped.
//
// Thunderbird starts it through runtime.connectNative("mft_spike"). It:
//   - logs every frame type it receives (never payload contents) to
//     $MFT_SPIKE_DIR/host.log as JSON lines;
//   - sends {"type":"ping","seq":n} every $MFT_SPIKE_PING seconds
//     (default 20, 0 disables) and logs the pong round trip;
//   - echoes {"type":"echo",...} frames back unchanged;
//   - listens on the unix socket $MFT_SPIKE_DIR/ctl-<instance>.sock (and a
//     symlink ctl.sock to the newest one). A client writes one JSON line
//     {"api":"messages.query","args":[...]} or {"cmd":"name","args":{...}};
//     the host forwards it to the add-on as {"type":"call","id":n,...} and
//     writes the add-on's result frame back as one JSON line.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

var (
	logMu    sync.Mutex
	logFile  *os.File
	outMu    sync.Mutex
	pending  = map[int64]chan json.RawMessage{}
	pendMu   sync.Mutex
	nextID   int64
	pingSent = map[int64]time.Time{}
)

func logf(event string, kv map[string]any) {
	if kv == nil {
		kv = map[string]any{}
	}
	kv["t"] = time.Now().UTC().Format(time.RFC3339Nano)
	kv["pid"] = os.Getpid()
	kv["event"] = event
	b, _ := json.Marshal(kv)
	logMu.Lock()
	defer logMu.Unlock()
	logFile.Write(append(b, '\n'))
}

func readFrame(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.NativeEndian, &n); err != nil {
		return nil, err
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeFrame(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > 1<<20 {
		return errors.New("frame over 1 MiB")
	}
	outMu.Lock()
	defer outMu.Unlock()
	if err := binary.Write(os.Stdout, binary.NativeEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = os.Stdout.Write(b)
	return err
}

func main() {
	dir := os.Getenv("MFT_SPIKE_DIR")
	if dir == "" {
		exe, _ := os.Executable()
		dir = filepath.Dir(exe)
	}
	var err error
	logFile, err = os.OpenFile(filepath.Join(dir, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(2)
	}
	ping := 20
	if v := os.Getenv("MFT_SPIKE_PING"); v != "" {
		ping, _ = strconv.Atoi(v)
	}
	logf("start", map[string]any{"args": os.Args, "ping_s": ping, "dir": dir})

	sock := filepath.Join(dir, fmt.Sprintf("ctl-%d.sock", os.Getpid()))
	os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		logf("ctl_listen_error", map[string]any{"err": err.Error()})
	} else {
		link := filepath.Join(dir, "ctl.sock")
		os.Remove(link)
		os.Symlink(sock, link)
		go serveCtl(ln)
		defer os.Remove(sock)
	}

	if ping > 0 {
		go func() {
			var seq int64
			for range time.Tick(time.Duration(ping) * time.Second) {
				seq++
				pendMu.Lock()
				pingSent[seq] = time.Now()
				pendMu.Unlock()
				if err := writeFrame(map[string]any{"type": "ping", "seq": seq}); err != nil {
					logf("ping_write_error", map[string]any{"err": err.Error()})
					return
				}
			}
		}()
	}

	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		buf, err := readFrame(in)
		if err != nil {
			logf("stdin_closed", map[string]any{"err": err.Error()})
			return
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(buf, &m); err != nil {
			logf("bad_frame", map[string]any{"len": len(buf)})
			continue
		}
		var typ string
		json.Unmarshal(m["type"], &typ)
		switch typ {
		case "pong":
			var seq int64
			json.Unmarshal(m["seq"], &seq)
			pendMu.Lock()
			sent := pingSent[seq]
			delete(pingSent, seq)
			pendMu.Unlock()
			var bg json.RawMessage = m["bgStart"]
			logf("pong", map[string]any{"seq": seq, "rtt_ms": float64(time.Since(sent).Microseconds()) / 1000, "bgStart": bg})
		case "echo":
			writeFrame(json.RawMessage(buf))
			logf("echo", map[string]any{"len": len(buf)})
		case "result":
			var id int64
			json.Unmarshal(m["id"], &id)
			pendMu.Lock()
			ch := pending[id]
			delete(pending, id)
			pendMu.Unlock()
			logf("result", map[string]any{"id": id, "len": len(buf)})
			if ch != nil {
				ch <- json.RawMessage(buf)
			}
		default:
			// hello, suspend, report and anything else: log the whole frame.
			// Spike frames carry only synthetic GreenMail data and timings.
			logf("frame", map[string]any{"type": typ, "frame": json.RawMessage(buf)})
		}
	}
}

func serveCtl(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) {
			defer c.Close()
			line, err := bufio.NewReaderSize(c, 4<<20).ReadBytes('\n')
			if err != nil && len(line) == 0 {
				return
			}
			var req map[string]json.RawMessage
			if err := json.Unmarshal(line, &req); err != nil {
				fmt.Fprintf(c, "{\"ok\":false,\"error\":%q}\n", err.Error())
				return
			}
			pendMu.Lock()
			nextID++
			id := nextID
			ch := make(chan json.RawMessage, 1)
			pending[id] = ch
			pendMu.Unlock()
			req["type"] = json.RawMessage(`"call"`)
			req["id"] = json.RawMessage(strconv.FormatInt(id, 10))
			timeout := 900 * time.Second
			if err := writeFrame(req); err != nil {
				fmt.Fprintf(c, "{\"ok\":false,\"error\":%q}\n", err.Error())
				return
			}
			logf("call", map[string]any{"id": id})
			select {
			case res := <-ch:
				c.Write(append(res, '\n'))
			case <-time.After(timeout):
				fmt.Fprintf(c, "{\"ok\":false,\"error\":\"timeout\"}\n")
			}
		}(c)
	}
}
