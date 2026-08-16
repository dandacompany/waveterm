// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const sendKeysRpcTimeout = 2000

type keyNameEntry struct {
	Name    string
	Aliases []string
	Bytes   []byte
}

var keyNameTable = []keyNameEntry{
	{Name: "Enter", Aliases: []string{"Return"}, Bytes: []byte{'\r'}},
	{Name: "Tab", Bytes: []byte{'\t'}},
	{Name: "Escape", Aliases: []string{"Esc"}, Bytes: []byte{0x1b}},
	{Name: "Space", Bytes: []byte{0x20}},
	{Name: "BSpace", Bytes: []byte{0x7f}},
	{Name: "Delete", Bytes: []byte{0x1b, '[', '3', '~'}},
	{Name: "Up", Bytes: []byte{0x1b, '[', 'A'}},
	{Name: "Down", Bytes: []byte{0x1b, '[', 'B'}},
	{Name: "Right", Bytes: []byte{0x1b, '[', 'C'}},
	{Name: "Left", Bytes: []byte{0x1b, '[', 'D'}},
	{Name: "Home", Bytes: []byte{0x1b, '[', 'H'}},
	{Name: "End", Bytes: []byte{0x1b, '[', 'F'}},
	{Name: "PageUp", Bytes: []byte{0x1b, '[', '5', '~'}},
	{Name: "PageDown", Bytes: []byte{0x1b, '[', '6', '~'}},
	{Name: "F1", Bytes: []byte{0x1b, 'O', 'P'}},
	{Name: "F2", Bytes: []byte{0x1b, 'O', 'Q'}},
	{Name: "F3", Bytes: []byte{0x1b, 'O', 'R'}},
	{Name: "F4", Bytes: []byte{0x1b, 'O', 'S'}},
	{Name: "F5", Bytes: []byte{0x1b, '[', '1', '5', '~'}},
	{Name: "F6", Bytes: []byte{0x1b, '[', '1', '7', '~'}},
	{Name: "F7", Bytes: []byte{0x1b, '[', '1', '8', '~'}},
	{Name: "F8", Bytes: []byte{0x1b, '[', '1', '9', '~'}},
	{Name: "F9", Bytes: []byte{0x1b, '[', '2', '0', '~'}},
	{Name: "F10", Bytes: []byte{0x1b, '[', '2', '1', '~'}},
	{Name: "F11", Bytes: []byte{0x1b, '[', '2', '3', '~'}},
	{Name: "F12", Bytes: []byte{0x1b, '[', '2', '4', '~'}},
}

func renderKeyNameHelp() string {
	var sb strings.Builder
	sb.WriteString("  C-a .. C-z    control characters (0x01-0x1a)\n")
	for _, entry := range keyNameTable {
		label := entry.Name
		if len(entry.Aliases) > 0 {
			label = fmt.Sprintf("%s (%s)", entry.Name, strings.Join(entry.Aliases, ", "))
		}
		sb.WriteString(fmt.Sprintf("  %s\n", label))
	}
	return sb.String()
}

func keyNameToBytes(name string) ([]byte, error) {
	if strings.HasPrefix(strings.ToLower(name), "c-") {
		rest := name[2:]
		if len(rest) != 1 {
			return nil, keyNameError(name)
		}
		ch := strings.ToLower(rest)[0]
		if ch < 'a' || ch > 'z' {
			return nil, keyNameError(name)
		}
		return []byte{ch - 'a' + 1}, nil
	}
	for _, entry := range keyNameTable {
		if strings.EqualFold(entry.Name, name) {
			return entry.Bytes, nil
		}
		for _, alias := range entry.Aliases {
			if strings.EqualFold(alias, name) {
				return entry.Bytes, nil
			}
		}
	}
	return nil, keyNameError(name)
}

func keyNameError(name string) error {
	return fmt.Errorf("unknown key name %q\n\nvalid key names:\n%s", name, renderKeyNameHelp())
}

func keyNamesToBytes(names []string) ([]byte, error) {
	var out []byte
	for _, name := range names {
		b, err := keyNameToBytes(name)
		if err != nil {
			return nil, err
		}
		out = append(out, b...)
	}
	return out, nil
}

var sendKeysTab string
var sendKeysNames []string
var sendKeysSignal string
var sendKeysEnter bool

var sendKeysCmd = &cobra.Command{
	Use:   "sendkeys [-b block] {text | --keys key...}",
	Short: "send keystrokes to a terminal block",
	Long: "Send keystrokes to a terminal block.\n\n" +
		"The text argument is sent literally -- no escape sequences are interpreted, so\n" +
		"passwords and Windows paths arrive unchanged. Use --keys to send control keys.\n\n" +
		"Valid key names:\n" + renderKeyNameHelp(),
	Example: "  wsh sendkeys -b 2 \"npm test\"\n" +
		"  wsh sendkeys -b 2 --enter \"npm test\"\n" +
		"  wsh sendkeys -b 2 --keys C-c\n" +
		"  wsh sendkeys -b 2 --keys Up Up Enter\n" +
		"  wsh sendkeys --tab logs -b 1 --signal SIGINT",
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  sendKeysRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

func init() {
	sendKeysCmd.Flags().StringVar(&sendKeysTab, "tab", "", "tab containing the block (number, name, or id; defaults to current tab)")
	sendKeysCmd.Flags().StringSliceVar(&sendKeysNames, "keys", nil, "named control keys to send (e.g. C-c, Up, Enter)")
	sendKeysCmd.Flags().StringVar(&sendKeysSignal, "signal", "", "signal to send instead of input (e.g. SIGINT)")
	sendKeysCmd.Flags().BoolVar(&sendKeysEnter, "enter", false, "append a carriage return after the text")
	rootCmd.AddCommand(sendKeysCmd)
}

func sendKeysRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("sendkeys", rtnErr == nil)
	}()

	modeCount := 0
	if len(args) > 0 {
		modeCount++
	}
	if len(sendKeysNames) > 0 {
		modeCount++
	}
	if sendKeysSignal != "" {
		modeCount++
	}
	if modeCount == 0 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("provide text, --keys, or --signal")
	}
	if modeCount > 1 {
		return fmt.Errorf("text, --keys, and --signal are mutually exclusive")
	}
	if sendKeysEnter && len(args) == 0 {
		return fmt.Errorf("--enter only applies to a text argument")
	}

	scopeTabId, err := resolveTabScopeArg(sendKeysTab)
	if err != nil {
		return err
	}
	fullORef, err := resolveBlockArgInTab(scopeTabId)
	if err != nil {
		return err
	}
	if fullORef.OType != waveobj.OType_Block {
		return fmt.Errorf("object reference is not a block")
	}
	metaData, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{
		ORef: *fullORef,
	}, &wshrpc.RpcOpts{Timeout: sendKeysRpcTimeout})
	if err != nil {
		return fmt.Errorf("error getting block metadata: %w", err)
	}
	viewType, ok := metaData[waveobj.MetaKey_View].(string)
	if !ok || viewType != "term" {
		return fmt.Errorf("block %s is not a terminal block (view type: %s)", fullORef.OID, viewType)
	}

	inputData := wshrpc.CommandBlockInputData{BlockId: fullORef.OID}
	if sendKeysSignal != "" {
		inputData.SigName = sendKeysSignal
	} else {
		var payload []byte
		if len(sendKeysNames) > 0 {
			payload, err = keyNamesToBytes(sendKeysNames)
			if err != nil {
				return err
			}
		} else {
			payload = []byte(args[0])
			if sendKeysEnter {
				payload = append(payload, '\r')
			}
		}
		inputData.InputData64 = base64.StdEncoding.EncodeToString(payload)
	}

	err = wshclient.ControllerInputCommand(RpcClient, inputData, &wshrpc.RpcOpts{Timeout: sendKeysRpcTimeout})
	if err != nil {
		return fmt.Errorf("sending keys: %w", err)
	}
	return nil
}
