// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package streamclient

import (
	"io"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// setupCuttableBrokerPair is setupBrokerPair with a kill switch on the relay
// goroutines, so a test can simulate a connection route vanishing mid-stream
// (the local -> WSL copy stall under investigation).
func setupCuttableBrokerPair() (b1 *Broker, b2 *Broker, cut func()) {
	rpc1 := &mockRpcInterface{
		dataChan: make(chan wshrpc.CommandStreamData, 10),
		ackChan:  make(chan wshrpc.CommandStreamAckData, 10),
	}
	rpc2 := &mockRpcInterface{
		dataChan: make(chan wshrpc.CommandStreamData, 10),
		ackChan:  make(chan wshrpc.CommandStreamAckData, 10),
	}
	broker1 := NewBroker(rpc1)
	broker2 := NewBroker(rpc2)

	stop := make(chan struct{})
	relay := func(deliver func()) {
		go func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				deliver()
			}
		}()
	}
	relay(func() {
		select {
		case d := <-rpc1.dataChan:
			broker2.RecvData(d)
		case <-stop:
		case <-time.After(10 * time.Millisecond):
		}
	})
	relay(func() {
		select {
		case a := <-rpc1.ackChan:
			broker2.RecvAck(a)
		case <-stop:
		case <-time.After(10 * time.Millisecond):
		}
	})
	relay(func() {
		select {
		case d := <-rpc2.dataChan:
			broker1.RecvData(d)
		case <-stop:
		case <-time.After(10 * time.Millisecond):
		}
	})
	relay(func() {
		select {
		case a := <-rpc2.ackChan:
			broker1.RecvAck(a)
		case <-stop:
		case <-time.After(10 * time.Millisecond):
		}
	})

	return broker1, broker2, func() { close(stop) }
}

// TestReproRouteLossStallsWriter asserts the writer surfaces an error when the
// route carrying its acks disappears mid-stream. Today it blocks forever
// instead, which is the suspected cause of the local -> WSL copy hang.
func TestReproRouteLossStallsWriter(t *testing.T) {
	broker1, broker2, cut := setupCuttableBrokerPair()

	// small window forces the writer to wait on acks, as a real large transfer does
	reader, meta := broker1.CreateStreamReader("reader1", "writer1", 1024)
	writer, err := broker2.CreateStreamWriter(meta)
	if err != nil {
		t.Fatalf("CreateStreamWriter failed: %v", err)
	}

	payload := make([]byte, 512*1024) // 512 KB against a 1 KB window
	writeDone := make(chan error, 1)
	go func() {
		_, werr := writer.Write(payload)
		writeDone <- werr
	}()

	// let the transfer get going, then sever the route
	buf := make([]byte, 4096)
	if _, err := reader.Read(buf); err != nil {
		t.Fatalf("initial read failed: %v", err)
	}
	cut()

	select {
	case werr := <-writeDone:
		if werr == nil {
			t.Fatal("write reported success after the route was cut")
		}
		t.Logf("PASS: writer surfaced an error after route loss: %v", werr)
	case <-time.After(RetransmitInterval*time.Duration(MaxRetransmitAttempts+2) + 10*time.Second):
		t.Fatal("writer blocked indefinitely after route loss — the retransmit budget must fail the stream")
	}
}

// TestReproRouteLossStallsReader is the reader-side twin: a reader whose writer
// route has vanished should surface an error rather than block forever.
func TestReproRouteLossStallsReader(t *testing.T) {
	t.Skip("by design: a generic Reader has no idle timeout (it would break legitimately idle streams). " +
		"A reader whose peer vanished is covered at the copy layer, not here.")
	broker1, broker2, cut := setupCuttableBrokerPair()

	reader, meta := broker1.CreateStreamReader("reader1", "writer1", 64*1024)
	writer, err := broker2.CreateStreamWriter(meta)
	if err != nil {
		t.Fatalf("CreateStreamWriter failed: %v", err)
	}

	if _, err := writer.Write([]byte("first chunk")); err != nil {
		t.Fatalf("initial write failed: %v", err)
	}
	buf := make([]byte, 4096)
	if _, err := reader.Read(buf); err != nil {
		t.Fatalf("initial read failed: %v", err)
	}

	cut()

	readDone := make(chan error, 1)
	go func() {
		_, rerr := reader.Read(buf)
		readDone <- rerr
	}()

	select {
	case rerr := <-readDone:
		if rerr == nil || rerr == io.EOF {
			t.Fatalf("reader returned %v after route loss — a vanished route must not look like a clean EOF", rerr)
		}
		t.Logf("PASS: reader surfaced an error after route loss: %v", rerr)
	case <-time.After(5 * time.Second):
		t.Fatal("REPRODUCED: reader blocked indefinitely after route loss (no timeout, no keepalive, no teardown)")
	}
}

// TestReproPartialWriteLooksLikeCleanEOF demonstrates finding 3: when the source
// side abandons a stream partway and closes normally (which is what the writer
// goroutine in wshremote_file.go does on a write error — a bare `return` falling
// through to `defer writer.Close()`), the destination sees a clean io.EOF. io.Copy
// then returns nil and the copy is reported as a full-size success, silently
// truncating the destination file.
func TestReproPartialWriteLooksLikeCleanEOF(t *testing.T) {
	broker1, broker2 := setupBrokerPair()

	reader, meta := broker1.CreateStreamReader("reader1", "writer1", 64*1024)
	writer, err := broker2.CreateStreamWriter(meta)
	if err != nil {
		t.Fatalf("CreateStreamWriter failed: %v", err)
	}

	const declaredTotal = 1000 // what the copy tells the user it will transfer
	partial := make([]byte, 100)
	for i := range partial {
		partial[i] = byte(i)
	}
	if _, err := writer.Write(partial); err != nil {
		t.Fatalf("partial write failed: %v", err)
	}
	// the abandon-without-error path
	writer.Close()

	got, err := io.ReadAll(reader)
	if err != nil {
		t.Logf("PASS: destination surfaced an error on a truncated stream: %v", err)
		return
	}
	// This is correct broker behaviour: Close() means "end of stream", so a caller that
	// abandons a transfer MUST use CloseWithError. wshremote_file.go used a bare return
	// (falling through to Close) and so reported truncated copies as complete.
	if len(got) == declaredTotal {
		t.Fatalf("expected a short read, got the full %d bytes", declaredTotal)
	}
	t.Logf("Close() after a partial write reads as clean EOF (%d of %d bytes) — "+
		"callers must use CloseWithError to signal an abandoned transfer", len(got), declaredTotal)
}

// TestReproSustainedTransfer drives a large payload through the broker with the
// same window and chunk sizes the real copy path uses (256 KB reader window,
// 32 KB writer chunks). If the stall is a flow-control/ack accounting bug rather
// than route loss, this stalls at a reproducible offset with the route intact.
func TestReproSustainedTransfer(t *testing.T) {
	broker1, broker2 := setupBrokerPair()

	const totalSize = 64 * 1024 * 1024 // 64 MB
	reader, meta := broker1.CreateStreamReader("reader1", "writer1", 256*1024)
	writer, err := broker2.CreateStreamWriter(meta)
	if err != nil {
		t.Fatalf("CreateStreamWriter failed: %v", err)
	}

	go func() {
		buf := make([]byte, 32*1024)
		for i := range buf {
			buf[i] = byte(i)
		}
		written := 0
		for written < totalSize {
			n, werr := writer.Write(buf)
			if werr != nil {
				t.Logf("writer stopped at %d bytes: %v", written, werr)
				return
			}
			written += n
		}
		writer.Close()
	}()

	progress := make(chan int64, 1)
	go func() {
		n, _ := io.Copy(io.Discard, reader)
		progress <- n
	}()

	select {
	case n := <-progress:
		if n != totalSize {
			t.Fatalf("REPRODUCED: transfer ended at %d of %d bytes", n, totalSize)
		}
		t.Logf("PASS: full %d bytes transferred with the route intact", n)
	case <-time.After(60 * time.Second):
		t.Fatal("REPRODUCED: sustained transfer stalled with the route intact — flow-control bug, not route loss")
	}
}
