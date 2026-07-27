// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package streamclient

import (
	"bytes"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// lossyTransport relays between a reader and a writer, dropping selected data packets
// exactly once each — reproducing the field failure where a single packet vanished on a
// WSL connection and deadlocked the transfer permanently.
type lossyTransport struct {
	lock        sync.Mutex
	reader      *Reader
	writer      *Writer
	dropSeqs    map[int64]bool
	dropped     map[int64]bool
	dropAllData bool
	dropAllAcks bool
	relayed     int
	cutAfter    int // when >0, sever the link entirely after this many data packets
}

func newLossyTransport(dropSeqs ...int64) *lossyTransport {
	lt := &lossyTransport{dropSeqs: map[int64]bool{}, dropped: map[int64]bool{}}
	for _, s := range dropSeqs {
		lt.dropSeqs[s] = true
	}
	return lt
}

func (lt *lossyTransport) SendData(dataPk wshrpc.CommandStreamData) {
	lt.lock.Lock()
	if dataPk.Data64 != "" {
		lt.relayed++
		if lt.cutAfter > 0 && lt.relayed >= lt.cutAfter {
			lt.dropAllData = true
			lt.dropAllAcks = true
		}
	}
	if lt.dropAllData {
		lt.lock.Unlock()
		return
	}
	// drop each targeted seq once, so the retransmit is allowed through
	if lt.dropSeqs[dataPk.Seq] && !lt.dropped[dataPk.Seq] && dataPk.Data64 != "" {
		lt.dropped[dataPk.Seq] = true
		lt.lock.Unlock()
		return
	}
	r := lt.reader
	lt.lock.Unlock()
	go r.RecvData(dataPk)
}

func (lt *lossyTransport) SendAck(ackPk wshrpc.CommandStreamAckData) {
	lt.lock.Lock()
	if lt.dropAllAcks {
		lt.lock.Unlock()
		return
	}
	w := lt.writer
	lt.lock.Unlock()
	go w.RecvAck(ackPk)
}

func (lt *lossyTransport) setDropAll(data bool, acks bool) {
	lt.lock.Lock()
	defer lt.lock.Unlock()
	lt.dropAllData = data
	lt.dropAllAcks = acks
}

// TestRecoversFromDroppedDataPacket is the regression test for the root cause: one data
// packet is dropped mid-stream. Before the fix the reader parked every later packet
// out-of-order without ACKing, the writer blocked on a window that never reopened, and the
// transfer hung forever.
func TestRecoversFromDroppedDataPacket(t *testing.T) {
	lt := newLossyTransport(4096)
	lt.reader = NewReader("loss1", 8192, lt)
	lt.writer = NewWriter("loss1", 8192, lt)

	payload := make([]byte, 64*1024)
	for i := range payload {
		payload[i] = byte(i % 251)
	}

	writeDone := make(chan error, 1)
	go func() {
		_, err := lt.writer.Write(payload)
		if err != nil {
			writeDone <- err
			return
		}
		writeDone <- lt.writer.Close()
	}()

	got := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(lt.reader)
		got <- b
	}()

	select {
	case b := <-got:
		if !bytes.Equal(b, payload) {
			t.Fatalf("data mismatch: got %d bytes, want %d", len(b), len(payload))
		}
	case <-time.After(30 * time.Second):
		t.Fatal("transfer did not recover from a single dropped data packet")
	}

	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("write failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("writer did not finish")
	}
}

// TestRecoversFromMultipleDroppedPackets covers losses spread across the stream, including
// non-adjacent gaps.
func TestRecoversFromMultipleDroppedPackets(t *testing.T) {
	lt := newLossyTransport(2048, 6144, 14336)
	lt.reader = NewReader("loss2", 4096, lt)
	lt.writer = NewWriter("loss2", 4096, lt)

	payload := make([]byte, 32*1024)
	for i := range payload {
		payload[i] = byte(i % 253)
	}

	go func() {
		lt.writer.Write(payload)
		lt.writer.Close()
	}()

	got := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(lt.reader)
		got <- b
	}()

	select {
	case b := <-got:
		if !bytes.Equal(b, payload) {
			t.Fatalf("data mismatch: got %d bytes, want %d", len(b), len(payload))
		}
	case <-time.After(60 * time.Second):
		t.Fatal("transfer did not recover from multiple dropped data packets")
	}
}

// TestWriterFailsInsteadOfHangingWhenTransportDies asserts the second half of the fix:
// when the transport is genuinely gone, the writer gives up and reports an error rather
// than blocking forever. This is what turns a silent hang into a visible failure.
func TestWriterFailsInsteadOfHangingWhenTransportDies(t *testing.T) {
	lt := newLossyTransport()
	lt.reader = NewReader("dead1", 4096, lt)
	lt.writer = NewWriter("dead1", 4096, lt)

	// the reader must keep draining: a reader that simply stops reading is legitimate
	// backpressure (window 0, nothing unacked), not the failure this test is about
	go io.Copy(io.Discard, lt.reader)

	// sever the link deterministically once data is genuinely in flight
	lt.lock.Lock()
	lt.cutAfter = 5
	lt.lock.Unlock()

	writeDone := make(chan error, 1)
	go func() {
		payload := make([]byte, 4*1024*1024)
		_, err := lt.writer.Write(payload)
		writeDone <- err
	}()

	maxWait := RetransmitInterval*time.Duration(MaxRetransmitAttempts+2) + 10*time.Second
	select {
	case err := <-writeDone:
		if err == nil {
			t.Fatal("write reported success after the transport died")
		}
		t.Logf("writer surfaced an error as intended: %v", err)
	case <-time.After(maxWait):
		t.Fatalf("writer still blocked after %v — a dead transport must not hang forever", maxWait)
	}
}
