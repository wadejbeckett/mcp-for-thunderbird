// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testPort  = 47110
)

// okHandler records that the guard let the request through and echoes the
// body length so the size cap can be checked.
func okHandler(reached *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*reached = true
		n, _ := io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, strings.Repeat("x", int(n%7)))
	})
}

func goodRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	r.Host = "127.0.0.1:47110"
	r.RemoteAddr = "127.0.0.1:50000"
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func serve(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestGoodRequestPasses(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	for _, host := range []string{"127.0.0.1:47110", "localhost:47110"} {
		r := goodRequest("{}")
		r.Host = host
		if w := serve(g, r); w.Code != http.StatusOK || !reached {
			t.Fatalf("host %s: status %d reached %v", host, w.Code, reached)
		}
	}
}

func TestNoTokenIs401(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	r := goodRequest("{}")
	r.Header.Del("Authorization")
	if w := serve(g, r); w.Code != http.StatusUnauthorized || reached {
		t.Fatalf("status %d reached %v, want 401 and not reached", w.Code, reached)
	}
}

func TestWrongTokenIs401(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	for _, auth := range []string{
		"Bearer " + strings.Repeat("0", 64),
		"Bearer " + testToken[:63],
		"Bearer " + testToken + "0",
		"bearer " + testToken + " ",
		testToken,
		"Basic " + testToken,
	} {
		r := goodRequest("{}")
		r.Header.Set("Authorization", auth)
		if w := serve(g, r); w.Code != http.StatusUnauthorized || reached {
			t.Fatalf("auth %q: status %d reached %v, want 401", auth, w.Code, reached)
		}
	}
	// An empty configured token never authorises anything.
	g = Guard("", testPort, okHandler(&reached))
	r := goodRequest("{}")
	r.Header.Set("Authorization", "Bearer ")
	if w := serve(g, r); w.Code != http.StatusUnauthorized || reached {
		t.Fatalf("empty token: status %d reached %v, want 401", w.Code, reached)
	}
}

func TestOriginIs403(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	for _, origin := range []string{"https://evil.example", "http://127.0.0.1:47110", "null", ""} {
		r := goodRequest("{}")
		r.Header["Origin"] = []string{origin}
		if w := serve(g, r); w.Code != http.StatusForbidden || reached {
			t.Fatalf("origin %q: status %d reached %v, want 403", origin, w.Code, reached)
		}
	}
}

func TestForeignHostIs403(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	for _, host := range []string{
		"evil.example:47110", "127.0.0.1:47111", "localhost", "127.0.0.1",
		"[::1]:47110", "127.0.0.1.evil.example:47110", "localhost.:47110", "",
	} {
		r := goodRequest("{}")
		r.Host = host
		if w := serve(g, r); w.Code != http.StatusForbidden || reached {
			t.Fatalf("host %q: status %d reached %v, want 403", host, w.Code, reached)
		}
	}
}

func TestBodyOver1MiBIs413(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))

	// Exactly 1 MiB passes.
	if w := serve(g, goodRequest(strings.Repeat("a", 1<<20))); w.Code != http.StatusOK || !reached {
		t.Fatalf("1 MiB: status %d reached %v, want 200", w.Code, reached)
	}
	reached = false

	// Declared length over the cap.
	if w := serve(g, goodRequest(strings.Repeat("a", 1<<20+1))); w.Code != http.StatusRequestEntityTooLarge || reached {
		t.Fatalf("declared: status %d reached %v, want 413", w.Code, reached)
	}

	// Unknown length (chunked) over the cap.
	r := goodRequest("")
	r.Body = io.NopCloser(strings.NewReader(strings.Repeat("a", 1<<20+1)))
	r.ContentLength = -1
	if w := serve(g, r); w.Code != http.StatusRequestEntityTooLarge || reached {
		t.Fatalf("chunked: status %d reached %v, want 413", w.Code, reached)
	}
}

func TestRateLimit429(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	limited := 0
	for i := 0; i < 60; i++ {
		w := serve(g, goodRequest("{}"))
		if w.Code == http.StatusTooManyRequests {
			limited++
		}
	}
	// Burst of 40, refilling at 20/s: a tight loop of 60 sees roughly 20 refusals.
	if limited < 10 || limited > 20 {
		t.Fatalf("limited %d of 60, want about 20 (burst 40)", limited)
	}

	// A different MCP session has its own bucket (R4).
	r := goodRequest("{}")
	r.Header.Set("Mcp-Session-Id", "other-session")
	if w := serve(g, r); w.Code != http.StatusOK {
		t.Fatalf("other session: status %d, want 200", w.Code)
	}

	// Unauthenticated requests are refused before they reach the limiter.
	bad := goodRequest("{}")
	bad.Header.Del("Authorization")
	if w := serve(g, bad); w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: status %d, want 401", w.Code)
	}
}

func TestNoCORSHeaders(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	reqs := []*http.Request{goodRequest("{}")}
	pre := goodRequest("")
	pre.Method = http.MethodOptions
	pre.Header.Set("Origin", "https://evil.example")
	pre.Header.Set("Access-Control-Request-Method", "POST")
	reqs = append(reqs, pre)
	noAuth := goodRequest("{}")
	noAuth.Header.Del("Authorization")
	reqs = append(reqs, noAuth)
	for _, r := range reqs {
		w := serve(g, r)
		for k := range w.Header() {
			if strings.HasPrefix(strings.ToLower(k), "access-control-") {
				t.Fatalf("%s %s: response carries %s", r.Method, r.URL, k)
			}
		}
	}
}
