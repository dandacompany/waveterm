package streamclient

import (
	"encoding/base64"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// The stream protocol runs over a transport that can drop a message (observed in the
// field: a single lost data packet on a WSL connection). Flow control alone cannot
// recover from that, so the writer retains everything it has sent but not had ACKed and
// re-sends it, driven by duplicate ACKs (fast path) and by a timer (the only thing that
// can recover a lost *final* packet, where no further data exists to trigger a dup ACK).
const (
	DupAckRetransmitThreshold = 3
	RetransmitChunkSize       = 32 * 1024
	RetransmitInterval        = 2 * time.Second
	MaxRetransmitAttempts     = 8
	retransmitTickInterval    = 500 * time.Millisecond
)

type DataSender interface {
	SendData(dataPk wshrpc.CommandStreamData)
}

type Writer struct {
	lock         sync.Mutex
	cond         *sync.Cond
	id           string
	dataSender   DataSender
	readWindow   int64
	nextSeq      int64
	buffer       []byte
	sentNotAcked int64
	maxAckedSeq  int64
	maxAckedRwnd int64
	finAcked     bool
	canceled     bool
	canceledChan chan struct{}
	eof          bool
	err          error
	closed       bool

	// retransmission state
	unacked           []byte // sent but not yet ACKed; unacked[0] carries seq unackedBase
	unackedBase       int64
	dupAckCount       int
	lastProgress      time.Time
	retransmitCount   int
	retransmitStopped bool
	finPending        bool
	finSeq            int64
}

func NewWriter(id string, readWindow int64, dataSender DataSender) *Writer {
	w := &Writer{
		id:           id,
		readWindow:   readWindow,
		dataSender:   dataSender,
		nextSeq:      0,
		sentNotAcked: 0,
		maxAckedSeq:  0,
		canceledChan: make(chan struct{}),
		lastProgress: time.Now(),
	}
	w.cond = sync.NewCond(&w.lock)
	go w.retransmitLoop()
	return w
}

// retransmitLoop re-sends the oldest unACKed bytes when the stream stops making progress,
// and fails the stream outright after MaxRetransmitAttempts so a broken transport surfaces
// as an error instead of an indefinite hang.
func (w *Writer) retransmitLoop() {
	ticker := time.NewTicker(retransmitTickInterval)
	defer ticker.Stop()
	for range ticker.C {
		w.lock.Lock()
		// deliberately not keyed on w.err: a normal Close sets it to io.ErrClosedPipe, and
		// the tail of a transfer is exactly when a lost packet must still be recoverable
		if w.retransmitStopped || w.canceled || w.finAcked {
			w.retransmitStopped = true
			w.lock.Unlock()
			return
		}
		if time.Since(w.lastProgress) < RetransmitInterval {
			w.lock.Unlock()
			continue
		}
		// nothing outstanding and nothing waiting to be sent: idle by design, not stalled
		if len(w.unacked) == 0 && !w.finPending && len(w.buffer) == 0 {
			w.lock.Unlock()
			continue
		}
		w.retransmitCount++
		if w.retransmitCount > MaxRetransmitAttempts {
			w.err = fmt.Errorf("stream stalled: no ack for %d bytes at seq %d after %d retransmits",
				len(w.unacked), w.unackedBase, MaxRetransmitAttempts)
			w.retransmitStopped = true
			w.cond.Broadcast()
			errPk := wshrpc.CommandStreamData{Id: w.id, Seq: w.nextSeq, Error: w.err.Error()}
			w.lock.Unlock()
			w.dataSender.SendData(errPk)
			return
		}
		w.lastProgress = time.Now()
		if len(w.unacked) > 0 {
			w.retransmitOldestLocked()
			w.lock.Unlock()
			continue
		}
		if w.finPending {
			// all data acked but the EOF marker never was; it carries no payload so it is
			// not in unacked and needs re-sending on its own
			finPk := wshrpc.CommandStreamData{Id: w.id, Seq: w.finSeq, Eof: true}
			w.lock.Unlock()
			w.dataSender.SendData(finPk)
			continue
		}
		// Zero-window probe. Everything sent has been ACKed, but the reader's last window
		// update never arrived, so there is nothing to retransmit and the writer would wait
		// forever. An empty data packet at nextSeq is a no-op for the reader and makes it
		// re-ACK with its current window.
		probePk := wshrpc.CommandStreamData{Id: w.id, Seq: w.nextSeq}
		w.lock.Unlock()
		w.dataSender.SendData(probePk)
	}
}

// retransmitOldestLocked re-sends the first RetransmitChunkSize bytes of unacked data.
// Re-sending only the head is enough: filling the reader's gap lets it drain everything
// it already has parked out-of-order and ACK far forward in one step.
func (w *Writer) retransmitOldestLocked() {
	if len(w.unacked) == 0 {
		return
	}
	toSend := len(w.unacked)
	if toSend > RetransmitChunkSize {
		toSend = RetransmitChunkSize
	}
	dataPk := wshrpc.CommandStreamData{
		Id:     w.id,
		Seq:    w.unackedBase,
		Data64: base64.StdEncoding.EncodeToString(w.unacked[:toSend]),
	}
	w.dataSender.SendData(dataPk)
}

func (w *Writer) RecvAck(ackPk wshrpc.CommandStreamAckData) {
	w.lock.Lock()
	defer w.lock.Unlock()

	if ackPk.Id != w.id {
		return
	}

	ackedSeq := ackPk.Seq
	rwnd := ackPk.RWnd

	if ackPk.Fin {
		w.finAcked = true
		w.maxAckedSeq = ackedSeq
		w.unacked = nil
		w.finPending = false
		return
	}

	if ackPk.Cancel && !w.canceled {
		w.canceled = true
		close(w.canceledChan)
		if !w.closed {
			w.err = fmt.Errorf("stream cancelled")
			w.cond.Broadcast()
		}
		return
	}

	// Duplicate ACKs mean the reader is parking out-of-order data behind a gap at ackedSeq.
	// This must be handled before the stale-ACK filter below, which would otherwise discard
	// them (same seq, and a shrinking window as the reader's buffer fills).
	if ackedSeq == w.maxAckedSeq && len(w.unacked) > 0 {
		w.dupAckCount++
		if w.dupAckCount >= DupAckRetransmitThreshold {
			w.dupAckCount = 0
			w.lastProgress = time.Now()
			w.retransmitOldestLocked()
		}
	} else if ackedSeq > w.maxAckedSeq {
		w.dupAckCount = 0
	}

	if ackedSeq > w.unackedBase {
		drop := ackedSeq - w.unackedBase
		if drop >= int64(len(w.unacked)) {
			w.unacked = nil
		} else {
			w.unacked = w.unacked[drop:]
		}
		w.unackedBase = ackedSeq
		w.lastProgress = time.Now()
		w.retransmitCount = 0
	}

	// Ignore stale ACKs using tuple comparison (seq, rwnd)
	if ackedSeq < w.maxAckedSeq || (ackedSeq == w.maxAckedSeq && rwnd <= w.maxAckedRwnd) {
		return
	}

	// Update max acked tuple
	w.maxAckedSeq = ackedSeq
	w.maxAckedRwnd = rwnd

	if !w.closed {
		if ackedSeq > (w.nextSeq - w.sentNotAcked) {
			ackedBytes := ackedSeq - (w.nextSeq - w.sentNotAcked)
			w.sentNotAcked -= ackedBytes
			if w.sentNotAcked < 0 {
				w.sentNotAcked = 0
			}
		}

		w.readWindow = rwnd
		w.cond.Broadcast()
	}
}

func (w *Writer) GetAckState() (maxAckedSeq int64, finAcked bool, canceled bool) {
	w.lock.Lock()
	defer w.lock.Unlock()

	return w.maxAckedSeq, w.finAcked, w.canceled
}

func (w *Writer) GetCanceledChan() <-chan struct{} {
	return w.canceledChan
}

func (w *Writer) Write(p []byte) (int, error) {
	w.lock.Lock()
	defer w.lock.Unlock()

	if w.closed {
		return 0, io.ErrClosedPipe
	}

	if w.err != nil {
		return 0, w.err
	}

	w.buffer = append(w.buffer, p...)
	n := len(p)

	for len(w.buffer) > 0 {
		if w.closed {
			return 0, io.ErrClosedPipe
		}
		if w.err != nil {
			return 0, w.err
		}

		sent := w.trySendDataLocked()
		if !sent {
			w.cond.Wait()
		}
	}

	return n, nil
}

func (w *Writer) trySendDataLocked() bool {
	availWindow := w.readWindow - w.sentNotAcked
	if availWindow <= 0 {
		return false
	}

	toSend := len(w.buffer)
	if int64(toSend) > availWindow {
		toSend = int(availWindow)
	}

	data := w.buffer[:toSend]
	w.buffer = w.buffer[toSend:]

	if len(w.unacked) == 0 {
		w.unackedBase = w.nextSeq
	}
	w.unacked = append(w.unacked, data...)

	dataStr := base64.StdEncoding.EncodeToString(data)
	dataPk := wshrpc.CommandStreamData{
		Id:     w.id,
		Seq:    w.nextSeq,
		Data64: dataStr,
	}

	w.dataSender.SendData(dataPk)
	w.nextSeq += int64(toSend)
	w.sentNotAcked += int64(toSend)

	return toSend > 0
}

// If Close() is called while a Write is blocked, the Write will return an error and buffered data may be discarded.
func (w *Writer) Close() error {
	return w.CloseWithError(nil)
}

// If CloseWithError() is called while a Write is blocked, the Write will return an error and buffered data may be discarded.
func (w *Writer) CloseWithError(err error) error {
	w.lock.Lock()
	defer w.lock.Unlock()

	if w.closed {
		return nil
	}

	w.closed = true
	if w.err == nil {
		w.err = io.ErrClosedPipe
	}
	w.cond.Broadcast()

	if err != nil && err != io.EOF {
		// an errored stream is not going to be recovered by retransmitting
		w.retransmitStopped = true
	}

	var dataPk wshrpc.CommandStreamData
	if err == nil || err == io.EOF {
		w.finPending = true
		w.finSeq = w.nextSeq
		w.lastProgress = time.Now()
		dataPk = wshrpc.CommandStreamData{
			Id:  w.id,
			Seq: w.nextSeq,
			Eof: true,
		}
	} else {
		dataPk = wshrpc.CommandStreamData{
			Id:    w.id,
			Seq:   w.nextSeq,
			Error: err.Error(),
		}
	}
	w.dataSender.SendData(dataPk)

	return nil
}
