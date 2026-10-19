// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Package files confines attachment reads and writes to the single folder the
// user chose in the add-on's options.
package files

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
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
)

func checkDir(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) {
		return ErrNoDir
	}
	return nil
}

// sanitise reduces name to a safe base name.
func sanitise(name string) string {
	name = strings.NewReplacer(`\`, "/").Replace(name)
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`:*?"<>|`, r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimRight(strings.TrimSpace(name), ". ")
	if name == "" {
		return "attachment"
	}
	return name
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

// Save writes data into dir under a sanitised name, never overwriting an
// existing file, and returns the absolute path. dir is created with 0700.
func Save(dir, name string, data []byte) (string, error) {
	if err := checkDir(dir); err != nil {
		return "", err
	}
	if len(data) > MaxSize {
		return "", ErrTooLarge
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
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

// ReadForDraft reads a regular file named name from directly inside dir.
// Path separators, "..", absolute names and symlinks that resolve outside dir
// are refused with ErrOutside.
func ReadForDraft(dir, name string) ([]byte, string, error) {
	if err := checkDir(dir); err != nil {
		return nil, "", err
	}
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) ||
		filepath.IsAbs(name) || filepath.VolumeName(name) != "" || strings.ContainsRune(name, 0) {
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
	f, err := os.Open(realFile)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, "", err
	}
	if !st.Mode().IsRegular() {
		return nil, "", errors.New("files: not a regular file")
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
