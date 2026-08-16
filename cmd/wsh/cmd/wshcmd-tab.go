// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// tab create and delete do more work than a lookup -- create applies a layout and
// starts a shell, delete tears down the tab's blocks
const tabMutateRpcTimeout = 5000

var tabListJSON bool
var tabCreateEmpty bool
var tabCreateNoActivate bool
var tabCreateJSON bool
var tabDeleteCloseWindow bool

var tabCmd = &cobra.Command{
	Use:   "tab",
	Short: "manage tabs",
	Long: "Manage the tabs in the current workspace.\n\n" +
		"Tabs can be addressed four ways:\n" +
		"  (omitted) or 'this'  the tab this command is running in\n" +
		"  2                    tab number, matching the order in the tab bar (1-based)\n" +
		"  logs                 tab name, matched exactly within the current workspace\n" +
		"  a0459921-cc1a-...    full tab id\n\n" +
		"Tab names are not unique. When a name matches more than one tab, the command\n" +
		"fails and lists the matches instead of guessing.",
}

var tabListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "list tabs in the current workspace",
	Example: "  wsh tab list\n  wsh tab list --json",
	Args:    cobra.NoArgs,
	RunE:    tabListRun,
	PreRunE: preRunSetupRpcClient,
}

var tabCreateCmd = &cobra.Command{
	Use:     "create [name]",
	Short:   "create a new tab",
	Example: "  wsh tab create\n  wsh tab create logs\n  wsh tab create scratch --empty --no-activate",
	Args:    cobra.MaximumNArgs(1),
	RunE:    tabCreateRun,
	PreRunE: preRunSetupRpcClient,
}

var tabRenameCmd = &cobra.Command{
	Use:     "rename <tab> <new-name>",
	Short:   "rename a tab",
	Example: "  wsh tab rename 2 logs\n  wsh tab rename this main",
	Args:    cobra.ExactArgs(2),
	RunE:    tabRenameRun,
	PreRunE: preRunSetupRpcClient,
}

var tabDeleteCmd = &cobra.Command{
	Use:   "delete <tab>",
	Short: "delete a tab",
	Long: "Delete a tab and everything in it.\n\n" +
		"Deleting the last tab in a workspace is refused, because it would leave an\n" +
		"empty window. Pass --close-window to delete it and close the window instead.",
	Example: "  wsh tab delete 2\n  wsh tab delete logs\n  wsh tab delete this --close-window",
	Args:    cobra.ExactArgs(1),
	RunE:    tabDeleteRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	tabListCmd.Flags().BoolVar(&tabListJSON, "json", false, "output as json")
	tabCreateCmd.Flags().BoolVar(&tabCreateEmpty, "empty", false, "create the tab with no blocks and no tab background")
	tabCreateCmd.Flags().BoolVar(&tabCreateNoActivate, "no-activate", false, "create the tab without switching to it")
	tabCreateCmd.Flags().BoolVar(&tabCreateJSON, "json", false, "output the new tab id as json")
	tabDeleteCmd.Flags().BoolVar(&tabDeleteCloseWindow, "close-window", false, "allow deleting the last tab, closing the window")
	tabCmd.AddCommand(tabListCmd)
	tabCmd.AddCommand(tabCreateCmd)
	tabCmd.AddCommand(tabRenameCmd)
	tabCmd.AddCommand(tabDeleteCmd)
	rootCmd.AddCommand(tabCmd)
}

func tabListRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("tab:list", rtnErr == nil)
	}()
	entries, err := listTabEntries()
	if err != nil {
		return err
	}
	if tabListJSON {
		barr, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return fmt.Errorf("json encoding: %w", err)
		}
		WriteStdout("%s\n", string(barr))
		return nil
	}
	for _, entry := range entries {
		marker := ""
		if entry.Active {
			marker = "  (current)"
		}
		WriteStdout("%3d  %-24s %s%s\n", entry.Num, entry.Name, entry.TabId, marker)
	}
	return nil
}

func tabCreateRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("tab:create", rtnErr == nil)
	}()
	var name string
	if len(args) > 0 {
		name = args[0]
	}
	wsId, err := currentWorkspaceId()
	if err != nil {
		return err
	}
	tabId, err := wshclient.CreateTabCommand(RpcClient, wshrpc.CommandCreateTabData{
		WorkspaceId: wsId,
		Name:        name,
		Empty:       tabCreateEmpty,
		NoActivate:  tabCreateNoActivate,
	}, &wshrpc.RpcOpts{Timeout: tabMutateRpcTimeout})
	if err != nil {
		return fmt.Errorf("creating tab: %w", err)
	}
	if tabCreateJSON {
		WriteStdout("{\"tabid\": %q}\n", tabId)
		return nil
	}
	WriteStdout("created tab %s\n", tabId)
	return nil
}

func tabRenameRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("tab:rename", rtnErr == nil)
	}()
	tabId, err := resolveTabArg(args[0])
	if err != nil {
		return err
	}
	err = wshclient.UpdateTabNameCommand(RpcClient, tabId, args[1], &wshrpc.RpcOpts{Timeout: tabRpcTimeout})
	if err != nil {
		return fmt.Errorf("renaming tab: %w", err)
	}
	WriteStdout("renamed tab %s to %q\n", tabId, args[1])
	return nil
}

func tabDeleteRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("tab:delete", rtnErr == nil)
	}()
	tabId, err := resolveTabArg(args[0])
	if err != nil {
		return err
	}
	err = wshclient.DeleteTabCommand(RpcClient, wshrpc.CommandDeleteTabData{
		TabId:       tabId,
		CloseWindow: tabDeleteCloseWindow,
	}, &wshrpc.RpcOpts{Timeout: tabMutateRpcTimeout})
	if err != nil {
		return fmt.Errorf("deleting tab: %w", err)
	}
	WriteStdout("deleted tab %s\n", tabId)
	return nil
}
