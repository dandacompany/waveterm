// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strconv"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var tabMoveCmd = &cobra.Command{
	Use:   "move <tab> <position>",
	Short: "move a tab to a new position in the tab bar",
	Long: "Move a tab to a new position in the tab bar.\n\n" +
		"The position is 1-based, matching the numbers 'wsh tab list' prints, so\n" +
		"'wsh tab move logs 1' makes the logs tab the leftmost one.",
	Example: "  wsh tab move logs 1\n" +
		"  wsh tab move 3 1\n" +
		"  wsh tab move this 2",
	Args:    cobra.ExactArgs(2),
	RunE:    tabMoveRun,
	PreRunE: preRunSetupRpcClient,
}

// reorderTabIds returns a copy of tabIds with the entry at oldIdx moved to newIdx,
// preserving the relative order of everything else. The caller must pass indices
// that are in range; the set of ids is never changed, because the server overwrites
// the workspace's tab list wholesale without validating it.
func reorderTabIds(tabIds []string, oldIdx int, newIdx int) []string {
	moved := tabIds[oldIdx]
	rest := make([]string, 0, len(tabIds)-1)
	for i, id := range tabIds {
		if i == oldIdx {
			continue
		}
		rest = append(rest, id)
	}
	rtn := make([]string, 0, len(tabIds))
	rtn = append(rtn, rest[:newIdx]...)
	rtn = append(rtn, moved)
	rtn = append(rtn, rest[newIdx:]...)
	return rtn
}

func tabMoveRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("tab:move", rtnErr == nil)
	}()

	tabId, err := resolveTabArg(args[0])
	if err != nil {
		return err
	}
	position, err := strconv.Atoi(args[1])
	if err != nil {
		return fmt.Errorf("position must be a number, got %q", args[1])
	}

	wsId, err := currentWorkspaceId()
	if err != nil {
		return err
	}
	ws, err := wshclient.GetWorkspaceCommand(RpcClient, wsId, &wshrpc.RpcOpts{Timeout: tabRpcTimeout})
	if err != nil {
		return fmt.Errorf("getting workspace %s: %w", wsId, err)
	}

	if position < 1 || position > len(ws.TabIds) {
		return fmt.Errorf("position %d is out of range, workspace has %d tabs", position, len(ws.TabIds))
	}
	newIdx := position - 1

	oldIdx := -1
	for i, id := range ws.TabIds {
		if id == tabId {
			oldIdx = i
			break
		}
	}
	if oldIdx == -1 {
		return fmt.Errorf("tab %s is not in the current workspace", tabId)
	}
	if oldIdx == newIdx {
		WriteStdout("tab is already at position %d\n", position)
		return nil
	}

	err = wshclient.UpdateWorkspaceTabIdsCommand(RpcClient, wsId, reorderTabIds(ws.TabIds, oldIdx, newIdx), &wshrpc.RpcOpts{Timeout: tabRpcTimeout})
	if err != nil {
		return fmt.Errorf("moving tab: %w", err)
	}
	WriteStdout("moved tab from position %d to %d\n", oldIdx+1, position)
	return nil
}
