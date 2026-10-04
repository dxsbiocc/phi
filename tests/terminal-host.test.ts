import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import test from 'node:test'
import { TerminalHost, type TerminalCreateOptions } from '../src/main/terminal/terminal-host'

type Frame = Record<string, unknown>
type RequestHandler = (request: Frame, endpoint: FakeEndpoint) => void

class FakeEndpoint extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: Frame[] = []
  killed = false
  private inputBuffer = ''

  constructor(private handler: RequestHandler) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.inputBuffer += chunk
      while (this.inputBuffer.includes('\n')) {
        const index = this.inputBuffer.indexOf('\n')
        const line = this.inputBuffer.slice(0, index)
        this.inputBuffer = this.inputBuffer.slice(index + 1)
        if (!line) continue
        const request = JSON.parse(line) as Frame
        this.requests.push(request)
        this.handler(request, this)
      }
    })
  }

  setHandler(handler: RequestHandler): void {
    this.handler = handler
  }

  frame(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  respond(request: Frame, result: unknown = null): void {
    this.frame({ id: request.id, ok: true, result })
  }

  fail(request: Frame, error: string): void {
    this.frame({ id: request.id, ok: false, error })
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

const terminal: TerminalCreateOptions = {
  terminalId: 'terminal_1',
  application: '/bin/zsh',
  args: ['-il'],
  cwd: '/tmp',
  env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  cols: 80,
  rows: 24
}

function defaultWorker(request: Frame, endpoint: FakeEndpoint): void {
  switch (request.type) {
    case 'create':
      endpoint.frame({ type: 'started', terminalId: request.terminalId, pid: 4321 })
      endpoint.respond(request, { pid: 4321 })
      return
    case 'replay':
      endpoint.respond(request, { records: [], nextSeq: 1, more: false })
      return
    case 'kill':
      endpoint.respond(request, { killed: true })
      return
    case 'ping':
      endpoint.respond(request, { pong: true })
      return
    default:
      endpoint.respond(request)
  }
}

function defaultSupervisor(request: Frame, endpoint: FakeEndpoint): void {
  if (request.type === 'terminate' || request.type === 'terminateAll') {
    endpoint.respond(request, { allExited: true, survivors: [] })
  } else if (request.type === 'register') {
    endpoint.respond(request, { registered: true })
  } else if (request.type === 'forget') {
    endpoint.respond(request, { forgotten: true })
  } else if (request.type === 'ping') {
    endpoint.respond(request, { pong: true })
  } else {
    endpoint.respond(request)
  }
}

function harness(
  options: {
    worker?: RequestHandler
    supervisor?: RequestHandler
    heartbeatIntervalMs?: number
    heartbeatTimeoutMs?: number
    heartbeatStartupGraceMs?: number
    faultCleanupTimeoutMs?: number
  } = {}
): { host: TerminalHost; worker: FakeEndpoint; supervisor: FakeEndpoint } {
  const worker = new FakeEndpoint(options.worker ?? defaultWorker)
  const supervisor = new FakeEndpoint(options.supervisor ?? defaultSupervisor)
  const host = new TerminalHost({
    spawnWorker: () => worker.asChild(),
    spawnSupervisor: () => supervisor.asChild(),
    workerPath: '/fake/worker.ts',
    supervisorPath: '/fake/supervisor.ts',
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 30_000,
    heartbeatStartupGraceMs: options.heartbeatStartupGraceMs,
    faultCleanupTimeoutMs: options.faultCleanupTimeoutMs
  })
  return { host, worker, supervisor }
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('create waits for worker started and supervisor registration', async () => {
  let createRequest: Frame | undefined
  let registerRequest: Frame | undefined
  const { host, worker, supervisor } = harness({
    worker: (request, endpoint) => {
      if (request.type === 'create') {
        createRequest = request
        endpoint.respond(request, { pid: 4321 })
      } else defaultWorker(request, endpoint)
    },
    supervisor: (request, endpoint) => {
      if (request.type === 'register') registerRequest = request
      else defaultSupervisor(request, endpoint)
    }
  })
  try {
    let settled = false
    const creating = host.createTerminal(terminal).then((result) => {
      settled = true
      return result
    })
    await turn()
    assert.ok(createRequest)
    assert.equal(settled, false)

    worker.frame({ type: 'started', terminalId: terminal.terminalId, pid: 4321 })
    await turn()
    assert.ok(registerRequest)
    assert.equal(settled, false)

    supervisor.respond(registerRequest, { registered: true })
    assert.deepEqual(await creating, { terminalId: terminal.terminalId, pid: 4321 })
  } finally {
    await host.dispose()
  }
})

test('register failure kills the new PTY and rejects create', async () => {
  const { host, worker } = harness({
    supervisor: (request, endpoint) => {
      if (request.type === 'register') endpoint.fail(request, 'cannot retain process')
      else defaultSupervisor(request, endpoint)
    }
  })
  try {
    await assert.rejects(host.createTerminal(terminal), /cannot retain process/)
    assert.equal(
      worker.requests.some(
        (request) => request.type === 'kill' && request.terminalId === terminal.terminalId
      ),
      true
    )
  } finally {
    await host.dispose()
  }
})

test('input calls for one terminal are written in call order', async () => {
  let firstInput: Frame | undefined
  const { host, worker } = harness({
    worker: (request, endpoint) => {
      if (request.type === 'input' && firstInput === undefined) {
        firstInput = request
        return
      }
      defaultWorker(request, endpoint)
    }
  })
  try {
    await host.createTerminal(terminal)
    const first = host.input(terminal.terminalId, 'first\n')
    const second = host.input(terminal.terminalId, 'second\n')
    await turn()
    assert.deepEqual(
      worker.requests.filter((request) => request.type === 'input').map((request) => request.data),
      ['first\n']
    )

    assert.ok(firstInput)
    worker.respond(firstInput, null)
    await first
    await second
    assert.deepEqual(
      worker.requests.filter((request) => request.type === 'input').map((request) => request.data),
      ['first\n', 'second\n']
    )
  } finally {
    await host.dispose()
  }
})

test('setCredit forwards an absolute credit value to the worker', async () => {
  const { host, worker } = harness()
  try {
    await host.createTerminal(terminal)
    await host.setCredit(terminal.terminalId, 0)
    await host.setCredit(terminal.terminalId, 512 * 1024)
    assert.deepEqual(
      worker.requests
        .filter((request) => request.type === 'setCredit')
        .map((request) => ({ terminalId: request.terminalId, bytes: request.bytes })),
      [
        { terminalId: terminal.terminalId, bytes: 0 },
        { terminalId: terminal.terminalId, bytes: 512 * 1024 }
      ]
    )
  } finally {
    await host.dispose()
  }
})

test('concurrent close calls share one cleanup operation', async () => {
  let terminateRequest: Frame | undefined
  const { host, supervisor } = harness({
    supervisor: (request, endpoint) => {
      if (request.type === 'terminate') terminateRequest = request
      else defaultSupervisor(request, endpoint)
    }
  })
  try {
    await host.createTerminal(terminal)
    const first = host.close(terminal.terminalId, 'user')
    const second = host.close(terminal.terminalId, 'user')
    assert.equal(first, second)
    await turn()
    assert.ok(terminateRequest)
    supervisor.respond(terminateRequest, { allExited: true, survivors: [] })
    await Promise.all([first, second])
    assert.equal(supervisor.requests.filter((request) => request.type === 'terminate').length, 1)
  } finally {
    await host.dispose()
  }
})

test('worker heartbeat timeout fails terminals and asks supervisor to terminate all', async () => {
  let answerPings = true
  const events: unknown[] = []
  const { host, worker, supervisor } = harness({
    worker: (request, endpoint) => {
      if (request.type === 'ping' && !answerPings) return
      defaultWorker(request, endpoint)
    },
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 80
  })
  host.subscribe((event) => events.push(event))
  try {
    await host.createTerminal(terminal)
    await waitFor(() => worker.requests.some((request) => request.type === 'ping'))
    await turn()
    answerPings = false
    await waitFor(
      () =>
        events.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            (event as { type?: unknown }).type === 'failed'
        ),
      3_000
    )
    await waitFor(() => supervisor.requests.some((request) => request.type === 'terminateAll'))
  } finally {
    await host.dispose()
  }
})

test('heartbeat uses startup grace until the first pong', async () => {
  const events: unknown[] = []
  const { host } = harness({
    worker: (request, endpoint) => {
      if (request.type === 'ping') return
      defaultWorker(request, endpoint)
    },
    // Wide margins: under full-suite load, createTerminal alone can take longer than a tight grace window.
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 80,
    heartbeatStartupGraceMs: 1_500
  })
  host.subscribe((event) => events.push(event))
  try {
    await host.createTerminal(terminal)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      events.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: unknown }).type === 'failed'
      ),
      false
    )
    await waitFor(
      () =>
        events.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            (event as { type?: unknown }).type === 'failed'
        ),
      5_000
    )
  } finally {
    await host.dispose()
  }
})

test('unexpected worker exit fails an active terminal', async () => {
  const events: unknown[] = []
  const { host, worker, supervisor } = harness()
  host.subscribe((event) => events.push(event))
  try {
    await host.createTerminal(terminal)
    worker.emit('exit', 9, null)
    await waitFor(() =>
      events.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: unknown }).type === 'failed'
      )
    )
    await waitFor(() => supervisor.requests.some((request) => request.type === 'terminateAll'))
  } finally {
    await host.dispose()
  }
})

test('worker fault terminates, forgets failed terminals, then drops host records', async () => {
  let terminateAllRequest: Frame | undefined
  const { host, worker, supervisor } = harness({
    supervisor: (request, endpoint) => {
      if (request.type === 'terminateAll' && terminateAllRequest === undefined) {
        terminateAllRequest = request
        return
      }
      defaultSupervisor(request, endpoint)
    }
  })
  try {
    await host.createTerminal(terminal)
    worker.emit('exit', 9, null)
    await waitFor(() => terminateAllRequest !== undefined)
    assert.equal(
      supervisor.requests.some((request) => request.type === 'forget'),
      false
    )

    assert.ok(terminateAllRequest)
    supervisor.respond(terminateAllRequest, { allExited: true, survivors: [] })
    await waitFor(() => supervisor.requests.some((request) => request.type === 'forget'))
    await turn()
    await assert.rejects(host.replay(terminal.terminalId, 1), /Unknown terminal/u)
  } finally {
    await host.dispose()
  }
})

test('worker fault timeout retains cleanup ownership and quarantines new terminals', async () => {
  const { host, worker, supervisor } = harness({
    supervisor: (request, endpoint) => {
      if (request.type === 'terminateAll') return
      defaultSupervisor(request, endpoint)
    },
    faultCleanupTimeoutMs: 50
  })
  try {
    await host.createTerminal(terminal)
    worker.emit('exit', 9, null)
    await waitFor(() => supervisor.requests.some((request) => request.type === 'terminateAll'))
    await new Promise((resolve) => setTimeout(resolve, 75))

    assert.equal(
      supervisor.requests.some((request) => request.type === 'forget'),
      false
    )
    await assert.rejects(
      host.createTerminal({ ...terminal, terminalId: 'terminal_2' }),
      /supervisor is unavailable/u
    )
  } finally {
    supervisor.setHandler(defaultSupervisor)
    await host.dispose()
  }
})

test('quit closeAll stays within its budget when a child never responds', async () => {
  let ignoredTerminateAll = false
  const { host } = harness({
    supervisor: (request, endpoint) => {
      if (request.type === 'terminateAll' && !ignoredTerminateAll) {
        ignoredTerminateAll = true
        return
      }
      defaultSupervisor(request, endpoint)
    }
  })
  try {
    await host.createTerminal(terminal)
    const startedAt = performance.now()
    await host.closeAll('quit')
    assert.ok(performance.now() - startedAt <= 1_650)
  } finally {
    await host.dispose()
  }
})

test('dispose stays within the quit budget when both children stop answering', async () => {
  let hang = false
  const { host, worker, supervisor } = harness({
    worker: (request, endpoint) => {
      if (hang) return
      defaultWorker(request, endpoint)
    },
    supervisor: (request, endpoint) => {
      if (hang) return
      defaultSupervisor(request, endpoint)
    }
  })
  await host.createTerminal(terminal)
  hang = true
  const startedAt = performance.now()
  await host.dispose()
  assert.ok(performance.now() - startedAt <= 1_500)
  assert.equal(worker.killed, true)
  assert.equal(supervisor.killed, true)
})

test('malformed and oversized worker frames are ignored', async () => {
  const events: unknown[] = []
  const { host, worker } = harness()
  host.subscribe((event) => events.push(event))
  try {
    await host.createTerminal(terminal)
    worker.stdout.write('{not json}\n')
    worker.frame({
      type: 'data',
      terminalId: terminal.terminalId,
      seq: 1,
      data: 'bad',
      extra: true
    })
    worker.stdout.write(`${'x'.repeat(256 * 1024 + 1)}\n`)
    worker.frame({ type: 'data', terminalId: terminal.terminalId, seq: 2, data: 'good' })
    await turn()
    const dataEvents = events.filter(
      (event) =>
        typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'data'
    )
    assert.deepEqual(dataEvents, [
      { type: 'data', terminalId: terminal.terminalId, seq: 2, data: 'good' }
    ])
  } finally {
    await host.dispose()
  }
})
