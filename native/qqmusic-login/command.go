// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxLineBytes  = 64 * 1024
	maxEventBytes = 64 * 1024
	maxIDBytes    = 512
)

var (
	errCommand = errors.New("invalid helper command")
	errOutput  = errors.New("helper output unavailable")
)

type command struct {
	Command   string  `json:"command"`
	QRCodeID  *string `json:"qrcodeID,omitempty"`
	TimeoutMs *int64  `json:"timeoutMs,omitempty"`
}

type event struct {
	Type    string                     `json:"type"`
	Entropy string                     `json:"entropy,omitempty"`
	Data    map[string]json.RawMessage `json:"data,omitempty"`
	Message string                     `json:"message,omitempty"`
}

func errorEvent(message string) event { return event{Type: "error", Message: message} }

func contextEvent(ctx context.Context) event {
	if errors.Is(context.Cause(ctx), errCommand) {
		return errorEvent("Invalid helper command.")
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return event{Type: "timeout"}
	}
	return event{Type: "canceled"}
}

func decodeCommand(line []byte) (command, error) {
	var cmd command
	if len(line) > maxLineBytes || !utf8.Valid(line) {
		return cmd, errCommand
	}
	dec := json.NewDecoder(bytes.NewReader(line))
	start, err := dec.Token()
	if err != nil || start != json.Delim('{') {
		return command{}, errCommand
	}
	seen := make(map[string]bool)
	for dec.More() {
		token, err := dec.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return command{}, errCommand
		}
		seen[key] = true
		switch key {
		case "command":
			err = dec.Decode(&cmd.Command)
		case "qrcodeID":
			err = dec.Decode(&cmd.QRCodeID)
		case "timeoutMs":
			err = dec.Decode(&cmd.TimeoutMs)
		default:
			return command{}, errCommand
		}
		if err != nil {
			return command{}, errCommand
		}
	}
	end, err := dec.Token()
	if err != nil || end != json.Delim('}') || dec.Decode(new(any)) != io.EOF {
		return command{}, errCommand
	}
	switch cmd.Command {
	case "subscribe":
		if cmd.QRCodeID == nil || !validID(*cmd.QRCodeID) || cmd.TimeoutMs == nil ||
			*cmd.TimeoutMs < 1000 || *cmd.TimeoutMs > 180000 {
			return command{}, errCommand
		}
	case "cancel":
		if len(seen) != 1 {
			return command{}, errCommand
		}
	default:
		return command{}, errCommand
	}
	return cmd, nil
}

func validID(id string) bool {
	return len(id) > 0 && len(id) <= maxIDBytes && validMQTTString(id) &&
		!strings.ContainsAny(id, "#+")
}

type commandResult struct {
	cmd command
	err error
}

// readCommands owns the scanner. Closing input interrupts a pending pipe read;
// done lets run join this goroutine on every terminal path.
func readCommands(ctx context.Context, input io.Reader, results chan<- commandResult, done chan<- struct{}, stop context.CancelCauseFunc) {
	defer close(done)
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), maxLineBytes+1)
	first := true
	for scanner.Scan() {
		cmd, err := decodeCommand(scanner.Bytes())
		if !first {
			// Cancel independently of stdout, which may be under backpressure.
			if err == nil && cmd.Command == "cancel" {
				stop(context.Canceled)
			} else {
				stop(errCommand)
			}
			return
		}
		select {
		case results <- commandResult{cmd: cmd, err: err}:
		case <-ctx.Done():
			return
		}
		first = false
		if err != nil {
			return
		}
	}
	err := io.EOF
	if scanner.Err() != nil {
		err = errCommand
	}
	if !first {
		if err == io.EOF {
			stop(context.Canceled)
		} else {
			stop(errCommand)
		}
		return
	}
	select {
	case results <- commandResult{err: err}:
	case <-ctx.Done():
	}
}

func encodeEvent(ev event) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(ev) != nil || buf.Len() > maxEventBytes {
		return nil, errOutput
	}
	return buf.Bytes(), nil
}

func writeEvent(output io.Writer, ev event) error {
	data, err := encodeEvent(ev)
	if err != nil {
		return err
	}
	n, err := output.Write(data)
	if err != nil || n != len(data) {
		return errOutput
	}
	return nil
}

// writeEventContext can interrupt a blocked process pipe write. Non-closable
// writers are used only by nonblocking, in-memory test sinks.
func writeEventContext(ctx context.Context, output io.Writer, ev event) error {
	closer, ok := output.(io.Closer)
	if !ok {
		return writeEvent(output, ev)
	}
	done := make(chan error, 1)
	go func() { done <- writeEvent(output, ev) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		// Let an already completing write finish before aborting its pipe.
		grace := time.NewTimer(50 * time.Millisecond)
		defer grace.Stop()
		select {
		case err := <-done:
			return err
		case <-grace.C:
		}
		closer.Close()
		<-done
		return errOutput
	}
}

func writeTerminal(output io.Writer, ev event) error {
	// A canceled session still gets a chance to deliver its terminal event.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return writeEventContext(ctx, output, ev)
}

type sessionRunner func(context.Context, string, func(event) bool) event

func run(ctx context.Context, input io.ReadCloser, output io.Writer, session sessionRunner) error {
	entropy := make([]byte, 4096)
	if _, err := rand.Read(entropy); err != nil {
		return writeTerminal(output, errorEvent("Unable to initialize transport helper."))
	}
	if err := writeEventContext(ctx, output, event{Type: "ready", Entropy: hex.EncodeToString(entropy)}); err != nil {
		return err
	}

	inputCtx, stopInput := context.WithCancelCause(ctx)
	commands := make(chan commandResult)
	inputDone := make(chan struct{})
	go readCommands(inputCtx, input, commands, inputDone, stopInput)
	defer func() {
		stopInput(context.Canceled)
		input.Close()
		<-inputDone
	}()

	var first commandResult
	select {
	case <-ctx.Done():
		return writeTerminal(output, contextEvent(ctx))
	case first = <-commands:
	}
	if first.err == io.EOF {
		return writeTerminal(output, event{Type: "canceled"})
	}
	if first.err != nil || first.cmd.Command != "subscribe" {
		return writeTerminal(output, errorEvent("Invalid helper command."))
	}

	sessionCtx, cancel := context.WithTimeout(inputCtx, time.Duration(*first.cmd.TimeoutMs)*time.Millisecond)
	notifications := make(chan event)
	terminal := make(chan event, 1)
	sessionDone := make(chan struct{})
	go func() {
		defer close(sessionDone)
		terminal <- session(sessionCtx, *first.cmd.QRCodeID, func(ev event) bool {
			select {
			case notifications <- ev:
				return true
			case <-sessionCtx.Done():
				return false
			}
		})
	}()
	defer func() {
		cancel()
		<-sessionDone
	}()

	finish := func(ev event) error {
		cancel()
		<-sessionDone // Close the transport before reporting its terminal event.
		return writeTerminal(output, ev)
	}
	for {
		select {
		case <-sessionCtx.Done():
			return finish(contextEvent(sessionCtx))
		case ev := <-notifications:
			if sessionCtx.Err() != nil {
				return finish(contextEvent(sessionCtx))
			}
			if err := writeEventContext(sessionCtx, output, ev); err != nil {
				return err
			}
		case ev := <-terminal:
			if sessionCtx.Err() != nil {
				ev = contextEvent(sessionCtx)
			}
			return finish(ev)
		}
	}
}
