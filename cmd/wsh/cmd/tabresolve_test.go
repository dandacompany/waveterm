// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestClassifyTabArg(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty means current tab", input: "", want: TabArgKind_This},
		{name: "this keyword", input: "this", want: TabArgKind_This},
		{name: "plain number", input: "2", want: TabArgKind_Num},
		{name: "multi digit number", input: "12", want: TabArgKind_Num},
		{name: "full uuid", input: "a0459921-cc1a-48cc-ae7b-5f4821e1c9e1", want: TabArgKind_UUID},
		{name: "plain word is a name", input: "logs", want: TabArgKind_Name},
		{name: "name with spaces", input: "my tab", want: TabArgKind_Name},
		{name: "name that looks like a view type", input: "term", want: TabArgKind_Name},
		{name: "negative number is a name", input: "-1", want: TabArgKind_Name},
		{name: "zero is a name", input: "0", want: TabArgKind_Name},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyTabArg(tt.input)
			if got != tt.want {
				t.Errorf("classifyTabArg(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
