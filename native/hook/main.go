// hipokamp-hook: natywny hook hipokampa (config hooks.mode = native albo auto). Startuje w ok. 20 ms zamiast
// 80 do 190 ms samego Buna: czyta payload hooka ze stdin, wysyła workerowi (POST /api/hook/<zdarzenie> na
// 127.0.0.1) tylko potrzebne pola, z twardym limitem czasu, i wypisuje JSON hooka. Logikę liczy worker
// (src/hooks/handle.ts), ale wynik składa ten program: z odpowiedzi bierze wyłącznie napis additionalContext
// (najwyżej 9500 znaków), a nazwę zdarzenia ustala sam. Na porcie workera może słuchać obcy proces (T-17): payload
// idzie dopiero po wyzwaniu i odpowiedzi z kluczem z <dane>/state/worker.key (src/worker/auth.ts), wynik tylko z
// dowodem odpowiedzi, a i tak żadne pole decyzji (decision, continue, reason, systemMessage…) nie przechodzi.
// Gdy worker nie odpowiada, uruchamia zapasowo hook Buna (`bun src/hooks/hook.ts <zdarzenie>`), który liczy lokalnie
// i podnosi workera; gdy i Buna nie da się uruchomić, zdarzenia zapisu idą do spool/pending.jsonl.
// ZASADA jak w hook.ts: nigdy nie blokuje, zawsze kod wyjścia 0. Tylko biblioteka standardowa Go.
//
// Użycie: hipokamp-hook [--bun <bun>] [--hook-ts <hook.ts>] <zdarzenie> [codex]
//
//	hipokamp-hook [--hook-ts <hook.ts>] --smoke   (test dymny: JSON z wersją i tym, czy widać hook Buna)
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// version: podbijana przy każdej zmianie zachowania; instalator i doctor porównują ją z NATIVE_VERSION w modes.ts.
// 3: uwierzytelnienie workera (T-17).
const version = 3

// maxContext: limit additionalContext w znakach UTF-16, jak MAX_CONTEXT_CHARS w handle.ts (Claude Code: 10 000).
const maxContext = 9500

// Limity czasu odpowiedzi workera: jak w hooku Buna (client.call), zapis tury z zapasem na dłuższy transkrypt.
// SessionEnd ma w Claude Code budżet 1,5 s na wszystkie hooki, więc czekamy krócej i zostawiamy czas na zapas.
var limits = map[string]time.Duration{
	"session-start": 1800 * time.Millisecond,
	"prompt":        1600 * time.Millisecond,
	"post-tool":     1000 * time.Millisecond,
	"stop":          2500 * time.Millisecond,
	"pre-compact":   2500 * time.Millisecond,
	"session-end":   1000 * time.Millisecond,
}

// eventNames: zdarzenia, które wstrzykują kontekst, i ich nazwa w wyniku hooka. Zapis tury nie wypisuje nic.
var eventNames = map[string]string{
	"session-start": "SessionStart",
	"prompt":        "UserPromptSubmit",
	"post-tool":     "PostToolUse",
}

type options struct {
	event  string
	codex  bool
	bun    string
	hookTs string
	smoke  bool
}

func parseArgs(args []string) options {
	var o options
	var rest []string
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--smoke":
			o.smoke = true
		case a == "--bun" && i+1 < len(args):
			i++
			o.bun = args[i]
		case a == "--hook-ts" && i+1 < len(args):
			i++
			o.hookTs = args[i]
		default:
			rest = append(rest, a)
		}
	}
	if len(rest) > 0 {
		o.event = strings.ToLower(rest[0])
	}
	o.codex = len(rest) > 1 && strings.EqualFold(rest[1], "codex")
	return o
}

// dataDir: jak config.ts (HIPOKAMP_HOME albo ~/.hipokamp).
func dataDir() string {
	if h := os.Getenv("HIPOKAMP_HOME"); h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".hipokamp"
	}
	return filepath.Join(home, ".hipokamp")
}

// endpoint: adres i port workera. Kolejność: HIPOKAMP_PORT, config.json, worker.lock.json (port działającego
// workera), domyślny 47777. Nagłówek Host musi się zgadzać z portem workera, inaczej odpowie 403.
func endpoint(home string) (string, int) {
	var cfg struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if b, err := os.ReadFile(filepath.Join(home, "config.json")); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	host, port := "127.0.0.1", cfg.Port
	if cfg.Host != "" {
		host = cfg.Host
	}
	if port == 0 {
		var lock struct {
			Port int `json:"port"`
		}
		if b, err := os.ReadFile(filepath.Join(home, "worker.lock.json")); err == nil {
			_ = json.Unmarshal(b, &lock)
		}
		port = lock.Port
	}
	if p, err := strconv.Atoi(os.Getenv("HIPOKAMP_PORT")); err == nil && p > 0 {
		port = p
	}
	if port <= 0 {
		port = 47777
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)), port
}

// protocol: jak PROTOCOL w src/worker/auth.ts (zmiana = nowa wersja protokołu po obu stronach).
const protocol = "hipokamp-auth-1"

var nonceRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// readKey: klucz workera (<dane>/state/worker.key, 64 znaki hex). Brak albo uszkodzony plik to błąd: zapas w hooku
// Buna, który klucz utworzy i podniesie workera.
func readKey(home string) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(home, "state", "worker.key"))
	if err != nil {
		return nil, err
	}
	k, err := hex.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(k) != 32 {
		return nil, errors.New("uszkodzony klucz workera")
	}
	return k, nil
}

// sign: HMAC-SHA256 (hex) z protokołu, etykiety (worker, client, response), portu i części, jak sign() w auth.ts.
func sign(key []byte, label string, port int, parts ...string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(strings.Join(append([]string{protocol, label, strconv.Itoa(port)}, parts...), "\n")))
	return hex.EncodeToString(m.Sum(nil))
}

// verify: dowód zgodny z kluczem, porównanie stałoczasowe (hmac.Equal).
func verify(key []byte, label string, port int, proof string, parts ...string) bool {
	got, err := hex.DecodeString(proof)
	if err != nil || len(got) != sha256.Size || strings.ToLower(proof) != proof {
		return false
	}
	want, _ := hex.DecodeString(sign(key, label, port, parts...))
	return hmac.Equal(want, got)
}

// worker: adres, port (wchodzi do każdego dowodu) i klucz.
type worker struct {
	base string
	port int
	key  []byte
}

// handshake: krok 1 (src/worker/auth.ts): wyzwanie z losowym nonce i sprawdzenie dowodu workera. Nagłówek
// x-hipokamp-bg: samo wyzwanie nie liczy się jako aktywność workera.
func (w worker) handshake(ctx context.Context) (nc, nw string, err error) {
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	nc = hex.EncodeToString(b)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, w.base+"/api/auth", nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("x-hipokamp-challenge", nc)
	req.Header.Set("x-hipokamp-bg", "1")
	res, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return "", "", err
	}
	if res.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("wyzwanie: HTTP %d", res.StatusCode)
	}
	var j struct {
		App   string `json:"app"`
		Nonce string `json:"nonce"`
		Proof string `json:"proof"`
	}
	if json.Unmarshal(data, &j) != nil || j.App != "hipokamp" || !nonceRe.MatchString(j.Nonce) || j.Nonce == nc ||
		!verify(w.key, "worker", w.port, j.Proof, nc, j.Nonce) {
		return "", "", errors.New("wyzwanie: zły dowód workera")
	}
	return nc, j.Nonce, nil
}

// hookTsPath: hook Buna względem pliku wykonywalnego (native/hook/ → src/hooks/hook.ts), o ile nie podano jawnie.
func hookTsPath(o options) string {
	if o.hookTs != "" {
		return o.hookTs
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exe), "..", "..", "src", "hooks", "hook.ts")
}

// minimalInput: do workera idą tylko pola, których potrzebuje handle.ts. Bez tool_response (treść czytanego
// pliku, np. .env) i bez treści z tool_input (Write niesie cały plik): w trybie command nie wychodziły z procesu hooka.
func minimalInput(event string, stdin []byte) []byte {
	var in map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimSpace(stdin), &in) != nil {
		return []byte("{}")
	}
	keep := []string{"session_id", "transcript_path", "cwd", "hook_event_name"}
	switch event {
	case "session-start":
		keep = append(keep, "source")
	case "prompt":
		keep = append(keep, "prompt")
	case "post-tool":
		keep = append(keep, "tool_name")
	}
	out := map[string]json.RawMessage{}
	for _, k := range keep {
		if v, ok := in[k]; ok {
			out[k] = v
		}
	}
	if event == "post-tool" {
		var ti map[string]json.RawMessage
		if json.Unmarshal(in["tool_input"], &ti) == nil {
			pick := map[string]json.RawMessage{}
			for _, k := range []string{"file_path", "notebook_path"} {
				var s string
				if json.Unmarshal(ti[k], &s) == nil {
					pick[k] = ti[k]
				}
			}
			if b, err := json.Marshal(pick); err == nil {
				out["tool_input"] = b
			}
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// utf16Len: długość napisu jak w JS (String.length), bo tak liczy limit Claude Code.
func utf16Len(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

// limitContext: najwyżej max znaków UTF-16, cięcie na granicy znaku, z dopiskiem jak w handle.ts.
func limitContext(s string, max int) string {
	n := 0
	for _, r := range s {
		n += utf16Len(r)
	}
	if n <= max {
		return s
	}
	const more = "\n… (ucięte do limitu hooka; reszta: search / timeline)"
	room := max - utf8.RuneCountInString(more)
	n = 0
	for i, r := range s {
		if n+utf16Len(r) > room {
			return s[:i] + more
		}
		n += utf16Len(r)
	}
	return s
}

// buildOutput: wynik hooka składany tutaj, nie przepisywany z odpowiedzi. Z pola output bierzemy wyłącznie napis
// hookSpecificOutput.additionalContext; nazwa zdarzenia jest stała dla zdarzenia hooka. Zapis tury nie wypisuje nic.
func buildOutput(event string, raw json.RawMessage) []byte {
	name, ok := eventNames[event]
	if !ok || !present(raw) {
		return nil
	}
	var o struct {
		HookSpecificOutput struct {
			AdditionalContext json.RawMessage `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if json.Unmarshal(raw, &o) != nil {
		return nil
	}
	var text string
	if json.Unmarshal(o.HookSpecificOutput.AdditionalContext, &text) != nil || strings.TrimSpace(text) == "" {
		return nil
	}
	b, err := json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]string{"hookEventName": name, "additionalContext": limitContext(text, maxContext)},
	})
	if err != nil {
		return nil
	}
	return b
}

type reply struct {
	Output  json.RawMessage `json:"output"`
	Pending json.RawMessage `json:"pending"`
	// delegate: worker nie bierze dużego zapisu tury na swoją pętlę zdarzeń; robi go hook Buna w osobnym procesie
	Delegate bool `json:"delegate"`
}

// bez proxy i bez przekierowań: worker słucha tylko na 127.0.0.1, a ani zmienne HTTP_PROXY, ani odpowiedź 3xx
// (307 powtórzyłby POST z payloadem pod inny adres, 302 zrobiłby z niego GET) nie wyślą payloadu gdzie indziej.
// Odpowiedź 3xx wraca jak jest i jako nie-200 kończy się zapasem w hooku Buna.
var client = &http.Client{
	Transport: &http.Transport{Proxy: nil, DisableCompression: true},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// post: wyzwanie, potem żądanie z dowodem klienta, z limitem czasu na całość (oba połączenia, odpowiedź i treść).
// Payload wychodzi dopiero po dowodzie workera; treść wraca tylko przy 200 i zgodnym dowodzie odpowiedzi.
func (w worker) post(path string, body []byte, limit time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	nc, nw, err := w.handshake(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-hipokamp-nonce", nw)
	req.Header.Set("x-hipokamp-proof", sign(w.key, "client", w.port, nw, "POST "+path))
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if !verify(w.key, "response", w.port, res.Header.Get("x-hipokamp-proof"), nc, nw, strconv.Itoa(res.StatusCode)) {
		return nil, fmt.Errorf("worker: HTTP %d bez dowodu odpowiedzi", res.StatusCode)
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker: HTTP %d", res.StatusCode)
	}
	return data, nil
}

func callWorker(w worker, o options, stdin []byte, limit time.Duration) (*reply, error) {
	wd, _ := os.Getwd()
	body, err := json.Marshal(map[string]any{
		"input":      json.RawMessage(minimalInput(o.event, stdin)),
		"codex":      o.codex,
		"projectDir": os.Getenv("CLAUDE_PROJECT_DIR"),
		"cwd":        wd,
	})
	if err != nil {
		return nil, err
	}
	data, err := w.post("/api/hook/"+o.event, body, limit)
	if err != nil {
		return nil, err
	}
	var r reply
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func present(m json.RawMessage) bool {
	t := bytes.TrimSpace(m)
	return len(t) > 0 && !bytes.Equal(t, []byte("null"))
}

// runBun: hook Buna z tym samym wejściem. failed = worker nie odpowiedział (HIPOKAMP_HOOK_FALLBACK: hook Buna nie
// pyta go drugi raz); przy oddanym zapisie tury (delegate) worker żyje, więc hook Buna go potem budzi jak zwykle.
func runBun(o options, home string, stdin []byte, failed bool, why error) {
	bun := o.bun
	if bun == "" {
		bun = os.Getenv("HIPOKAMP_BUN")
	}
	if bun == "" {
		if p, err := exec.LookPath("bun"); err == nil {
			bun = p
		}
	}
	hookTs := hookTsPath(o)
	if bun == "" || hookTs == "" {
		spool(o, home, stdin, fmt.Errorf("%v; brak buna albo hook.ts", why))
		return
	}
	args := []string{hookTs, o.event}
	if o.codex {
		args = append(args, "codex")
	}
	cmd := exec.Command(bun, args...)
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if failed {
		cmd.Env = append(cmd.Env, "HIPOKAMP_HOOK_FALLBACK=1")
	}
	hideWindow(cmd)
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			// Bun się nie uruchomił: zdarzenie zapisu nie przepada, worker dociągnie je przy starcie
			spool(o, home, stdin, fmt.Errorf("%v; bun: %v", why, err))
		}
	}
}

// spool: jak spool() w handle.ts; tylko zdarzenia zapisu tury (kontekst po fakcie nie ma sensu).
func spool(o options, home string, stdin []byte, why error) {
	if o.event != "stop" && o.event != "pre-compact" && o.event != "session-end" {
		return
	}
	var in struct {
		SessionID      string  `json:"session_id"`
		TranscriptPath string  `json:"transcript_path"`
		Cwd            *string `json:"cwd"`
	}
	if json.Unmarshal(stdin, &in) != nil || in.SessionID == "" || in.TranscriptPath == "" {
		return
	}
	var final any = true
	if o.event == "pre-compact" {
		final = false
	} else if o.codex {
		final = "complete"
	}
	msg := fmt.Sprint(why)
	if len(msg) > 300 {
		msg = msg[:300]
	}
	line, err := json.Marshal(map[string]any{
		"at":   time.Now().UnixMilli(),
		"kind": "ingest",
		"payload": map[string]any{
			"sessionId": in.SessionID, "transcriptPath": in.TranscriptPath, "cwd": in.Cwd, "final": final, "maxBytes": 24 << 20,
		},
		"error": msg,
	})
	if err != nil {
		return
	}
	dir := filepath.Join(home, "spool")
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "pending.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

func run(o options) {
	if o.smoke {
		p := hookTsPath(o)
		_, err := os.Stat(p)
		out, _ := json.Marshal(map[string]any{"app": "hipokamp-hook", "version": version, "hookTs": err == nil, "hookTsPath": p})
		_, _ = os.Stdout.Write(out)
		return
	}
	limit, ok := limits[o.event]
	if !ok {
		return // nieznane zdarzenie: jak hook Buna, nic nie robimy
	}
	stdin, _ := io.ReadAll(io.LimitReader(os.Stdin, 64<<20))
	home := dataDir()
	// PostToolUse Codexa niesie ścieżki tylko w treści łatki: ta treść nie wychodzi z procesu, liczy hook Buna
	// (Codex i tak dostaje od instalatora hook Buna; to zabezpieczenie dla ręcznej konfiguracji)
	if o.codex && o.event == "post-tool" {
		runBun(o, home, stdin, false, nil)
		return
	}
	base, port := endpoint(home)
	key, err := readKey(home)
	if err != nil {
		// bez klucza nie ma jak sprawdzić workera: liczy hook Buna (utworzy klucz i w razie potrzeby podniesie workera)
		runBun(o, home, stdin, true, err)
		return
	}
	w := worker{base: base, port: port, key: key}
	r, err := callWorker(w, o, stdin, limit)
	if err != nil {
		runBun(o, home, stdin, true, err)
		return
	}
	if r.Delegate && eventNames[o.event] == "" {
		runBun(o, home, stdin, false, nil)
		return
	}
	out := buildOutput(o.event, r.Output)
	if out == nil {
		return
	}
	_, _ = os.Stdout.Write(out)
	// wstrzyknięcie zapisujemy dopiero teraz, gdy wynik jest już na wyjściu (porzucony hook niczego nie zapisuje);
	// nonce jest jednorazowy, więc potwierdzenie ma własne wyzwanie
	if present(r.Pending) {
		_, _ = w.post("/api/hook/ack", r.Pending, 300*time.Millisecond)
	}
}

func main() {
	defer func() {
		_ = recover() // panika nie może dać kodu wyjścia innego niż 0
		os.Exit(0)
	}()
	run(parseArgs(os.Args[1:]))
}
