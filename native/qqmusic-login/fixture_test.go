// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const fixtureID = "synthetic/fixture"
const fixtureCookies = `{"cookies":{"qqmusic_uin":{"value":"123456789"},"qqmusic_key":{"value":"synthetic-intermediate-token"}}}`

func fixtureString(s string) []byte {
	return append([]byte{byte(len(s) >> 8), byte(len(s))}, s...)
}

func fixtureUser(key, value string) []byte {
	return append(append([]byte{0x26}, fixtureString(key)...), fixtureString(value)...)
}

func fixturePacket(header byte, body []byte) []byte {
	return append(binary.AppendUvarint([]byte{header}, uint64(len(body))), body...)
}

func fixturePublishPacket(topic, kind string, payload, extra []byte) mqttPacket {
	props := append([]byte(nil), extra...)
	if kind != "" {
		props = append(props, fixtureUser("type", kind)...)
	}
	body := binary.AppendUvarint(fixtureString(topic), uint64(len(props)))
	body = append(body, props...)
	body = append(body, payload...)
	return mqttPacket{header: 0x30, body: body}
}

func fixturePublish(kind, payload string) []byte {
	p := fixturePublishPacket(topicPrefix+fixtureID, kind, []byte(payload), nil)
	return fixturePacket(p.header, p.body)
}

func fixtureConnack(reason byte, props []byte) []byte {
	body := binary.AppendUvarint([]byte{0, reason}, uint64(len(props)))
	return fixturePacket(0x20, append(body, props...))
}

func fixtureWrite(ctx context.Context, c *websocket.Conn, data []byte) error {
	return c.Write(ctx, websocket.MessageBinary, data)
}

func fixtureConnected(ctx context.Context, c *websocket.Conn, r *mqttReader, props []byte) error {
	packet, err := r.packet()
	if err != nil || packet.header != 0x10 || !bytes.HasPrefix(packet.body, []byte("\x00\x04MQTT\x05\x02\x00\x2d")) {
		return errors.New("fixture expected MQTT5 clean-start CONNECT")
	}
	if err := fixtureWrite(ctx, c, fixtureConnack(0, props)); err != nil {
		return err
	}
	packet, err = r.packet()
	want := subscribePacket(fixtureID)
	if err != nil || !bytes.Equal(fixturePacket(packet.header, packet.body), want) {
		return errors.New("fixture expected APP scan SUBSCRIBE")
	}
	return nil
}

func fixtureSubscribed(ctx context.Context, c *websocket.Conn, r *mqttReader, props []byte) error {
	if err := fixtureConnected(ctx, c, r, props); err != nil {
		return err
	}
	return fixtureWrite(ctx, c, []byte{0x90, 4, 0, 1, 0, 0})
}

// loopbackTransport trusts only httptest's local TLS certificate. Production's
// verified-TLS dial function is never invoked by an authored fixture.
func loopbackTransport(t *testing.T, handler func(context.Context, *websocket.Conn, *mqttReader, *http.Request) error) transport {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	var conns []*websocket.Conn
	var wg sync.WaitGroup
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		wg.Add(1)
		defer wg.Done()
		if req.Header.Get("Origin") != "https://y.qq.com" || req.Header.Get("Referer") != "https://y.qq.com/" ||
			req.Header.Get("User-Agent") != "Mozilla"+"/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36" ||
			req.Header.Get("Sec-Websocket-Protocol") != "mqtt" {
			t.Error("incorrect WebSocket handshake headers")
		}
		c, err := websocket.Accept(w, req, &websocket.AcceptOptions{
			Subprotocols: []string{"mqtt"}, OriginPatterns: []string{"y.qq.com"},
		})
		if err != nil {
			t.Error("loopback WebSocket handshake failed")
			return
		}
		mu.Lock()
		conns = append(conns, c)
		mu.Unlock()
		defer c.CloseNow()
		c.SetReadLimit(maxWebSocketMessageBytes)
		handlerCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		if err := handler(handlerCtx, c, &mqttReader{ctx: handlerCtx, conn: c}, req); err != nil && ctx.Err() == nil {
			t.Errorf("loopback fixture failed: %v", err)
		}
	}))
	t.Cleanup(func() {
		cancel()
		server.Close()
		mu.Lock()
		for _, c := range conns {
			c.CloseNow()
		}
		mu.Unlock()
		wg.Wait()
	})
	return transport{dial: func(ctx context.Context, path string) (*websocket.Conn, error) {
		if _, err := endpointURL(path); err != nil {
			return nil, err
		}
		opts := webSocketOptions()
		client := *server.Client()
		client.Timeout = 3 * time.Second
		client.CheckRedirect = opts.HTTPClient.CheckRedirect
		opts.HTTPClient = &client
		c, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(server.URL, "https")+path, opts)
		return c, err
	}}
}

type eventSink struct{ events chan event }

func (s *eventSink) Write(data []byte) (int, error) {
	if len(data) > maxEventBytes || len(data) == 0 || data[len(data)-1] != '\n' {
		return 0, errors.New("fixture received invalid JSON line size")
	}
	var ev event
	if err := json.Unmarshal(data, &ev); err != nil {
		return 0, err
	}
	s.events <- ev
	return len(data), nil
}

func awaitEvent(t *testing.T, sink *eventSink, kind string) event {
	t.Helper()
	select {
	case ev := <-sink.events:
		if ev.Type != kind {
			t.Fatalf("expected %s, got %s (%s)", kind, ev.Type, ev.Message)
		}
		return ev
	case <-time.After(4 * time.Second):
		t.Fatalf("timed out waiting for %s", kind)
		return event{}
	}
}

func awaitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("transport or input goroutine did not finish")
	}
}

type runningApp struct {
	input  *io.PipeWriter
	sink   *eventSink
	done   <-chan struct{}
	cancel context.CancelFunc
}

func startApp(t *testing.T, runner sessionRunner) runningApp {
	t.Helper()
	input, writer := io.Pipe()
	sink := &eventSink{events: make(chan event, 32)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := run(ctx, input, sink, runner); err != nil {
			t.Errorf("helper run failed: %v", err)
		}
	}()
	t.Cleanup(func() {
		cancel()
		writer.Close()
		awaitDone(t, done)
	})
	return runningApp{input: writer, sink: sink, done: done, cancel: cancel}
}

func (app runningApp) subscribe(t *testing.T, timeout int) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"command": "subscribe", "qrcodeID": fixtureID, "timeoutMs": timeout})
	if _, err := app.input.Write(append(data, '\n')); err != nil {
		t.Fatalf("cannot send subscription: %v", err)
	}
}

func (app runningApp) cancelCommand(t *testing.T) {
	t.Helper()
	if _, err := io.WriteString(app.input, "{\"command\":\"cancel\"}\n"); err != nil {
		t.Fatalf("cannot send cancellation: %v", err)
	}
}
