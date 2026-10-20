// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Package connfile manages the per-instance connection file that holds the
// local endpoint's port and bearer token, and the choice of listening port.
package connfile

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/acl"
)

const (
	// PortMin and PortMax bound the ports the host will listen on.
	PortMin = 47110
	PortMax = 47119
)

var instanceRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Conn is the content of one connection file.
type Conn struct {
	Instance  string    `json:"instance"`
	Port      int       `json:"port"`
	Token     string    `json:"token"`
	PID       int       `json:"pid"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Dir returns the directory holding connection files.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "mcp-for-thunderbird"), nil
}

func validInstance(instance string) error {
	if !instanceRE.MatchString(instance) {
		return errors.New("connfile: invalid instance id")
	}
	return nil
}

func pathFor(instance string) (string, error) {
	if err := validInstance(instance); err != nil {
		return "", err
	}
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "connection-"+instance+".json"), nil
}

// Load reads the connection file of one instance.
func Load(instance string) (*Conn, error) {
	p, err := pathFor(instance)
	if err != nil {
		return nil, err
	}
	return read(p)
}

func read(path string) (*Conn, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Conn
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("connfile: %s: %w", filepath.Base(path), err)
	}
	if validInstance(c.Instance) != nil {
		return nil, fmt.Errorf("connfile: %s: invalid instance", filepath.Base(path))
	}
	return &c, nil
}

// Save stamps c.UpdatedAt and writes the file atomically with owner-only
// access (0600 on Unix, a protected owner-only DACL on Windows).
func Save(c *Conn) error {
	p, err := pathFor(c.Instance)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	c.UpdatedAt = time.Now().UTC()
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".connection-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := acl.OwnerOnly(name); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(b); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, p); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// NewToken returns 32 random bytes as 64 lowercase hex characters.
func NewToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("connfile: no randomness: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// Rotate replaces c.Token with a fresh token and saves the file.
func Rotate(c *Conn) error {
	old := c.Token
	c.Token = NewToken()
	if err := Save(c); err != nil {
		c.Token = old
		return err
	}
	return nil
}

// PickPort listens on 127.0.0.1 at the preferred port if it is free, else on
// the first free port in 47110-47119.
func PickPort(preferred int) (net.Listener, int, error) {
	try := func(p int) (net.Listener, int, bool) {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			return nil, 0, false
		}
		return ln, p, true
	}
	if preferred >= PortMin && preferred <= PortMax {
		if ln, p, ok := try(preferred); ok {
			return ln, p, nil
		}
	}
	for p := PortMin; p <= PortMax; p++ {
		if p == preferred {
			continue
		}
		if ln, p, ok := try(p); ok {
			return ln, p, nil
		}
	}
	return nil, 0, fmt.Errorf("connfile: no free port in %d-%d", PortMin, PortMax)
}

// Newest returns the most recently updated connection file.
func Newest() (*Conn, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var best *Conn
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, "connection-") || !strings.HasSuffix(n, ".json") {
			continue
		}
		c, err := read(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		if best == nil || c.UpdatedAt.After(best.UpdatedAt) {
			best = c
		}
	}
	if best == nil {
		return nil, errors.New("connfile: no connection file found; is MCP for Thunderbird running?")
	}
	return best, nil
}
