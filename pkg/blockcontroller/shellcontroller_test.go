// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func TestResolveCommandCwd(t *testing.T) {
	localCwd, err := wavebase.ExpandHomeDir("~/projects/waveterm")
	if err != nil {
		t.Fatalf("expanding local test path: %v", err)
	}

	tests := []struct {
		name     string
		cwd      string
		connType string
		want     string
	}{
		{
			name:     "preserves WSL home expansion for the guest",
			cwd:      "~/projects/waveterm",
			connType: ConnType_Wsl,
			want:     "~/projects/waveterm",
		},
		{
			name:     "preserves SSH home expansion for the remote host",
			cwd:      "~/projects/waveterm",
			connType: ConnType_Ssh,
			want:     "~/projects/waveterm",
		},
		{
			name:     "preserves an empty working directory",
			connType: ConnType_Local,
			want:     "",
		},
		{
			name:     "expands the local home directory",
			cwd:      "~/projects/waveterm",
			connType: ConnType_Local,
			want:     localCwd,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveCommandCwd(tt.cwd, tt.connType)
			if err != nil {
				t.Fatalf("resolveCommandCwd() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("resolveCommandCwd() = %q, want %q", got, tt.want)
			}
		})
	}
}
