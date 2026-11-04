// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

package server

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// MaxBody is the largest HTTP request body the endpoint accepts.
const MaxBody = 1 << 20

const (
	rateLimit = 20 // requests a second per client
	rateBurst = 40
	// The per-client buckets keep clients fair with each other; the shared
	// bucket bounds what the host as a whole, and so the add-on behind it,
	// is asked to do, however many sessions a client opens.
	rateLimitAll = 200 // requests a second for all clients together
	rateBurstAll = 400
	// Idle limiters are dropped once there are this many, so a stream of
	// session ids cannot grow the table without bound.
	maxLimiters = 1024
	limiterIdle = time.Minute
)

// bodyReadTimeout bounds reading one request body (at most MaxBody bytes
// over loopback).
var bodyReadTimeout = 30 * time.Second

// Guard refuses everything that is not an authorised, same-machine,
// non-browser request of bounded size and rate before it reaches next.
// It never sets CORS headers.
func Guard(token string, port int, next http.Handler) http.Handler {
	return guard(func() string { return token }, port, next)
}

// guard is Guard with a token that may change (rotation). A request is
// checked against the token current when it arrives; streams already open
// continue.
func guard(token func() string, port int, next http.Handler) http.Handler {
	hosts := []string{"127.0.0.1:" + strconv.Itoa(port), "localhost:" + strconv.Itoa(port)}
	lim := &limiters{m: map[string]*limiter{}}
	known := &sessions{m: map[string]time.Time{}}
	all := rate.NewLimiter(rateLimitAll, rateBurstAll)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reading the body has a deadline from the start, so neither a
		// client that stalls mid body nor one refused before its body is
		// read can hold the connection: after a refusal the server would
		// otherwise wait, without limit, for the body it was promised. It
		// is lifted for every request that is let through: a whole-request
		// ReadTimeout would also cancel the long-lived streams and calls
		// that follow. After a refusal or a failed read it stays, and the
		// connection is closed.
		rc := http.NewResponseController(w)
		_ = rc.SetReadDeadline(time.Now().Add(bodyReadTimeout))
		refuse := func(msg string, code int) {
			w.Header().Set("Connection", "close")
			http.Error(w, msg, code)
		}
		// A browser always sends Origin on cross-origin and on POST requests;
		// MCP clients never do. Its presence, even empty, is refused.
		if _, ok := r.Header["Origin"]; ok {
			refuse("Forbidden", http.StatusForbidden)
			return
		}
		if !hostAllowed(r.Host, hosts) {
			refuse("Forbidden", http.StatusForbidden)
			return
		}
		if !authorised(r.Header.Get("Authorization"), token()) {
			refuse("Unauthorized", http.StatusUnauthorized)
			return
		}
		if !lim.allow(clientKey(r, known)) || !all.Allow() {
			w.Header().Set("Retry-After", "1")
			refuse("Too Many Requests", http.StatusTooManyRequests)
			return
		}
		if r.ContentLength > MaxBody {
			refuse("Request Entity Too Large", http.StatusRequestEntityTooLarge)
			return
		}
		if r.Body != nil && r.Body != http.NoBody {
			body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
			r.Body.Close()
			if err != nil {
				refuse("Bad Request", http.StatusBadRequest)
				return
			}
			if len(body) > MaxBody {
				refuse("Request Entity Too Large", http.StatusRequestEntityTooLarge)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
		}
		_ = rc.SetReadDeadline(time.Time{})
		next.ServeHTTP(&sessionWriter{ResponseWriter: w, known: known}, r)
	})
}

func hostAllowed(host string, allowed []string) bool {
	for _, a := range allowed {
		if strings.EqualFold(host, a) {
			return true
		}
	}
	return false
}

// authorised compares the bearer token in constant time. The scheme is
// case-insensitive (RFC 7235); an empty configured token authorises nothing.
func authorised(header, token string) bool {
	if token == "" || len(header) < 7 || !strings.EqualFold(header[:7], "Bearer ") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header[7:]), []byte(token)) == 1
}

// clientKey identifies a client for rate limiting (Ruling R4): its MCP
// session when the host issued it, else its remote address. Every client
// shares the one token, so the token cannot be the key. A session id the
// host did not issue (made up, too long, or forgotten) shares one bucket
// with every other such id, so fresh ids cannot buy fresh bursts; the SDK
// then refuses the request anyway. Session ids are keyed by a hash, which
// bounds the key's length.
func clientKey(r *http.Request, known *sessions) string {
	if id := r.Header.Get("Mcp-Session-Id"); id != "" {
		if len(id) > maxSessionID {
			return "s:unknown"
		}
		h := sessionHash(id)
		if !known.seen(h) {
			return "s:unknown"
		}
		return "s:" + h
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return "a:" + host
}

// maxSessionID is the longest session id taken as one the host may have
// issued; the SDK's are far shorter.
const maxSessionID = 256

func sessionHash(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:16])
}

// sessions holds the hashes of the session ids the host issued, with when
// each was last used, at most maxLimiters of them.
type sessions struct {
	mu sync.Mutex
	m  map[string]time.Time
}

func (ss *sessions) seen(h string) bool {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if _, ok := ss.m[h]; !ok {
		return false
	}
	ss.m[h] = time.Now()
	return true
}

// add records an issued session id; when full, the session used least
// recently is forgotten (it then shares the unknown-session bucket).
func (ss *sessions) add(id string) {
	if id == "" || len(id) > maxSessionID {
		return
	}
	h := sessionHash(id)
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if _, ok := ss.m[h]; !ok && len(ss.m) >= maxLimiters {
		var oldest string
		var at time.Time
		for k, v := range ss.m {
			if oldest == "" || v.Before(at) {
				oldest, at = k, v
			}
		}
		delete(ss.m, oldest)
	}
	ss.m[h] = time.Now()
}

// sessionWriter learns the session id the SDK issues in a successful
// initialize answer. It passes Flush and Unwrap through, so streaming and
// http.ResponseController keep working.
type sessionWriter struct {
	http.ResponseWriter
	known *sessions
	wrote bool
}

func (w *sessionWriter) WriteHeader(code int) {
	if !w.wrote {
		w.wrote = true
		if code >= 200 && code < 300 {
			w.known.add(w.Header().Get("Mcp-Session-Id"))
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *sessionWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *sessionWriter) Flush() {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *sessionWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type limiter struct {
	l    *rate.Limiter
	seen time.Time
}

type limiters struct {
	mu sync.Mutex
	m  map[string]*limiter
}

func (ls *limiters) allow(key string) bool {
	now := time.Now()
	ls.mu.Lock()
	defer ls.mu.Unlock()
	l := ls.m[key]
	if l == nil {
		if len(ls.m) >= maxLimiters {
			for k, v := range ls.m {
				if now.Sub(v.seen) > limiterIdle {
					delete(ls.m, k)
				}
			}
		}
		if len(ls.m) >= maxLimiters {
			// Still full of live entries: share one overflow bucket rather
			// than let fresh session ids buy fresh bursts.
			key = "overflow"
			if l = ls.m[key]; l == nil {
				l = &limiter{l: rate.NewLimiter(rateLimit, rateBurst)}
				ls.m[key] = l
			}
		} else {
			l = &limiter{l: rate.NewLimiter(rateLimit, rateBurst)}
			ls.m[key] = l
		}
	}
	l.seen = now
	return l.l.AllowN(now, 1)
}
