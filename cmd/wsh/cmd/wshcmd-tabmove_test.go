// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"reflect"
	"testing"
)

func TestReorderTabIds(t *testing.T) {
	base := []string{"a", "b", "c", "d"}

	tests := []struct {
		name   string
		oldIdx int
		newIdx int
		want   []string
	}{
		{name: "move first to last", oldIdx: 0, newIdx: 3, want: []string{"b", "c", "d", "a"}},
		{name: "move last to first", oldIdx: 3, newIdx: 0, want: []string{"d", "a", "b", "c"}},
		{name: "move forward by one", oldIdx: 1, newIdx: 2, want: []string{"a", "c", "b", "d"}},
		{name: "move backward by one", oldIdx: 2, newIdx: 1, want: []string{"a", "c", "b", "d"}},
		{name: "move middle to front", oldIdx: 2, newIdx: 0, want: []string{"c", "a", "b", "d"}},
		{name: "move middle to back", oldIdx: 1, newIdx: 3, want: []string{"a", "c", "d", "b"}},
		{name: "same index is a no-op", oldIdx: 2, newIdx: 2, want: []string{"a", "b", "c", "d"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := append([]string(nil), base...)
			got := reorderTabIds(input, tt.oldIdx, tt.newIdx)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("reorderTabIds(%v, %d, %d) = %v, want %v", base, tt.oldIdx, tt.newIdx, got, tt.want)
			}
			if !reflect.DeepEqual(input, base) {
				t.Errorf("input slice was mutated: got %v, want %v", input, base)
			}
		})
	}
}

func TestReorderTabIdsPreservesTheSet(t *testing.T) {
	// the server overwrites TabIds wholesale with no validation, so losing or
	// duplicating an id here would drop a tab out of the workspace for good
	base := []string{"a", "b", "c", "d", "e"}
	for oldIdx := range base {
		for newIdx := range base {
			got := reorderTabIds(base, oldIdx, newIdx)
			if len(got) != len(base) {
				t.Fatalf("reorder(%d->%d) changed length: %v", oldIdx, newIdx, got)
			}
			seen := map[string]int{}
			for _, id := range got {
				seen[id]++
			}
			for _, id := range base {
				if seen[id] != 1 {
					t.Fatalf("reorder(%d->%d) = %v: id %q appears %d times", oldIdx, newIdx, got, id, seen[id])
				}
			}
		}
	}
}

func TestReorderTabIdsSingleElement(t *testing.T) {
	got := reorderTabIds([]string{"only"}, 0, 0)
	if !reflect.DeepEqual(got, []string{"only"}) {
		t.Errorf("got %v, want [only]", got)
	}
}
