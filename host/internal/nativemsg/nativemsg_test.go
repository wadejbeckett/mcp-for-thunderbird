// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
