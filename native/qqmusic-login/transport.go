// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors
// Protocol adapted from QQMusicApi by Luren and contributors; see NOTICE.

package main

import (
	"context"
	"crypto/rand"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	endpointHost  = "mu.y.qq.com:443"
	handshakePath = "/ws/handshake"
	maxRedirects  = 3
	userAgent     = "Mozilla" + "/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

// dialFunc is private and injectable only by the authored offline tests. The
// executable accepts neither hosts nor dial options through its command input.
type dialFunc func(context.Context, string) (*websocket.Conn, error)

type transport struct{ dial dialFunc }

func newTransport() transport { return transport{dial: dialWebSocket} }

func redirectPath(reference string) (string, error) {
	if reference == "" || len(reference) > 512 || reference == "." || reference == ".." {
		return "", errProtocol
	}
	for _, r := range reference {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			strings.ContainsRune("._-:[]", r)) {
			return "", errProtocol
		}
	}
	return handshakePath + "/" + reference, nil
}

func endpointURL(path string) (string, error) {
	if path != handshakePath {
		if !strings.HasPrefix(path, handshakePath+"/") {
			return "", errProtocol
		}
		validated, err := redirectPath(strings.TrimPrefix(path, handshakePath+"/"))
		if err != nil || path != validated {
			return "", errProtocol
		}
	}
	return (&url.URL{Scheme: "wss", Host: endpointHost, Path: path}).String(), nil
}

func webSocketOptions() *websocket.DialOptions {
	return &websocket.DialOptions{
		HTTPClient: &http.Client{
			Transport: &http.Transport{
				Proxy:                  http.ProxyFromEnvironment,
				DisableKeepAlives:      true,
				TLSHandshakeTimeout:    10 * time.Second,
				ResponseHeaderTimeout:  20 * time.Second,
				MaxResponseHeaderBytes: maxLineBytes,
			},
			Timeout: 20 * time.Second,
			// MQTT node references use the fixed host's path. HTTP redirects
			// must never move the TLS handshake to a different origin.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		HTTPHeader: http.Header{
			"Origin":     {"https://y.qq.com"},
			"Referer":    {"https://y.qq.com/"},
			"User-Agent": {userAgent},
		},
		Subprotocols:    []string{"mqtt"},
		CompressionMode: websocket.CompressionDisabled,
	}
}

func dialWebSocket(ctx context.Context, path string) (*websocket.Conn, error) {
	endpoint, err := endpointURL(path)
	if err != nil {
		return nil, errProtocol
	}
	conn, _, err := websocket.Dial(ctx, endpoint, webSocketOptions())
	if err != nil {
		return nil, errProtocol
	}
	return conn, nil
}

func clientID() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(9000))
	if err != nil {
		return "", errProtocol
	}
	return strconv.FormatInt(time.Now().UnixMilli(), 10) + strconv.FormatInt(n.Int64()+1000, 10), nil
}

func (t transport) connect(ctx context.Context, id string) (*websocket.Conn, *mqttReader, properties, error) {
	var empty properties
	cid, err := clientID()
	if err != nil || !validID(id) {
		return nil, nil, empty, errProtocol
	}
	connect := connectPacket(cid, id)
	path := handshakePath
	for redirects := 0; ; redirects++ {
		conn, err := t.dial(ctx, path)
		if err != nil {
			return nil, nil, empty, errProtocol
		}
		conn.SetReadLimit(maxWebSocketMessageBytes)
		if conn.Subprotocol() != "mqtt" {
			conn.CloseNow()
			return nil, nil, empty, errProtocol
		}
		if err := conn.Write(ctx, websocket.MessageBinary, connect); err != nil {
			conn.CloseNow()
			return nil, nil, empty, errProtocol
		}
		reader := &mqttReader{ctx: ctx, conn: conn}
		packet, err := reader.packet()
		if err != nil {
			conn.CloseNow()
			return nil, nil, empty, errProtocol
		}
		reason, props, err := parseConnack(packet)
		if err == nil && reason == 0 {
			return conn, reader, props, nil
		}
		conn.CloseNow()
		if err != nil || reason != 0x9C && reason != 0x9D || redirects >= maxRedirects {
			return nil, nil, empty, errProtocol
		}
		path, err = redirectPath(props.serverReference)
		if err != nil {
			return nil, nil, empty, errProtocol
		}
	}
}

type readResult struct {
	packet mqttPacket
	err    error
}

func (t transport) run(ctx context.Context, id string, notify func(event) bool) event {
	conn, reader, props, err := t.connect(ctx, id)
	if err != nil {
		if ctx.Err() != nil {
			return contextEvent(ctx)
		}
		return errorEvent("Unable to connect to QQ Music transport.")
	}

	readCtx, stopRead := context.WithCancel(ctx)
	reader.ctx = readCtx
	packets := make(chan readResult)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			packet, err := reader.packet()
			select {
			case packets <- readResult{packet: packet, err: err}:
			case <-readCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() {
		stopRead()
		conn.CloseNow()
		<-readDone
	}()

	write := func(packet []byte) error {
		if props.maxPacketSize != 0 && uint32(len(packet)) > props.maxPacketSize {
			return errProtocol
		}
		if err := conn.Write(ctx, websocket.MessageBinary, packet); err != nil {
			return errProtocol
		}
		return nil
	}
	if err := write(subscribePacket(id)); err != nil {
		return errorEvent("Unable to subscribe to QQ Music transport.")
	}

	keepAlive := 45 * time.Second
	if props.keepAlive != nil {
		keepAlive = time.Duration(*props.keepAlive) * time.Second
	}
	var ticks <-chan time.Time
	if keepAlive > 0 {
		ticker := time.NewTicker(keepAlive / 2)
		defer ticker.Stop()
		ticks = ticker.C
	}
	var pingSent time.Time
	subscribed := false
	// MQTT permits delivery before SUBACK. Hold a small, bounded queue so
	// subscribed still precedes scanned/cookies on the parent's JSON stream.
	var early []event
	earlyBytes := 0
	for {
		select {
		case <-ctx.Done():
			return contextEvent(ctx)
		case now := <-ticks:
			if !pingSent.IsZero() {
				if now.Sub(pingSent) >= keepAlive {
					return errorEvent("QQ Music transport stopped responding.")
				}
				continue
			}
			if err := write([]byte{0xC0, 0}); err != nil {
				return errorEvent("QQ Music transport connection closed.")
			}
			pingSent = now
		case result := <-packets:
			if result.err != nil {
				return errorEvent("Invalid QQ Music transport message.")
			}
			packet := result.packet
			switch packet.header >> 4 {
			case 9:
				if subscribed || parseSuback(packet) != nil {
					return errorEvent("QQ Music transport subscription was rejected.")
				}
				subscribed = true
				if !notify(event{Type: "subscribed"}) {
					return contextEvent(ctx)
				}
				for _, ev := range early {
					if ev.Type != "scanned" {
						return ev
					}
					if !notify(ev) {
						return contextEvent(ctx)
					}
				}
				early = nil
			case 3:
				ev, err := parsePublish(packet, topicPrefix+id)
				if err != nil {
					return errorEvent("Invalid QQ Music transport message.")
				}
				if ev.Type == "" {
					continue
				}
				if !subscribed {
					earlyBytes += len(packet.body)
					if len(early) >= 8 || earlyBytes > maxEventBytes {
						return errorEvent("QQ Music transport message limit exceeded.")
					}
					early = append(early, ev)
					continue
				}
				if ev.Type != "scanned" {
					return ev
				}
				if !notify(ev) {
					return contextEvent(ctx)
				}
			case 13:
				if packet.header != 0xD0 || len(packet.body) != 0 || pingSent.IsZero() {
					return errorEvent("Invalid QQ Music transport message.")
				}
				pingSent = time.Time{}
			default:
				return errorEvent("QQ Music transport connection closed.")
			}
		}
	}
}
