// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
// Package files confines attachment reads and writes to the single folder the
// user chose in the add-on's options.
package files

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/acl"
)

// MaxSize is the largest attachment accepted, 50 MiB.
const MaxSize = 50 << 20

// MaxNameBytes is the longest file name Save creates, suffix included;
// most file systems allow 255 bytes.
const MaxNameBytes = 200

// maxExtBytes is the longest extension kept apart from the stem; a longer
// "extension" is treated as part of the name.
const maxExtBytes = 32

var (
	// ErrOutside means the name or its resolved path leaves the folder.
	ErrOutside = errors.New("files: path is outside the attachment folder")
	// ErrTooLarge means the file is over MaxSize.
	ErrTooLarge = errors.New("files: attachment is larger than 50 MiB")
	// ErrNoDir means no usable absolute attachment folder is configured.
	ErrNoDir = errors.New("files: no attachment folder is set")
	// ErrNotRegular means the name is a folder, FIFO, device or other
	// special file, which is never read.
	ErrNotRegular = errors.New("files: not a regular file")
)

func checkDir(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) {
		return ErrNoDir
	}
	return nil
}

// sanitise reduces name to a safe base name. It drops control characters,
// characters Windows does not allow in names, the bidirectional controls
// (such as a right-to-left override) and the invisible zero width space
// and byte order mark, all of which can make a name show as something it
// is not. Other format characters stay: the zero width non-joiner is part
// of correct Persian, Urdu and Indic spellings, and the zero width joiner
// builds emoji sequences.
func sanitise(name string) string {
	name = strings.NewReplacer(`\`, "/").Replace(name)
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || disguise(r) || strings.ContainsRune(`:*?"<>|`, r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimRight(strings.TrimSpace(name), ". ")
	if name == "" {
		return "attachment"
	}
	if reserved(name) {
		name = "_" + name
	}
	return name
}

// disguise reports whether r is a bidirectional control (U+061C,
// U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), the zero width
// space U+200B or the byte order mark U+FEFF.
func disguise(r rune) bool {
	switch {
	case r == 0x061c, r == 0x200b, r == 0x200e, r == 0x200f, r == 0xfeff:
		return true
	case r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// reserved reports whether Windows would open a device for name: CON,
// PRN, AUX, NUL, CONIN$, CONOUT$, COM1-9 or LPT1-9 (also with superscript
// 1-3), in any case, alone or before any extension or stream name,
// ignoring trailing spaces. Such names are prefixed on every platform, so
// a folder synced to Windows is safe too.
func reserved(name string) bool {
	stem := name
	if i := strings.IndexAny(stem, ".:"); i >= 0 {
		stem = stem[:i]
	}
	stem = strings.ToUpper(strings.TrimRight(stem, " "))
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if r := []rune(stem); len(r) == 4 && (string(r[:3]) == "COM" || string(r[:3]) == "LPT") {
		return (r[3] >= '1' && r[3] <= '9') || r[3] == '¹' || r[3] == '²' || r[3] == '³'
	}
	return false
}

// cut shortens s to at most n bytes without splitting a UTF-8 sequence.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 0 {
		return ""
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// fit joins stem, suffix and ext, shortening the stem so the whole name is
// at most MaxNameBytes. A shortened stem loses trailing dots and spaces.
func fit(stem, suffix, ext string) string {
	short := cut(stem, MaxNameBytes-len(suffix)-len(ext))
	if short != stem {
		short = strings.TrimRight(short, ". ")
	}
	if short == "" {
		short = "attachment"
	}
	return short + suffix + ext
}

// mkdirPrivate creates dir and any missing parents, each private to the
// current user (0700, or an owner-only DACL on Windows, where the mode has
// no effect). Folders that already exist are left as they are.
func mkdirPrivate(dir string) error {
	var missing []string
	for p := filepath.Clean(dir); ; p = filepath.Dir(p) {
		if _, err := os.Lstat(p); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		missing = append(missing, p)
		if filepath.Dir(p) == p {
			break
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for i := len(missing) - 1; i >= 0; i-- {
		if err := acl.OwnerOnly(missing[i]); err != nil {
			return err
		}
	}
	return nil
}

// Save writes data into dir under a sanitised name, never overwriting an
// existing file, and returns its absolute path with symlinks resolved. A
// missing dir is created private to the user; the file is too (0600, or an
// owner-only DACL on Windows).
func Save(dir, name string, data []byte) (string, error) {
	if err := checkDir(dir); err != nil {
		return "", err
	}
	if len(data) > MaxSize {
		return "", ErrTooLarge
	}
	if err := mkdirPrivate(dir); err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	base := sanitise(name)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" || len(ext) > maxExtBytes { // dotfile such as ".bashrc", or no real extension
		stem, ext = base, ""
	}
	for i := 1; i < 10000; i++ {
		candidate := fit(stem, "", ext)
		if i > 1 {
			candidate = fit(stem, fmt.Sprintf(" (%d)", i), ext)
		}
		p := filepath.Join(real, candidate)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if err := acl.OwnerOnly(p); err != nil { // 0600 is a no-op on Windows
			f.Close()
			os.Remove(p)
			return "", err
		}
		_, werr := f.Write(data)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			os.Remove(p)
			return "", errors.Join(werr, cerr)
		}
		return p, nil
	}
	return "", errors.New("files: too many files with the same name")
}

// localName reports whether name names an entry directly inside a
// folder on goos. On Windows it also refuses names Windows would read as
// something else: a colon (a drive or an NTFS alternate data stream such
// as "a.txt:hidden"), a device name such as CON or NUL, and a name made
// only of dots and spaces, which Windows trims to the folder or its parent.
func localName(goos, name string) bool {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) ||
		strings.ContainsRune(name, 0) {
		return false
	}
	if goos == "windows" {
		if strings.ContainsRune(name, ':') || reserved(name) || strings.TrimRight(name, ". ") == "" {
			return false
		}
	}
	return true
}

// ReadForDraft reads a regular file named name from directly inside dir.
// Path separators, "..", absolute names, names Windows would read as a
// device or another stream, and symlinks that resolve outside dir are
// refused with ErrOutside. Anything but a regular file (a folder, a FIFO,
// a device) is refused without being opened for reading, so it cannot
// block the host.
func ReadForDraft(dir, name string) ([]byte, string, error) {
	if err := checkDir(dir); err != nil {
		return nil, "", err
	}
	if !localName(runtime.GOOS, name) || !filepath.IsLocal(name) ||
		filepath.IsAbs(name) || filepath.VolumeName(name) != "" {
		return nil, "", ErrOutside
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, "", err
	}
	realFile, err := filepath.EvalSymlinks(filepath.Join(realDir, name))
	if err != nil {
		return nil, "", err
	}
	rel, err := filepath.Rel(realDir, realFile)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, "", ErrOutside
	}
	// realFile has no links left, so Lstat describes the file itself.
	before, err := os.Lstat(realFile)
	if err != nil {
		return nil, "", err
	}
	if !before.Mode().IsRegular() {
		return nil, "", ErrNotRegular
	}
	if before.Size() > MaxSize {
		return nil, "", ErrTooLarge
	}
	// openFlags never waits for a writer, should the file have been
	// swapped for a FIFO since the check above.
	f, err := os.OpenFile(realFile, os.O_RDONLY|openFlags, 0)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, "", err
	}
	if !st.Mode().IsRegular() || !os.SameFile(before, st) {
		return nil, "", ErrNotRegular
	}
	if st.Size() > MaxSize {
		return nil, "", ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxSize+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > MaxSize {
		return nil, "", ErrTooLarge
	}
	return data, name, nil
}
