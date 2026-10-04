import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  TerminalAttachResult,
  TerminalEvent,
  TerminalRendererBridge,
  TerminalResult,
  TerminalSnapshot,
  TerminalWorkspaceRef
} from '../src/shared/terminalTypes'
import {
  createTerminalController,
  disposeTerminalController,
  getTerminalController,
  type TerminalController,
  type TerminalControllerDependencies,
  type XtermFitAddonLike,
  type XtermTerminalLike
} from '../src/renderer/src/features/terminal/lib/terminalController'

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }
}

class FakeTextarea {
  readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: 'paste', listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: 'paste', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }
}

class FakeTerminal implements XtermTerminalLike {
  static instances: FakeTerminal[] = []

  readonly textarea = new FakeTextarea()
  readonly modes = { bracketedPasteMode: false }
  readonly writes: Array<{ data: string; callback?: () => void }> = []
  readonly screen: string[] = []
  readonly dataListeners = new Set<(data: string) => void>()
  cols: number
  rows: number
  private terminalOptions: XtermTerminalLike['options']
  openCalls = 0
  resetCalls = 0
  disposeCalls = 0
  clearCalls = 0
  focusCalls = 0
  autoCompleteWrites = true
  keyHandler?: (event: KeyboardEvent) => boolean
  selection = ''

  constructor(options: XtermTerminalLike['options'] & { cols?: number; rows?: number } = {}) {
    this.terminalOptions = options
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    FakeTerminal.instances.push(this)
  }

  get options(): XtermTerminalLike['options'] {
    return this.terminalOptions
  }

  set options(options: XtermTerminalLike['options']) {
    if ('cols' in options || 'rows' in options) {
      throw new TypeError('constructor-only xterm options cannot be assigned after construction')
    }
    this.terminalOptions = options
  }

  loadAddon(): void {
    return undefined
  }

  open(): void {
    this.openCalls += 1
  }

  write(data: string, callback?: () => void): void {
    this.writes.push({ data, callback })
    this.screen.push(data)
    if (this.autoCompleteWrites) {
      this.writes.at(-1)!.callback = undefined
      callback?.()
    }
  }

  completeWrites(): void {
    for (const write of this.writes) {
      const callback = write.callback
      write.callback = undefined
      callback?.()
    }
  }

  reset(): void {
    this.resetCalls += 1
    this.screen.splice(0)
  }

  clear(): void {
    this.clearCalls += 1
  }

  focus(): void {
    this.focusCalls += 1
  }

  dispose(): void {
    this.disposeCalls += 1
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler
  }

  hasSelection(): boolean {
    return this.selection.length > 0
  }

  getSelection(): string {
    return this.selection
  }
}

class FakeFitAddon implements XtermFitAddonLike {
  fitCalls = 0
  disposeCalls = 0

  fit(): void {
    this.fitCalls += 1
  }

  dispose(): void {
    this.disposeCalls += 1
  }
}

class FakeScheduler {
  private nextId = 0
  private readonly callbacks = new Map<number, () => void>()

  setTimer = (callback: () => void): ReturnType<typeof setTimeout> => {
    const id = ++this.nextId
    this.callbacks.set(id, callback)
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.callbacks.delete(timer as unknown as number)
  }

  flush(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }
}

const ok = <T>(value: T): TerminalResult<T> => ({ ok: true, value })

const project = (projectId: string): TerminalWorkspaceRef => ({ kind: 'project', projectId })

const snapshot = (
  terminalId: string,
  workspaceKey = 'project:alpha',
  overrides: Partial<TerminalSnapshot> = {}
): TerminalSnapshot => ({
  terminalId,
  workspaceKey,
  title: 'Terminal 1',
  host: 'local',
  initialCwd: '/work/alpha',
  shell: '/bin/zsh',
  state: 'open',
  createdAt: '2026-10-04T00:00:00.000Z',
  cols: 80,
  rows: 24,
  ...overrides
})

const attachment = (
  terminal: TerminalSnapshot,
  epoch: number,
  records: TerminalAttachResult['records'] = []
): TerminalAttachResult => ({
  epoch,
  snapshot: terminal,
  records,
  nextSeq: (records.at(-1)?.seq ?? 0) + 1
})

class FakeBridge implements TerminalRendererBridge {
  readonly listCalls: TerminalWorkspaceRef[] = []
  readonly createCalls: Parameters<TerminalRendererBridge['create']>[0][] = []
  readonly attachCalls: string[] = []
  readonly inputCalls: Array<{ terminalId: string; data: string }> = []
  readonly resizeCalls: Array<{ terminalId: string; cols: number; rows: number }> = []
  readonly ackCalls: Array<{ terminalId: string; epoch: number; bytes: number }> = []
  readonly closeCalls: string[] = []
  listResults = new Map<string, TerminalSnapshot[]>()
  attachResults = new Map<string, TerminalAttachResult[]>()
  createHandler?: (
    input: Parameters<TerminalRendererBridge['create']>[0]
  ) => Promise<TerminalResult<TerminalSnapshot>>
  attachHandler?: (terminalId: string) => Promise<TerminalResult<TerminalAttachResult>>
  inputHandler?: (terminalId: string, data: string) => Promise<TerminalResult<void>>
  listener: ((event: TerminalEvent) => void) | null = null
  unsubscribeCalls = 0
  nextTerminal = 0

  async list(ref: TerminalWorkspaceRef): Promise<TerminalResult<TerminalSnapshot[]>> {
    this.listCalls.push(ref)
    return ok(this.listResults.get(ref.kind === 'project' ? ref.projectId : 'ordinary') ?? [])
  }

  create(
    input: Parameters<TerminalRendererBridge['create']>[0]
  ): Promise<TerminalResult<TerminalSnapshot>> {
    this.createCalls.push(input)
    if (this.createHandler) return this.createHandler(input)
    const name = input.workspace.kind === 'project' ? input.workspace.projectId : 'ordinary'
    const created = snapshot(`created-${++this.nextTerminal}`, `project:${name}`, {
      initialCwd: `/work/${name}`
    })
    this.attachResults.set(created.terminalId, [attachment(created, 1)])
    return Promise.resolve(ok(created))
  }

  attach(terminalId: string): Promise<TerminalResult<TerminalAttachResult>> {
    this.attachCalls.push(terminalId)
    if (this.attachHandler) return this.attachHandler(terminalId)
    const results = this.attachResults.get(terminalId) ?? []
    const result = results.shift()
    assert.ok(result, `missing attach result for ${terminalId}`)
    return Promise.resolve(ok(result))
  }

  input(terminalId: string, data: string): Promise<TerminalResult<void>> {
    this.inputCalls.push({ terminalId, data })
    if (this.inputHandler) return this.inputHandler(terminalId, data)
    return Promise.resolve(ok(undefined))
  }

  resize(terminalId: string, cols: number, rows: number): Promise<TerminalResult<void>> {
    this.resizeCalls.push({ terminalId, cols, rows })
    return Promise.resolve(ok(undefined))
  }

  ack(terminalId: string, epoch: number, bytes: number): Promise<TerminalResult<void>> {
    this.ackCalls.push({ terminalId, epoch, bytes })
    return Promise.resolve(ok(undefined))
  }

  close(terminalId: string): Promise<TerminalResult<void>> {
    this.closeCalls.push(terminalId)
    return Promise.resolve(ok(undefined))
  }

  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.listener = listener
    return () => {
      this.unsubscribeCalls += 1
      if (this.listener === listener) this.listener = null
    }
  }

  emit(event: TerminalEvent): void {
    this.listener?.(event)
  }
}

function harness(bridge = new FakeBridge()): {
  bridge: FakeBridge
  controller: TerminalController
  scheduler: FakeScheduler
} {
  FakeTerminal.instances = []
  const scheduler = new FakeScheduler()
  let request = 0
  const dependencies: Partial<TerminalControllerDependencies> = {
    Terminal: FakeTerminal,
    FitAddon: FakeFitAddon,
    createHost: () => ({}) as HTMLElement,
    createRequestId: () => `request_${++request}`,
    writeClipboard: async () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  }
  return {
    bridge,
    scheduler,
    controller: createTerminalController({ bridge, dependencies })
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('waitFor timed out')
}

test('attach resets, replays, then applies matching live output and ACKs hidden terminals', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  const gate = new Deferred<TerminalResult<TerminalAttachResult>>()
  bridge.attachHandler = () => gate.promise
  const { controller, scheduler } = harness(bridge)

  const ensure = controller.ensureWorkspace(project('alpha'))
  await waitFor(() => bridge.attachCalls.length === 1)
  bridge.emit({ type: 'data', terminalId: existing.terminalId, epoch: 7, seq: 2, data: 'live' })
  gate.resolve(ok(attachment(existing, 7, [{ seq: 1, data: 'replay-' }])))
  await ensure

  const terminal = FakeTerminal.instances[0]
  assert.equal(terminal.openCalls, 1)
  assert.equal(terminal.resetCalls, 1)
  assert.deepEqual(terminal.screen, ['replay-', 'live'])
  scheduler.flush()
  assert.deepEqual(bridge.ackCalls, [{ terminalId: existing.terminalId, epoch: 7, bytes: 11 }])

  // No panel host is mounted, but output continues to drain and receive credit.
  bridge.emit({ type: 'data', terminalId: existing.terminalId, epoch: 7, seq: 3, data: '隐藏' })
  scheduler.flush()
  assert.deepEqual(bridge.ackCalls.at(-1), {
    terminalId: existing.terminalId,
    epoch: 7,
    bytes: 6
  })
  controller.dispose()
})

test('re-attach resets the screen and late write callbacks keep their original epoch', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [
    attachment(existing, 1, [{ seq: 1, data: 'old' }]),
    attachment(existing, 2, [{ seq: 1, data: 'new' }])
  ])
  const { controller, scheduler } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  const terminal = FakeTerminal.instances[0]
  terminal.autoCompleteWrites = false

  bridge.emit({ type: 'data', terminalId: existing.terminalId, epoch: 1, seq: 2, data: 'late' })
  await controller.attach(existing.terminalId)
  assert.equal(terminal.resetCalls, 2)
  assert.deepEqual(terminal.screen, ['new'])

  terminal.completeWrites()
  scheduler.flush()
  assert.deepEqual(bridge.ackCalls, [
    { terminalId: existing.terminalId, epoch: 1, bytes: 7 },
    { terminalId: existing.terminalId, epoch: 2, bytes: 3 }
  ])
  assert.equal(
    bridge.ackCalls.some((call) => call.epoch === 2 && call.bytes > 3),
    false
  )
  controller.dispose()
})

test('writes the dim retention notice for attach and live gaps', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [
    {
      ...attachment(existing, 4),
      gap: { fromSeq: 1, toSeq: 3, droppedBytes: 100 }
    }
  ])
  const { controller } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  bridge.emit({
    type: 'gap',
    terminalId: existing.terminalId,
    epoch: 4,
    fromSeq: 4,
    toSeq: 5,
    droppedBytes: 50
  })
  const screen = FakeTerminal.instances[0].screen.join('')
  assert.equal(screen.match(/部分输出已超出保留范围/gu)?.length, 2)
  assert.equal(screen.includes('\u001b[2m部分输出已超出保留范围\u001b[0m'), true)
  controller.dispose()
})

test('StrictMode-style double ensure creates once and creation is isolated per workspace', async () => {
  const bridge = new FakeBridge()
  const createGate = new Deferred<TerminalResult<TerminalSnapshot>>()
  bridge.createHandler = (input) => {
    if (input.workspace.kind === 'project' && input.workspace.projectId === 'alpha') {
      return createGate.promise
    }
    const beta = snapshot('terminal-beta', 'project:beta', { initialCwd: '/work/beta' })
    bridge.attachResults.set(beta.terminalId, [attachment(beta, 1)])
    return Promise.resolve(ok(beta))
  }
  const { controller } = harness(bridge)
  const first = controller.ensureWorkspace(project('alpha'))
  const second = controller.ensureWorkspace(project('alpha'))
  await waitFor(() => bridge.createCalls.length === 1)
  assert.equal(bridge.createCalls.length, 1)

  const alpha = snapshot('terminal-alpha')
  bridge.attachResults.set(alpha.terminalId, [attachment(alpha, 1)])
  createGate.resolve(ok(alpha))
  await Promise.all([first, second])
  await controller.ensureWorkspace(project('beta'))
  assert.equal(bridge.createCalls.length, 2)
  assert.deepEqual(
    bridge.createCalls.map((call) =>
      call.workspace.kind === 'project' ? call.workspace.projectId : 'ordinary'
    ),
    ['alpha', 'beta']
  )
  controller.dispose()
})

test('renderer startup restoration reattaches existing terminals without creating a shell', async () => {
  const bridge = new FakeBridge()
  const firstHarness = harness(bridge)
  const firstSnapshot = await firstHarness.controller.ensureWorkspace(project('alpha'))
  const existing = firstSnapshot.terminals[0]
  assert.ok(existing)
  firstHarness.controller.dispose()

  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [attachment(existing, 3)])
  const { controller } = harness(bridge)

  await controller.restoreWorkspace(project('alpha'))
  await controller.ensureWorkspace(project('alpha'))

  assert.deepEqual(bridge.listCalls, [project('alpha'), project('alpha')])
  assert.deepEqual(bridge.attachCalls, [existing.terminalId, existing.terminalId])
  assert.equal(bridge.createCalls.length, 1)
  assert.deepEqual(controller.getWorkspaceSnapshot(project('alpha')).terminals, [existing])
  controller.dispose()
})

test('hidden controller drains 10k events and never ACKs more than xterm accepted', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [attachment(existing, 11)])
  const { controller, scheduler } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))

  let deliveredBytes = 0
  for (let index = 1; index <= 10_000; index += 1) {
    const data = index % 2 === 0 ? '隐藏' : 'x'
    deliveredBytes += Buffer.byteLength(data, 'utf8')
    bridge.emit({ type: 'data', terminalId: existing.terminalId, epoch: 11, seq: index, data })
    assert.ok(
      bridge.ackCalls.reduce((total, call) => total + call.bytes, 0) <= deliveredBytes,
      `ACK credit exceeded delivered bytes after event ${index}`
    )
  }
  scheduler.flush()

  assert.equal(FakeTerminal.instances[0].writes.length, 10_000)
  assert.equal(
    bridge.ackCalls.reduce((total, call) => total + call.bytes, 0),
    deliveredBytes
  )
  controller.dispose()
})

test('theme updates avoid reassigning constructor-only xterm options', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [attachment(existing, 1)])
  const { controller } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  const terminal = FakeTerminal.instances[0]
  const view = controller.getTerminalView(existing.terminalId)
  assert.ok(view)

  assert.throws(() => {
    terminal.options = { ...terminal.options, theme: { background: '#ffffff' } }
  }, /constructor-only xterm options/u)
  assert.doesNotThrow(() => view.setTheme({ background: '#123456' }))
  assert.deepEqual(terminal.options.theme, { background: '#123456' })
  controller.dispose()
})

test('first visible ensure creates once after an empty startup restoration', async () => {
  const bridge = new FakeBridge()
  const { controller } = harness(bridge)

  const restore = controller.restoreWorkspace(project('alpha'))
  const firstEnsure = controller.ensureWorkspace(project('alpha'))
  const secondEnsure = controller.ensureWorkspace(project('alpha'))
  await Promise.all([restore, firstEnsure, secondEnsure])

  assert.equal(bridge.createCalls.length, 1)
  assert.equal(bridge.attachCalls.length, 1)
  controller.dispose()
})

test('switching workspaces leaves earlier terminals attached and acknowledging output', async () => {
  const bridge = new FakeBridge()
  const alpha = snapshot('terminal-alpha')
  const beta = snapshot('terminal-beta', 'project:beta', { initialCwd: '/work/beta' })
  bridge.listResults.set('alpha', [alpha])
  bridge.listResults.set('beta', [beta])
  bridge.attachResults.set(alpha.terminalId, [attachment(alpha, 1)])
  bridge.attachResults.set(beta.terminalId, [attachment(beta, 2)])
  const { controller, scheduler } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  await controller.ensureWorkspace(project('beta'))

  bridge.emit({ type: 'data', terminalId: alpha.terminalId, epoch: 1, seq: 1, data: 'alpha' })
  bridge.emit({ type: 'data', terminalId: beta.terminalId, epoch: 2, seq: 1, data: 'beta' })
  scheduler.flush()
  assert.deepEqual(bridge.ackCalls, [
    { terminalId: alpha.terminalId, epoch: 1, bytes: 5 },
    { terminalId: beta.terminalId, epoch: 2, bytes: 4 }
  ])
  controller.dispose()
})

test('serializes xterm input, confirms bracketed paste once, and disposes subscriptions', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [attachment(existing, 1)])
  const { controller } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  const terminal = FakeTerminal.instances[0]
  const view = controller.getTerminalView(existing.terminalId)
  assert.ok(view)

  terminal.emitData('a')
  terminal.emitData('b')
  terminal.modes.bracketedPasteMode = true
  const pasteResult = await controller.submitPaste(existing.terminalId, 'one\ntwo')
  assert.equal(pasteResult.ok, true)
  assert.equal(view.isCurrentLineDirty(), true)

  const newlineEndingPasteResult = await controller.submitPaste(existing.terminalId, 'reset\r\n')
  assert.equal(newlineEndingPasteResult.ok, true)
  assert.equal(view.isCurrentLineDirty(), false)
  assert.deepEqual(bridge.inputCalls, [
    { terminalId: existing.terminalId, data: 'a' },
    { terminalId: existing.terminalId, data: 'b' },
    { terminalId: existing.terminalId, data: '\u001b[200~one\ntwo\u001b[201~' },
    { terminalId: existing.terminalId, data: '\u001b[200~reset\r\n\u001b[201~' }
  ])

  controller.dispose()
  controller.dispose()
  assert.equal(bridge.unsubscribeCalls, 1)
  assert.equal(terminal.disposeCalls, 1)
  bridge.emit({ type: 'data', terminalId: existing.terminalId, epoch: 1, seq: 2, data: 'ignored' })
  assert.equal(terminal.screen.includes('ignored'), false)
})

test('pending newline paste cannot erase later printable keyboard state', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  const pasteGate = new Deferred<TerminalResult<void>>()
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [attachment(existing, 1)])
  bridge.inputHandler = (_terminalId, data) =>
    data === 'reset\n' ? pasteGate.promise : Promise.resolve(ok(undefined))
  const { controller } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  const terminal = FakeTerminal.instances[0]
  const view = controller.getTerminalView(existing.terminalId)
  assert.ok(view)

  const paste = controller.submitPaste(existing.terminalId, 'reset\n')
  await waitFor(() => bridge.inputCalls.length === 1)
  terminal.emitData('partial')
  assert.equal(view.isCurrentLineDirty(), true)
  assert.equal(bridge.inputCalls.length, 1)

  pasteGate.resolve(ok(undefined))
  assert.equal((await paste).ok, true)
  await waitFor(() => bridge.inputCalls.length === 2)

  assert.equal(view.isCurrentLineDirty(), true)
  assert.deepEqual(bridge.inputCalls, [
    { terminalId: existing.terminalId, data: 'reset\n' },
    { terminalId: existing.terminalId, data: 'partial' }
  ])
  controller.dispose()
})

test('multi-line paste blocks xterm same-target forwarding until confirmation', async () => {
  const bridge = new FakeBridge()
  const existing = snapshot('terminal-alpha')
  bridge.listResults.set('alpha', [existing])
  bridge.attachResults.set(existing.terminalId, [attachment(existing, 1)])
  const { controller } = harness(bridge)
  await controller.ensureWorkspace(project('alpha'))
  const terminal = FakeTerminal.instances[0]
  const view = controller.getTerminalView(existing.terminalId)
  assert.ok(view)

  let preview = ''
  view.setPasteHandler((text) => {
    preview = text
  })
  const pasteListener = [...(terminal.textarea.listeners.get('paste') ?? [])][0]
  assert.ok(pasteListener)
  let stoppedImmediately = false
  pasteListener({
    clipboardData: { getData: () => 'echo one\necho two' },
    preventDefault: () => undefined,
    stopImmediatePropagation: () => {
      stoppedImmediately = true
    }
  } as unknown as ClipboardEvent)
  // Model xterm's listener on the same textarea: it must not run once our
  // capture listener has stopped the event immediately.
  if (!stoppedImmediately) terminal.emitData('echo one\necho two')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stoppedImmediately, true)
  assert.equal(preview, 'echo one\necho two')
  assert.deepEqual(bridge.inputCalls, [])
  controller.dispose()
})

test('module singleton survives consumers and explicitly disposes before resubscribe', () => {
  const firstBridge = new FakeBridge()
  const first = getTerminalController(firstBridge)
  assert.equal(getTerminalController(firstBridge), first)
  assert.ok(firstBridge.listener)

  disposeTerminalController()
  assert.equal(firstBridge.unsubscribeCalls, 1)
  assert.equal(firstBridge.listener, null)

  const secondBridge = new FakeBridge()
  const second = getTerminalController(secondBridge)
  assert.notEqual(second, first)
  assert.ok(secondBridge.listener)
  disposeTerminalController()
  assert.equal(secondBridge.unsubscribeCalls, 1)
})
