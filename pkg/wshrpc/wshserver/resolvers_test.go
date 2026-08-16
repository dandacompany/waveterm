// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestTabIdForResolve(t *testing.T) {
	ctx := context.Background()

	t.Run("tabid wins over blockid", func(t *testing.T) {
		data := wshrpc.CommandResolveIdsData{BlockId: "block-1", TabId: "tab-9"}
		got, err := tabIdForResolve(ctx, data)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "tab-9" {
			t.Errorf("got %q, want %q", got, "tab-9")
		}
	})

	t.Run("errors when neither is set", func(t *testing.T) {
		data := wshrpc.CommandResolveIdsData{}
		_, err := tabIdForResolve(ctx, data)
		if err == nil {
			t.Fatal("expected an error when both blockid and tabid are empty")
		}
	})
}
