// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

package nativemsg

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	msg := []byte(`{"type":"hello"}`)
	if err := Write(&buf, msg); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	if n := binary.NativeEndian.Uint32(raw[:4]); int(n) != len(msg) {
		t.Fatalf("length prefix = %d, want %d", n, len(msg))
	}
	got, err := Read(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("got %q", got)
	}
}

func TestWriteRejectsOverMax(t *testing.T) {
	var buf bytes.Buffer
	err := Write(&buf, make([]byte, MaxOutgoing+1))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if buf.Len() != 0 {
		t.Fatal("wrote bytes despite rejection")
	}
	if err := Write(&buf, make([]byte, MaxOutgoing)); err != nil {
		t.Fatalf("exactly MaxOutgoing must be accepted: %v", err)
	}
}

func TestReadEOF(t *testing.T) {
	if _, err := Read(bytes.NewReader(nil)); err != io.EOF {
		t.Fatalf("err = %v, want io.EOF", err)
	}
}

func TestReadTruncated(t *testing.T) {
	hdr := make([]byte, 4)
	binary.NativeEndian.PutUint32(hdr, 10)
	if _, err := Read(bytes.NewReader(append(hdr, 'a', 'b'))); err != io.ErrUnexpectedEOF {
		t.Fatalf("truncated body: err = %v", err)
	}
	if _, err := Read(bytes.NewReader([]byte{1, 2})); err != io.ErrUnexpectedEOF {
		t.Fatalf("truncated header: err = %v", err)
	}
}

func TestReadRejectsOversizeIncoming(t *testing.T) {
	hdr := make([]byte, 4)
	binary.NativeEndian.PutUint32(hdr, MaxIncoming+1)
	if _, err := Read(bytes.NewReader(hdr)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}
