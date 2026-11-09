// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestCommandValidation(t *testing.T) {
	for _, tc := range []struct {
		id      string
		timeout int
		valid   bool
	}{
		{"synthetic", 1000, true}, {"synthetic/path", 180000, true},
		{strings.Repeat("a", 512), 1000, true}, {"二维码", 1000, true},
		{"", 1000, false}, {"x#", 1000, false}, {"x+", 1000, false},
		{"x\x00", 1000, false}, {"x\n", 1000, false}, {"x\t", 1000, false},
		{"x\u007f", 1000, false}, {"x\u0085", 1000, false},
		{strings.Repeat("a", 513), 1000, false}, {strings.Repeat("界", 171), 1000, false},
		{"synthetic", 999, false}, {"synthetic", 180001, false},
	} {
		wire, _ := json.Marshal(map[string]any{"command": "subscribe", "qrcodeID": tc.id, "timeoutMs": tc.timeout})
		_, err := decodeCommand(wire)
		if (err == nil) != tc.valid {
			t.Errorf("command validation result differs: id length %d, timeout %d", len(tc.id), tc.timeout)
		}
	}
	for _, input := range []string{
		``, `{}`, `null`, `[]`, `{"command":"other"}`,
		`{"command":"subscribe","qrcodeID":"x"}`,
		`{"command":"subscribe","timeoutMs":1000}`,
		`{"command":"subscribe","qrcodeID":"x","timeoutMs":1000.1}`,
		`{"command":"subscribe","qrcodeID":"x","timeoutMs":null}`,
		`{"command":"subscribe","qrcodeID":"x","timeoutMs":1000,"host":"evil.example"}`,
		`{"command":"cancel","qrcodeID":"x"}`,
		`{"command":"cancel","timeoutMs":1000}`,
		`{"command":"cancel","qrcodeID":null}`,
		`{"command":"cancel","command":"cancel"}`,
		`{"Command":"cancel"}`,
		`{"command":"cancel"} {"command":"cancel"}`,
		strings.Repeat("x", maxLineBytes+1),
		"{\"command\":\"subscribe\",\"qrcodeID\":\"\xff\",\"timeoutMs\":1000}",
	} {
		if _, err := decodeCommand([]byte(input)); err == nil {
			t.Errorf("accepted malformed command of length %d", len(input))
		}
	}
	if _, err := decodeCommand([]byte(`{"command":"cancel"}`)); err != nil {
		t.Fatal("valid cancel rejected")
	}
}

func TestInputEOFAndInvalidFirstCommand(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", "canceled"}, {"{\"command\":\"cancel\"}\n", "error"},
		{"{\"command\":\"bad\"}\n", "error"},
		{strings.Repeat("x", maxLineBytes+2) + "\n", "error"},
	} {
		var output bytes.Buffer
		err := run(context.Background(), io.NopCloser(strings.NewReader(tc.input)), &output,
			func(context.Context, string, func(event) bool) event {
				t.Error("invalid input reached transport")
				return event{}
			})
		if err != nil {
			t.Fatal(err)
		}
		var events []event
		dec := json.NewDecoder(&output)
		for {
			var ev event
			if err := dec.Decode(&ev); err == io.EOF {
				break
			} else if err != nil {
				t.Fatal(err)
			}
			events = append(events, ev)
		}
		if len(events) != 2 || events[0].Type != "ready" || events[1].Type != tc.want {
			t.Fatalf("unexpected event sequence for invalid command (%d events)", len(events))
		}
	}
}

func TestSecondSubscribeIsTerminalError(t *testing.T) {
	stopped := make(chan struct{})
	app := startApp(t, func(ctx context.Context, _ string, notify func(event) bool) event {
		defer close(stopped)
		notify(event{Type: "subscribed"})
		<-ctx.Done()
		return contextEvent(ctx)
	})
	awaitEvent(t, app.sink, "ready")
	app.subscribe(t, 3000)
	awaitEvent(t, app.sink, "subscribed")
	app.subscribe(t, 3000)
	awaitEvent(t, app.sink, "error")
	awaitDone(t, stopped)
	awaitDone(t, app.done)
}

func TestOutputFailureCancelsWorkerAndInput(t *testing.T) {
	input, writer := io.Pipe()
	defer writer.Close()
	stopped := make(chan struct{})
	output := &failAfterReady{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		err := run(context.Background(), input, output, func(ctx context.Context, _ string, notify func(event) bool) event {
			defer close(stopped)
			notify(event{Type: "subscribed"})
			<-ctx.Done()
			return contextEvent(ctx)
		})
		if err != errOutput {
			t.Errorf("expected generic output error, got %v", err)
		}
	}()
	io.WriteString(writer, "{\"command\":\"subscribe\",\"qrcodeID\":\"synthetic\",\"timeoutMs\":3000}\n")
	awaitDone(t, done)
	awaitDone(t, stopped)
}

type failAfterReady struct{ wrote bool }

func (w *failAfterReady) Write(data []byte) (int, error) {
	if !w.wrote {
		w.wrote = true
		return len(data), nil
	}
	return 0, errors.New("synthetic-secret-I/O-message")
}

func TestBlockedOutputStillCancels(t *testing.T) {
	for _, ending := range []string{"cancel", "eof", "timeout"} {
		t.Run(ending, func(t *testing.T) {
			input, commands := io.Pipe()
			output, pipe := io.Pipe()
			observed := &observedPipeWriter{PipeWriter: pipe, blocked: make(chan struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(func() {
				cancel()
				commands.Close()
				output.Close()
				pipe.Close()
			})
			stopped := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				done <- run(ctx, input, observed, func(ctx context.Context, _ string, notify func(event) bool) event {
					defer close(stopped)
					notify(event{Type: "subscribed"})
					<-ctx.Done()
					return contextEvent(ctx)
				})
			}()
			// Read ready, then leave all later stdout writes blocked.
			if _, err := bufio.NewReader(output).ReadBytes('\n'); err != nil {
				t.Fatal("missing ready event")
			}
			timeout := 3000
			if ending == "timeout" {
				timeout = 1000
			}
			cmd, _ := json.Marshal(map[string]any{"command": "subscribe", "qrcodeID": "synthetic", "timeoutMs": timeout})
			if _, err := commands.Write(append(cmd, '\n')); err != nil {
				t.Fatal(err)
			}
			awaitDone(t, observed.blocked)
			if ending == "cancel" {
				io.WriteString(commands, "{\"command\":\"cancel\"}\n")
			} else if ending == "eof" {
				commands.Close()
			}
			limit := time.Second
			if ending == "timeout" {
				limit = 2 * time.Second
			}
			select {
			case err := <-done:
				if err != errOutput {
					t.Fatalf("expected generic output error after closing blocked pipe: %v", err)
				}
			case <-time.After(limit):
				t.Fatal("stdout backpressure prevented session cancellation")
			}
			awaitDone(t, stopped)
		})
	}
}

type observedPipeWriter struct {
	*io.PipeWriter
	blocked chan struct{}
}

func (w *observedPipeWriter) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte(`"type":"subscribed"`)) {
		close(w.blocked)
	}
	return w.PipeWriter.Write(data)
}

func TestBoundOutput(t *testing.T) {
	var output bytes.Buffer
	if writeEvent(&output, event{Type: "error", Message: strings.Repeat("x", maxEventBytes)}) != errOutput || output.Len() != 0 {
		t.Fatal("oversize output was not rejected before writing")
	}
}
