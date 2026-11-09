//go:build unix

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestProcessSignalBeforeSubscription(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProcessFixture$")
	cmd.Env = []string{"QQMUSIC_HELPER_OFFLINE_FIXTURE=main"}
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() {
		t.Fatal("child did not emit ready")
	}
	var ev event
	if json.Unmarshal(scanner.Bytes(), &ev) != nil || ev.Type != "ready" {
		t.Fatal("invalid child ready event")
	}
	// No subscribe command is sent, so production main cannot contact QQ Music.
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if !scanner.Scan() || json.Unmarshal(scanner.Bytes(), &ev) != nil || ev.Type != "canceled" {
		t.Fatal("process signal did not yield canceled")
	}
	if scanner.Scan() || scanner.Err() != nil {
		t.Fatal("unexpected output after process cancellation")
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("child did not exit cleanly after signal: %v", err)
	}
	if stderr.Len() != 0 {
		t.Fatal("unexpected stderr from canceled helper")
	}
}
