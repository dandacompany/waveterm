// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"reflect"
	"testing"
)

func TestMakeWslCommandArgs(t *testing.T) {
	tests := []struct {
		name        string
		distroName  string
		cwd         string
		commandArgs []string
		want        []string
	}{
		{
			name:       "defaults to the WSL home directory",
			distroName: "Ubuntu",
			want:       []string{"--distribution", "Ubuntu", "--cd", "~"},
		},
		{
			name:       "sets an absolute Linux working directory",
			distroName: "Ubuntu-24.04",
			cwd:        "/home/dante/projects/waveterm",
			want:       []string{"--distribution", "Ubuntu-24.04", "--cd", "/home/dante/projects/waveterm"},
		},
		{
			name:        "preserves spaces and appends a command",
			distroName:  "Ubuntu",
			cwd:         "/home/dante/project with spaces",
			commandArgs: []string{"sh", "-c", "printf ok"},
			want: []string{
				"--distribution", "Ubuntu", "--cd", "/home/dante/project with spaces",
				"--", "sh", "-c", "printf ok",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := makeWslCommandArgs(tt.distroName, tt.cwd, tt.commandArgs...)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("makeWslCommandArgs() = %#v, want %#v", got, tt.want)
			}
		})
	}
}
