package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
)

var transferIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type protocolNegotiationParams struct {
	MinVersion int `json:"minVersion"`
	MaxVersion int `json:"maxVersion"`
}

type transferDataPlaneCapability struct {
	Version   int `json:"version"`
	ChunkSize int `json:"chunkSize"`
	MaxWindow int `json:"maxWindow"`
}

type protocolCapabilities struct {
	TransferDataPlane transferDataPlaneCapability `json:"transferDataPlane"`
}

type protocolNegotiationResult struct {
	ProtocolVersion int                  `json:"protocolVersion"`
	Capabilities    protocolCapabilities `json:"capabilities"`
}

type transferSourceIdentity struct {
	Kind   string `json:"kind"`
	Device string `json:"device"`
	Inode  string `json:"inode"`
	Size   int64  `json:"size"`
	Mtime  string `json:"mtime"`
}

type transferInspection struct {
	Kind           string  `json:"kind"`
	Size           int64   `json:"size"`
	OwnerID        *uint32 `json:"ownerId"`
	AvailableBytes uint64  `json:"availableBytes"`
}

type transferCreateResult struct {
	Size    int64   `json:"size"`
	OwnerID *uint32 `json:"ownerId"`
}

type transferHashResult struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

type transferPublishResult struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

type uploadOpenParams struct {
	TransferID string `json:"transferId"`
	Path       string `json:"path"`
	Offset     uint64 `json:"offset"`
	Window     int    `json:"window,omitempty"`
}

type uploadOpenResult struct {
	Offset    uint64 `json:"offset"`
	ChunkSize int    `json:"chunkSize"`
	Window    int    `json:"window"`
}

type downloadOpenParams struct {
	TransferID string `json:"transferId"`
	Path       string `json:"path"`
	Offset     uint64 `json:"offset"`
	Window     int    `json:"window,omitempty"`
}

type downloadOpenResult struct {
	Offset         uint64                 `json:"offset"`
	ChunkSize      int                    `json:"chunkSize"`
	Window         int                    `json:"window"`
	SourceIdentity transferSourceIdentity `json:"sourceIdentity"`
}

type transferSession struct {
	file     *os.File
	path     string
	offset   uint64
	finished bool
}

type transferSessions struct {
	mu        sync.Mutex
	uploads   map[string]*transferSession
	downloads map[string]*transferSession
}

func newTransferSessions() *transferSessions {
	return &transferSessions{
		uploads: make(map[string]*transferSession), downloads: make(map[string]*transferSession),
	}
}

func negotiatedWindow(requested int) (int, error) {
	if requested == 0 {
		return maxTransferWindow, nil
	}
	if requested < 1 || requested > maxTransferWindow {
		return 0, invalidArgument("transfer window must be between 1 and %d", maxTransferWindow)
	}
	return requested, nil
}

func checkTransferID(value string) error {
	if !transferIDPattern.MatchString(value) {
		return invalidArgument("transfer id is invalid")
	}
	return nil
}

func (server *rpcServer) negotiateProtocol(params protocolNegotiationParams) (protocolNegotiationResult, error) {
	if params.MinVersion > transferProtocolVersion || params.MaxVersion < transferProtocolVersion ||
		params.MinVersion < 1 || params.MaxVersion < params.MinVersion {
		return protocolNegotiationResult{}, newDomainError(
			"UNSUPPORTED_PROTOCOL", "no mutually supported helper protocol version",
		)
	}
	return protocolNegotiationResult{
		ProtocolVersion: transferProtocolVersion,
		Capabilities: protocolCapabilities{TransferDataPlane: transferDataPlaneCapability{
			Version: transferProtocolVersion, ChunkSize: maxTransferChunkBytes, MaxWindow: maxTransferWindow,
		}},
	}, nil
}

func (server *rpcServer) openUpload(params uploadOpenParams) (uploadOpenResult, error) {
	if err := checkTransferID(params.TransferID); err != nil {
		return uploadOpenResult{}, err
	}
	window, err := negotiatedWindow(params.Window)
	if err != nil {
		return uploadOpenResult{}, err
	}
	target, info, inspectErr := guardedLstat(server.fs.guard, params.Path)
	if inspectErr == nil && !info.Mode().IsRegular() {
		return uploadOpenResult{}, newDomainError("INVALID_PARTIAL", "transfer partial is not a regular file")
	}
	if inspectErr != nil {
		if !errors.Is(inspectErr, os.ErrNotExist) {
			return uploadOpenResult{}, inspectErr
		}
		target, err = server.fs.guard.writable(params.Path)
		if err != nil {
			return uploadOpenResult{}, err
		}
	}
	file, err := openTransferFile(target, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return uploadOpenResult{}, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = file.Close()
		}
	}()
	info, err = file.Stat()
	if err != nil {
		return uploadOpenResult{}, err
	}
	if !info.Mode().IsRegular() {
		return uploadOpenResult{}, newDomainError("INVALID_PARTIAL", "transfer partial is not a regular file")
	}
	if !ownedByCurrentUser(info) {
		return uploadOpenResult{}, newDomainError("INVALID_PARTIAL", "transfer partial has an unexpected owner")
	}
	if info.Size() < 0 || uint64(info.Size()) != params.Offset {
		return uploadOpenResult{}, newDomainError(
			"OFFSET_MISMATCH", "transfer partial offset is %d, requested %d", info.Size(), params.Offset,
		)
	}
	server.transfers.mu.Lock()
	for identifier, existing := range server.transfers.uploads {
		if identifier != params.TransferID && existing.path == target {
			server.transfers.mu.Unlock()
			return uploadOpenResult{}, newDomainError("TRANSFER_BUSY", "transfer partial is already open")
		}
	}
	if previous := server.transfers.uploads[params.TransferID]; previous != nil {
		_ = previous.file.Close()
	}
	if previous := server.transfers.downloads[params.TransferID]; previous != nil {
		_ = previous.file.Close()
		delete(server.transfers.downloads, params.TransferID)
	}
	server.transfers.uploads[params.TransferID] = &transferSession{
		file: file, path: target, offset: params.Offset,
	}
	server.transfers.mu.Unlock()
	keep = true
	return uploadOpenResult{Offset: params.Offset, ChunkSize: maxTransferChunkBytes, Window: window}, nil
}

func (server *rpcServer) openDownload(params downloadOpenParams) (downloadOpenResult, error) {
	if err := checkTransferID(params.TransferID); err != nil {
		return downloadOpenResult{}, err
	}
	window, err := negotiatedWindow(params.Window)
	if err != nil {
		return downloadOpenResult{}, err
	}
	target, err := server.fs.guard.existing(params.Path)
	if err != nil {
		return downloadOpenResult{}, err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return downloadOpenResult{}, err
	}
	if !info.Mode().IsRegular() {
		return downloadOpenResult{}, invalidArgument("transfer source must be a regular file")
	}
	if params.Offset > uint64(info.Size()) {
		return downloadOpenResult{}, newDomainError("OFFSET_MISMATCH", "download offset exceeds source size")
	}
	file, err := openTransferFile(target, os.O_RDONLY, 0)
	if err != nil {
		return downloadOpenResult{}, err
	}
	identity := sourceIdentity(info)
	server.transfers.mu.Lock()
	if previous := server.transfers.downloads[params.TransferID]; previous != nil {
		_ = previous.file.Close()
	}
	if previous := server.transfers.uploads[params.TransferID]; previous != nil {
		_ = previous.file.Close()
		delete(server.transfers.uploads, params.TransferID)
	}
	server.transfers.downloads[params.TransferID] = &transferSession{
		file: file, path: target, offset: params.Offset, finished: params.Offset == uint64(info.Size()),
	}
	server.transfers.mu.Unlock()
	return downloadOpenResult{
		Offset: params.Offset, ChunkSize: maxTransferChunkBytes, Window: window, SourceIdentity: identity,
	}, nil
}

func sourceIdentity(info os.FileInfo) transferSourceIdentity {
	identity := transferSourceIdentity{
		Kind: "file", Size: info.Size(), Mtime: info.ModTime().UTC().Format(time.RFC3339Nano),
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		identity.Device = strconv.FormatUint(uint64(stat.Dev), 10)
		identity.Inode = strconv.FormatUint(uint64(stat.Ino), 10)
	}
	return identity
}

func (server *rpcServer) closeTransfer(transferID string) error {
	if err := checkTransferID(transferID); err != nil {
		return err
	}
	server.transfers.mu.Lock()
	defer server.transfers.mu.Unlock()
	if session := server.transfers.uploads[transferID]; session != nil {
		_ = session.file.Close()
		delete(server.transfers.uploads, transferID)
	}
	if session := server.transfers.downloads[transferID]; session != nil {
		_ = session.file.Close()
		delete(server.transfers.downloads, transferID)
	}
	return nil
}

func (server *rpcServer) closeTransfers() {
	server.transfers.mu.Lock()
	defer server.transfers.mu.Unlock()
	for identifier, session := range server.transfers.uploads {
		_ = session.file.Close()
		delete(server.transfers.uploads, identifier)
	}
	for identifier, session := range server.transfers.downloads {
		_ = session.file.Close()
		delete(server.transfers.downloads, identifier)
	}
}

func (server *rpcServer) handleBinaryTransferFrame(frame binaryTransferFrame) (binaryTransferFrame, error) {
	if err := checkTransferID(frame.TransferID); err != nil {
		return binaryTransferFrame{}, err
	}
	switch frame.Type {
	case binaryUploadData:
		return server.handleUploadData(frame)
	case binaryDownloadRequest:
		return server.handleDownloadRequest(frame)
	default:
		return binaryTransferFrame{}, invalidArgument("binary transfer frame type is not valid for the helper")
	}
}

func (server *rpcServer) handleUploadData(frame binaryTransferFrame) (binaryTransferFrame, error) {
	if frame.Length == 0 || frame.Length > maxTransferChunkBytes || uint32(len(frame.Data)) != frame.Length {
		return binaryTransferFrame{}, invalidArgument("upload chunk length must be between 1 and 8 MiB")
	}
	digest := sha256.Sum256(frame.Data)
	if digest != frame.Digest {
		return binaryTransferFrame{}, newDomainError("HASH_MISMATCH", "upload chunk SHA-256 mismatch")
	}
	server.transfers.mu.Lock()
	defer server.transfers.mu.Unlock()
	session := server.transfers.uploads[frame.TransferID]
	if session == nil {
		return binaryTransferFrame{}, newDomainError("TRANSFER_NOT_OPEN", "upload transfer is not open")
	}
	if frame.Offset != session.offset {
		return binaryTransferFrame{}, newDomainError(
			"OFFSET_MISMATCH", "upload offset is %d, expected %d", frame.Offset, session.offset,
		)
	}
	written, err := session.file.WriteAt(frame.Data, int64(frame.Offset))
	if err != nil {
		return binaryTransferFrame{}, err
	}
	if written != len(frame.Data) {
		return binaryTransferFrame{}, io.ErrShortWrite
	}
	session.offset += uint64(written)
	return binaryTransferFrame{
		Type: binaryUploadAck, TransferID: frame.TransferID, Offset: frame.Offset,
		Length: uint32(written), Digest: digest,
	}, nil
}

func (server *rpcServer) handleDownloadRequest(frame binaryTransferFrame) (binaryTransferFrame, error) {
	if frame.Length == 0 || frame.Length > maxTransferChunkBytes {
		return binaryTransferFrame{}, invalidArgument("download chunk length must be between 1 and 8 MiB")
	}
	server.transfers.mu.Lock()
	defer server.transfers.mu.Unlock()
	session := server.transfers.downloads[frame.TransferID]
	if session == nil {
		return binaryTransferFrame{}, newDomainError("TRANSFER_NOT_OPEN", "download transfer is not open")
	}
	if frame.Offset != session.offset || session.finished {
		return binaryTransferFrame{}, newDomainError(
			"OFFSET_MISMATCH", "download offset is %d, expected %d", frame.Offset, session.offset,
		)
	}
	content := make([]byte, int(frame.Length))
	read, err := session.file.ReadAt(content, int64(frame.Offset))
	if err != nil && !errors.Is(err, io.EOF) {
		return binaryTransferFrame{}, err
	}
	content = content[:read]
	digest := sha256.Sum256(content)
	session.offset += uint64(read)
	if errors.Is(err, io.EOF) || read < int(frame.Length) {
		session.finished = true
	}
	return binaryTransferFrame{
		Type: binaryDownloadData, TransferID: frame.TransferID, Offset: frame.Offset,
		Length: uint32(read), Digest: digest, Data: content,
	}, nil
}

func transferErrorFrame(transferID string, offset uint64, err error) binaryTransferFrame {
	code := "TRANSFER_FAILED"
	var domainErr *domainError
	var protocolErr *protocolError
	if errors.As(err, &domainErr) {
		code = domainErr.code
	} else if errors.As(err, &protocolErr) {
		code = protocolErr.code
	}
	content := []byte(code + "\n" + err.Error())
	return binaryTransferFrame{
		Type: binaryTransferError, TransferID: transferID, Offset: offset,
		Length: uint32(len(content)), Data: content,
	}
}

func guardedLstat(guard *pathGuard, path string) (string, os.FileInfo, error) {
	target, err := guard.candidate(path)
	if err != nil {
		return "", nil, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		return "", nil, err
	}
	if !guard.contains(parent) {
		return "", nil, outsideRoot()
	}
	target = filepath.Join(parent, filepath.Base(target))
	info, err := os.Lstat(target)
	return target, info, err
}

func openTransferFile(path string, flags int, mode os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flags|syscall.O_NOFOLLOW, mode)
}

func guardedPublishDestination(guard *pathGuard, path string) (string, error) {
	target, info, err := guardedLstat(guard, path)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", newDomainError("INVALID_PARTIAL", "transfer destination is a symlink")
		}
		return target, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return guard.writable(path)
}

func availableBytes(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}

func ownerID(info os.FileInfo) *uint32 {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	value := uint32(stat.Uid)
	return &value
}

func ownedByCurrentUser(info os.FileInfo) bool {
	owner := ownerID(info)
	return owner != nil && *owner == uint32(os.Getuid())
}

func (fs *fileSystem) transferInspect(path string) (transferInspection, error) {
	target, info, err := guardedLstat(fs.guard, path)
	if errors.Is(err, os.ErrNotExist) {
		writable, writableErr := fs.guard.writable(path)
		if writableErr != nil {
			return transferInspection{}, writableErr
		}
		available, availableErr := availableBytes(filepath.Dir(writable))
		if availableErr != nil {
			return transferInspection{}, availableErr
		}
		return transferInspection{Kind: "missing", AvailableBytes: available}, nil
	}
	if err != nil {
		return transferInspection{}, err
	}
	available, err := availableBytes(filepath.Dir(target))
	if err != nil {
		return transferInspection{}, err
	}
	return transferInspection{
		Kind: entryKind(info), Size: info.Size(), OwnerID: ownerID(info), AvailableBytes: available,
	}, nil
}

func (fs *fileSystem) transferIdentity(path string) (transferSourceIdentity, error) {
	target, err := fs.guard.existing(path)
	if err != nil {
		return transferSourceIdentity{}, err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return transferSourceIdentity{}, err
	}
	if !info.Mode().IsRegular() {
		return transferSourceIdentity{}, invalidArgument("transfer source must be a regular file")
	}
	return sourceIdentity(info), nil
}

func (fs *fileSystem) transferCreate(path string) (transferCreateResult, error) {
	target, err := fs.guard.writable(path)
	if err != nil {
		return transferCreateResult{}, err
	}
	file, err := openTransferFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return transferCreateResult{}, err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return transferCreateResult{}, err
	}
	if err := file.Close(); err != nil {
		return transferCreateResult{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return transferCreateResult{}, err
	}
	return transferCreateResult{Size: 0, OwnerID: ownerID(info)}, nil
}

func (fs *fileSystem) transferTruncate(path string, size int64) error {
	if size < 0 {
		return invalidArgument("truncate size must be non-negative")
	}
	target, err := fs.guard.existing(path)
	if err != nil {
		return err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return newDomainError("INVALID_PARTIAL", "transfer partial is not a regular file")
	}
	if !ownedByCurrentUser(info) {
		return newDomainError("INVALID_PARTIAL", "transfer partial has an unexpected owner")
	}
	file, err := openTransferFile(target, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Truncate(size); err != nil {
		return err
	}
	return file.Sync()
}

func (fs *fileSystem) transferHash(path string, offset int64, length *int64) (transferHashResult, error) {
	return fs.transferHashContext(context.Background(), path, offset, length)
}

func (fs *fileSystem) transferHashContext(
	ctx context.Context, path string, offset int64, length *int64,
) (transferHashResult, error) {
	if offset < 0 || (length != nil && *length < 0) {
		return transferHashResult{}, invalidArgument("hash range must be non-negative")
	}
	target, err := fs.guard.existing(path)
	if err != nil {
		return transferHashResult{}, err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return transferHashResult{}, err
	}
	if !info.Mode().IsRegular() {
		return transferHashResult{}, invalidArgument("hash target must be a regular file")
	}
	if offset > info.Size() {
		return transferHashResult{}, newDomainError("OFFSET_MISMATCH", "hash offset exceeds file size")
	}
	size := info.Size() - offset
	if length != nil {
		size = *length
		if size > info.Size()-offset {
			return transferHashResult{}, newDomainError("OFFSET_MISMATCH", "hash range exceeds file size")
		}
	}
	file, err := openTransferFile(target, os.O_RDONLY, 0)
	if err != nil {
		return transferHashResult{}, err
	}
	defer file.Close()
	hash := sha256.New()
	reader := io.NewSectionReader(file, offset, size)
	buffer := make([]byte, maxTransferChunkBytes)
	remaining := size
	for remaining > 0 {
		select {
		case <-ctx.Done():
			return transferHashResult{}, ctx.Err()
		default:
		}
		wanted := int64(len(buffer))
		if remaining < wanted {
			wanted = remaining
		}
		read, readErr := reader.Read(buffer[:wanted])
		if read > 0 {
			if _, err := hash.Write(buffer[:read]); err != nil {
				return transferHashResult{}, err
			}
			remaining -= int64(read)
		}
		if readErr != nil {
			return transferHashResult{}, readErr
		}
		if read == 0 {
			return transferHashResult{}, io.ErrUnexpectedEOF
		}
	}
	return transferHashResult{Hash: hex.EncodeToString(hash.Sum(nil)), Size: size}, nil
}

func (fs *fileSystem) transferSync(path string) error {
	target, err := fs.guard.existing(path)
	if err != nil {
		return err
	}
	file, err := openTransferFile(target, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func (fs *fileSystem) transferPublish(
	partialPath, destinationPath string, expectedSize int64, expectedHash string, overwrite bool,
) (transferPublishResult, error) {
	if expectedSize < 0 || !sha256Pattern.MatchString(expectedHash) {
		return transferPublishResult{}, invalidArgument("publish size or SHA-256 is invalid")
	}
	partial, err := fs.guard.existing(partialPath)
	if err != nil {
		return transferPublishResult{}, err
	}
	destination, err := guardedPublishDestination(fs.guard, destinationPath)
	if err != nil {
		return transferPublishResult{}, err
	}
	if filepath.Dir(partial) != filepath.Dir(destination) {
		return transferPublishResult{}, invalidArgument("transfer partial must be adjacent to its destination")
	}
	release, err := acquireWriteLock(destination)
	if err != nil {
		return transferPublishResult{}, err
	}
	defer release()
	partial, err = fs.guard.existing(partialPath)
	if err != nil {
		return transferPublishResult{}, err
	}
	destination, err = guardedPublishDestination(fs.guard, destinationPath)
	if err != nil {
		return transferPublishResult{}, err
	}
	file, err := openTransferFile(partial, os.O_RDWR, 0)
	if err != nil {
		return transferPublishResult{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return transferPublishResult{}, err
	}
	if !info.Mode().IsRegular() || info.Size() != expectedSize {
		return transferPublishResult{}, newDomainError("INVALID_PARTIAL", "transfer partial size or kind is invalid")
	}
	if !ownedByCurrentUser(info) {
		return transferPublishResult{}, newDomainError("INVALID_PARTIAL", "transfer partial has an unexpected owner")
	}
	if !overwrite {
		if _, err := os.Lstat(destination); err == nil {
			return transferPublishResult{}, newDomainError("DESTINATION_EXISTS", "transfer destination already exists")
		} else if !errors.Is(err, os.ErrNotExist) {
			return transferPublishResult{}, err
		}
	}
	if err := file.Sync(); err != nil {
		return transferPublishResult{}, err
	}
	digest := sha256.New()
	if _, err := io.CopyN(digest, io.NewSectionReader(file, 0, expectedSize), expectedSize); err != nil {
		return transferPublishResult{}, err
	}
	hash := hex.EncodeToString(digest.Sum(nil))
	if hash != expectedHash {
		return transferPublishResult{}, newDomainError("HASH_MISMATCH", "transfer SHA-256 verification failed")
	}
	verifiedInfo, err := file.Stat()
	if err != nil {
		return transferPublishResult{}, err
	}
	pathInfo, err := os.Lstat(partial)
	if err != nil || !os.SameFile(info, verifiedInfo) || !os.SameFile(info, pathInfo) ||
		verifiedInfo.Size() != info.Size() || !verifiedInfo.ModTime().Equal(info.ModTime()) {
		return transferPublishResult{}, newDomainError(
			"INVALID_PARTIAL", "transfer partial changed during verification",
		)
	}
	if overwrite {
		if err := os.Rename(partial, destination); err != nil {
			return transferPublishResult{}, err
		}
	} else {
		// Linux uses renameat2(RENAME_NOREPLACE). The portable fallback uses a same-filesystem
		// hard link because a plain rename would overwrite a target created after preflight.
		if err := publishNoReplace(partial, destination); err != nil {
			if errors.Is(err, os.ErrExist) {
				return transferPublishResult{}, newDomainError(
					"DESTINATION_EXISTS", "transfer destination already exists",
				)
			}
			return transferPublishResult{}, err
		}
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		return transferPublishResult{}, err
	}
	return transferPublishResult{Hash: hash, Size: expectedSize}, nil
}

func (server *rpcServer) publishTransfer(params transferPublishParams) (transferPublishResult, error) {
	partial, err := server.fs.guard.existing(params.PartialPath)
	if err != nil {
		return transferPublishResult{}, err
	}
	server.transfers.mu.Lock()
	for identifier, session := range server.transfers.uploads {
		if session.path == partial {
			if err := session.file.Sync(); err != nil {
				server.transfers.mu.Unlock()
				return transferPublishResult{}, err
			}
			if err := session.file.Close(); err != nil {
				server.transfers.mu.Unlock()
				return transferPublishResult{}, err
			}
			delete(server.transfers.uploads, identifier)
		}
	}
	server.transfers.mu.Unlock()
	return server.fs.transferPublish(
		params.PartialPath, params.DestinationPath, params.ExpectedSize,
		params.ExpectedSHA256, params.Overwrite,
	)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync transfer destination directory: %w", err)
	}
	return nil
}
