// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/fspath"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

var DisableRecursiveFileOpts = true

const copyProgressInterval = 100 * time.Millisecond

// A large copy has no meaningful upper bound on total duration, so callers pass an
// effectively infinite timeout (a year). That leaves nothing to catch a transfer that
// simply stops. Bound *idle* time instead: a transfer that moves no bytes for this long
// is dead, however large the file.
const copyIdleTimeout = 60 * time.Second
const copyIdleCheckInterval = 5 * time.Second

// A stat is not a transfer; it must never inherit the caller's year-long copy timeout.
const copyStatTimeout = 60 * time.Second

// publishCopyProgress emits a FileCopyProgress event scoped by copyId. Only the wavesrv-side of a
// copy reaches the frontend; a remote wsh has no broker route, so its publish is a harmless no-op.
func publishCopyProgress(copyId string, bytes, total int64, done bool, errStr string) {
	if copyId == "" {
		return
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_FileCopyProgress,
		Scopes: []string{copyId},
		Data:   wshrpc.FileCopyProgressData{CopyId: copyId, Bytes: bytes, Total: total, Done: done, Error: errStr},
	})
}

// progressReader wraps a reader and emits throttled FileCopyProgress events as bytes flow through.
type progressReader struct {
	reader      io.Reader
	copyId      string
	total       int64
	read        int64
	lastPub     time.Time
	lastAdvance atomic.Int64 // unix nanos of the last byte received; read by the idle watchdog
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	if n > 0 {
		pr.read += int64(n)
		pr.lastAdvance.Store(time.Now().UnixNano())
		if time.Since(pr.lastPub) >= copyProgressInterval {
			pr.lastPub = time.Now()
			publishCopyProgress(pr.copyId, pr.read, pr.total, false, "")
		}
	}
	return n, err
}

// watchCopyIdle fails the copy when no bytes have arrived for copyIdleTimeout. It returns
// when the copy finishes (done closes) so it never outlives the transfer.
func watchCopyIdle(done <-chan struct{}, pr *progressReader, cancel context.CancelCauseFunc, srcUri string) {
	ticker := time.NewTicker(copyIdleCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			last := time.Unix(0, pr.lastAdvance.Load())
			if time.Since(last) < copyIdleTimeout {
				continue
			}
			cancel(fmt.Errorf("copy of %q stalled: no data for %v", srcUri, copyIdleTimeout))
			return
		}
	}
}

// prepareDestForCopy resolves the final destination path and handles overwrite logic.
// destPath is the raw destination path (may be a directory or file path).
// srcBaseName is the basename of the source file (used when dest is a directory or ends with slash).
// destHasSlash indicates if the original URI ended with a slash (forcing directory interpretation).
// Returns the resolved path ready for writing.
func prepareDestForCopy(destPath string, srcBaseName string, destHasSlash bool, overwrite bool) (string, error) {
	destInfo, err := os.Stat(destPath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("cannot stat destination %q: %w", destPath, err)
	}

	destExists := destInfo != nil
	destIsDir := destExists && destInfo.IsDir()

	var finalPath string
	if destHasSlash || destIsDir {
		finalPath = filepath.Join(destPath, srcBaseName)
	} else {
		finalPath = destPath
	}

	finalInfo, err := os.Stat(finalPath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("cannot stat file %q: %w", finalPath, err)
	}

	if finalInfo != nil {
		if !overwrite {
			return "", fmt.Errorf(wshfs.OverwriteRequiredError, finalPath)
		}
		if err := os.Remove(finalPath); err != nil {
			return "", fmt.Errorf("cannot remove file %q: %w", finalPath, err)
		}
	}

	return finalPath, nil
}

// remoteCopyFileInternal copies FROM local (this host) TO local (this host)
// Only supports copying files, not directories
func remoteCopyFileInternal(srcUri, destUri string, srcPathCleaned, destPathCleaned string, destHasSlash bool, overwrite bool, copyId string) error {
	srcFileStat, err := os.Stat(srcPathCleaned)
	if err != nil {
		return fmt.Errorf("cannot stat file %q: %w", srcPathCleaned, err)
	}
	if srcFileStat.IsDir() {
		return fmt.Errorf("copying directories is not supported")
	}

	destFilePath, err := prepareDestForCopy(destPathCleaned, filepath.Base(srcPathCleaned), destHasSlash, overwrite)
	if err != nil {
		return err
	}

	srcFile, err := os.Open(srcPathCleaned)
	if err != nil {
		return fmt.Errorf("cannot open file %q: %w", srcPathCleaned, err)
	}
	defer srcFile.Close()

	destFile, err := os.OpenFile(destFilePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcFileStat.Mode())
	if err != nil {
		return fmt.Errorf("cannot create file %q: %w", destFilePath, err)
	}
	defer destFile.Close()

	pr := &progressReader{reader: srcFile, copyId: copyId, total: srcFileStat.Size(), lastPub: time.Now()}
	if _, err = io.Copy(destFile, pr); err != nil {
		publishCopyProgress(copyId, pr.read, srcFileStat.Size(), true, err.Error())
		return fmt.Errorf("cannot copy %q to %q: %w", srcUri, destUri, err)
	}
	publishCopyProgress(copyId, srcFileStat.Size(), srcFileStat.Size(), true, "")
	return nil
}

// RemoteFileCopyCommand copies a file FROM somewhere TO here
func (impl *ServerImpl) RemoteFileCopyCommand(ctx context.Context, data wshrpc.CommandFileCopyData) (bool, error) {
	log.Printf("RemoteFileCopyCommand: src=%s, dest=%s\n", data.SrcUri, data.DestUri)
	opts := data.Opts
	if opts == nil {
		opts = &wshrpc.FileCopyOpts{}
	}
	if opts.Overwrite && opts.Merge {
		return false, fmt.Errorf("cannot specify both overwrite and merge")
	}
	if opts.Recursive {
		return false, fmt.Errorf("directory copying is not supported")
	}
	srcConn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, data.SrcUri)
	if err != nil {
		return false, fmt.Errorf("cannot parse source URI %q: %w", data.SrcUri, err)
	}
	destConn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, data.DestUri)
	if err != nil {
		return false, fmt.Errorf("cannot parse destination URI %q: %w", data.DestUri, err)
	}
	destPathCleaned := filepath.Clean(wavebase.ExpandHomeDirSafe(destConn.Path))
	destHasSlash := strings.HasSuffix(data.DestUri, "/")

	if srcConn.Host == destConn.Host {
		srcPathCleaned := filepath.Clean(wavebase.ExpandHomeDirSafe(srcConn.Path))
		err := remoteCopyFileInternal(data.SrcUri, data.DestUri, srcPathCleaned, destPathCleaned, destHasSlash, opts.Overwrite, data.CopyId)
		return false, err
	}

	// FROM external TO here - only supports single file copying
	timeout := wshfs.DefaultTimeout
	if opts.Timeout > 0 {
		timeout = time.Duration(opts.Timeout) * time.Millisecond
	}
	readCtx, cancelRead := context.WithCancelCause(ctx)
	defer cancelRead(nil)
	// keep the caller's timeout as an absolute ceiling, but the real guard is the idle
	// watchdog started below — total duration is unbounded for a large file, idle time is not
	readTimer := time.AfterFunc(timeout, func() {
		cancelRead(fmt.Errorf("timeout copying file %q to %q", data.SrcUri, data.DestUri))
	})
	defer readTimer.Stop()
	copyStart := time.Now()

	statTimeout := opts.Timeout
	if statTimeout <= 0 || statTimeout > copyStatTimeout.Milliseconds() {
		statTimeout = copyStatTimeout.Milliseconds()
	}
	srcFileInfo, err := wshclient.RemoteFileInfoCommand(wshfs.RpcClient, srcConn.Path, &wshrpc.RpcOpts{Timeout: statTimeout, Route: wshutil.MakeConnectionRouteId(srcConn.Host)})
	if err != nil {
		return false, fmt.Errorf("cannot get info for source file %q: %w", data.SrcUri, err)
	}
	if srcFileInfo.IsDir {
		return false, fmt.Errorf("copying directories is not supported")
	}

	destFilePath, err := prepareDestForCopy(destPathCleaned, fspath.Base(srcConn.Path), destHasSlash, opts.Overwrite)
	if err != nil {
		return false, err
	}

	destFile, err := os.OpenFile(destFilePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcFileInfo.Mode)
	if err != nil {
		return false, fmt.Errorf("cannot create destination file %q: %w", destFilePath, err)
	}
	defer destFile.Close()

	if wshfs.RpcClientRouteId == "" {
		return false, fmt.Errorf("stream broker route id not available for file copy")
	}
	writerRouteId := wshutil.MakeConnectionRouteId(srcConn.Host)
	reader, streamMeta := wshfs.RpcClient.StreamBroker.CreateStreamReader(wshfs.RpcClientRouteId, writerRouteId, 256*1024)
	log.Printf("RemoteFileCopyCommand: readroute=%s writeroute=%s", streamMeta.ReaderRouteId, streamMeta.WriterRouteId)
	defer reader.Close()
	go func() {
		<-readCtx.Done()
		reader.Close()
	}()
	streamData := wshrpc.CommandRemoteFileStreamData{
		Path:       srcConn.Path,
		StreamMeta: *streamMeta,
		CopyId:     data.CopyId,
		TotalSize:  srcFileInfo.Size,
	}
	if _, err = wshclient.RemoteFileStreamCommand(wshfs.RpcClient, streamData, &wshrpc.RpcOpts{Route: writerRouteId}); err != nil {
		return false, fmt.Errorf("error starting file stream for %q: %w", data.SrcUri, err)
	}
	pr := &progressReader{reader: reader, copyId: data.CopyId, total: srcFileInfo.Size, lastPub: time.Now()}
	pr.lastAdvance.Store(time.Now().UnixNano())
	copyDone := make(chan struct{})
	go watchCopyIdle(copyDone, pr, cancelRead, data.SrcUri)
	_, err = io.Copy(destFile, pr)
	close(copyDone)
	if err != nil {
		if cause := context.Cause(readCtx); cause != nil && cause != context.Canceled {
			err = cause
		}
		publishCopyProgress(data.CopyId, pr.read, srcFileInfo.Size, true, err.Error())
		return false, fmt.Errorf("error copying file %q to %q: %w", data.SrcUri, data.DestUri, err)
	}
	publishCopyProgress(data.CopyId, srcFileInfo.Size, srcFileInfo.Size, true, "")

	totalTime := time.Since(copyStart).Seconds()
	totalMegaBytes := float64(srcFileInfo.Size) / 1024 / 1024
	rate := float64(0)
	if totalTime > 0 {
		rate = totalMegaBytes / totalTime
	}
	log.Printf("RemoteFileCopyCommand: done; 1 file copied in %.3fs, total of %.4f MB, %.2f MB/s\n", totalTime, totalMegaBytes, rate)
	return false, nil
}

func (impl *ServerImpl) RemoteListEntriesCommand(ctx context.Context, data wshrpc.CommandRemoteListEntriesData) chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData], 16)
	go func() {
		defer func() {
			panichandler.PanicHandler("RemoteListEntriesCommand", recover())
		}()
		defer close(ch)
		path, err := wavebase.ExpandHomeDir(data.Path)
		if err != nil {
			ch <- wshutil.RespErr[wshrpc.CommandRemoteListEntriesRtnData](err)
			return
		}
		if data.Opts == nil {
			data.Opts = &wshrpc.FileListOpts{}
		}
		innerFilesEntries := []os.DirEntry{}
		seen := 0
		if data.Opts.Limit == 0 {
			data.Opts.Limit = wshrpc.MaxDirSize
		}
		if data.Opts.All {
			if DisableRecursiveFileOpts {
				ch <- wshutil.RespErr[wshrpc.CommandRemoteListEntriesRtnData](fmt.Errorf("recursive directory listings are not supported"))
				return
			}
			fs.WalkDir(os.DirFS(path), ".", func(path string, d fs.DirEntry, err error) error {
				defer func() {
					seen++
				}()
				if seen < data.Opts.Offset {
					return nil
				}
				if seen >= data.Opts.Offset+data.Opts.Limit {
					return io.EOF
				}
				if err != nil {
					return err
				}
				if d.IsDir() {
					return nil
				}
				innerFilesEntries = append(innerFilesEntries, d)
				return nil
			})
		} else {
			innerFilesEntries, err = os.ReadDir(path)
			if err != nil {
				ch <- wshutil.RespErr[wshrpc.CommandRemoteListEntriesRtnData](fmt.Errorf("cannot open dir %q: %w", path, err))
				return
			}
		}
		var fileInfoArr []*wshrpc.FileInfo
		for _, innerFileEntry := range innerFilesEntries {
			if ctx.Err() != nil {
				ch <- wshutil.RespErr[wshrpc.CommandRemoteListEntriesRtnData](ctx.Err())
				return
			}
			innerFileInfoInt, err := innerFileEntry.Info()
			if err != nil {
				log.Printf("cannot stat file %q: %v\n", innerFileEntry.Name(), err)
				continue
			}
			innerFileInfo := statToFileInfo(filepath.Join(path, innerFileInfoInt.Name()), innerFileInfoInt, false)
			fileInfoArr = append(fileInfoArr, innerFileInfo)
			if len(fileInfoArr) >= wshrpc.DirChunkSize {
				resp := wshrpc.CommandRemoteListEntriesRtnData{FileInfo: fileInfoArr}
				ch <- wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]{Response: resp}
				fileInfoArr = nil
			}
		}
		if len(fileInfoArr) > 0 {
			resp := wshrpc.CommandRemoteListEntriesRtnData{FileInfo: fileInfoArr}
			ch <- wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]{Response: resp}
		}
	}()
	return ch
}

func statToFileInfo(fullPath string, finfo fs.FileInfo, extended bool) *wshrpc.FileInfo {
	mimeType := fileutil.DetectMimeType(fullPath, finfo, extended)
	rtn := &wshrpc.FileInfo{
		Path:          wavebase.ReplaceHomeDir(fullPath),
		Dir:           computeDirPart(fullPath),
		Name:          finfo.Name(),
		Size:          finfo.Size(),
		Mode:          finfo.Mode(),
		ModeStr:       finfo.Mode().String(),
		ModTime:       finfo.ModTime().UnixMilli(),
		IsDir:         finfo.IsDir(),
		MimeType:      mimeType,
		SupportsMkdir: true,
	}
	if finfo.IsDir() {
		rtn.Size = -1
	}
	return rtn
}

// fileInfo might be null
func checkIsReadOnly(path string, fileInfo fs.FileInfo, exists bool) bool {
	if !exists || fileInfo.Mode().IsDir() {
		dirName := filepath.Dir(path)
		randHexStr, err := utilfn.RandomHexString(12)
		if err != nil {
			// we're not sure, just return false
			return false
		}
		tmpFileName := filepath.Join(dirName, "wsh-tmp-"+randHexStr)
		fd, err := os.Create(tmpFileName)
		if err != nil {
			return true
		}
		utilfn.GracefulClose(fd, "checkIsReadOnly", tmpFileName)
		os.Remove(tmpFileName)
		return false
	}
	// try to open for writing, if this fails then it is read-only
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		return true
	}
	utilfn.GracefulClose(file, "checkIsReadOnly", path)
	return false
}

func computeDirPart(path string) string {
	path = filepath.Clean(wavebase.ExpandHomeDirSafe(path))
	path = filepath.ToSlash(path)
	if path == "/" {
		return "/"
	}
	return filepath.Dir(path)
}

func (*ServerImpl) fileInfoInternal(path string, extended bool) (*wshrpc.FileInfo, error) {
	cleanedPath := filepath.Clean(wavebase.ExpandHomeDirSafe(path))
	finfo, err := os.Stat(cleanedPath)
	if os.IsNotExist(err) {
		return &wshrpc.FileInfo{
			Path:          wavebase.ReplaceHomeDir(path),
			Dir:           computeDirPart(path),
			NotFound:      true,
			ReadOnly:      checkIsReadOnly(cleanedPath, finfo, false),
			SupportsMkdir: true,
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot stat file %q: %w", path, err)
	}
	rtn := statToFileInfo(cleanedPath, finfo, extended)
	if extended {
		rtn.ReadOnly = checkIsReadOnly(cleanedPath, finfo, true)
	}
	return rtn, nil
}

func resolvePaths(paths []string) string {
	if len(paths) == 0 {
		return wavebase.ExpandHomeDirSafe("~")
	}
	rtnPath := wavebase.ExpandHomeDirSafe(paths[0])
	for _, path := range paths[1:] {
		path = wavebase.ExpandHomeDirSafe(path)
		if filepath.IsAbs(path) {
			rtnPath = path
			continue
		}
		rtnPath = filepath.Join(rtnPath, path)
	}
	return rtnPath
}

func (impl *ServerImpl) RemoteFileJoinCommand(ctx context.Context, paths []string) (*wshrpc.FileInfo, error) {
	rtnPath := resolvePaths(paths)
	return impl.fileInfoInternal(rtnPath, true)
}

func (impl *ServerImpl) RemoteFileInfoCommand(ctx context.Context, path string) (*wshrpc.FileInfo, error) {
	return impl.fileInfoInternal(path, true)
}

func (impl *ServerImpl) RemoteFileMultiInfoCommand(ctx context.Context, data wshrpc.CommandRemoteFileMultiInfoData) (map[string]wshrpc.FileInfo, error) {
	cwd := data.Cwd
	if cwd == "" {
		cwd = "~"
	}
	cwd = filepath.Clean(wavebase.ExpandHomeDirSafe(cwd))
	rtn := make(map[string]wshrpc.FileInfo, len(data.Paths))
	for _, path := range data.Paths {
		if _, found := rtn[path]; found {
			continue
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		cleanedPath := wavebase.ExpandHomeDirSafe(path)
		if !filepath.IsAbs(cleanedPath) {
			cleanedPath = filepath.Join(cwd, cleanedPath)
		}
		fileInfo, err := impl.fileInfoInternal(cleanedPath, false)
		if err != nil {
			rtn[path] = wshrpc.FileInfo{
				Path:          wavebase.ReplaceHomeDir(cleanedPath),
				Dir:           computeDirPart(cleanedPath),
				Name:          filepath.Base(cleanedPath),
				StatError:     err.Error(),
				SupportsMkdir: true,
			}
			continue
		}
		rtn[path] = *fileInfo
	}
	return rtn, nil
}

func (impl *ServerImpl) RemoteFileTouchCommand(ctx context.Context, path string) error {
	cleanedPath := filepath.Clean(wavebase.ExpandHomeDirSafe(path))
	if _, err := os.Stat(cleanedPath); err == nil {
		return fmt.Errorf("file %q already exists", path)
	}
	if err := os.MkdirAll(filepath.Dir(cleanedPath), 0755); err != nil {
		return fmt.Errorf("cannot create directory %q: %w", filepath.Dir(cleanedPath), err)
	}
	if err := os.WriteFile(cleanedPath, []byte{}, 0644); err != nil {
		return fmt.Errorf("cannot create file %q: %w", cleanedPath, err)
	}
	return nil
}

func (impl *ServerImpl) RemoteFileMoveCommand(ctx context.Context, data wshrpc.CommandFileCopyData) error {
	destUri := data.DestUri
	srcUri := data.SrcUri

	destConn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, destUri)
	if err != nil {
		return fmt.Errorf("cannot parse destination URI %q: %w", srcUri, err)
	}
	destPathCleaned := filepath.Clean(wavebase.ExpandHomeDirSafe(destConn.Path))
	_, err = os.Stat(destPathCleaned)
	if err == nil {
		return fmt.Errorf("destination %q already exists", destUri)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("cannot stat destination %q: %w", destUri, err)
	}

	srcConn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, srcUri)
	if err != nil {
		return fmt.Errorf("cannot parse source URI %q: %w", srcUri, err)
	}

	if srcConn.Host != destConn.Host {
		return fmt.Errorf("cannot move file %q to %q: different hosts", srcUri, destUri)
	}

	srcPathCleaned := filepath.Clean(wavebase.ExpandHomeDirSafe(srcConn.Path))
	err = os.Rename(srcPathCleaned, destPathCleaned)
	if err != nil {
		return fmt.Errorf("cannot move file %q to %q: %w", srcPathCleaned, destPathCleaned, err)
	}
	return nil
}

func (impl *ServerImpl) RemoteMkdirCommand(ctx context.Context, path string) error {
	cleanedPath := filepath.Clean(wavebase.ExpandHomeDirSafe(path))
	if stat, err := os.Stat(cleanedPath); err == nil {
		if stat.IsDir() {
			return fmt.Errorf("directory %q already exists", path)
		} else {
			return fmt.Errorf("cannot create directory %q, file exists at path", path)
		}
	}
	if err := os.MkdirAll(cleanedPath, 0755); err != nil {
		return fmt.Errorf("cannot create directory %q: %w", cleanedPath, err)
	}
	return nil
}

func (*ServerImpl) RemoteWriteFileCommand(ctx context.Context, data wshrpc.FileData) error {
	var truncate, append bool
	var atOffset int64
	if data.Info != nil && data.Info.Opts != nil {
		truncate = data.Info.Opts.Truncate
		append = data.Info.Opts.Append
	}
	if data.At != nil {
		atOffset = data.At.Offset
	}
	if truncate && atOffset > 0 {
		return fmt.Errorf("cannot specify non-zero offset with truncate option")
	}
	if append && atOffset > 0 {
		return fmt.Errorf("cannot specify non-zero offset with append option")
	}
	path, err := wavebase.ExpandHomeDir(data.Info.Path)
	if err != nil {
		return err
	}
	createMode := os.FileMode(0644)
	if data.Info != nil && data.Info.Mode > 0 {
		createMode = data.Info.Mode
	}
	dataSize := base64.StdEncoding.DecodedLen(len(data.Data64))
	dataBytes := make([]byte, dataSize)
	n, err := base64.StdEncoding.Decode(dataBytes, []byte(data.Data64))
	if err != nil {
		return fmt.Errorf("cannot decode base64 data: %w", err)
	}
	finfo, err := os.Stat(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("cannot stat file %q: %w", path, err)
	}
	fileSize := int64(0)
	if finfo != nil {
		if finfo.IsDir() {
			return fmt.Errorf("cannot use write file to overwrite a directory %q", path)
		}
		fileSize = finfo.Size()
	}
	if atOffset > fileSize {
		return fmt.Errorf("cannot write at offset %d, file size is %d", atOffset, fileSize)
	}
	openFlags := os.O_CREATE | os.O_WRONLY
	if truncate {
		openFlags |= os.O_TRUNC
	}
	if append {
		openFlags |= os.O_APPEND
	}

	file, err := os.OpenFile(path, openFlags, createMode)
	if err != nil {
		return fmt.Errorf("cannot open file %q: %w", path, err)
	}
	defer utilfn.GracefulClose(file, "RemoteWriteFileCommand", path)
	if atOffset > 0 && !append {
		n, err = file.WriteAt(dataBytes[:n], atOffset)
	} else {
		n, err = file.Write(dataBytes[:n])
	}
	if err != nil {
		return fmt.Errorf("cannot write to file %q: %w", path, err)
	}
	return nil
}

func (impl *ServerImpl) RemoteFileStreamCommand(ctx context.Context, data wshrpc.CommandRemoteFileStreamData) (*wshrpc.FileInfo, error) {
	wshRpc := wshutil.GetWshRpcFromContext(ctx)
	if wshRpc == nil || wshRpc.StreamBroker == nil {
		return nil, fmt.Errorf("no stream broker available")
	}

	writer, err := wshRpc.StreamBroker.CreateStreamWriter(&data.StreamMeta)
	if err != nil {
		return nil, fmt.Errorf("error creating stream writer: %w", err)
	}

	path, err := wavebase.ExpandHomeDir(data.Path)
	if err != nil {
		writer.CloseWithError(err)
		return nil, err
	}
	cleanedPath := filepath.Clean(path)

	finfo, err := os.Stat(cleanedPath)
	if err != nil {
		if os.IsNotExist(err) {
			writer.Close()
			return &wshrpc.FileInfo{
				Path:     wavebase.ReplaceHomeDir(data.Path),
				Dir:      computeDirPart(data.Path),
				NotFound: true,
			}, nil
		}
		writer.CloseWithError(err)
		return nil, fmt.Errorf("cannot stat file %q: %w", data.Path, err)
	}
	if finfo.IsDir() {
		writer.CloseWithError(fmt.Errorf("path is a directory"))
		return nil, fmt.Errorf("cannot stream directory %q", data.Path)
	}

	byteRange, err := fileutil.ParseByteRange(data.ByteRange)
	if err != nil {
		writer.CloseWithError(err)
		return nil, err
	}

	fileInfo := statToFileInfo(cleanedPath, finfo, true)
	fileInfo.Path = data.Path

	go func() {
		defer func() {
			panichandler.PanicHandler("RemoteFileStreamCommand", recover())
		}()
		defer writer.Close()

		file, err := os.Open(cleanedPath)
		if err != nil {
			writer.CloseWithError(fmt.Errorf("cannot open file %q: %w", data.Path, err))
			return
		}
		defer utilfn.GracefulClose(file, "RemoteFileStreamCommand", cleanedPath)

		if !byteRange.All && byteRange.Start > 0 {
			if _, err := file.Seek(byteRange.Start, io.SeekStart); err != nil {
				writer.CloseWithError(fmt.Errorf("cannot seek in file %q: %w", data.Path, err))
				return
			}
		}

		var src io.Reader = file
		if !byteRange.All && !byteRange.OpenEnd {
			src = io.LimitReader(file, byteRange.End-byteRange.Start+1)
		}
		// during a copy (CopyId set) the read side runs on the source host; when that host is
		// wavesrv (e.g. local -> remote copy) this is where progress reaches the frontend
		if data.CopyId != "" {
			src = &progressReader{reader: src, copyId: data.CopyId, total: data.TotalSize, lastPub: time.Now()}
		}

		buf := make([]byte, 32*1024)
		for {
			n, readErr := src.Read(buf)
			if n > 0 {
				if _, writeErr := writer.Write(buf[:n]); writeErr != nil {
					// must close *with* the error: a plain return falls through to the
					// deferred Close(), which the destination reads as a clean EOF and
					// reports a truncated file as a complete copy
					writer.CloseWithError(fmt.Errorf("error streaming file %q: %w", data.Path, writeErr))
					return
				}
			}
			if readErr == io.EOF {
				return
			}
			if readErr != nil {
				writer.CloseWithError(fmt.Errorf("error reading file %q: %w", data.Path, readErr))
				return
			}
		}
	}()

	return fileInfo, nil
}

func (*ServerImpl) RemoteFileDeleteCommand(ctx context.Context, data wshrpc.CommandDeleteFileData) error {
	expandedPath, err := wavebase.ExpandHomeDir(data.Path)
	if err != nil {
		return fmt.Errorf("cannot delete file %q: %w", data.Path, err)
	}
	cleanedPath := filepath.Clean(expandedPath)

	if data.Recursive {
		err = os.RemoveAll(cleanedPath)
		if err != nil {
			return fmt.Errorf("cannot delete %q: %w", data.Path, err)
		}
		return nil
	}

	err = os.Remove(cleanedPath)
	if err != nil {
		finfo, statErr := os.Stat(cleanedPath)
		if statErr == nil && finfo.IsDir() {
			return fmt.Errorf(wshfs.RecursiveRequiredError)
		}
		return fmt.Errorf("cannot delete file %q: %w", data.Path, err)
	}
	return nil
}
