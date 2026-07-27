// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// stalledReader delivers a burst of data and then blocks forever, standing in for a
// transfer whose transport has silently died.
type stalledReader struct {
	remaining int
	blocked   chan struct{}
}

func (sr *stalledReader) Read(p []byte) (int, error) {
	if sr.remaining > 0 {
		n := len(p)
		if n > sr.remaining {
			n = sr.remaining
		}
		sr.remaining -= n
		return n, nil
	}
	<-sr.blocked // never returns
	return 0, io.EOF
}

func TestWatchCopyIdleFiresOnStall(t *testing.T) {
	pr := &progressReader{reader: &stalledReader{remaining: 1024}, total: 4096, lastPub: time.Now()}
	// backdate past the idle threshold so the first tick trips it
	pr.lastAdvance.Store(time.Now().Add(-2 * copyIdleTimeout).UnixNano())

	_, cancel := context.WithCancelCause(context.Background())
	causeCh := make(chan error, 1)
	wrapped := func(err error) {
		causeCh <- err
		cancel(err)
	}

	done := make(chan struct{})
	defer close(done)
	go watchCopyIdle(done, pr, wrapped, "wsh://test/file.bin")

	select {
	case err := <-causeCh:
		if err == nil || !strings.Contains(err.Error(), "stalled") {
			t.Fatalf("expected a stall error, got %v", err)
		}
	case <-time.After(copyIdleCheckInterval + 5*time.Second):
		t.Fatal("idle watchdog did not fire on a stalled transfer")
	}
}

func TestWatchCopyIdleIgnoresSlowButLiveTransfer(t *testing.T) {
	pr := &progressReader{total: 4096, lastPub: time.Now()}
	pr.lastAdvance.Store(time.Now().UnixNano())

	_, cancel := context.WithCancelCause(context.Background())
	causeCh := make(chan error, 1)
	wrapped := func(err error) {
		causeCh <- err
		cancel(err)
	}

	done := make(chan struct{})
	go watchCopyIdle(done, pr, wrapped, "wsh://test/file.bin")

	// keep the transfer barely alive across several watchdog ticks
	deadline := time.After(2*copyIdleCheckInterval + time.Second)
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-causeCh:
			close(done)
			t.Fatalf("watchdog fired on a live transfer: %v", err)
		case <-tick.C:
			pr.lastAdvance.Store(time.Now().UnixNano())
		case <-deadline:
			close(done)
			return
		}
	}
}

func TestWatchCopyIdleStopsWhenCopyFinishes(t *testing.T) {
	pr := &progressReader{total: 0, lastPub: time.Now()}
	pr.lastAdvance.Store(time.Now().Add(-2 * copyIdleTimeout).UnixNano())

	fired := make(chan error, 1)
	done := make(chan struct{})
	close(done) // copy already finished

	go watchCopyIdle(done, pr, func(err error) { fired <- err }, "wsh://test/file.bin")

	select {
	case err := <-fired:
		t.Fatalf("watchdog fired after the copy completed: %v", err)
	case <-time.After(copyIdleCheckInterval + time.Second):
		// expected: watchdog exited without firing
	}
}

func TestStatTimeoutIsNotTheCallerCopyTimeout(t *testing.T) {
	// mirrors the clamp in RemoteFileCopyCommand: a stat must never inherit a year
	const oneYearMs = int64(31536000000)
	clamp := func(optsTimeout int64) int64 {
		if optsTimeout <= 0 || optsTimeout > copyStatTimeout.Milliseconds() {
			return copyStatTimeout.Milliseconds()
		}
		return optsTimeout
	}
	if got := clamp(oneYearMs); got != copyStatTimeout.Milliseconds() {
		t.Fatalf("a year-long copy timeout must not reach the stat call; got %d ms", got)
	}
	if got := clamp(0); got != copyStatTimeout.Milliseconds() {
		t.Fatalf("unset timeout should fall back to the stat default; got %d ms", got)
	}
	if got := clamp(1500); got != 1500 {
		t.Fatalf("a caller timeout shorter than the default must be respected; got %d ms", got)
	}
	if errors.Is(nil, context.Canceled) {
		t.Fatal("unreachable")
	}
}
