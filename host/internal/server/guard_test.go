// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package server

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

	// A session id the host never issued shares one bucket with all the
	// others like it; it is not a fresh burst (see TestSessionBuckets).

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

// A client that stalls while sending its body is cut off after
// bodyReadTimeout instead of holding the connection for ever.
func TestStalledBodyCutOff(t *testing.T) {
	old := bodyReadTimeout
	bodyReadTimeout = 200 * time.Millisecond
	t.Cleanup(func() { bodyReadTimeout = old })
	var reached bool
	hs := httptest.NewUnstartedServer(nil)
	addr := hs.Listener.Addr().String()
	hs.Config.Handler = guard(func() string { return testToken }, hs.Listener.Addr().(*net.TCPAddr).Port, okHandler(&reached))
	hs.Start()
	t.Cleanup(hs.Close)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "POST /mcp HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"half\":", addr, testToken)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	start := time.Now()
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", resp.StatusCode)
		}
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("connection still open 3 s into a stalled body")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("cut off after %v", el)
	}
	if reached {
		t.Fatal("a stalled body reached the handler")
	}
}

// issuing answers like the SDK's initialize: with the session id it issues.
func issuing(id string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Mcp-Session-Id") == "" {
			w.Header().Set("Mcp-Session-Id", id)
		}
		w.WriteHeader(http.StatusOK)
	})
}

// R4: a session the host issued has its own bucket; session ids a client
// makes up share one, so they cannot buy fresh bursts, and an id of any
// length makes a short key.
func TestSessionBuckets(t *testing.T) {
	g := Guard(testToken, testPort, issuing("issued-1"))
	if w := serve(g, goodRequest("{}")); w.Code != http.StatusOK {
		t.Fatalf("initialize: status %d", w.Code)
	}
	limited := 0
	for i := 0; i < 60; i++ {
		r := goodRequest("{}")
		r.Header.Set("Mcp-Session-Id", "made-up-"+strconv.Itoa(i))
		if serve(g, r).Code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited < 10 {
		t.Fatalf("made-up session ids: %d of 60 limited, want them to share one bucket", limited)
	}
	r := goodRequest("{}")
	r.Header.Set("Mcp-Session-Id", "issued-1")
	if w := serve(g, r); w.Code != http.StatusOK {
		t.Fatalf("issued session: status %d, want 200 from its own bucket", w.Code)
	}

	known := &sessions{m: map[string]time.Time{}}
	r = goodRequest("{}")
	r.Header.Set("Mcp-Session-Id", strings.Repeat("x", 10000))
	if k := clientKey(r, known); len(k) > 64 {
		t.Fatalf("key of %d bytes for a long session id", len(k))
	}
	known.add("abc")
	r.Header.Set("Mcp-Session-Id", "abc")
	if k := clientKey(r, known); k == "s:unknown" || len(k) > 64 {
		t.Fatalf("issued session key = %q", k)
	}
}

// A request refused before its body is read (here for want of a token)
// is answered with "Connection: close", and the body it announced but
// never sends cannot hold the connection open: the server gives up on it
// after bodyReadTimeout.
func TestRefusedRequestDoesNotHoldConnection(t *testing.T) {
	var reached bool
	g := Guard(testToken, testPort, okHandler(&reached))
	r := goodRequest("{}")
	r.Header.Del("Authorization")
	if w := serve(g, r); w.Code != http.StatusUnauthorized || w.Header().Get("Connection") != "close" {
		t.Errorf("status %d Connection %q, want 401 and close", w.Code, w.Header().Get("Connection"))
	}

	old := bodyReadTimeout
	bodyReadTimeout = 200 * time.Millisecond
	t.Cleanup(func() { bodyReadTimeout = old })
	hs := httptest.NewUnstartedServer(nil)
	addr := hs.Listener.Addr().String()
	hs.Config.Handler = guard(func() string { return testToken }, hs.Listener.Addr().(*net.TCPAddr).Port, okHandler(&reached))
	hs.Start()
	t.Cleanup(hs.Close)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "POST /mcp HTTP/1.1\r\nHost: %s\r\nContent-Length: 100000\r\n\r\n", addr)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	start := time.Now()
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("no response: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || !resp.Close {
		t.Fatalf("status %d close %v, want 401 and Connection: close", resp.StatusCode, resp.Close)
	}
	_, err = br.ReadByte()
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("connection still open 3 s after a refused request")
	}
	if err == nil {
		t.Fatal("server sent more after a refusal")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("closed after %v", el)
	}
	if reached {
		t.Fatal("a refused request reached the handler")
	}
}

// Every authorised request also draws on one bucket shared by all
// clients, so many sessions together cannot ask more of the host than it
// allows as a whole.
func TestSharedRateLimit(t *testing.T) {
	var n atomic.Int64
	g := Guard(testToken, testPort, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Mcp-Session-Id") == "" {
			w.Header().Set("Mcp-Session-Id", "issued-"+strconv.FormatInt(n.Add(1), 10))
		}
		w.WriteHeader(http.StatusOK)
	}))
	const clients, each = 20, 30 // each stays inside its own burst of 40
	ids := make([]string, clients)
	for i := range ids {
		w := serve(g, goodRequest("{}"))
		if w.Code != http.StatusOK {
			t.Fatalf("initialize %d: status %d", i, w.Code)
		}
		ids[i] = w.Header().Get("Mcp-Session-Id")
	}
	var limited atomic.Int64
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			for j := 0; j < each; j++ {
				r := goodRequest("{}")
				r.Header.Set("Mcp-Session-Id", id)
				if serve(g, r).Code == http.StatusTooManyRequests {
					limited.Add(1)
				}
			}
		}(id)
	}
	wg.Wait()
	// 600 requests against a shared burst of 400 (less the 20 initialize
	// requests), refilling at 200 a second: about 200 are refused.
	if l := limited.Load(); l < 100 || l > 220 {
		t.Fatalf("%d of %d limited, want about 200 (shared burst 400)", l, clients*each)
	}
}
