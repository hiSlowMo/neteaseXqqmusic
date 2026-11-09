// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

// qqmusic-login is a single-session JSON-lines MQTT transport for APP scanning.
// QR creation, device identity, and final session exchange belong to its parent.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	input, output, err := processIO()
	if err == nil {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		err = run(ctx, input, output, newTransport().run)
		stop()
		output.Close()
	}
	if err != nil {
		// Never print an underlying I/O, WebSocket, or server error.
		fmt.Fprintln(os.Stderr, "QQ Music transport helper stopped.")
		os.Exit(1)
	}
}
