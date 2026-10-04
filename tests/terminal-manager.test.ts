import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  type TerminalEvent,
  type TerminalWorkspaceRef
} from '../src/shared/terminalTypes'
import { TerminalError } from '../src/main/terminal/terminal-error'
import { BunExecutableNotFoundError } from '../src/main/terminal/terminal-bun'
import type {
  TerminalCreateOptions,
  TerminalHostEvent,
  TerminalReplayResult
} from '../src/main/terminal/terminal-host'
import {
  TerminalManager,
  type TerminalHostLike,
  type TerminalManagerWorkspace
} from '../src/main/terminal/terminal-manager'

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

class FakeTerminalHost implements TerminalHostLike {
  readonly createCalls: TerminalCreateOptions[] = []
  readonly inputCalls: Array<{ terminalId: string; data: string }> = []
  readonly resizeCalls: Array<{ terminalId: string; cols: number; rows: number }> = []
  readonly creditCalls: Array<{ terminalId: string; bytes: number }> = []
  readonly setCreditCalls: Array<{ terminalId: string; bytes: number }> = []
  readonly replayCalls: Array<{ terminalId: string; fromSeq: number }> = []
  readonly closeCalls: Array<{ terminalId: string; mode: 'user' | 'quit' }> = []
  readonly createGates = new Map<string, Deferred<{ terminalId: string; pid: number }>>()
  readonly resizeGates: Array<Deferred<void>> = []
  deferCreates = false
  deferResizes = false
  disposeCalls = 0
  disposeGate?: Deferred<void>
  inputFailure?: (terminalId: string, data: string) => Error | undefined
  setCreditHandler?: (terminalId: string, bytes: number) => void
  replayHandler: (terminalId: string, fromSeq: number) => Promise<TerminalReplayResult> = async (
    _terminalId,
    fromSeq
  ) => ({
    records: [],
    nextSeq: fromSeq,
    more: false
  })
  private readonly listeners = new Set<(event: TerminalHostEvent) => void>()

  subscribe(listener: (event: TerminalHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: TerminalHostEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  createTerminal(options: TerminalCreateOptions): Promise<{ terminalId: string; pid: number }> {
    this.createCalls.push({ ...options, args: [...options.args], env: { ...options.env } })
    if (!this.deferCreates) {
      return Promise.resolve({
        terminalId: options.terminalId,
        pid: 4_000 + this.createCalls.length
      })
    }
    const gate = new Deferred<{ terminalId: string; pid: number }>()
    this.createGates.set(options.terminalId, gate)
    return gate.promise
  }

  resolveCreate(terminalId: string): void {
    const gate = this.createGates.get(terminalId)
    assert.ok(gate, `missing create gate for ${terminalId}`)
    gate.resolve({ terminalId, pid: 4_000 + this.createCalls.length })
  }

  resolveAllCreates(): void {
    for (const terminalId of this.createGates.keys()) this.resolveCreate(terminalId)
  }

  input(terminalId: string, data: string): Promise<void> {
    this.inputCalls.push({ terminalId, data })
    const failure = this.inputFailure?.(terminalId, data)
    return failure ? Promise.reject(failure) : Promise.resolve()
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.resizeCalls.push({ terminalId, cols, rows })
    if (!this.deferResizes) return Promise.resolve()
    const gate = new Deferred<void>()
    this.resizeGates.push(gate)
    return gate.promise
  }

  credit(terminalId: string, bytes: number): Promise<void> {
    this.creditCalls.push({ terminalId, bytes })
    return Promise.resolve()
  }

  setCredit(terminalId: string, bytes: number): Promise<void> {
    this.setCreditCalls.push({ terminalId, bytes })
    this.setCreditHandler?.(terminalId, bytes)
    return Promise.resolve()
  }

  replay(terminalId: string, fromSeq: number): Promise<TerminalReplayResult> {
    this.replayCalls.push({ terminalId, fromSeq })
    return this.replayHandler(terminalId, fromSeq)
  }

  close(terminalId: string, mode: 'user' | 'quit'): Promise<void> {
    this.closeCalls.push({ terminalId, mode })
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1
    return this.disposeGate?.promise ?? Promise.resolve()
  }
}

const project = (projectId: string): TerminalWorkspaceRef => ({ kind: 'project', projectId })

function resolvedWorkspace(ref: TerminalWorkspaceRef): TerminalManagerWorkspace {
  const name = ref.kind === 'project' ? ref.projectId : 'ordinary'
  return {
    workspaceKey: ref.kind === 'project' ? `project:${name}` : 'ordinary',
    cwd: `/workspaces/${name}`,
    label: name
  }
}

function harness(host = new FakeTerminalHost()): {
  host: FakeTerminalHost
  manager: TerminalManager
  events: TerminalEvent[]
} {
  let nextTerminalId = 0
  const events: TerminalEvent[] = []
  const manager = new TerminalManager({
    resolveWorkspace: async (ref) => resolvedWorkspace(ref),
    sink: (event) => events.push(event),
    hostFactory: () => host,
    now: () => Date.UTC(2026, 9, 3, 10, 30),
    randomTerminalId: () => `terminal-${String(++nextTerminalId).padStart(13, '0')}`,
    environment: {
      HOME: '/Users/tester',
      SHELL: '/bin/zsh',
      SECRET_NOT_ALLOWED: 'manager-environment-secret'
    },
    resolveShell: () => ({ application: '/bin/zsh', args: ['-il'] })
  })
  return { host, manager, events }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function terminalError(
  action: () => unknown | Promise<unknown>,
  code: TerminalError['code']
): Promise<TerminalError> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof TerminalError)
  assert.equal(caught.code, code)
  assert.ok(caught.message.length > 0)
  return caught
}

test('deduplicates in-flight creates and a lost-response retry by requestId', async () => {
  const { host, manager } = harness()
  host.deferCreates = true

  const first = manager.create(project('alpha'), 80, 24, 'request_dedupe')
  const inFlightRetry = manager.create(project('alpha'), 80, 24, 'request_dedupe')
  await waitFor(() => host.createCalls.length === 1)

  const terminalId = host.createCalls[0].terminalId
  host.resolveCreate(terminalId)
  const [firstResult, retryResult] = await Promise.all([first, inFlightRetry])
  assert.equal(retryResult.terminalId, firstResult.terminalId)
  assert.equal(host.createCalls.length, 1)

  // Simulate a caller losing the successful response and retrying the same accepted request.
  const lostResponseRetry = await manager.create(project('alpha'), 120, 40, 'request_dedupe')
  assert.equal(lostResponseRetry.terminalId, firstResult.terminalId)
  assert.equal(host.createCalls.length, 1)
  await manager.dispose()
})

test('counts delayed creates against per-workspace and total live limits', async () => {
  const { host, manager } = harness()
  host.deferCreates = true

  const alphaCreates = Array.from({ length: 4 }, (_, index) =>
    manager.create(project('alpha'), 80, 24, `request_alpha_${index}`)
  )
  await waitFor(() => host.createCalls.length === 4)
  await terminalError(
    () => manager.create(project('alpha'), 80, 24, 'alpha_over_limit'),
    'limit_reached'
  )

  const betaCreates = Array.from({ length: 4 }, (_, index) =>
    manager.create(project('beta'), 80, 24, `request_beta_${index}`)
  )
  await waitFor(() => host.createCalls.length === 8)
  await terminalError(
    () => manager.create(project('gamma'), 80, 24, 'total_over_limit'),
    'limit_reached'
  )

  host.resolveAllCreates()
  await Promise.all([...alphaCreates, ...betaCreates])
  assert.equal(host.createCalls.length, 8)
  await manager.dispose()
})

test('reuses the lowest free title number after close', async () => {
  const { host, manager } = harness()
  const first = await manager.create(project('alpha'), 80, 24, 'title_request_1')
  const second = await manager.create(project('alpha'), 80, 24, 'title_request_2')
  const third = await manager.create(project('alpha'), 80, 24, 'title_request_3')
  assert.deepEqual(
    [first.title, second.title, third.title],
    ['Terminal 1', 'Terminal 2', 'Terminal 3']
  )

  await manager.close(second.terminalId)
  const replacement = await manager.create(project('alpha'), 80, 24, 'title_request_4')
  assert.equal(replacement.title, 'Terminal 2')
  assert.deepEqual(host.closeCalls, [{ terminalId: second.terminalId, mode: 'user' }])
  await manager.dispose()
})

test('maps started, exit, and failed host events to snapshots and state events', async () => {
  const { host, manager, events } = harness()
  host.deferCreates = true
  const firstCreate = manager.create(project('alpha'), 80, 24, 'states_1')
  await waitFor(() => host.createCalls.length === 1)
  const firstId = host.createCalls[0].terminalId

  host.emit({ type: 'started', terminalId: firstId, pid: 4_321 })
  assert.deepEqual(events.at(-1), assertStateEvent(firstId, 'open'))
  host.resolveCreate(firstId)
  await firstCreate

  host.emit({
    type: 'exit',
    terminalId: firstId,
    exitCode: 7,
    cancelled: false,
    timedOut: false
  })
  const exitEvent = events.at(-1)
  assert.equal(exitEvent?.type, 'state')
  if (exitEvent?.type === 'state') {
    assert.equal(exitEvent.snapshot.state, 'exited')
    assert.equal(exitEvent.snapshot.exitCode, 7)
  }

  const secondCreate = manager.create(project('alpha'), 80, 24, 'states_2')
  await waitFor(() => host.createCalls.length === 2)
  const secondId = host.createCalls[1].terminalId
  host.resolveCreate(secondId)
  await secondCreate
  host.emit({ type: 'failed', terminalId: secondId, message: 'raw-worker-detail' })

  const snapshots = await manager.list(project('alpha'))
  assert.equal(snapshots.find((snapshot) => snapshot.terminalId === firstId)?.state, 'exited')
  assert.deepEqual(
    snapshots.find((snapshot) => snapshot.terminalId === secondId),
    {
      ...(snapshots.find((snapshot) => snapshot.terminalId === secondId) ?? {}),
      state: 'failed',
      message: 'Terminal process failed'
    }
  )
  assert.equal(events.at(-1)?.type, 'state')
  await manager.dispose()
})

function assertStateEvent(
  terminalId: string,
  state: 'starting' | 'open' | 'closing' | 'exited' | 'failed'
): TerminalEvent {
  return {
    type: 'state',
    snapshot: {
      terminalId,
      workspaceKey: 'project:alpha',
      title: 'Terminal 1',
      host: 'local',
      initialCwd: '/workspaces/alpha',
      shell: '/bin/zsh',
      state,
      createdAt: '2026-10-03T10:30:00.000Z',
      cols: 80,
      rows: 24
    }
  }
}

test('coalesces in-flight resizes and always sends the final size', async () => {
  const { host, manager } = harness()
  const snapshot = await manager.create(project('alpha'), 80, 24, 'resize_create')
  host.deferResizes = true

  const first = manager.resize(snapshot.terminalId, 90, 30)
  await waitFor(() => host.resizeCalls.length === 1)
  const middle = manager.resize(snapshot.terminalId, 100, 40)
  const final = manager.resize(snapshot.terminalId, 120, 50)
  assert.deepEqual(host.resizeCalls, [{ terminalId: snapshot.terminalId, cols: 90, rows: 30 }])

  host.resizeGates[0].resolve()
  await waitFor(() => host.resizeCalls.length === 2)
  assert.deepEqual(host.resizeCalls[1], {
    terminalId: snapshot.terminalId,
    cols: 120,
    rows: 50
  })
  host.resizeGates[1].resolve()
  await Promise.all([first, middle, final])

  const [resized] = await manager.list(project('alpha'))
  assert.deepEqual({ cols: resized.cols, rows: resized.rows }, { cols: 120, rows: 50 })
  await manager.dispose()
})

test('attaches through replay pages, deduplicates the live boundary, then restores credit', async () => {
  const { host, manager, events } = harness()
  const snapshot = await manager.create(project('alpha'), 80, 24, 'attach_create')
  events.length = 0
  const secondPage = new Deferred<TerminalReplayResult>()
  host.replayHandler = async (_terminalId, fromSeq) => {
    if (fromSeq === 1) {
      return {
        records: [
          { seq: 1, data: 'one' },
          { seq: 2, data: 'two' }
        ],
        nextSeq: 3,
        more: true
      }
    }
    assert.equal(fromSeq, 3)
    return secondPage.promise
  }
  host.setCreditHandler = (terminalId, bytes) => {
    if (bytes !== TERMINAL_CREDIT_WINDOW_BYTES) return
    host.emit({ type: 'data', terminalId, seq: 1, data: 'one' })
    host.emit({ type: 'data', terminalId, seq: 2, data: 'two' })
    host.emit({ type: 'data', terminalId, seq: 3, data: 'three-replay' })
  }

  const attaching = manager.attach(snapshot.terminalId)
  await waitFor(() => host.replayCalls.length === 2)
  assert.deepEqual(host.setCreditCalls, [{ terminalId: snapshot.terminalId, bytes: 0 }])
  host.emit({ type: 'data', terminalId: snapshot.terminalId, seq: 3, data: 'three-duplicate' })
  host.emit({ type: 'data', terminalId: snapshot.terminalId, seq: 4, data: 'four-live' })
  secondPage.resolve({
    records: [{ seq: 3, data: 'three-replay' }],
    nextSeq: 4,
    more: false
  })

  const attached = await attaching
  assert.deepEqual(host.replayCalls, [
    { terminalId: snapshot.terminalId, fromSeq: 1 },
    { terminalId: snapshot.terminalId, fromSeq: 3 }
  ])
  assert.deepEqual(attached.records, [
    { seq: 1, data: 'one' },
    { seq: 2, data: 'two' },
    { seq: 3, data: 'three-replay' }
  ])
  assert.equal(attached.nextSeq, 4)
  assert.deepEqual(events, [
    {
      type: 'data',
      terminalId: snapshot.terminalId,
      epoch: attached.epoch,
      seq: 4,
      data: 'four-live'
    }
  ])
  assert.deepEqual(host.setCreditCalls, [
    { terminalId: snapshot.terminalId, bytes: 0 },
    { terminalId: snapshot.terminalId, bytes: TERMINAL_CREDIT_WINDOW_BYTES }
  ])
  assert.deepEqual(host.creditCalls, [{ terminalId: snapshot.terminalId, bytes: 18 }])
  await manager.dispose()
})

test('trims replayed UTF-8 bytes from a live gap that overlaps the attach boundary', async () => {
  const { host, manager, events } = harness()
  const snapshot = await manager.create(project('alpha'), 80, 24, 'attach_gap_create')
  events.length = 0
  const replay = new Deferred<TerminalReplayResult>()
  host.replayHandler = async () => replay.promise

  const attaching = manager.attach(snapshot.terminalId)
  await waitFor(() => host.replayCalls.length === 1)
  host.emit({
    type: 'gap',
    terminalId: snapshot.terminalId,
    fromSeq: 1,
    toSeq: 3,
    droppedBytes: 10
  })
  replay.resolve({
    records: [
      { seq: 1, data: 'one' },
      { seq: 2, data: 'é' }
    ],
    nextSeq: 3,
    more: false
  })

  const attached = await attaching
  assert.deepEqual(events, [
    {
      type: 'gap',
      terminalId: snapshot.terminalId,
      epoch: attached.epoch,
      fromSeq: 3,
      toSeq: 3,
      droppedBytes: 5
    }
  ])
  await manager.dispose()
})

test('reattach replaces the epoch; stale ACK is ignored and over-ACK is invalid', async () => {
  const { host, manager, events } = harness()
  const snapshot = await manager.create(project('alpha'), 80, 24, 'ack_create')
  host.replayHandler = async () => ({
    records: [{ seq: 1, data: 'é' }],
    nextSeq: 2,
    more: false
  })

  const first = await manager.attach(snapshot.terminalId)
  const second = await manager.attach(snapshot.terminalId)
  assert.ok(second.epoch > first.epoch)

  await manager.ack(snapshot.terminalId, first.epoch, 2)
  assert.deepEqual(host.creditCalls, [])
  await terminalError(() => manager.ack(snapshot.terminalId, second.epoch, 3), 'invalid')
  assert.deepEqual(host.creditCalls, [])
  await manager.ack(snapshot.terminalId, second.epoch, 2)
  assert.deepEqual(host.creditCalls, [{ terminalId: snapshot.terminalId, bytes: 2 }])

  events.length = 0
  host.emit({ type: 'data', terminalId: snapshot.terminalId, seq: 2, data: 'live' })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'data')
  if (events[0].type === 'data') assert.equal(events[0].epoch, second.epoch)
  await manager.dispose()
})

test('closeWorkspace closes only terminals owned by that workspace', async () => {
  const { host, manager } = harness()
  const alphaOne = await manager.create(project('alpha'), 80, 24, 'close_alpha_1')
  const alphaTwo = await manager.create(project('alpha'), 80, 24, 'close_alpha_2')
  const beta = await manager.create(project('beta'), 80, 24, 'close_beta_1')

  await manager.closeWorkspace('project:alpha')
  assert.deepEqual(
    host.closeCalls.map((call) => call.terminalId).sort(),
    [alphaOne.terminalId, alphaTwo.terminalId].sort()
  )
  assert.equal(
    host.closeCalls.every((call) => call.mode === 'user'),
    true
  )
  assert.deepEqual(await manager.list(project('alpha')), [])
  assert.deepEqual(
    (await manager.list(project('beta'))).map((item) => item.terminalId),
    [beta.terminalId]
  )
  await manager.dispose()
})

test('dispose is bounded and rejects every later manager operation', async () => {
  const { host, manager } = harness()
  host.disposeGate = new Deferred<void>()
  const startedAt = Date.now()
  let watchdog: NodeJS.Timeout | undefined
  await Promise.race([
    manager.dispose(),
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('manager dispose exceeded 2 seconds')), 2_000)
    })
  ])
  if (watchdog) clearTimeout(watchdog)
  assert.ok(Date.now() - startedAt <= 1_500)
  assert.equal(host.disposeCalls, 1)

  const calls: Array<() => unknown | Promise<unknown>> = [
    () => manager.list(project('alpha')),
    () => manager.create(project('alpha'), 80, 24, 'after_dispose'),
    () => manager.input('missing', 'input'),
    () => manager.resize('missing', 80, 24),
    () => manager.attach('missing'),
    () => manager.ack('missing', 1, 1),
    () => manager.close('missing'),
    () => manager.closeWorkspace('project:alpha')
  ]
  for (const call of calls) await terminalError(call, 'unavailable')
})

test('sanitizes host errors so terminal input and output are absent from thrown messages', async () => {
  const { host, manager } = harness()
  const snapshot = await manager.create(project('alpha'), 80, 24, 'sensitive_create')
  const sensitiveInput = 'INPUT-SECRET-4b90f7'
  const sensitiveOutput = 'OUTPUT-SECRET-c3a182'
  host.inputFailure = (_terminalId, data) => new Error(`write rejected: ${data}`)
  host.replayHandler = async () => {
    throw new Error(`replay rejected after: ${sensitiveOutput}`)
  }

  const inputError = await terminalError(
    () => manager.input(snapshot.terminalId, sensitiveInput),
    'unavailable'
  )
  const outputError = await terminalError(() => manager.attach(snapshot.terminalId), 'unavailable')
  assert.equal(inputError.message.includes(sensitiveInput), false)
  assert.equal(outputError.message.includes(sensitiveOutput), false)
  await manager.dispose()
})

test('maps missing Bun to the packaged-app runtime error shown by the UI', async () => {
  const { host, manager } = harness()
  host.createTerminal = () => Promise.reject(new BunExecutableNotFoundError())

  const error = await terminalError(
    () => manager.create(project('alpha'), 80, 24, 'missing_bun_create'),
    'unavailable'
  )
  assert.equal(error.message, '未找到 Bun 运行时')
  const [failedSnapshot] = await manager.list(project('alpha'))
  assert.equal(failedSnapshot.state, 'failed')
  assert.equal(failedSnapshot.message, '未找到 Bun 运行时')
  await manager.dispose()
})
