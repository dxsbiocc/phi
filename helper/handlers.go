package main

import "encoding/json"

type pathParams struct {
	Path string `json:"path"`
}

type statParams struct {
	Path              string `json:"path"`
	IncludeModifiedAt bool   `json:"includeModifiedAt,omitempty"`
}

type readParams struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Length int    `json:"length"`
}

type writeParams struct {
	Path         string  `json:"path"`
	Content      []byte  `json:"content"`
	ExpectedHash *string `json:"expectedHash,omitempty"`
}

type listParams struct {
	Path   string `json:"path"`
	Cursor string `json:"cursor,omitempty"`
	Limit  *int   `json:"limit,omitempty"`
}

type removeParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
	Force     bool   `json:"force,omitempty"`
}

func (server *rpcServer) dispatch(request rpcRequest) (any, error) {
	switch request.Method {
	case "fs.stat":
		return server.handleStat(request.Params)
	case "fs.readRange":
		return server.handleReadRange(request.Params)
	case "fs.writeAtomic":
		return server.handleWriteAtomic(request.Params)
	case "fs.list":
		return server.handleList(request.Params)
	case "fs.mkdirp":
		return server.handleMkdirp(request.Params)
	case "fs.remove":
		return server.handleRemove(request.Params)
	case "exec.run":
		return server.handleRun(request.ID, request.Params)
	case "exec.cancel":
		return server.handleCancel(request.Params)
	case "exec.spawnBackground":
		return server.handleSpawnBackground(request.Params)
	case "exec.backgroundStatus":
		return server.handleBackgroundStatus(request.Params)
	case "exec.terminate":
		return server.handleTerminate(request.Params)
	default:
		return nil, &methodNotFoundError{method: request.Method}
	}
}

func (server *rpcServer) handleStat(content json.RawMessage) (statResult, error) {
	var params statParams
	if err := decodeParams(content, &params); err != nil {
		return statResult{}, err
	}
	return server.fs.stat(params.Path, params.IncludeModifiedAt)
}

func (server *rpcServer) handleReadRange(content json.RawMessage) (readRangeResult, error) {
	var params readParams
	if err := decodeParams(content, &params); err != nil {
		return readRangeResult{}, err
	}
	return server.fs.readRange(params.Path, params.Offset, params.Length)
}

func (server *rpcServer) handleWriteAtomic(content json.RawMessage) (writeResult, error) {
	var params writeParams
	if err := decodeParams(content, &params); err != nil {
		return writeResult{}, err
	}
	return server.fs.writeAtomic(params.Path, params.Content, params.ExpectedHash)
}

func (server *rpcServer) handleList(content json.RawMessage) (listResult, error) {
	var params listParams
	if err := decodeParams(content, &params); err != nil {
		return listResult{}, err
	}
	limit := 100
	if params.Limit != nil {
		limit = *params.Limit
	}
	return server.fs.list(params.Path, params.Cursor, limit)
}

func (server *rpcServer) handleMkdirp(content json.RawMessage) (map[string]any, error) {
	var params pathParams
	if err := decodeParams(content, &params); err != nil {
		return nil, err
	}
	if err := server.fs.mkdirp(params.Path); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (server *rpcServer) handleRemove(content json.RawMessage) (map[string]any, error) {
	var params removeParams
	if err := decodeParams(content, &params); err != nil {
		return nil, err
	}
	if err := server.fs.remove(params.Path, params.Recursive, params.Force); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
