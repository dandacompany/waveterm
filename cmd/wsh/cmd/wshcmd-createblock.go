// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var positionToTargetAction = map[string]string{
	"right":   "splitright",
	"left":    "splitleft",
	"up":      "splitup",
	"down":    "splitdown",
	"replace": "replace",
}

var createBlockMagnified bool
var createBlockTab string
var createBlockTarget string
var createBlockPosition string
var createBlockSize int

var createBlockCmd = &cobra.Command{
	Use:   "createblock viewname key=value ...",
	Short: "create a new block",
	Long: "Create a new block in a tab.\n\n" +
		"Without --target the block is inserted using the tab's default placement.\n" +
		"With --target the block is placed relative to an existing block, and --size\n" +
		"sets the new block's share of that pair as a percentage (1-99).",
	Example: "  wsh createblock term\n" +
		"  wsh createblock term --target 1 --position right --size 30\n" +
		"  wsh createblock preview file=/tmp/notes.md --tab logs --target 1 --position down\n" +
		"  wsh createblock web url=https://waveterm.dev --target 2 --position replace",
	Args:    cobra.MinimumNArgs(1),
	RunE:    createBlockRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	createBlockCmd.Flags().BoolVarP(&createBlockMagnified, "magnified", "m", false, "create block in magnified mode")
	createBlockCmd.Flags().StringVar(&createBlockTab, "tab", "", "tab to create the block in (number, name, or id; defaults to current tab)")
	createBlockCmd.Flags().StringVar(&createBlockTarget, "target", "", "existing block to place the new block against (block number or id)")
	createBlockCmd.Flags().StringVar(&createBlockPosition, "position", "right", "placement relative to --target: right, left, up, down, replace")
	createBlockCmd.Flags().IntVar(&createBlockSize, "size", 0, "percentage of the split pair for the new block (1-99, requires --target)")
	rootCmd.AddCommand(createBlockCmd)
}

func createBlockRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("createblock", rtnErr == nil)
	}()

	viewName := args[0]
	var metaSetStrs []string
	if len(args) > 1 {
		metaSetStrs = args[1:]
	}
	if createBlockSize != 0 && createBlockTarget == "" {
		return fmt.Errorf("--size requires --target")
	}
	targetAction, ok := positionToTargetAction[createBlockPosition]
	if !ok {
		valid := make([]string, 0, len(positionToTargetAction))
		for key := range positionToTargetAction {
			valid = append(valid, key)
		}
		return fmt.Errorf("invalid --position %q (valid: %s)", createBlockPosition, strings.Join(valid, ", "))
	}

	scopeTabId, err := resolveTabScopeArg(createBlockTab)
	if err != nil {
		return err
	}
	tabId := scopeTabId
	if tabId == "" {
		tabId = getTabIdFromEnv()
	}
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}

	var targetBlockId string
	if createBlockTarget != "" {
		targetORef, err := resolveSimpleIdInTab(createBlockTarget, scopeTabId)
		if err != nil {
			return fmt.Errorf("resolving --target: %w", err)
		}
		if targetORef.OType != waveobj.OType_Block {
			return fmt.Errorf("--target is not a block: %s", targetORef)
		}
		targetBlockId = targetORef.OID
	}

	meta, err := parseMetaSets(metaSetStrs)
	if err != nil {
		return err
	}
	meta["view"] = viewName
	data := wshrpc.CommandCreateBlockData{
		TabId: tabId,
		BlockDef: &waveobj.BlockDef{
			Meta: meta,
		},
		Magnified: createBlockMagnified,
		Focused:   true,
	}
	if targetBlockId != "" {
		data.TargetBlockId = targetBlockId
		data.TargetAction = targetAction
		data.TargetSizePercent = createBlockSize
	}
	oref, err := wshclient.CreateBlockCommand(RpcClient, data, nil)
	if err != nil {
		return fmt.Errorf("create block failed: %v", err)
	}
	WriteStdout("created block %s\n", oref.OID)
	return nil
}
