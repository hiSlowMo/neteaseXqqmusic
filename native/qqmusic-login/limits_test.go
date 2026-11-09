// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRedirectValidation(t *testing.T) {
	for _, ref := range []string{"node.internal:443", "127.0.0.1:443", "[::1]:443", "edge-1"} {
		path, err := redirectPath(ref)
		endpoint, err2 := endpointURL(path)
		u, err3 := url.Parse(endpoint)
		if err != nil || err2 != nil || err3 != nil || u.Scheme != "wss" || u.Host != endpointHost ||
			u.Path != handshakePath+"/"+ref || u.RawQuery != "" || u.Fragment != "" {
			t.Errorf("reference escaped the fixed TLS origin: %q", ref)
		}
	}
	for _, ref := range []string{"", ".", "..", "//evil.example", "wss://evil.example", "a/b", "../evil", "a?b", "a#b", "a%2fb", "a@b", "a\\b", "a\r\nb", strings.Repeat("a", 513)} {
		if _, err := redirectPath(ref); err == nil {
			t.Errorf("accepted invalid node reference %q", ref)
		}
	}
	for _, path := range []string{"/evil", handshakePath + "/../other", handshakePath + "/x/y", "https://evil.example"} {
		if _, err := endpointURL(path); err == nil {
			t.Errorf("accepted invalid endpoint path %q", path)
		}
	}
	if webSocketOptions().HTTPClient.CheckRedirect(&http.Request{}, nil) != http.ErrUseLastResponse {
		t.Fatal("HTTP redirects must remain disabled")
	}
}

func TestRedirectsReconnectSameHostAndStopAtLimit(t *testing.T) {
	for _, succeed := range []bool{true, false} {
		t.Run(map[bool]string{true: "success", false: "limit"}[succeed], func(t *testing.T) {
			var mu sync.Mutex
			var paths []string
			tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, req *http.Request) error {
				mu.Lock()
				paths = append(paths, req.URL.Path)
				attempt := len(paths)
				mu.Unlock()
				if _, err := r.packet(); err != nil {
					return err
				}
				if succeed && attempt == 4 {
					if err := fixtureWrite(ctx, c, fixtureConnack(0, nil)); err != nil {
						return err
					}
					if _, err := r.packet(); err != nil {
						return err
					}
					data := append([]byte{0x90, 4, 0, 1, 0, 0}, fixturePublish("cookies", fixtureCookies)...)
					if err := fixtureWrite(ctx, c, data); err != nil {
						return err
					}
				} else {
					reference := "edge-" + string(rune('0'+attempt)) + ":443"
					reason := byte(0x9C)
					if attempt%2 == 0 {
						reason = 0x9D
					}
					if err := fixtureWrite(ctx, c, fixtureConnack(reason, append([]byte{0x1C}, fixtureString(reference)...))); err != nil {
						return err
					}
				}
				r.packet()
				return nil
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ev := tr.run(ctx, fixtureID, func(event) bool { return true })
			want := "error"
			if succeed {
				want = "cookies"
			}
			if ev.Type != want {
				t.Fatalf("unexpected redirect result: %s %s", ev.Type, ev.Message)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(paths) != 4 || paths[0] != handshakePath || paths[1] != handshakePath+"/edge-1:443" || paths[3] != handshakePath+"/edge-3:443" {
				t.Fatalf("redirect paths or count incorrect: %v", paths)
			}
		})
	}
}

func TestRejectMalformedOrOversizeFrames(t *testing.T) {
	unknown := fixturePublish("unknown", `{}`)
	oversizeWebSocket := bytes.Repeat(unknown, maxWebSocketMessageBytes/len(unknown)+2)
	for _, tc := range []struct {
		name string
		typ  websocket.MessageType
		data []byte
	}{
		{"remaining-length-overflow", websocket.MessageBinary, []byte{0x30, 0x80, 0x80, 0x80, 0x80}},
		{"non-minimal-length", websocket.MessageBinary, []byte{0x30, 0x80, 0}},
		{"oversize-mqtt", websocket.MessageBinary, binary.AppendUvarint([]byte{0x30}, maxPacketBytes+1)},
		{"oversize-websocket", websocket.MessageBinary, oversizeWebSocket},
		{"text", websocket.MessageText, []byte("synthetic-message")},
		{"wrong-suback-id", websocket.MessageBinary, []byte{0x90, 4, 0, 2, 0, 0}},
		{"failed-suback", websocket.MessageBinary, []byte{0x90, 4, 0, 1, 0, 0x80}},
		{"wrong-topic", websocket.MessageBinary, fixturePacket(0x30, fixturePublishPacket("other", "scanned", nil, nil).body)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
				if err := fixtureConnected(ctx, c, r, nil); err != nil {
					return err
				}
				// The oversize receiver can terminate before this write finishes.
				c.Write(ctx, tc.typ, tc.data)
				r.packet()
				return nil
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ev := tr.run(ctx, fixtureID, func(event) bool { return true })
			if ev.Type != "error" {
				t.Fatalf("expected bounded protocol error, got %s", ev.Type)
			}
		})
	}
}

func TestServerKeepAlivePingAndMissedResponse(t *testing.T) {
	for _, pong := range []bool{true, false} {
		t.Run(map[bool]string{true: "response", false: "missing-response"}[pong], func(t *testing.T) {
			tr := loopbackTransport(t, func(ctx context.Context, c *websocket.Conn, r *mqttReader, _ *http.Request) error {
				if err := fixtureSubscribed(ctx, c, r, []byte{0x13, 0, 1}); err != nil {
					return err
				}
				p, err := r.packet()
				if err != nil || p.header != 0xC0 || len(p.body) != 0 {
					return errors.New("missing MQTT PINGREQ under server keepalive")
				}
				if pong {
					if err := fixtureWrite(ctx, c, append([]byte{0xD0, 0}, fixturePublish("cookies", fixtureCookies)...)); err != nil {
						return err
					}
				}
				if _, err := r.packet(); err == nil {
					return errors.New("connection not closed after terminal event or missed ping response")
				}
				return nil
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ev := tr.run(ctx, fixtureID, func(event) bool { return true })
			want := "error"
			if pong {
				want = "cookies"
			}
			if ev.Type != want {
				t.Fatalf("unexpected keepalive result: %s", ev.Type)
			}
		})
	}
}
