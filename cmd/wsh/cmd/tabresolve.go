// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	TabArgKind_This = "this"
	TabArgKind_Num  = "num"
	TabArgKind_UUID = "uuid"
	TabArgKind_Name = "name"
)

const tabRpcTimeout = 2000

type tabEntry struct {
	TabId  string `json:"tabid"`
	Name   string `json:"name"`
	Num    int    `json:"num"`
	Active bool   `json:"active"`
}

func classifyTabArg(arg string) string {
	if arg == "" || arg == "this" {
		return TabArgKind_This
	}
	if _, err := uuid.Parse(arg); err == nil {
		return TabArgKind_UUID
	}
	if num, err := strconv.Atoi(arg); err == nil && num > 0 {
		return TabArgKind_Num
	}
	return TabArgKind_Name
}

func currentWorkspaceId() (string, error) {
	blockId := os.Getenv("WAVETERM_BLOCKID")
	if blockId == "" {
		return "", fmt.Errorf("no WAVETERM_BLOCKID env var set")
	}
	blockInfo, err := wshclient.BlockInfoCommand(RpcClient, blockId, &wshrpc.RpcOpts{Timeout: tabRpcTimeout})
	if err != nil {
		return "", fmt.Errorf("getting block info: %w", err)
	}
	return blockInfo.WorkspaceId, nil
}

func listTabEntries() ([]tabEntry, error) {
	wsId, err := currentWorkspaceId()
	if err != nil {
		return nil, err
	}
	workspaces, err := wshclient.WorkspaceListCommand(RpcClient, &wshrpc.RpcOpts{Timeout: tabRpcTimeout})
	if err != nil {
		return nil, fmt.Errorf("listing workspaces: %w", err)
	}
	var ws *waveobj.Workspace
	for _, wsInfo := range workspaces {
		if wsInfo.WorkspaceData != nil && wsInfo.WorkspaceData.OID == wsId {
			ws = wsInfo.WorkspaceData
			break
		}
	}
	if ws == nil {
		return nil, fmt.Errorf("workspace %s not found", wsId)
	}
	entries := make([]tabEntry, 0, len(ws.TabIds))
	for idx, tabId := range ws.TabIds {
		tab, err := wshclient.GetTabCommand(RpcClient, tabId, &wshrpc.RpcOpts{Timeout: tabRpcTimeout})
		if err != nil {
			return nil, fmt.Errorf("getting tab %s: %w", tabId, err)
		}
		entries = append(entries, tabEntry{
			TabId:  tabId,
			Name:   tab.Name,
			Num:    idx + 1,
			Active: tabId == ws.ActiveTabId,
		})
	}
	return entries, nil
}

func resolveTabArg(arg string) (string, error) {
	switch classifyTabArg(arg) {
	case TabArgKind_This:
		tabId := getTabIdFromEnv()
		if tabId == "" {
			return "", fmt.Errorf("no WAVETERM_TABID env var set")
		}
		return tabId, nil
	case TabArgKind_UUID:
		return arg, nil
	case TabArgKind_Num:
		oref, err := resolveSimpleId("tab:" + arg)
		if err != nil {
			return "", fmt.Errorf("resolving tab %s: %w", arg, err)
		}
		if oref.OType != waveobj.OType_Tab {
			return "", fmt.Errorf("resolved object is not a tab: %s", oref)
		}
		return oref.OID, nil
	}
	entries, err := listTabEntries()
	if err != nil {
		return "", err
	}
	var matches []tabEntry
	for _, entry := range entries {
		if entry.Name == arg {
			matches = append(matches, entry)
		}
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("no tab named %q in the current workspace", arg)
	}
	if len(matches) > 1 {
		descs := make([]string, 0, len(matches))
		for _, m := range matches {
			descs = append(descs, fmt.Sprintf("%d (%s)", m.Num, m.TabId))
		}
		return "", fmt.Errorf("%q matches %d tabs: %s -- use a tab number or id", arg, len(matches), strings.Join(descs, ", "))
	}
	return matches[0].TabId, nil
}

// returns "" when no tab was requested, so callers stay on the default
// current-tab resolution path instead of paying an RPC round trip
func resolveTabScopeArg(arg string) (string, error) {
	if arg == "" {
		return "", nil
	}
	return resolveTabArg(arg)
}
