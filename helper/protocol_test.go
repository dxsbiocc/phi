package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	payload := []byte(`{"jsonrpc":"2.0","id":1,"method":"fs.stat","params":{"path":"."}}`)
	var stream bytes.Buffer
	if err := writeFrame(&stream, payload); err != nil {
		t.Fatal(err)
	}
	got, err := readFrame(&stream)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload = %q, want %q", got, payload)
	}
}

func TestFrameRejectsOversizedPayload(t *testing.T) {
	var stream bytes.Buffer
	if err := binary.Write(&stream, binary.BigEndian, uint32(maxFrameSize+1)); err != nil {
		t.Fatal(err)
	}
	_, err := readFrame(&stream)
	var protocolErr *protocolError
	if !errors.As(err, &protocolErr) || protocolErr.code != "FRAME_TOO_LARGE" {
		t.Fatalf("error = %v, want FRAME_TOO_LARGE", err)
	}
}

func TestFrameRejectsTruncatedPayload(t *testing.T) {
	var stream bytes.Buffer
	if err := binary.Write(&stream, binary.BigEndian, uint32(8)); err != nil {
		t.Fatal(err)
	}
	stream.WriteString("short")
	_, err := readFrame(&stream)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("error = %v, want unexpected EOF", err)
	}
}

func TestFrameRejectsEmptyPayload(t *testing.T) {
	var stream bytes.Buffer
	if err := binary.Write(&stream, binary.BigEndian, uint32(0)); err != nil {
		t.Fatal(err)
	}
	_, err := readFrame(&stream)
	var protocolErr *protocolError
	if !errors.As(err, &protocolErr) || protocolErr.code != "INVALID_FRAME" {
		t.Fatalf("error = %v, want INVALID_FRAME", err)
	}
}

func TestRequestRejectsTrailingJSONValue(t *testing.T) {
	_, rpcErr := decodeRequest([]byte(
		`{"jsonrpc":"2.0","id":1,"method":"fs.stat","params":{"path":"."}} {}`,
	))
	if rpcErr == nil || rpcErr.Code != -32700 {
		t.Fatalf("rpc error = %+v, want parse error", rpcErr)
	}
}

func TestBinaryTransferFrameRoundTrip(t *testing.T) {
	content := []byte{0, 1, 2, 0xff}
	digest := sha256.Sum256(content)
	want := binaryTransferFrame{
		Type: binaryUploadData, TransferID: "transfer-1", Offset: 8,
		Length: uint32(len(content)), Digest: digest, Data: content,
	}
	payload, err := encodeBinaryTransferFrame(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeBinaryTransferFrame(payload)
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != want.Type || got.TransferID != want.TransferID || got.Offset != want.Offset ||
		got.Length != want.Length || got.Digest != want.Digest || !bytes.Equal(got.Data, want.Data) {
		t.Fatalf("frame = %+v, want %+v", got, want)
	}
}

func TestBinaryTransferFrameRejectsBrokenAndOversizedChunks(t *testing.T) {
	digest := sha256.Sum256([]byte("short"))
	payload, err := encodeBinaryTransferFrame(binaryTransferFrame{
		Type: binaryUploadData, TransferID: "transfer-1", Offset: 0,
		Length: 5, Digest: digest, Data: []byte("short"),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = decodeBinaryTransferFrame(payload[:len(payload)-1])
	assertProtocolCode(t, err, "INVALID_FRAME")
	_, err = encodeBinaryTransferFrame(binaryTransferFrame{
		Type: binaryUploadData, TransferID: "transfer-1", Length: maxTransferChunkBytes + 1,
		Data: make([]byte, maxTransferChunkBytes+1),
	})
	assertProtocolCode(t, err, "FRAME_TOO_LARGE")
}

func assertProtocolCode(t *testing.T, err error, code string) {
	t.Helper()
	var protocolErr *protocolError
	if !errors.As(err, &protocolErr) || protocolErr.code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}
