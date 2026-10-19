// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package server

import (
	"bytes"
	"crypto/subtle"
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
	// Idle limiters are dropped once there are this many, so a stream of
	// session ids cannot grow the table without bound.
	maxLimiters = 1024
	limiterIdle = time.Minute
)

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
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A browser always sends Origin on cross-origin and on POST requests;
		// MCP clients never do. Its presence, even empty, is refused.
		if _, ok := r.Header["Origin"]; ok {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if !hostAllowed(r.Host, hosts) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if !authorised(r.Header.Get("Authorization"), token()) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if !lim.allow(clientKey(r)) {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		if r.ContentLength > MaxBody {
			http.Error(w, "Request Entity Too Large", http.StatusRequestEntityTooLarge)
			return
		}
		if r.Body != nil && r.Body != http.NoBody {
			body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
			r.Body.Close()
			if err != nil {
				http.Error(w, "Bad Request", http.StatusBadRequest)
				return
			}
			if len(body) > MaxBody {
				http.Error(w, "Request Entity Too Large", http.StatusRequestEntityTooLarge)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
		}
		next.ServeHTTP(w, r)
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
// session when it has one, else its remote address. Every client shares
// the one token, so the token cannot be the key.
func clientKey(r *http.Request) string {
	if id := r.Header.Get("Mcp-Session-Id"); id != "" {
		return "s:" + id
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return "a:" + host
}

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
