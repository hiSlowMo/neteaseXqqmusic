//go:build unix

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MyGo contributors

package main

import (
	"os"
	"syscall"
)

// processIO wraps inherited descriptors in Go's poller so Close interrupts
// pending pipe I/O. os.Stdin may otherwise use a blocking read syscall.
func processIO() (*os.File, *os.File, error) {
	input, err := pollableCopy(os.Stdin)
	if err != nil {
		return nil, nil, errProtocol
	}
	output, err := pollableCopy(os.Stdout)
	if err != nil {
		input.Close()
		return nil, nil, errProtocol
	}
	return input, output, nil
}

func pollableCopy(file *os.File) (*os.File, error) {
	fd, err := syscall.Dup(int(file.Fd()))
	if err != nil {
		return nil, errProtocol
	}
	syscall.CloseOnExec(fd)
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, errProtocol
	}
	return os.NewFile(uintptr(fd), file.Name()), nil
}
