package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type cancelParams struct {
	RequestID json.RawMessage `json:"requestId"`
}

type cancelResult struct {
	Cancelled bool `json:"cancelled"`
}

type backgroundResult struct {
	HandleID string `json:"handleId"`
	PID      int    `json:"pid"`
}

type backgroundParams struct {
	HandleID string `json:"handleId"`
}

type backgroundStatus struct {
	PID     int            `json:"pid"`
	Running bool           `json:"running"`
	Result  *commandResult `json:"result,omitempty"`
}

func (server *rpcServer) handleRun(id, content json.RawMessage) (commandResult, error) {
	key, control, err := server.ensureRun(id)
	if err != nil {
		return commandResult{}, err
	}
	defer func() {
		control.cancel()
		server.mu.Lock()
		delete(server.runs, key)
		server.mu.Unlock()
	}()
	var params runParams
	if err := decodeParams(content, &params); err != nil {
		return commandResult{}, err
	}
	return server.runner.run(control.context, params)
}

func (server *rpcServer) ensureRun(id json.RawMessage) (string, runControl, error) {
	key, err := requestIDKey(id)
	if err != nil {
		return "", runControl{}, err
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if control, exists := server.runs[key]; exists {
		return key, control, nil
	}
	ctx, cancel := context.WithCancel(server.context)
	control := runControl{context: ctx, cancel: cancel}
	server.runs[key] = control
	return key, control, nil
}

func (server *rpcServer) handleCancel(content json.RawMessage) (cancelResult, error) {
	var params cancelParams
	if err := decodeParams(content, &params); err != nil {
		return cancelResult{}, err
	}
	key, err := requestIDKey(params.RequestID)
	if err != nil {
		return cancelResult{}, err
	}
	server.mu.Lock()
	control, exists := server.runs[key]
	server.mu.Unlock()
	if !exists {
		return cancelResult{Cancelled: false}, nil
	}
	control.cancel()
	return cancelResult{Cancelled: true}, nil
}

func (server *rpcServer) handleSpawnBackground(content json.RawMessage) (backgroundResult, error) {
	var params runParams
	if err := decodeParams(content, &params); err != nil {
		return backgroundResult{}, err
	}
	process, err := server.runner.start(params)
	if err != nil {
		return backgroundResult{}, err
	}
	server.mu.Lock()
	server.nextHandle++
	handleID := fmt.Sprintf("process-%d", server.nextHandle)
	server.backgrounds[handleID] = &backgroundProcess{process: process}
	server.mu.Unlock()
	if params.TimeoutMs != nil {
		go terminateAfter(process, time.Duration(*params.TimeoutMs)*time.Millisecond)
	}
	return backgroundResult{HandleID: handleID, PID: process.cmd.Process.Pid}, nil
}

func terminateAfter(process *managedProcess, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-process.done:
	case <-timer.C:
		process.terminate("timeout")
	}
}

func (server *rpcServer) background(handleID string) (*backgroundProcess, error) {
	if handleID == "" {
		return nil, invalidArgument("handleId is required")
	}
	server.mu.Lock()
	background := server.backgrounds[handleID]
	server.mu.Unlock()
	if background == nil {
		return nil, invalidArgument("unknown background process handle")
	}
	return background, nil
}

func (server *rpcServer) handleBackgroundStatus(content json.RawMessage) (backgroundStatus, error) {
	var params backgroundParams
	if err := decodeParams(content, &params); err != nil {
		return backgroundStatus{}, err
	}
	background, err := server.background(params.HandleID)
	if err != nil {
		return backgroundStatus{}, err
	}
	result, running := background.process.query()
	status := backgroundStatus{PID: background.process.cmd.Process.Pid, Running: running}
	if !running {
		status.Result = &result
	}
	return status, nil
}

func (server *rpcServer) handleTerminate(content json.RawMessage) (commandResult, error) {
	var params backgroundParams
	if err := decodeParams(content, &params); err != nil {
		return commandResult{}, err
	}
	background, err := server.background(params.HandleID)
	if err != nil {
		return commandResult{}, err
	}
	background.process.terminate("terminated")
	result, err := background.process.await()
	background.process.awaitTermination()
	return result, err
}
