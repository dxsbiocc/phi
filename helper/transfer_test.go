package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTransferNegotiationAdvertisesBoundedBinaryDataPlane(t *testing.T) {
	server := mustServer(t, t.TempDir())
	response := server.handle(rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "protocol.negotiate",
		Params: mustJSON(t, map[string]any{"minVersion": 1, "maxVersion": 1}),
	})
	if response.Error != nil {
		t.Fatalf("rpc error: %+v", response.Error)
	}
	result := response.Result.(protocolNegotiationResult)
	if result.ProtocolVersion != transferProtocolVersion ||
		result.Capabilities.TransferDataPlane.ChunkSize != maxTransferChunkBytes ||
		result.Capabilities.TransferDataPlane.MaxWindow != maxTransferWindow {
		t.Fatalf("unexpected negotiation: %+v", result)
	}
}

func TestTransferNegotiationRejectsIncompatibleRanges(t *testing.T) {
	server := mustServer(t, t.TempDir())
	if _, err := server.negotiateProtocol(protocolNegotiationParams{MinVersion: 1, MaxVersion: 2}); err != nil {
		t.Fatalf("overlapping range was rejected: %v", err)
	}
	for _, params := range []protocolNegotiationParams{
		{MinVersion: 0, MaxVersion: 0},
		{MinVersion: 2, MaxVersion: 2},
		{MinVersion: 2, MaxVersion: 1},
	} {
		_, err := server.negotiateProtocol(params)
		assertDomainCode(t, err, "UNSUPPORTED_PROTOCOL")
	}
}

func TestTransferWindowIsBounded(t *testing.T) {
	for _, test := range []struct {
		requested int
		want      int
		valid     bool
	}{{0, 2, true}, {1, 1, true}, {2, 2, true}, {-1, 0, false}, {3, 0, false}} {
		got, err := negotiatedWindow(test.requested)
		if test.valid && (err != nil || got != test.want) {
			t.Fatalf("window %d = %d, %v; want %d", test.requested, got, err, test.want)
		}
		if !test.valid && err == nil {
			t.Fatalf("invalid window %d was accepted", test.requested)
		}
	}
}

func TestUploadRejectsOutOfOrderAndDuplicateOffsets(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	if _, err := server.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "result.part", Offset: 0, Window: 2,
	}); err != nil {
		t.Fatal(err)
	}
	first := uploadDataFrame("upload-1", 0, []byte("first"))
	if _, err := server.handleBinaryTransferFrame(first); err != nil {
		t.Fatal(err)
	}
	if _, err := server.handleBinaryTransferFrame(uploadDataFrame("upload-1", 0, []byte("dup"))); err == nil {
		t.Fatal("duplicate offset was accepted")
	} else {
		assertDomainCode(t, err, "OFFSET_MISMATCH")
	}
	if _, err := server.handleBinaryTransferFrame(uploadDataFrame("upload-1", 99, []byte("gap"))); err == nil {
		t.Fatal("out-of-order offset was accepted")
	} else {
		assertDomainCode(t, err, "OFFSET_MISMATCH")
	}
	content, err := os.ReadFile(filepath.Join(root, "result.part"))
	if err != nil || string(content) != "first" {
		t.Fatalf("partial = %q, error = %v", content, err)
	}
}

func TestUploadReconnectResumesAtPartialOffset(t *testing.T) {
	root := t.TempDir()
	firstServer := mustServer(t, root)
	if _, err := firstServer.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "result.part", Offset: 0,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := firstServer.handleBinaryTransferFrame(uploadDataFrame("upload-1", 0, []byte("first"))); err != nil {
		t.Fatal(err)
	}
	firstServer.closeTransfers()

	secondServer := mustServer(t, root)
	if _, err := secondServer.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "result.part", Offset: 5,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := secondServer.handleBinaryTransferFrame(uploadDataFrame("upload-1", 5, []byte("second"))); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "result.part"))
	if err != nil || string(content) != "firstsecond" {
		t.Fatalf("partial = %q, error = %v", content, err)
	}
}

func TestUploadRejectsHashMismatchWithoutAdvancingPartial(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	if _, err := server.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "result.part", Offset: 0,
	}); err != nil {
		t.Fatal(err)
	}
	frame := uploadDataFrame("upload-1", 0, []byte("content"))
	frame.Digest = sha256.Sum256([]byte("different"))
	_, err := server.handleBinaryTransferFrame(frame)
	assertDomainCode(t, err, "HASH_MISMATCH")
	info, statErr := os.Stat(filepath.Join(root, "result.part"))
	if statErr != nil || info.Size() != 0 {
		t.Fatalf("partial size = %v, error = %v", info, statErr)
	}
}

func TestUploadRejectsSymlinkPartial(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "real.part"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.part", filepath.Join(root, "linked.part")); err != nil {
		t.Fatal(err)
	}
	server := mustServer(t, root)
	_, err := server.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "linked.part", Offset: 0,
	})
	assertDomainCode(t, err, "INVALID_PARTIAL")
}

func TestTransferControlGuardsPathsAndPublishesSyncedHash(t *testing.T) {
	root := t.TempDir()
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.transferCreate("nested/result.part"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested/result.part"), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	partialInfo, err := os.Stat(filepath.Join(root, "nested/result.part"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("payload"))
	expected := hex.EncodeToString(digest[:])
	result, err := fs.transferPublish("nested/result.part", "nested/result.bin", 7, expected, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Hash != expected || result.Size != 7 {
		t.Fatalf("publish result = %+v", result)
	}
	content, err := os.ReadFile(filepath.Join(root, "nested/result.bin"))
	if err != nil || !bytes.Equal(content, []byte("payload")) {
		t.Fatalf("published = %q, error = %v", content, err)
	}
	publishedInfo, err := os.Stat(filepath.Join(root, "nested/result.bin"))
	if err != nil || !os.SameFile(partialInfo, publishedInfo) {
		t.Fatalf("publish did not rename the synced partial: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "nested/result.part")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial still exists: %v", err)
	}
	_, err = fs.transferInspect("../outside")
	assertDomainCode(t, err, "PATH_OUTSIDE_ROOT")
}

func TestPublishRejectsHashMismatchAndKeepsPartial(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "result.part"), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fs.transferPublish("result.part", "result.bin", 7, strings.Repeat("0", 64), false)
	assertDomainCode(t, err, "HASH_MISMATCH")
	if content, readErr := os.ReadFile(filepath.Join(root, "result.part")); readErr != nil || string(content) != "payload" {
		t.Fatalf("partial = %q, error = %v", content, readErr)
	}
	if _, statErr := os.Stat(filepath.Join(root, "result.bin")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("destination was published after hash mismatch: %v", statErr)
	}
}

func TestTransferHashHonorsCancellation(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "source.bin"), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = fs.transferHashContext(ctx, "source.bin", 0, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("hash error = %v, want context canceled", err)
	}
}

func TestPublishRequiresAdjacentPartialAndDestination(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "staging"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "staging/result.part"), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("payload"))
	_, err = fs.transferPublish(
		"staging/result.part", "result.bin", 7, hex.EncodeToString(digest[:]), false,
	)
	if err == nil {
		t.Fatal("cross-directory publish was accepted")
	}
}

func TestPublishClosesUploadBeforeAtomicRename(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	if _, err := server.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "result.part", Offset: 0,
	}); err != nil {
		t.Fatal(err)
	}
	content := []byte("payload")
	if _, err := server.handleBinaryTransferFrame(uploadDataFrame("upload-1", 0, content)); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if _, err := server.publishTransfer(transferPublishParams{
		PartialPath: "result.part", DestinationPath: "result.bin",
		ExpectedSize: int64(len(content)), ExpectedSHA256: hex.EncodeToString(digest[:]),
	}); err != nil {
		t.Fatal(err)
	}
	_, err := server.handleBinaryTransferFrame(uploadDataFrame("upload-1", uint64(len(content)), []byte("late")))
	assertDomainCode(t, err, "TRANSFER_NOT_OPEN")
}

func TestPublishRejectsExistingDestinationWithoutChangingEitherFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "result.part"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "result.bin"), []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("new"))
	_, err = fs.transferPublish(
		"result.part", "result.bin", 3, hex.EncodeToString(digest[:]), false,
	)
	assertDomainCode(t, err, "DESTINATION_EXISTS")
	for path, want := range map[string]string{"result.part": "new", "result.bin": "existing"} {
		content, readErr := os.ReadFile(filepath.Join(root, path))
		if readErr != nil || string(content) != want {
			t.Fatalf("%s = %q, error = %v", path, content, readErr)
		}
	}
}

func TestPublishRejectsSymlinkDestination(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "result.part"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "real.bin"), []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.bin", filepath.Join(root, "result.bin")); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("new"))
	_, err = fs.transferPublish(
		"result.part", "result.bin", 3, hex.EncodeToString(digest[:]), true,
	)
	assertDomainCode(t, err, "INVALID_PARTIAL")
	content, readErr := os.ReadFile(filepath.Join(root, "real.bin"))
	if readErr != nil || string(content) != "existing" {
		t.Fatalf("symlink target = %q, error = %v", content, readErr)
	}
}

func TestDownloadStreamsExactOffsetWithServerHash(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "source.bin"), []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := mustServer(t, root)
	opened, err := server.openDownload(downloadOpenParams{
		TransferID: "download-1", Path: "source.bin", Offset: 3, Window: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if opened.SourceIdentity.Size != 10 || opened.Offset != 3 {
		t.Fatalf("open = %+v", opened)
	}
	response, err := server.handleBinaryTransferFrame(binaryTransferFrame{
		Type: binaryDownloadRequest, TransferID: "download-1", Offset: 3, Length: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Type != binaryDownloadData || string(response.Data) != "3456" ||
		response.Digest != sha256.Sum256([]byte("3456")) {
		t.Fatalf("download response = %+v", response)
	}
	_, err = server.handleBinaryTransferFrame(binaryTransferFrame{
		Type: binaryDownloadRequest, TransferID: "download-1", Offset: 3, Length: 1,
	})
	assertDomainCode(t, err, "OFFSET_MISMATCH")
	_, err = server.handleBinaryTransferFrame(binaryTransferFrame{
		Type: binaryDownloadRequest, TransferID: "download-1", Offset: 9, Length: 1,
	})
	assertDomainCode(t, err, "OFFSET_MISMATCH")
}

func TestTransferSourceIdentityCanBeRechecked(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "source.bin"), []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	fs, err := newFileSystem(root)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := fs.transferIdentity("source.bin")
	if err != nil {
		t.Fatal(err)
	}
	if identity.Kind != "file" || identity.Device == "" || identity.Inode == "" ||
		identity.Size != 7 || identity.Mtime == "" {
		t.Fatalf("identity = %+v", identity)
	}
}

func uploadDataFrame(transferID string, offset uint64, content []byte) binaryTransferFrame {
	return binaryTransferFrame{
		Type: binaryUploadData, TransferID: transferID, Offset: offset,
		Length: uint32(len(content)), Digest: sha256.Sum256(content), Data: content,
	}
}
