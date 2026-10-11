package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestServerServesFileRPC(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	reader, writer := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- server.serve(reader, responseWriter) }()

	writeRequest(t, writer, rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "fs.writeAtomic",
		Params: mustJSON(t, map[string]any{"path": "a.txt", "content": []byte("hello")}),
	})
	response := readResponse(t, responseReader)
	if response.Error != nil {
		t.Fatalf("rpc error: %+v", response.Error)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := responseWriter.Close(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "a.txt"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("content = %q, error = %v", content, err)
	}
}

func TestServerEOFStopsBackgroundProcessGroup(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	reader, writer := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- server.serve(reader, responseWriter) }()
	writeRequest(t, writer, rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`"spawn"`), Method: "exec.spawnBackground",
		Params: mustJSON(t, map[string]any{
			"command": []string{"/bin/sh", "-c", "trap '' TERM; echo $$ > helper-child.pid; while :; do sleep 1; done"},
			"cwd":     ".",
		}),
	})
	response := readResponse(t, responseReader)
	if response.Error != nil {
		t.Fatalf("rpc error: %+v", response.Error)
	}
	pid := waitForPIDFile(t, filepath.Join(root, "helper-child.pid"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not stop after stdin EOF")
	}
	if err := responseWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatalf("background process %d survived server EOF", pid)
	}
}

func TestServerCancelsRunByRequestID(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	defer server.shutdown()
	runRequest := rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`"long-run"`), Method: "exec.run",
		Params: mustJSON(t, map[string]any{
			"command": []string{"/bin/sh", "-c", "echo $$ > cancel.pid; sleep 30"}, "cwd": ".",
		}),
	}
	done := make(chan rpcResponse, 1)
	go func() { done <- server.handle(runRequest) }()
	_ = waitForPIDFile(t, filepath.Join(root, "cancel.pid"))
	cancelResponse := server.handle(rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`"cancel"`), Method: "exec.cancel",
		Params: mustJSON(t, map[string]any{"requestId": "long-run"}),
	})
	if cancelResponse.Error != nil || !cancelResponse.Result.(cancelResult).Cancelled {
		t.Fatalf("cancel response = %+v", cancelResponse)
	}
	select {
	case response := <-done:
		if response.Error != nil {
			t.Fatalf("run response error = %+v", response.Error)
		}
		result := response.Result.(commandResult)
		if result.TerminationReason != "cancelled" || result.Signal == nil {
			t.Fatalf("run was not cancelled: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled RPC did not finish")
	}
}

func TestServerReturnsStructuredPathError(t *testing.T) {
	server := mustServer(t, t.TempDir())
	response := server.handle(rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "fs.stat",
		Params: mustJSON(t, map[string]any{"path": "../outside"}),
	})
	if response.Error == nil || response.Error.Data["code"] != "PATH_OUTSIDE_ROOT" {
		t.Fatalf("response error = %+v", response.Error)
	}
}

func TestServerBrokenBinaryFramePreservesAcknowledgedUploadForReconnect(t *testing.T) {
	root := t.TempDir()
	server := mustServer(t, root)
	reader, writer := io.Pipe()
	responseReader, responseWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- server.serve(reader, responseWriter) }()

	writeRequest(t, writer, rpcRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "transfer.upload.open",
		Params: mustJSON(t, map[string]any{
			"transferId": "upload-1", "path": "result.part", "offset": 0,
		}),
	})
	if response := readResponse(t, responseReader); response.Error != nil {
		t.Fatalf("open error: %+v", response.Error)
	}
	writeBinaryTransfer(t, writer, uploadDataFrame("upload-1", 0, []byte("first")))
	ack := readBinaryTransfer(t, responseReader)
	if ack.Type != binaryUploadAck || ack.Offset != 0 || ack.Length != 5 {
		t.Fatalf("ack = %+v", ack)
	}
	writeBinaryTransfer(t, writer, uploadDataFrame("upload-1", 0, []byte("duplicate")))
	rejected := readBinaryTransfer(t, responseReader)
	if rejected.Type != binaryTransferError ||
		!bytes.HasPrefix(rejected.Data, []byte("OFFSET_MISMATCH\n")) {
		t.Fatalf("duplicate response = %+v", rejected)
	}

	broken, err := encodeBinaryTransferFrame(uploadDataFrame("upload-1", 5, []byte("broken")))
	if err != nil {
		t.Fatal(err)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(broken)))
	if _, err := writer.Write(header[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(broken[:len(broken)/2]); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("serve error = %v, want unexpected EOF", err)
	}
	if err := responseWriter.Close(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "result.part"))
	if err != nil || !bytes.Equal(content, []byte("first")) {
		t.Fatalf("partial = %q, error = %v", content, err)
	}

	reconnected := mustServer(t, root)
	if _, err := reconnected.openUpload(uploadOpenParams{
		TransferID: "upload-1", Path: "result.part", Offset: 5,
	}); err != nil {
		t.Fatalf("reconnect failed: %v", err)
	}
}

func mustServer(t *testing.T, root string) *rpcServer {
	t.Helper()
	server, err := newRPCServer(root)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func writeRequest(t *testing.T, writer io.Writer, request rpcRequest) {
	t.Helper()
	content, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeFrame(writer, content); err != nil {
		t.Fatal(err)
	}
}

func readResponse(t *testing.T, reader io.Reader) rpcResponse {
	t.Helper()
	content, err := readFrame(reader)
	if err != nil {
		t.Fatal(err)
	}
	var response rpcResponse
	if err := json.Unmarshal(content, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func writeBinaryTransfer(t *testing.T, writer io.Writer, frame binaryTransferFrame) {
	t.Helper()
	payload, err := encodeBinaryTransferFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeFrame(writer, payload); err != nil {
		t.Fatal(err)
	}
}

func readBinaryTransfer(t *testing.T, reader io.Reader) binaryTransferFrame {
	t.Helper()
	payload, err := readFrame(reader)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := decodeBinaryTransferFrame(payload)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}
