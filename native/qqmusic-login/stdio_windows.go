// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import "os"

// Go cancels pending Windows pipe I/O when the file is closed.
func processIO() (*os.File, *os.File, error) {
	return os.Stdin, os.Stdout, nil
}
