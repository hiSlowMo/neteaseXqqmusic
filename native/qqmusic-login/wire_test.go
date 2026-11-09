// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestConnectWireProperties(t *testing.T) {
	// Authored wire expectation, independent of the packet/property encoders.
	want := "\x10\x98\x01\x00\x04MQTT\x05\x02\x00\x2d\x7a" +
		"\x15\x00\x04pass" +
		"\x26\x00\x08tmeAppID\x00\x07qqmusic" +
		"\x26\x00\x08business\x00\x0amanagement" +
		"\x26\x00\x07hashTag\x00\x0afixture/id" +
		"\x26\x00\x09clientTag\x00\x0fmanagement.user" +
		"\x26\x00\x06userID\x00\x0afixture/id" +
		"\x00\x1117000000000001234"
	got := connectPacket("17000000000001234", "fixture/id")
	if !bytes.Equal(got, []byte(want)) {
		t.Fatalf("CONNECT bytes differ: got %s, want %s", hex.EncodeToString(got), hex.EncodeToString([]byte(want)))
	}
}

func TestSubscribeWireProperties(t *testing.T) {
	want := "\x82\x54\x00\x01\x2c" +
		"\x26\x00\x0dauthorization\x00\x08tmelogin" +
		"\x26\x00\x06pubsub\x00\x07unicast" +
		"\x00\x22management.qrcode_login/fixture/id\x00"
	if got := subscribePacket("fixture/id"); !bytes.Equal(got, []byte(want)) {
		t.Fatalf("SUBSCRIBE bytes differ: got %x, want %x", got, want)
	}
}

func TestVarintAndPropertyLengths(t *testing.T) {
	for _, tc := range []struct {
		wire string
		want int
		bad  bool
	}{
		{"\x00", 0, false}, {"\x7f", 127, false},
		{"\x80\x01", 128, false}, {"\xff\x7f", 16383, false},
		{"\x80\x80\x01", 16384, false}, {"\xff\xff\xff\x7f", 268435455, false},
		{"", 0, true}, {"\x80", 0, true}, {"\x80\x00", 0, true},
		{"\xff\x80\x00", 0, true}, {"\x80\x80\x80\x80\x00", 0, true},
	} {
		c := cursor{data: []byte(tc.wire)}
		got, err := c.varint()
		if (err != nil) != tc.bad || !tc.bad && got != tc.want {
			t.Errorf("varint %x: got %d, %v", tc.wire, got, err)
		}
	}
	// A maximum-length identifier makes CONNECT's property length multi-byte.
	wire := connectPacket("17000000000001234", strings.Repeat("a", 512))
	c := cursor{data: wire[1:]}
	length, err := c.varint()
	if err != nil || length != c.remaining() {
		t.Fatal("invalid outer remaining length")
	}
	c.take(10)
	propertyLength, err := c.varint()
	if err != nil || propertyLength != 1126 {
		t.Fatalf("unexpected multi-byte CONNECT property length: %d, %v", propertyLength, err)
	}
}

func TestConnackAndSubackValidation(t *testing.T) {
	reason, props, err := parseConnack(mqttPacket{0x20, []byte{0, 0, 3, 0x13, 0, 1}})
	if err != nil || reason != 0 || props.keepAlive == nil || *props.keepAlive != 1 {
		t.Fatalf("server keepalive not decoded: %v", err)
	}
	for _, body := range [][]byte{
		{1, 0, 0}, // Session present conflicts with clean start.
		{0, 0}, {0, 0, 1}, {0, 0, 0, 0},
		{0, 0, 6, 0x13, 0, 1, 0x13, 0, 2}, // Duplicate singleton.
		{0, 0, 3, 0x21, 0, 0},             // Receive maximum cannot be zero.
		{0, 0, 2, 0x25, 2},                // Boolean property out of range.
		{0, 0, 1, 0x7F},                   // Unknown property type.
	} {
		if _, _, err := parseConnack(mqttPacket{0x20, body}); err == nil {
			t.Errorf("accepted malformed CONNACK: %x", body)
		}
	}
	if err := parseSuback(mqttPacket{0x90, []byte{0, 1, 0, 0}}); err != nil {
		t.Fatal("rejected successful matching SUBACK")
	}
	for _, packet := range []mqttPacket{
		{0x91, []byte{0, 1, 0, 0}}, {0x90, []byte{0, 2, 0, 0}},
		{0x90, []byte{0, 1, 0, 0x80}}, {0x90, []byte{0, 1, 0, 1}},
		{0x90, []byte{0, 1, 0}}, {0x90, []byte{0, 1, 0, 0, 0}},
		{0x90, []byte{0, 1, 2, 0x13, 0, 0}},
	} {
		if parseSuback(packet) == nil {
			t.Errorf("accepted malformed/mismatched SUBACK: %x %x", packet.header, packet.body)
		}
	}
}

func TestPublishUsesUserPropertyAndDefersCookieSchema(t *testing.T) {
	const topic = topicPrefix + "synthetic"
	for _, tc := range []struct {
		kind, payload, want string
	}{
		{"scanned", `{"state":999}`, "scanned"},
		{"", `{"state":1}`, ""},
		{"unknown", `{"state":0,"cookies":{}}`, ""},
		{"canceled", `not-json`, "canceled"},
		{"timeout", `not-json`, "timeout"},
		{"loginFailed", `{"token":"synthetic-secret"}`, "error"},
		{"cookies", `{"cookies":{"qqmusic_uin":{"value":"123456789"},"qqmusic_key":{"value":"synthetic-token"}}}`, "cookies"},
		{"cookies", `{"cookies":{}}`, "cookies"}, // Parent validates the schema.
	} {
		packet := fixturePublishPacket(topic, tc.kind, []byte(tc.payload), nil)
		ev, err := parsePublish(packet, topic)
		if err != nil || ev.Type != tc.want {
			t.Errorf("type %q: got %q, %v", tc.kind, ev.Type, err)
		}
		if tc.kind == "loginFailed" && strings.Contains(ev.Message, "synthetic-secret") {
			t.Fatal("server payload leaked into an error")
		}
		if ev.Type == "cookies" {
			encoded, _ := json.Marshal(ev.Data)
			if !bytes.Equal(encoded, []byte(tc.payload)) {
				t.Fatal("cookies object changed")
			}
		}
	}
}

func TestMalformedPublish(t *testing.T) {
	const topic = topicPrefix + "synthetic"
	good := fixturePublishPacket(topic, "cookies", []byte(`{"cookies":{}}`), nil)
	for name, packet := range map[string]mqttPacket{
		"qos1": {0x32, good.body}, "qos3": {0x36, good.body}, "dup-qos0": {0x38, good.body},
		"wrong-topic":       fixturePublishPacket(topic+"-other", "cookies", []byte(`{"cookies":{}}`), nil),
		"wildcard-topic":    fixturePublishPacket("bad/#", "scanned", nil, nil),
		"empty-topic":       fixturePublishPacket("", "scanned", nil, nil),
		"malformed-topic":   {0x30, []byte{0, 5, 'x'}},
		"property-overrun":  {0x30, append(fixtureString(topic), 5, 0x26)},
		"invalid-property":  {0x30, append(fixtureString(topic), 1, 0x7f)},
		"invalid-placement": fixturePublishPacket(topic, "scanned", nil, []byte{0x13, 0, 1}),
		"topic-alias":       fixturePublishPacket(topic, "scanned", nil, []byte{0x23, 0, 1}),
		"duplicate-type":    fixturePublishPacket(topic, "scanned", nil, fixtureUser("type", "cookies")),
		"not-json":          fixturePublishPacket(topic, "cookies", []byte(`{`), nil),
		"array":             fixturePublishPacket(topic, "cookies", []byte(`[]`), nil),
		"null":              fixturePublishPacket(topic, "cookies", []byte(`null`), nil),
		"missing-cookies":   fixturePublishPacket(topic, "cookies", []byte(`{}`), nil),
		"null-cookies":      fixturePublishPacket(topic, "cookies", []byte(`{"cookies":null}`), nil),
		"array-cookies":     fixturePublishPacket(topic, "cookies", []byte(`{"cookies":[]}`), nil),
		"invalid-utf8":      fixturePublishPacket(topic, "cookies", []byte("{\"cookies\":{},\"x\":\"\xff\"}"), nil),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parsePublish(packet, topic); err == nil {
				t.Fatal("malformed PUBLISH was accepted")
			}
		})
	}
}

func TestCookiesEncodingCannotExceedOutputLimit(t *testing.T) {
	// JSON map keys escape these Unicode separators during re-encoding.
	payload := `{"cookies":{},"` + strings.Repeat(" ", 12000) + `":0}`
	if len(payload) >= maxPacketBytes {
		t.Fatal("fixture must fit inside the MQTT packet limit")
	}
	packet := fixturePublishPacket(topicPrefix+fixtureID, "cookies", []byte(payload), nil)
	if _, err := parsePublish(packet, topicPrefix+fixtureID); err == nil {
		t.Fatal("cookies event that expands past the output limit was accepted")
	}
}

func TestClientIDFormat(t *testing.T) {
	a, err := clientID()
	b, err2 := clientID()
	if err != nil || err2 != nil || len(a) != 17 || len(b) != 17 {
		t.Fatalf("invalid client ID length or randomness failure")
	}
	for _, id := range []string{a, b} {
		if id[13] < '1' || id[13] > '9' || strings.Trim(id, "0123456789") != "" {
			t.Fatal("client ID is not decimal timestamp plus a 1000..9999 suffix")
		}
	}
}
