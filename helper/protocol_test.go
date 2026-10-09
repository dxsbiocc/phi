package main

import (
	"bytes"
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
