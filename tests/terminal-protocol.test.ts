import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  encodeProtocolFrame,
  parseProtocolLine,
  parseSupervisorRequest,
  parseSupervisorResponse,
  parseSupervisorResponseResult,
  parseSupervisorTerminationResult,
  parseWorkerMessage,
  parseWorkerReplayResult,
  parseWorkerRequest,
  parseWorkerResponse,
  parseWorkerResponseResult,
  TERMINAL_MAX_FRAME_BYTES,
  TerminalProtocolError,
  type SupervisorRequest,
  type WorkerEvent,
  type WorkerRequest
} from '../src/main/terminal/terminal-protocol'
import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS
} from '../src/shared/terminalTypes'

const requestId = 'request_1234'
const terminalId = 'terminal_1234'

function withExtraKey<T extends object>(value: T): T & { unexpected: true } {
  return { ...value, unexpected: true }
}

function assertProtocolError(run: () => unknown): void {
  assert.throws(run, TerminalProtocolError)
}

describe('worker request protocol', () => {
  const requests: WorkerRequest[] = [
    {
      id: requestId,
      type: 'create',
      terminalId,
      application: '/bin/zsh',
      args: ['-il'],
      cwd: '/tmp/project',
      env: { HOME: '/Users/phi', LANG: 'en_US.UTF-8' },
      cols: 120,
      rows: 40
    },
    { id: requestId, type: 'input', terminalId, data: 'echo 你好 👋\n' },
    { id: requestId, type: 'resize', terminalId, cols: 80, rows: 24 },
    { id: requestId, type: 'kill', terminalId },
    { id: requestId, type: 'credit', terminalId, bytes: 512 * 1024 },
    { id: requestId, type: 'setCredit', terminalId, bytes: TERMINAL_CREDIT_WINDOW_BYTES },
    { id: requestId, type: 'replay', terminalId, fromSeq: 1 },
    { id: requestId, type: 'ping' }
  ]

  it('accepts every valid request and rejects extra keys on each variant', () => {
    for (const request of requests) {
      assert.deepEqual(parseWorkerRequest(request), request)
      assertProtocolError(() => parseWorkerRequest(withExtraKey(request)))
    }
  })

  it('rejects wrong field types and malformed identifiers', () => {
    assertProtocolError(() => parseWorkerRequest({ ...requests[0], id: 4 }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[0], terminalId: 'short' }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[0], terminalId: 'bad id spaces' }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[0], args: '-il' }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[0], env: { LANG: 7 } }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[2], cols: 80.5 }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[4], bytes: 0 }))
    assertProtocolError(() => parseWorkerRequest({ ...requests[5], bytes: -1 }))
    assertProtocolError(() =>
      parseWorkerRequest({ ...requests[5], bytes: TERMINAL_CREDIT_WINDOW_BYTES + 1 })
    )
    assert.deepEqual(parseWorkerRequest({ ...requests[5], bytes: 0 }), {
      ...requests[5],
      bytes: 0
    })
    assertProtocolError(() => parseWorkerRequest({ ...requests[6], fromSeq: 0 }))
  })

  it('enforces terminal dimensions at both inclusive boundaries', () => {
    const create = requests[0] as Extract<WorkerRequest, { type: 'create' }>
    assert.deepEqual(parseWorkerRequest({ ...create, cols: TERMINAL_MIN_COLS }), {
      ...create,
      cols: TERMINAL_MIN_COLS
    })
    assert.deepEqual(parseWorkerRequest({ ...create, cols: TERMINAL_MAX_COLS }), {
      ...create,
      cols: TERMINAL_MAX_COLS
    })
    assert.deepEqual(parseWorkerRequest({ ...create, rows: TERMINAL_MIN_ROWS }), {
      ...create,
      rows: TERMINAL_MIN_ROWS
    })
    assert.deepEqual(parseWorkerRequest({ ...create, rows: TERMINAL_MAX_ROWS }), {
      ...create,
      rows: TERMINAL_MAX_ROWS
    })
    assertProtocolError(() => parseWorkerRequest({ ...create, cols: TERMINAL_MIN_COLS - 1 }))
    assertProtocolError(() => parseWorkerRequest({ ...create, cols: TERMINAL_MAX_COLS + 1 }))
    assertProtocolError(() => parseWorkerRequest({ ...create, rows: TERMINAL_MIN_ROWS - 1 }))
    assertProtocolError(() => parseWorkerRequest({ ...create, rows: TERMINAL_MAX_ROWS + 1 }))
  })

  it('enforces the UTF-8 input limit and rejects NUL', () => {
    const valid = '界'.repeat(Math.floor(TERMINAL_MAX_INPUT_BYTES / 3))
    assert.equal(
      (
        parseWorkerRequest({ id: requestId, type: 'input', terminalId, data: valid }) as {
          data: string
        }
      ).data,
      valid
    )
    assertProtocolError(() =>
      parseWorkerRequest({ id: requestId, type: 'input', terminalId, data: `${valid}界` })
    )
    assertProtocolError(() =>
      parseWorkerRequest({ id: requestId, type: 'input', terminalId, data: 'a\0b' })
    )
  })
})

describe('supervisor request protocol', () => {
  const requests: SupervisorRequest[] = [
    { id: requestId, type: 'register', terminalId, pid: 1234 },
    { id: requestId, type: 'terminate', terminalId, mode: 'user' },
    { id: requestId, type: 'terminateAll', mode: 'quit' },
    { id: requestId, type: 'forget', terminalId },
    { id: requestId, type: 'ping' }
  ]

  it('accepts every valid request and rejects extra keys on each variant', () => {
    for (const request of requests) {
      assert.deepEqual(parseSupervisorRequest(request), request)
      assertProtocolError(() => parseSupervisorRequest(withExtraKey(request)))
    }
  })

  it('rejects wrong types, modes, pids, and terminal ids', () => {
    assertProtocolError(() => parseSupervisorRequest({ ...requests[0], pid: 0 }))
    assertProtocolError(() => parseSupervisorRequest({ ...requests[0], pid: '1234' }))
    assertProtocolError(() => parseSupervisorRequest({ ...requests[1], mode: 'force' }))
    assertProtocolError(() => parseSupervisorRequest({ ...requests[3], terminalId: '../unsafe' }))
  })
})

describe('worker messages and responses', () => {
  const events: WorkerEvent[] = [
    { type: 'started', terminalId, pid: 1234 },
    { type: 'data', terminalId, seq: 1, data: '你好 👋' },
    { type: 'gap', terminalId, fromSeq: 1, toSeq: 4, droppedBytes: 4096 },
    { type: 'exit', terminalId, exitCode: 0, cancelled: false, timedOut: false },
    { type: 'error', terminalId, message: 'PTY start failed' }
  ]

  it('accepts strict worker events and rejects unknown keys and wrong types', () => {
    for (const event of events) {
      assert.deepEqual(parseWorkerMessage(event), event)
      assertProtocolError(() => parseWorkerMessage(withExtraKey(event)))
    }
    assertProtocolError(() => parseWorkerMessage({ ...events[0], pid: '1234' }))
    assertProtocolError(() => parseWorkerMessage({ ...events[1], seq: 0 }))
    assertProtocolError(() => parseWorkerMessage({ ...events[2], fromSeq: 8, toSeq: 7 }))
    assertProtocolError(() => parseWorkerMessage({ ...events[3], cancelled: 'false' }))
  })

  it('accepts exact success and failure responses on both channels', () => {
    const success = { id: requestId, ok: true as const, result: { pong: true } }
    const failure = { id: requestId, ok: false as const, error: 'failed safely' }
    assert.deepEqual(parseWorkerResponse(success), success)
    assert.deepEqual(parseWorkerMessage(success), success)
    assert.deepEqual(parseSupervisorResponse(success), success)
    assert.deepEqual(parseWorkerResponse(failure), failure)
    assert.deepEqual(parseSupervisorResponse(failure), failure)
    assertProtocolError(() => parseWorkerResponse(withExtraKey(success)))
    assertProtocolError(() => parseSupervisorResponse(withExtraKey(failure)))
    assertProtocolError(() => parseWorkerResponse({ ...success, ok: 'true' }))
  })

  it('strictly parses replay and supervisor termination results', () => {
    const replay = {
      records: [
        { seq: 2, data: '一' },
        { seq: 3, data: '👋' }
      ],
      gap: { fromSeq: 1, toSeq: 1, droppedBytes: 3 },
      nextSeq: 4,
      more: false
    }
    assert.deepEqual(parseWorkerReplayResult(replay), replay)
    assertProtocolError(() => parseWorkerReplayResult(withExtraKey(replay)))
    assertProtocolError(() =>
      parseWorkerReplayResult({ ...replay, records: [{ seq: 0, data: 'x' }] })
    )

    const termination = { allExited: false, survivors: [123, 456] }
    assert.deepEqual(parseSupervisorTerminationResult(termination), termination)
    assertProtocolError(() => parseSupervisorTerminationResult(withExtraKey(termination)))
    assertProtocolError(() =>
      parseSupervisorTerminationResult({ allExited: false, survivors: ['123'] })
    )
  })

  it('validates every request-specific success result', () => {
    assert.deepEqual(parseWorkerResponseResult('create', { pid: 123 }), { pid: 123 })
    assert.equal(parseWorkerResponseResult('input', null), null)
    assert.equal(parseWorkerResponseResult('setCredit', null), null)
    assert.deepEqual(parseWorkerResponseResult('kill', { killed: false }), { killed: false })
    assert.deepEqual(parseWorkerResponseResult('ping', { pong: true }), { pong: true })
    assert.deepEqual(parseSupervisorResponseResult('register', { registered: true }), {
      registered: true
    })
    assert.deepEqual(parseSupervisorResponseResult('forget', { forgotten: false }), {
      forgotten: false
    })
    assert.deepEqual(
      parseSupervisorResponseResult('terminate', {
        allExited: true,
        survivors: []
      }),
      { allExited: true, survivors: [] }
    )

    assertProtocolError(() => parseWorkerResponseResult('create', { pid: '123' }))
    assertProtocolError(() => parseWorkerResponseResult('input', {}))
    assertProtocolError(() => parseWorkerResponseResult('kill', { killed: true, extra: true }))
    assertProtocolError(() => parseWorkerResponseResult('ping', { pong: false }))
    assertProtocolError(() => parseSupervisorResponseResult('register', { registered: false }))
    assertProtocolError(() => parseSupervisorResponseResult('unknown', null))
  })
})

describe('line-delimited framing', () => {
  it('encodes exactly one JSON line and parses it back', () => {
    const frame = { id: requestId, type: 'ping' }
    const encoded = encodeProtocolFrame(frame)
    assert.equal(encoded.endsWith('\n'), true)
    assert.equal(encoded.slice(0, -1).includes('\n'), false)
    assert.deepEqual(parseProtocolLine(encoded), frame)
    assert.deepEqual(parseProtocolLine(`${encoded.trimEnd()}\r`), frame)
  })

  it('rejects malformed, empty, and oversized frames without parsing them', () => {
    assertProtocolError(() => parseProtocolLine(''))
    assertProtocolError(() => parseProtocolLine('{not-json}'))
    assertProtocolError(() => parseProtocolLine('x'.repeat(TERMINAL_MAX_FRAME_BYTES + 1)))
    assertProtocolError(() => encodeProtocolFrame({ data: '界'.repeat(TERMINAL_MAX_FRAME_BYTES) }))
  })
})
