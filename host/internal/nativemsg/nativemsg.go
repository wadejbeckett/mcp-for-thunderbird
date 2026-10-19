// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package nativemsg implements WebExtension native-messaging framing: a
// 4-byte length in the machine's native byte order followed by the message.
package nativemsg

import (
	"encoding/binary"
	"errors"
	"io"
)

const (
	// MaxOutgoing is the largest message a host may send to the browser.
	MaxOutgoing = 1 << 20
	// MaxIncoming bounds what the host accepts from the add-on: a 50 MiB
	// attachment base64-encoded plus envelope fits well inside it.
	MaxIncoming = 96 << 20
)

// ErrTooLarge reports a message over the size limit.
var ErrTooLarge = errors.New("nativemsg: message too large")

// Read reads one framed message. It returns io.EOF when the stream ends
// cleanly before a frame and io.ErrUnexpectedEOF when a frame is cut short.
func Read(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err // io.EOF for zero bytes, ErrUnexpectedEOF for 1-3
	}
	n := binary.NativeEndian.Uint32(hdr[:])
	if n > MaxIncoming {
		return nil, ErrTooLarge
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return buf, nil
}

// Write writes one framed message in a single Write call.
func Write(w io.Writer, msg []byte) error {
	if len(msg) > MaxOutgoing {
		return ErrTooLarge
	}
	frame := make([]byte, 4+len(msg))
	binary.NativeEndian.PutUint32(frame, uint32(len(msg)))
	copy(frame[4:], msg)
	_, err := w.Write(frame)
	return err
}
