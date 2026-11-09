// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestJSONLinesSyntheticSuccess(t *testing.T) {
	closed := make(chan struct{})
	tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
		if _, err := r.packet(); err != nil {
			return err
		}
		// Split CONNACK's header, remaining length, and body across messages.
		for _, part := range [][]byte{{0x20}, {3}, {0, 0, 0}} {
			if err := fixtureWrite(ctx, c, part); err != nil {
				return err
			}
		}
		if _, err := r.packet(); err != nil {
			return err
		}
		data := []byte{0x90, 4, 0, 1, 0, 0}
		data = append(data, fixturePublish("unknown", `{"state":200}`)...)
		data = append(data, fixturePublish("scanned", `{"state":999}`)...)
		// Multi-byte property lengths exercise parsing beyond a single byte.
		p := fixturePublishPacket(topicPrefix+fixtureID, "cookies", []byte(fixtureCookies), fixtureUser("ignored", strings.Repeat("x", 150)))
		data = append(data, fixturePacket(p.header, p.body)...)
		// Coalesce packets in one message, sent as real continuation frames.
		w, err := c.Writer(ctx, websocket.MessageBinary)
		if err != nil {
			return err
		}
		for len(data) > 0 {
			n := min(len(data), 7)
			if _, err := w.Write(data[:n]); err != nil {
				return err
			}
			data = data[n:]
		}
		if err := w.Close(); err != nil {
			return err
		}
		if _, err := r.packet(); err == nil {
			return errors.New("helper did not close after cookies")
		}
		close(closed)
		return nil
	})
	app := startApp(t, tr.run)
	ready := awaitEvent(t, app.sink, "ready")
	entropy, err := hex.DecodeString(ready.Entropy)
	if err != nil || len(entropy) != 4096 || strings.ToLower(ready.Entropy) != ready.Entropy {
		t.Fatal("ready must contain 4096 bytes of lowercase-hex entropy")
	}
	app.subscribe(t, 3000)
	awaitEvent(t, app.sink, "subscribed")
	awaitEvent(t, app.sink, "scanned")
	cookies := awaitEvent(t, app.sink, "cookies")
	data, _ := json.Marshal(cookies.Data)
	if string(data) != fixtureCookies {
		t.Fatal("cookies object changed")
	}
	awaitDone(t, app.done)
	awaitDone(t, closed)
	select {
	case ev := <-app.sink.events:
		t.Fatalf("extra event after terminal cookies: %s", ev.Type)
	default:
	}
}

func TestEarlyPublishWaitsForSuback(t *testing.T) {
	tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
		if err := fixtureConnected(ctx, c, r, nil); err != nil {
			return err
		}
		data := fixturePublish("scanned", `{}`)
		data = append(data, fixturePublish("cookies", fixtureCookies)...)
		data = append(data, 0x90, 4, 0, 1, 0, 0)
		if err := fixtureWrite(ctx, c, data); err != nil {
			return err
		}
		r.packet()
		return nil
	})
	app := startApp(t, tr.run)
	awaitEvent(t, app.sink, "ready")
	app.subscribe(t, 3000)
	awaitEvent(t, app.sink, "subscribed")
	awaitEvent(t, app.sink, "scanned")
	awaitEvent(t, app.sink, "cookies")
	awaitDone(t, app.done)
}

func TestCleanupCancelEOFSignalAndDeadline(t *testing.T) {
	for _, ending := range []string{"cancel", "eof", "signal", "timeout"} {
		t.Run(ending, func(t *testing.T) {
			closed := make(chan struct{})
			tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
				if err := fixtureSubscribed(ctx, c, r, nil); err != nil {
					return err
				}
				if _, err := r.packet(); err == nil {
					return errors.New("expected helper to close on cancellation")
				}
				close(closed)
				return nil
			})
			app := startApp(t, tr.run)
			awaitEvent(t, app.sink, "ready")
			app.subscribe(t, 1000)
			awaitEvent(t, app.sink, "subscribed")
			want := "canceled"
			switch ending {
			case "cancel":
				app.cancelCommand(t)
			case "eof":
				app.input.Close()
			case "signal":
				app.cancel()
			case "timeout":
				want = "timeout"
			}
			awaitEvent(t, app.sink, want)
			awaitDone(t, app.done)
			awaitDone(t, closed)
		})
	}
}

func TestCancelInterruptsPendingAcknowledgments(t *testing.T) {
	for _, phase := range []string{"connack", "suback"} {
		t.Run(phase, func(t *testing.T) {
			waiting, closed := make(chan struct{}), make(chan struct{})
			tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
				if _, err := r.packet(); err != nil {
					return err
				}
				if phase == "suback" {
					if err := fixtureWrite(ctx, c, fixtureConnack(0, nil)); err != nil {
						return err
					}
					if _, err := r.packet(); err != nil {
						return err
					}
				}
				close(waiting)
				if _, err := r.packet(); err == nil {
					return errors.New("expected cancellation to close pending acknowledgment")
				}
				close(closed)
				return nil
			})
			app := startApp(t, tr.run)
			awaitEvent(t, app.sink, "ready")
			app.subscribe(t, 3000)
			awaitDone(t, waiting)
			app.cancelCommand(t)
			awaitEvent(t, app.sink, "canceled")
			awaitDone(t, app.done)
			awaitDone(t, closed)
		})
	}
}

func TestCancelInterruptsPendingDial(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	tr := transport{dial: func(ctx context.Context, _ string) (*websocket.Conn, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, errors.New("synthetic-private-error")
	}}
	app := startApp(t, tr.run)
	awaitEvent(t, app.sink, "ready")
	app.subscribe(t, 3000)
	awaitDone(t, started)
	app.cancelCommand(t)
	awaitEvent(t, app.sink, "canceled")
	awaitDone(t, stopped)
	awaitDone(t, app.done)
}

func TestTerminalServerEvents(t *testing.T) {
	for _, tc := range []struct{ kind, want string }{
		{"canceled", "canceled"}, {"timeout", "timeout"}, {"loginFailed", "error"},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
				if err := fixtureSubscribed(ctx, c, r, nil); err != nil {
					return err
				}
				if err := fixtureWrite(ctx, c, fixturePublish(tc.kind, `{"account":"synthetic-private-value"}`)); err != nil {
					return err
				}
				r.packet()
				return nil
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3e9)
			defer cancel()
			ev := tr.run(ctx, fixtureID, func(event) bool { return true })
			if ev.Type != tc.want || strings.Contains(ev.Message, "synthetic-private") {
				t.Fatalf("unexpected terminal event: %s %s", ev.Type, ev.Message)
			}
		})
	}
}
