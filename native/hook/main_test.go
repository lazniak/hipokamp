package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestParseArgs(t *testing.T) {
	o := parseArgs([]string{"--bun", "C:/bun/bun.exe", "--hook-ts", "D:/r/src/hooks/hook.ts", "Stop", "codex"})
	if o.event != "stop" || !o.codex || o.bun != "C:/bun/bun.exe" || o.hookTs != "D:/r/src/hooks/hook.ts" {
		t.Fatalf("zły podział argumentów: %+v", o)
	}
	if o := parseArgs([]string{"prompt"}); o.event != "prompt" || o.codex {
		t.Fatalf("zły podział argumentów: %+v", o)
	}
}

func TestEndpointOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HIPOKAMP_PORT", "")
	if got, port := endpoint(home); got != "http://127.0.0.1:47777" || port != 47777 {
		t.Fatalf("domyślny: %s %d", got, port)
	}
	_ = os.WriteFile(filepath.Join(home, "worker.lock.json"), []byte(`{"pid":1,"port":40001}`), 0o644)
	if got, port := endpoint(home); got != "http://127.0.0.1:40001" || port != 40001 {
		t.Fatalf("z blokady workera: %s %d", got, port)
	}
	_ = os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"$comment":"x","port":40002}`), 0o644)
	if got, port := endpoint(home); got != "http://127.0.0.1:40002" || port != 40002 {
		t.Fatalf("z config.json: %s %d", got, port)
	}
	t.Setenv("HIPOKAMP_PORT", "40003")
	if got, port := endpoint(home); got != "http://127.0.0.1:40003" || port != 40003 {
		t.Fatalf("z HIPOKAMP_PORT: %s %d", got, port)
	}
}

func TestSpoolOnlyForIngest(t *testing.T) {
	home := t.TempDir()
	in := []byte(`{"session_id":"s1","transcript_path":"C:/t/s1.jsonl","cwd":"C:/p"}`)
	spool(options{event: "prompt"}, home, in, os.ErrNotExist)
	if _, err := os.Stat(filepath.Join(home, "spool", "pending.jsonl")); err == nil {
		t.Fatal("prompt nie idzie do spoolu")
	}
	spool(options{event: "stop", codex: true}, home, in, os.ErrNotExist)
	b, err := os.ReadFile(filepath.Join(home, "spool", "pending.jsonl"))
	if err != nil || len(b) == 0 {
		t.Fatalf("stop powinien trafić do spoolu: %v", err)
	}
}

// Obcy proces na porcie workera (T-17) nie może zablokować promptu, zatrzymać Claude ani zalać kontekstu.
func TestBuildOutputOnlyContext(t *testing.T) {
	cases := map[string]string{
		"block":       `{"decision":"block","reason":"x","continue":false,"stopReason":"y","suppressOutput":true}`,
		"mieszane":    `{"decision":"block","continue":false,"systemMessage":"z","hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"ok","permissionDecision":"deny"}}`,
		"nie-napis":   `{"hookSpecificOutput":{"additionalContext":{"a":1}}}`,
		"liczba":      `{"hookSpecificOutput":{"additionalContext":42}}`,
		"zły-kształt": `{"hookSpecificOutput":"tekst"}`,
		"pusty":       `{"hookSpecificOutput":{"additionalContext":"  "}}`,
		"napis":       `"tylko napis"`,
	}
	for name, raw := range cases {
		out := buildOutput("prompt", json.RawMessage(raw))
		if name == "mieszane" {
			if string(out) != `{"hookSpecificOutput":{"additionalContext":"ok","hookEventName":"UserPromptSubmit"}}` {
				t.Fatalf("%s: %s", name, out)
			}
			continue
		}
		if out != nil {
			t.Fatalf("%s: wynik powinien być pusty, jest %s", name, out)
		}
	}
	if out := buildOutput("stop", json.RawMessage(`{"hookSpecificOutput":{"additionalContext":"x"}}`)); out != nil {
		t.Fatalf("zapis tury nie wypisuje nic: %s", out)
	}
}

func TestLimitContextUTF16(t *testing.T) {
	huge := strings.Repeat("Zą😀", 20_000)
	raw, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]string{"additionalContext": huge}})
	out := buildOutput("post-tool", raw)
	var o struct {
		HookSpecificOutput struct{ HookEventName, AdditionalContext string }
	}
	if err := json.Unmarshal(out, &o); err != nil {
		t.Fatal(err)
	}
	s := o.HookSpecificOutput.AdditionalContext
	n := 0
	for _, r := range s {
		n += utf16Len(r)
	}
	if n > maxContext || !utf8.ValidString(s) || o.HookSpecificOutput.HookEventName != "PostToolUse" {
		t.Fatalf("limit: %d znaków UTF-16, poprawny UTF-8: %v, zdarzenie %s", n, utf8.ValidString(s), o.HookSpecificOutput.HookEventName)
	}
	if !strings.HasSuffix(s, "(ucięte do limitu hooka; reszta: search / timeline)") {
		t.Fatal("brak dopisku o ucięciu")
	}
	if limitContext("krótki", maxContext) != "krótki" {
		t.Fatal("krótki tekst bez zmian")
	}
}

// Odpowiedź 3xx z portu workera (obcy proces) nie przenosi payloadu pod inny adres: ani 307 (powtórzony POST),
// ani 302 (GET); hook dostaje błąd i przechodzi na zapas w hooku Buna. Przekierowanie na samym wyzwaniu i na
// żądaniu właściwym (serwer zna klucz, ale przekierowuje POST).
func TestNoRedirects(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"output":null}`))
	}))
	defer target.Close()
	key := testKey()
	for _, onAuth := range []bool{true, false} {
		for _, code := range []int{http.StatusTemporaryRedirect, http.StatusFound, http.StatusPermanentRedirect} {
			var evil *httptest.Server
			evil = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth" && !onAuth {
					fakeAuth(w, r, key, portOf(evil.URL))
					return
				}
				http.Redirect(w, r, target.URL+"/zbieracz", code)
			}))
			wk := worker{base: evil.URL, port: portOf(evil.URL), key: key}
			data, err := wk.post("/api/hook/prompt", []byte(`{"input":{"prompt":"tajne"}}`), 2*time.Second)
			evil.Close()
			if err == nil || data != nil {
				t.Fatalf("HTTP %d (wyzwanie: %v): przekierowanie powinno dać błąd, jest %q", code, onAuth, data)
			}
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("payload poszedł za przekierowaniem (%d żądań)", n)
	}
}

func testKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

func portOf(u string) int {
	_, p, _ := net.SplitHostPort(strings.TrimPrefix(u, "http://"))
	n, _ := strconv.Atoi(p)
	return n
}

// fakeAuth: krok 1 po stronie workera z kluczem (jak /api/auth w src/worker/server.ts).
func fakeAuth(w http.ResponseWriter, r *http.Request, key []byte, port int) string {
	nc := r.Header.Get("x-hipokamp-challenge")
	nw := "0123456789abcdef0123456789abcdef"
	_ = json.NewEncoder(w).Encode(map[string]any{"app": "hipokamp", "auth": 1, "nonce": nw, "proof": sign(key, "worker", port, nc, nw)})
	return nc
}

// Te same wektory co w test/auth.test.ts: dowody liczone w Go i w TypeScripcie muszą być identyczne.
func TestAuthVectors(t *testing.T) {
	k := testKey()
	a, b := "00112233445566778899aabbccddeeff", "ffeeddccbbaa99887766554433221100"
	cases := []struct{ got, want string }{
		{sign(k, "worker", 47777, a, b), "e571c88d72bf800c555be35b508902fa2b22bc8c5b7b564fe6423fa1038dad0a"},
		{sign(k, "client", 47777, b, "POST /api/hook/prompt"), "ac6b195301ecbfbdc0514c6d898dbdb71f92d251764767dbcd8d50ff161d4017"},
		{sign(k, "response", 47777, a, b, "200"), "33358c6a84a384b0fc46fc7a0c389eb37f03ea4341c9bd613ef20e73e3dd550e"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Fatalf("wektor %d: %s, oczekiwany %s", i, c.got, c.want)
		}
	}
	if !verify(k, "worker", 47777, cases[0].want, a, b) || verify(k, "worker", 47778, cases[0].want, a, b) ||
		verify(k, "client", 47777, cases[0].want, a, b) || verify(k, "worker", 47777, strings.ToUpper(cases[0].want), a, b) ||
		verify(k, "worker", 47777, "zz", a, b) {
		t.Fatal("verify: port, etykieta i format dowodu")
	}
}

func TestReadKey(t *testing.T) {
	home := t.TempDir()
	if _, err := readKey(home); err == nil {
		t.Fatal("brak pliku klucza to błąd")
	}
	_ = os.MkdirAll(filepath.Join(home, "state"), 0o700)
	_ = os.WriteFile(filepath.Join(home, "state", "worker.key"), []byte("nie-hex\n"), 0o600)
	if _, err := readKey(home); err == nil {
		t.Fatal("uszkodzony klucz to błąd")
	}
	_ = os.WriteFile(filepath.Join(home, "state", "worker.key"), []byte(strings.Repeat("ab", 32)+"\n"), 0o600)
	if k, err := readKey(home); err != nil || len(k) != 32 {
		t.Fatalf("klucz: %v", err)
	}
}

// Obcy proces na porcie (T-17): bez klucza nie przejdzie wyzwania, więc payload do niego nie idzie; z kluczem, ale
// bez dowodu odpowiedzi (albo z dowodem dla innego portu, starego nonce'a) wynik jest odrzucany.
func TestAuthRejectsImpostors(t *testing.T) {
	key := testKey()
	other := make([]byte, 32)
	var got atomic.Int32
	cases := map[string]func(srv *httptest.Server) http.HandlerFunc{
		"bez klucza": func(*httptest.Server) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/auth" {
					got.Add(1)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"app": "hipokamp", "nonce": "0123456789abcdef0123456789abcdef", "proof": strings.Repeat("0", 64)})
			}
		},
		"inny klucz": func(srv *httptest.Server) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth" {
					fakeAuth(w, r, other, portOf(srv.URL))
					return
				}
				got.Add(1)
			}
		},
		"inny port": func(srv *httptest.Server) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth" {
					fakeAuth(w, r, key, portOf(srv.URL)+1)
					return
				}
				got.Add(1)
			}
		},
		"stary dowód": func(srv *httptest.Server) http.HandlerFunc {
			// dowód skopiowany z wcześniejszej wymiany (inny nonce klienta)
			return func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth" {
					nw := "0123456789abcdef0123456789abcdef"
					_ = json.NewEncoder(w).Encode(map[string]any{"app": "hipokamp", "nonce": nw, "proof": sign(key, "worker", portOf(srv.URL), "00112233445566778899aabbccddeeff", nw)})
					return
				}
				got.Add(1)
			}
		},
	}
	for name, mk := range cases {
		var srv *httptest.Server
		srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { mk(srv)(w, r) }))
		wk := worker{base: srv.URL, port: portOf(srv.URL), key: key}
		if data, err := wk.post("/api/hook/prompt", []byte(`{"input":{"prompt":"tajne"}}`), 2*time.Second); err == nil || data != nil {
			t.Fatalf("%s: wynik przyjęty: %q", name, data)
		}
		srv.Close()
	}
	if n := got.Load(); n != 0 {
		t.Fatalf("payload poszedł do serwera, który nie przeszedł wyzwania (%d żądań)", n)
	}

	// klucz się zgadza, ale odpowiedź bez dowodu albo z dowodem innego statusu: wynik odrzucony
	for _, proof := range []func(nc, nw string, port int) string{
		func(string, string, int) string { return "" },
		func(nc, nw string, port int) string { return sign(key, "response", port, nc, nw, "500") },
		func(nc, nw string, port int) string { return sign(key, "worker", port, nc, nw) },
	} {
		var srv *httptest.Server
		var nc string
		srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			port := portOf(srv.URL)
			if r.URL.Path == "/api/auth" {
				nc = fakeAuth(w, r, key, port)
				return
			}
			nw := r.Header.Get("x-hipokamp-nonce")
			if !verify(key, "client", port, r.Header.Get("x-hipokamp-proof"), nw, "POST "+r.URL.Path) {
				t.Errorf("zły dowód klienta")
			}
			w.Header().Set("x-hipokamp-proof", proof(nc, nw, port))
			_, _ = w.Write([]byte(`{"output":{"hookSpecificOutput":{"additionalContext":"podrzucone"}}}`))
		}))
		wk := worker{base: srv.URL, port: portOf(srv.URL), key: key}
		if data, err := wk.post("/api/hook/prompt", []byte(`{}`), 2*time.Second); err == nil || data != nil {
			t.Fatalf("odpowiedź bez właściwego dowodu przyjęta: %q", data)
		}
		srv.Close()
	}

	// wszystko się zgadza: wynik przyjęty
	var srv *httptest.Server
	var nc string
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		port := portOf(srv.URL)
		if r.URL.Path == "/api/auth" {
			nc = fakeAuth(w, r, key, port)
			return
		}
		w.Header().Set("x-hipokamp-proof", sign(key, "response", port, nc, r.Header.Get("x-hipokamp-nonce"), "200"))
		_, _ = w.Write([]byte(`{"output":null}`))
	}))
	defer srv.Close()
	wk := worker{base: srv.URL, port: portOf(srv.URL), key: key}
	if data, err := wk.post("/api/hook/prompt", []byte(`{}`), 2*time.Second); err != nil || string(data) != `{"output":null}` {
		t.Fatalf("poprawna wymiana odrzucona: %v %q", err, data)
	}
}

func TestMinimalInput(t *testing.T) {
	in := []byte(`{"session_id":"s","cwd":"C:/p","transcript_path":"C:/t/s.jsonl","prompt":"p","tool_name":"Write",
		"tool_input":{"file_path":"C:/p/.env","content":"API_KEY=sk-tajne"},"tool_response":{"file":{"content":"API_KEY=sk-tajne"}}}`)
	got := string(minimalInput("post-tool", in))
	if strings.Contains(got, "sk-tajne") || strings.Contains(got, "tool_response") || strings.Contains(got, "prompt") {
		t.Fatalf("do workera idą tylko potrzebne pola: %s", got)
	}
	if !strings.Contains(got, `"file_path":"C:/p/.env"`) || !strings.Contains(got, `"tool_name":"Write"`) {
		t.Fatalf("brak ścieżki pliku: %s", got)
	}
	if p := string(minimalInput("prompt", in)); !strings.Contains(p, `"prompt":"p"`) || strings.Contains(p, "tool_input") {
		t.Fatalf("prompt: %s", p)
	}
	if s := string(minimalInput("stop", in)); strings.Contains(s, "prompt") || !strings.Contains(s, "transcript_path") {
		t.Fatalf("stop: %s", s)
	}
	if string(minimalInput("prompt", []byte("nie json"))) != "{}" {
		t.Fatal("zepsute wejście: pusty obiekt")
	}
}
