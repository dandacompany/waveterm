// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestKeyNameToBytes(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []byte
	}{
		{name: "ctrl-c", input: "C-c", want: []byte{0x03}},
		{name: "ctrl-a", input: "C-a", want: []byte{0x01}},
		{name: "ctrl-z", input: "C-z", want: []byte{0x1a}},
		{name: "ctrl uppercase letter", input: "C-C", want: []byte{0x03}},
		{name: "enter", input: "Enter", want: []byte{'\r'}},
		{name: "return alias", input: "Return", want: []byte{'\r'}},
		{name: "tab", input: "Tab", want: []byte{'\t'}},
		{name: "escape", input: "Escape", want: []byte{0x1b}},
		{name: "esc alias", input: "Esc", want: []byte{0x1b}},
		{name: "space", input: "Space", want: []byte{0x20}},
		{name: "up", input: "Up", want: []byte{0x1b, '[', 'A'}},
		{name: "down", input: "Down", want: []byte{0x1b, '[', 'B'}},
		{name: "right", input: "Right", want: []byte{0x1b, '[', 'C'}},
		{name: "left", input: "Left", want: []byte{0x1b, '[', 'D'}},
		{name: "home", input: "Home", want: []byte{0x1b, '[', 'H'}},
		{name: "end", input: "End", want: []byte{0x1b, '[', 'F'}},
		{name: "pageup", input: "PageUp", want: []byte{0x1b, '[', '5', '~'}},
		{name: "pagedown", input: "PageDown", want: []byte{0x1b, '[', '6', '~'}},
		{name: "bspace", input: "BSpace", want: []byte{0x7f}},
		{name: "delete", input: "Delete", want: []byte{0x1b, '[', '3', '~'}},
		{name: "f1", input: "F1", want: []byte{0x1b, 'O', 'P'}},
		{name: "f12", input: "F12", want: []byte{0x1b, '[', '2', '4', '~'}},
		{name: "case insensitive name", input: "enter", want: []byte{'\r'}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := keyNameToBytes(tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !bytes.Equal(got, tt.want) {
				t.Errorf("keyNameToBytes(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestKeyNameToBytesErrors(t *testing.T) {
	badInputs := []string{"", "C-", "C-1", "C-ab", "Nope", "F13", "F0"}
	for _, input := range badInputs {
		t.Run(input, func(t *testing.T) {
			_, err := keyNameToBytes(input)
			if err == nil {
				t.Fatalf("expected an error for %q", input)
			}
			if !strings.Contains(err.Error(), "Enter") {
				t.Errorf("error should list valid key names, got: %v", err)
			}
		})
	}
}

func TestKeyNamesToBytes(t *testing.T) {
	got, err := keyNamesToBytes([]string{"Up", "Up", "Enter"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []byte{0x1b, '[', 'A', 0x1b, '[', 'A', '\r'}
	if !bytes.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestRenderKeyNameHelpCoversTable(t *testing.T) {
	help := renderKeyNameHelp()
	for _, entry := range keyNameTable {
		if !strings.Contains(help, entry.Name) {
			t.Errorf("help output is missing key name %q", entry.Name)
		}
	}
	if !strings.Contains(help, "C-a") {
		t.Error("help output should document the C-<letter> form")
	}
}
