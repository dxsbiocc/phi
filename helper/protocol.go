package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"sync"
)

const maxFrameSize = 64 * 1024 * 1024

const (
	transferProtocolVersion  = 1
	maxTransferChunkBytes    = 8 * 1024 * 1024
	maxTransferWindow        = 2
	binaryTransferHeaderSize = 52
)

var binaryTransferMagic = [4]byte{'P', 'H', 'D', 'P'}

type binaryTransferType byte

const (
	binaryUploadData      binaryTransferType = 1
	binaryUploadAck       binaryTransferType = 2
	binaryDownloadRequest binaryTransferType = 3
	binaryDownloadData    binaryTransferType = 4
	binaryDownloadAck     binaryTransferType = 5
	binaryTransferError   binaryTransferType = 6
)

type binaryTransferFrame struct {
	Type       binaryTransferType
	TransferID string
	Offset     uint64
	Length     uint32
	Digest     [sha256Size]byte
	Data       []byte
}

const sha256Size = 32

type protocolError struct {
	code    string
	message string
}

func (err *protocolError) Error() string { return err.message }

func readFrame(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 {
		return nil, &protocolError{code: "INVALID_FRAME", message: "frame payload is empty"}
	}
	if length > maxFrameSize {
		return nil, &protocolError{
			code: "FRAME_TOO_LARGE", message: fmt.Sprintf("frame exceeds %d bytes", maxFrameSize),
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeFrame(writer io.Writer, payload []byte) error {
	if len(payload) == 0 || len(payload) > maxFrameSize {
		return &protocolError{code: "INVALID_FRAME", message: "invalid response frame size"}
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}

func isBinaryTransferPayload(payload []byte) bool {
	return len(payload) >= len(binaryTransferMagic) &&
		bytes.Equal(payload[:len(binaryTransferMagic)], binaryTransferMagic[:])
}

func encodeBinaryTransferFrame(frame binaryTransferFrame) ([]byte, error) {
	identifier := []byte(frame.TransferID)
	if len(identifier) == 0 || len(identifier) > 128 {
		return nil, &protocolError{code: "INVALID_FRAME", message: "invalid transfer id length"}
	}
	withData := frame.Type == binaryUploadData || frame.Type == binaryDownloadData ||
		frame.Type == binaryTransferError
	if withData {
		if uint32(len(frame.Data)) != frame.Length {
			return nil, &protocolError{code: "INVALID_FRAME", message: "binary frame length mismatch"}
		}
	} else if len(frame.Data) != 0 {
		return nil, &protocolError{code: "INVALID_FRAME", message: "binary control frame has payload"}
	}
	if (frame.Type == binaryUploadData || frame.Type == binaryDownloadData ||
		frame.Type == binaryDownloadRequest || frame.Type == binaryUploadAck ||
		frame.Type == binaryDownloadAck) && frame.Length > maxTransferChunkBytes {
		return nil, &protocolError{code: "FRAME_TOO_LARGE", message: "transfer chunk exceeds 8 MiB"}
	}
	payload := make([]byte, binaryTransferHeaderSize+len(identifier)+len(frame.Data))
	copy(payload[:4], binaryTransferMagic[:])
	payload[4] = transferProtocolVersion
	payload[5] = byte(frame.Type)
	binary.BigEndian.PutUint16(payload[6:8], uint16(len(identifier)))
	binary.BigEndian.PutUint64(payload[8:16], frame.Offset)
	binary.BigEndian.PutUint32(payload[16:20], frame.Length)
	copy(payload[20:52], frame.Digest[:])
	copy(payload[52:52+len(identifier)], identifier)
	copy(payload[52+len(identifier):], frame.Data)
	return payload, nil
}

func decodeBinaryTransferFrame(payload []byte) (binaryTransferFrame, error) {
	if len(payload) < binaryTransferHeaderSize || !isBinaryTransferPayload(payload) {
		return binaryTransferFrame{}, &protocolError{code: "INVALID_FRAME", message: "invalid binary transfer frame"}
	}
	if payload[4] != transferProtocolVersion {
		return binaryTransferFrame{}, &protocolError{code: "UNSUPPORTED_PROTOCOL", message: "unsupported transfer protocol version"}
	}
	identifierLength := int(binary.BigEndian.Uint16(payload[6:8]))
	if identifierLength == 0 || identifierLength > 128 ||
		len(payload) < binaryTransferHeaderSize+identifierLength {
		return binaryTransferFrame{}, &protocolError{code: "INVALID_FRAME", message: "invalid transfer id length"}
	}
	frame := binaryTransferFrame{
		Type:       binaryTransferType(payload[5]),
		TransferID: string(payload[52 : 52+identifierLength]),
		Offset:     binary.BigEndian.Uint64(payload[8:16]),
		Length:     binary.BigEndian.Uint32(payload[16:20]),
	}
	copy(frame.Digest[:], payload[20:52])
	data := payload[52+identifierLength:]
	switch frame.Type {
	case binaryUploadData, binaryDownloadData, binaryTransferError:
		if uint32(len(data)) != frame.Length {
			return binaryTransferFrame{}, &protocolError{code: "INVALID_FRAME", message: "binary frame length mismatch"}
		}
		frame.Data = append([]byte(nil), data...)
	case binaryUploadAck, binaryDownloadRequest, binaryDownloadAck:
		if len(data) != 0 {
			return binaryTransferFrame{}, &protocolError{code: "INVALID_FRAME", message: "binary control frame has payload"}
		}
	default:
		return binaryTransferFrame{}, &protocolError{code: "INVALID_FRAME", message: "unknown binary transfer frame type"}
	}
	if frame.Type != binaryTransferError && frame.Length > maxTransferChunkBytes {
		return binaryTransferFrame{}, &protocolError{code: "FRAME_TOO_LARGE", message: "transfer chunk exceeds 8 MiB"}
	}
	return frame, nil
}

type synchronizedFrameWriter struct {
	mu     sync.Mutex
	writer io.Writer
}

func (writer *synchronizedFrameWriter) write(payload []byte) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writeFrame(writer.writer, payload)
}
