// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors
// Protocol adapted from QQMusicApi by Luren and contributors; see NOTICE.

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	maxPacketBytes           = 60 * 1024
	maxWebSocketMessageBytes = 64 * 1024
	subscribePacketID        = 1
	topicPrefix              = "management.qrcode_login/"
)

var errProtocol = errors.New("invalid MQTT transport message")

func validMQTTString(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || r >= 0xFDD0 && r <= 0xFDEF || r&0xFFFF >= 0xFFFE {
			return false
		}
	}
	return true
}

func validTopic(s string) bool {
	return s != "" && validMQTTString(s) && !strings.ContainsAny(s, "#+")
}

func appendVarint(dst []byte, value int) []byte {
	for {
		b := byte(value % 128)
		value /= 128
		if value > 0 {
			b |= 0x80
		}
		dst = append(dst, b)
		if value == 0 {
			return dst
		}
	}
}

func appendString(dst []byte, s string) []byte {
	dst = binary.BigEndian.AppendUint16(dst, uint16(len(s)))
	return append(dst, s...)
}

func appendUserProperty(dst []byte, key, value string) []byte {
	dst = append(dst, 0x26)
	dst = appendString(dst, key)
	return appendString(dst, value)
}

func packetBytes(header byte, body []byte) []byte {
	result := appendVarint([]byte{header}, len(body))
	return append(result, body...)
}

func connectPacket(clientID, id string) []byte {
	props := appendString([]byte{0x15}, "pass")
	for _, pair := range [][2]string{
		{"tmeAppID", "qqmusic"},
		{"business", "management"},
		{"hashTag", id},
		{"clientTag", "management.user"},
		{"userID", id},
	} {
		props = appendUserProperty(props, pair[0], pair[1])
	}
	body := appendString(nil, "MQTT")
	body = append(body, 5, 2, 0, 45) // Level 5, clean start, keepalive 45 seconds.
	body = appendVarint(body, len(props))
	body = append(body, props...)
	body = appendString(body, clientID)
	return packetBytes(0x10, body)
}

func subscribePacket(id string) []byte {
	props := appendUserProperty(nil, "authorization", "tmelogin")
	props = appendUserProperty(props, "pubsub", "unicast")
	body := binary.BigEndian.AppendUint16(nil, subscribePacketID)
	body = appendVarint(body, len(props))
	body = append(body, props...)
	body = appendString(body, topicPrefix+id)
	body = append(body, 0) // QoS 0, no local/retain extensions.
	return packetBytes(0x82, body)
}

type cursor struct {
	data []byte
	pos  int
}

func (c *cursor) remaining() int { return len(c.data) - c.pos }

func (c *cursor) take(n int) ([]byte, error) {
	if n < 0 || n > c.remaining() {
		return nil, errProtocol
	}
	result := c.data[c.pos : c.pos+n]
	c.pos += n
	return result, nil
}

func (c *cursor) byte() (byte, error) {
	b, err := c.take(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (c *cursor) uint16() (uint16, error) {
	b, err := c.take(2)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(b), nil
}

func (c *cursor) uint32() (uint32, error) {
	b, err := c.take(4)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(b), nil
}

// readVarint rejects non-minimal encodings and the fifth byte before allocating.
func readVarint(readByte func() (byte, error)) (int, int, error) {
	value := 0
	for i := 0; i < 4; i++ {
		b, err := readByte()
		if err != nil {
			return 0, 0, errProtocol
		}
		value |= int(b&0x7F) << (7 * i)
		if b&0x80 == 0 {
			if i > 0 && b == 0 {
				return 0, 0, errProtocol
			}
			return value, i + 1, nil
		}
	}
	return 0, 0, errProtocol
}

func (c *cursor) varint() (int, error) {
	value, _, err := readVarint(c.byte)
	return value, err
}

func (c *cursor) binary() ([]byte, error) {
	length, err := c.uint16()
	if err != nil {
		return nil, err
	}
	return c.take(int(length))
}

func (c *cursor) string() (string, error) {
	b, err := c.binary()
	if err != nil || !validMQTTString(string(b)) {
		return "", errProtocol
	}
	return string(b), nil
}

type mqttPacket struct {
	header byte
	body   []byte
}

// mqttReader treats binary WebSocket messages as a byte stream. Reader handles
// WebSocket continuation frames; MQTT packets can also span messages or coalesce.
// No unbounded stream accumulator is needed, only one capped MQTT packet.
type mqttReader struct {
	ctx     context.Context
	conn    *websocket.Conn
	current io.Reader
}

func (r *mqttReader) Read(dst []byte) (int, error) {
	for {
		if r.ctx.Err() != nil {
			return 0, r.ctx.Err()
		}
		if r.current == nil {
			typ, reader, err := r.conn.Reader(r.ctx)
			if err != nil {
				return 0, errProtocol
			}
			if typ != websocket.MessageBinary {
				return 0, errProtocol
			}
			r.current = reader
		}
		n, err := r.current.Read(dst)
		if err == io.EOF {
			r.current = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (r *mqttReader) byte() (byte, error) {
	var b [1]byte
	_, err := io.ReadFull(r, b[:])
	return b[0], err
}

func (r *mqttReader) packet() (mqttPacket, error) {
	header, err := r.byte()
	if err != nil {
		return mqttPacket{}, errProtocol
	}
	length, size, err := readVarint(r.byte)
	if err != nil || length+size+1 > maxPacketBytes {
		return mqttPacket{}, errProtocol
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return mqttPacket{}, errProtocol
	}
	return mqttPacket{header: header, body: body}, nil
}

type propertyContext byte

const (
	connackProperties propertyContext = 1 << iota
	subackProperties
	publishProperties
)

type propertyKind byte

const (
	byteProperty propertyKind = iota
	uint16Property
	uint32Property
	varintProperty
	stringProperty
	binaryProperty
	pairProperty
)

type propertySpec struct {
	kind    propertyKind
	allowed propertyContext
}

// Known MQTT 5 properties may be skipped only after their type and placement
// are checked. Unknown IDs cannot be skipped safely because they lack a length.
var propertySpecs = map[int]propertySpec{
	0x01: {byteProperty, publishProperties},
	0x02: {uint32Property, publishProperties},
	0x03: {stringProperty, publishProperties},
	0x08: {stringProperty, publishProperties},
	0x09: {binaryProperty, publishProperties},
	0x0B: {varintProperty, publishProperties},
	0x11: {uint32Property, connackProperties},
	0x12: {stringProperty, connackProperties},
	0x13: {uint16Property, connackProperties},
	0x15: {stringProperty, connackProperties},
	0x16: {binaryProperty, connackProperties},
	0x1A: {stringProperty, connackProperties},
	0x1C: {stringProperty, connackProperties},
	0x1F: {stringProperty, connackProperties | subackProperties},
	0x21: {uint16Property, connackProperties},
	0x22: {uint16Property, connackProperties},
	0x23: {uint16Property, publishProperties},
	0x24: {byteProperty, connackProperties},
	0x25: {byteProperty, connackProperties},
	0x26: {pairProperty, connackProperties | subackProperties | publishProperties},
	0x27: {uint32Property, connackProperties},
	0x28: {byteProperty, connackProperties},
	0x29: {byteProperty, connackProperties},
	0x2A: {byteProperty, connackProperties},
}

type properties struct {
	keepAlive       *uint16
	serverReference string
	maxPacketSize   uint32
	user            map[string]string
}

func parseProperties(c *cursor, where propertyContext) (properties, error) {
	result := properties{user: make(map[string]string)}
	length, err := c.varint()
	if err != nil {
		return result, errProtocol
	}
	data, err := c.take(length)
	if err != nil {
		return result, errProtocol
	}
	p := cursor{data: data}
	seen := make(map[int]bool)
	for p.remaining() > 0 {
		id, err := p.varint()
		spec, known := propertySpecs[id]
		if err != nil || !known || spec.allowed&where == 0 ||
			(seen[id] && id != 0x26 && id != 0x0B) {
			return result, errProtocol
		}
		seen[id] = true
		switch spec.kind {
		case byteProperty:
			value, err := p.byte()
			if err != nil || value > 1 {
				return result, errProtocol
			}
		case uint16Property:
			value, err := p.uint16()
			// CONNECT advertises no topic aliases (the default maximum is 0).
			if err != nil || id == 0x21 && value == 0 || id == 0x23 {
				return result, errProtocol
			}
			if id == 0x13 {
				result.keepAlive = &value
			}
		case uint32Property:
			value, err := p.uint32()
			if err != nil || id == 0x27 && value == 0 {
				return result, errProtocol
			}
			if id == 0x27 {
				result.maxPacketSize = value
			}
		case varintProperty:
			value, err := p.varint()
			if err != nil || value == 0 {
				return result, errProtocol
			}
		case stringProperty:
			value, err := p.string()
			if err != nil || id == 0x08 && !validTopic(value) || id == 0x12 && value == "" {
				return result, errProtocol
			}
			if id == 0x1C {
				result.serverReference = value
			}
		case binaryProperty:
			if _, err := p.binary(); err != nil {
				return result, errProtocol
			}
		case pairProperty:
			key, err := p.string()
			if err != nil {
				return result, errProtocol
			}
			value, err := p.string()
			if err != nil {
				return result, errProtocol
			}
			if _, duplicate := result.user[key]; duplicate && key == "type" {
				return result, errProtocol
			}
			result.user[key] = value
		}
	}
	return result, nil
}

func parseConnack(packet mqttPacket) (byte, properties, error) {
	var props properties
	if packet.header != 0x20 {
		return 0, props, errProtocol
	}
	c := cursor{data: packet.body}
	flags, err := c.byte()
	if err != nil || flags != 0 { // Clean start cannot resume a previous session.
		return 0, props, errProtocol
	}
	reason, err := c.byte()
	if err != nil {
		return 0, props, errProtocol
	}
	props, err = parseProperties(&c, connackProperties)
	if err != nil || c.remaining() != 0 {
		return 0, props, errProtocol
	}
	return reason, props, nil
}

func parseSuback(packet mqttPacket) error {
	if packet.header != 0x90 {
		return errProtocol
	}
	c := cursor{data: packet.body}
	id, err := c.uint16()
	if err != nil || id != subscribePacketID {
		return errProtocol
	}
	if _, err := parseProperties(&c, subackProperties); err != nil || c.remaining() != 1 {
		return errProtocol
	}
	reason, err := c.byte()
	if err != nil || reason != 0 { // Exactly one subscription, requested QoS 0.
		return errProtocol
	}
	return nil
}

func parsePublish(packet mqttPacket, expectedTopic string) (event, error) {
	if packet.header>>4 != 3 || packet.header&0x0E != 0 {
		return event{}, errProtocol // QoS 0 has neither a packet ID nor DUP.
	}
	c := cursor{data: packet.body}
	topic, err := c.string()
	if err != nil || !validTopic(topic) || topic != expectedTopic {
		return event{}, errProtocol
	}
	props, err := parseProperties(&c, publishProperties)
	if err != nil {
		return event{}, errProtocol
	}
	switch props.user["type"] {
	case "scanned", "canceled", "timeout":
		return event{Type: props.user["type"]}, nil
	case "loginFailed":
		return errorEvent("QQ Music login failed."), nil
	case "cookies":
		payload := c.data[c.pos:]
		var data map[string]json.RawMessage
		if !utf8.Valid(payload) || json.Unmarshal(payload, &data) != nil || data == nil {
			return event{}, errProtocol
		}
		var cookies map[string]json.RawMessage
		if json.Unmarshal(data["cookies"], &cookies) != nil || cookies == nil {
			return event{}, errProtocol
		}
		// The parent owns schema validation and the intermediate-token exchange.
		ev := event{Type: "cookies", Data: data}
		if _, err := encodeEvent(ev); err != nil {
			return event{}, errProtocol
		}
		return ev, nil
	default:
		return event{}, nil
	}
}
