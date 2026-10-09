package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"sync"
)

const maxFrameSize = 64 * 1024 * 1024

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

type synchronizedFrameWriter struct {
	mu     sync.Mutex
	writer io.Writer
}

func (writer *synchronizedFrameWriter) write(payload []byte) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writeFrame(writer.writer, payload)
}
