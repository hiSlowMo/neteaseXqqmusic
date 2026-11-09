// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestProcessFixture runs only as an authored child of TestInheritedPipesClose.
// Its synthetic transport performs no dial or other network operation.
func TestProcessFixture(t *testing.T) {
	mode := os.Getenv("QQMUSIC_HELPER_OFFLINE_FIXTURE")
	if mode == "main" {
		main()
		os.Exit(0)
	}
	if mode != "1" {
		return
	}
	input, output, err := processIO()
	if err == nil {
		err = run(context.Background(), input, output, func(ctx context.Context, _ string, notify func(event) bool) event {
			if !notify(event{Type: "subscribed"}) {
				return contextEvent(ctx)
			}
			return event{Type: "cookies", Data: map[string]json.RawMessage{"cookies": json.RawMessage(`{}`)}}
		})
		output.Close()
	}
	if err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestInheritedPipesClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProcessFixture$")
	cmd.Env = []string{"QQMUSIC_HELPER_OFFLINE_FIXTURE=1"}
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
	for _, expected := range []string{"ready", "subscribed", "cookies"} {
		if !scanner.Scan() {
			t.Fatalf("missing child event %s", expected)
		}
		var ev event
		if json.Unmarshal(scanner.Bytes(), &ev) != nil || ev.Type != expected {
			t.Fatalf("unexpected child event while waiting for %s", expected)
		}
		if expected == "ready" {
			if _, err := io.WriteString(input, "{\"command\":\"subscribe\",\"qrcodeID\":\"synthetic\",\"timeoutMs\":1000}\n"); err != nil {
				t.Fatal("could not send synthetic child command")
			}
		}
	}
	// Keep the parent's write end open: the child must interrupt stdin itself.
	if scanner.Scan() || scanner.Err() != nil {
		t.Fatal("unexpected child output after terminal event")
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("child failed to exit with stdin open: %v", err)
	}
	if stderr.Len() != 0 {
		t.Fatal("unexpected stderr from successful helper fixture")
	}
}
