package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type backgroundProcess struct {
	process *managedProcess
}

type runControl struct {
	context context.Context
	cancel  context.CancelFunc
}

type rpcServer struct {
	fs          *fileSystem
	runner      *processRunner
	context     context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	runs        map[string]runControl
	backgrounds map[string]*backgroundProcess
	nextHandle  uint64
	requests    sync.WaitGroup
}

func newRPCServer(root string) (*rpcServer, error) {
	fs, err := newFileSystem(root)
	if err != nil {
		return nil, err
	}
	serverContext, cancel := context.WithCancel(context.Background())
	return &rpcServer{
		fs: fs, runner: newProcessRunner(fs.guard), runs: make(map[string]runControl),
		backgrounds: make(map[string]*backgroundProcess), context: serverContext, cancel: cancel,
	}, nil
}

func (server *rpcServer) serve(input io.Reader, output io.Writer) error {
	writer := &synchronizedFrameWriter{writer: output}
	for {
		payload, err := readFrame(input)
		if errors.Is(err, io.EOF) {
			server.shutdown()
			return nil
		}
		if err != nil {
			server.shutdown()
			return err
		}
		request, rpcErr := decodeRequest(payload)
		if rpcErr != nil {
			_ = writeResponse(writer, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: rpcErr})
			continue
		}
		if request.Method == "exec.run" {
			if _, _, err := server.ensureRun(request.ID); err != nil {
				_ = writeResponse(writer, rpcResponse{
					JSONRPC: "2.0", ID: request.ID, Error: toRPCError(err),
				})
				continue
			}
		}
		server.requests.Add(1)
		go func(current rpcRequest) {
			defer server.requests.Done()
			response := server.handle(current)
			_ = writeResponse(writer, response)
		}(request)
	}
}

func decodeRequest(payload []byte) (rpcRequest, *rpcError) {
	var request rpcRequest
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return rpcRequest{}, &rpcError{Code: -32700, Message: "invalid JSON request"}
	}
	if err := requireJSONEnd(decoder); err != nil {
		return rpcRequest{}, &rpcError{Code: -32700, Message: "invalid JSON request"}
	}
	if request.JSONRPC != "2.0" || request.Method == "" || len(request.ID) == 0 {
		return rpcRequest{}, &rpcError{Code: -32600, Message: "invalid JSON-RPC request"}
	}
	if _, err := requestIDKey(request.ID); err != nil {
		return rpcRequest{}, &rpcError{Code: -32600, Message: err.Error()}
	}
	return request, nil
}

func requestIDKey(id json.RawMessage) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(id))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", invalidArgument("request id must be a string or number")
	}
	switch typed := value.(type) {
	case string:
		return "s:" + typed, nil
	case json.Number:
		return "n:" + typed.String(), nil
	default:
		return "", invalidArgument("request id must be a string or number")
	}
}

func writeResponse(writer *synchronizedFrameWriter, response rpcResponse) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if len(payload) > maxFrameSize {
		payload, err = json.Marshal(rpcResponse{
			JSONRPC: "2.0", ID: response.ID,
			Error: &rpcError{Code: -32603, Message: "response exceeds protocol frame limit"},
		})
		if err != nil {
			return err
		}
	}
	return writer.write(payload)
}

func (server *rpcServer) handle(request rpcRequest) rpcResponse {
	result, err := server.dispatch(request)
	response := rpcResponse{JSONRPC: "2.0", ID: request.ID}
	if err != nil {
		response.Error = toRPCError(err)
	} else {
		response.Result = result
	}
	return response
}

func toRPCError(err error) *rpcError {
	var domainErr *domainError
	if errors.As(err, &domainErr) {
		return &rpcError{
			Code: -32602, Message: domainErr.message, Data: map[string]any{"code": domainErr.code},
		}
	}
	var methodErr *methodNotFoundError
	if errors.As(err, &methodErr) {
		return &rpcError{Code: -32601, Message: methodErr.Error()}
	}
	return &rpcError{Code: -32603, Message: err.Error()}
}

type methodNotFoundError struct{ method string }

func (err *methodNotFoundError) Error() string {
	return fmt.Sprintf("method not found: %s", err.method)
}

func decodeParams(content json.RawMessage, destination any) error {
	if len(content) == 0 {
		content = json.RawMessage("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return invalidArgument("invalid method parameters: %v", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return invalidArgument("invalid method parameters: %v", err)
	}
	return nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func (server *rpcServer) shutdown() {
	server.cancel()
	server.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(server.runs))
	for _, run := range server.runs {
		cancels = append(cancels, run.cancel)
	}
	server.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	server.requests.Wait()
	server.mu.Lock()
	backgrounds := make([]*managedProcess, 0, len(server.backgrounds))
	for _, background := range server.backgrounds {
		backgrounds = append(backgrounds, background.process)
	}
	server.mu.Unlock()
	for _, process := range backgrounds {
		process.terminate("terminated")
	}
	for _, process := range backgrounds {
		_, _ = process.await()
		process.awaitTermination()
	}
}
