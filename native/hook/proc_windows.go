//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow: zapasowy Bun bez okna konsoli (CREATE_NO_WINDOW). Hook bywa uruchamiany bez konsoli, a proces
// konsolowy bez tej flagi dostałby wtedy własne, migające okno.
func hideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
