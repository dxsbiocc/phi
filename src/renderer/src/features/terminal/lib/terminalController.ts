import {
  type TerminalErrorCode,
  type TerminalEvent,
  type TerminalRendererBridge,
  type TerminalResult,
  type TerminalSnapshot,
  type TerminalWorkspaceRef
} from '../../../../../shared/terminalTypes'
import { TerminalAckBatcher } from './terminalAckBatcher'
import type {
  TerminalRecord,
  TerminalController,
  TerminalControllerDependencies,
  TerminalControllerError,
  TerminalSize,
  TerminalView,
  TerminalWorkspaceSnapshot,
  WorkspaceRecord
} from './terminalControllerTypes'
import {
  EMPTY_TERMINAL_LINE_INPUT,
  isTerminalLineDirty,
  updateTerminalLineInput
} from './terminalDraft'
import {
  isTerminalInputWithinLimit,
  terminalInputByteLength,
  wrapBracketedPaste
} from './terminalInput'
import { bindTerminalInput, defaultTerminalControllerDependencies } from './terminalRuntime'
import { createTerminalTheme, TERMINAL_FONT_FAMILY } from './terminalTheme'

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 }
const GAP_NOTICE = '\r\n\u001b[2m部分输出已超出保留范围\u001b[0m\r\n'
const INPUT_TOO_LARGE_MESSAGE = '输入超过 64 KiB 限制'

function workspaceClientKey(ref: TerminalWorkspaceRef): string {
  return ref.kind === 'project' ? `project:${ref.projectId}` : 'ordinary'
}

class RendererTerminalController implements TerminalController {
  private readonly bridge: TerminalRendererBridge
  private readonly dependencies: TerminalControllerDependencies
  private readonly listeners = new Set<() => void>()
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly orphanStates = new Map<string, TerminalSnapshot>()
  private readonly unsubscribeBridge: () => void
  private disposed = false

  constructor(bridge: TerminalRendererBridge, dependencies: TerminalControllerDependencies) {
    this.bridge = bridge
    this.dependencies = dependencies
    this.unsubscribeBridge = bridge.onEvent((event) => this.handleEvent(event))
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getWorkspaceSnapshot(ref: TerminalWorkspaceRef): TerminalWorkspaceSnapshot {
    return this.workspace(ref).snapshot
  }

  restoreWorkspace(ref: TerminalWorkspaceRef): Promise<TerminalWorkspaceSnapshot> {
    const workspace = this.workspace(ref)
    if (workspace.ensurePromise) return workspace.ensurePromise
    if (workspace.restorePromise) return workspace.restorePromise
    if (this.disposed || workspace.initialized) return Promise.resolve(workspace.snapshot)

    this.publish(workspace, { pending: true, error: null })
    workspace.restorePromise = this.loadWorkspace(workspace, DEFAULT_SIZE, false)
      .then((snapshot) => {
        if (snapshot.terminals.length > 0) workspace.initialized = true
        return snapshot
      })
      .finally(() => {
        workspace.restorePromise = undefined
        if (!this.disposed && !workspace.ensurePromise) this.publish(workspace, { pending: false })
      })
    return workspace.restorePromise
  }

  ensureWorkspace(
    ref: TerminalWorkspaceRef,
    initialSize: TerminalSize = DEFAULT_SIZE
  ): Promise<TerminalWorkspaceSnapshot> {
    const workspace = this.workspace(ref)
    if (workspace.ensurePromise) return workspace.ensurePromise
    if (this.disposed || workspace.initialized) return Promise.resolve(workspace.snapshot)

    this.publish(workspace, { pending: true, error: null })
    workspace.ensurePromise = (async () => {
      if (workspace.restorePromise) await workspace.restorePromise
      if (this.disposed || workspace.initialized) return workspace.snapshot
      workspace.initialized = true
      return this.loadWorkspace(workspace, initialSize, true)
    })().finally(() => {
      workspace.ensurePromise = undefined
      if (!this.disposed) this.publish(workspace, { pending: false })
    })
    return workspace.ensurePromise
  }

  create(
    ref: TerminalWorkspaceRef,
    initialSize: TerminalSize = DEFAULT_SIZE
  ): Promise<TerminalSnapshot | null> {
    const workspace = this.workspace(ref)
    if (this.disposed) return Promise.resolve(null)
    if (workspace.createPromise) return workspace.createPromise

    this.publish(workspace, { pending: true, error: null })
    workspace.createPromise = this.createForWorkspace(workspace, initialSize).finally(() => {
      workspace.createPromise = undefined
      if (!this.disposed && !workspace.ensurePromise) this.publish(workspace, { pending: false })
    })
    return workspace.createPromise
  }

  select(ref: TerminalWorkspaceRef, terminalId: string): void {
    const workspace = this.workspace(ref)
    if (!workspace.snapshot.terminals.some((item) => item.terminalId === terminalId)) return
    this.publish(workspace, { activeTerminalId: terminalId })
  }

  getTerminalView(terminalId: string): TerminalView | null {
    return this.terminals.get(terminalId)?.view ?? null
  }

  async attach(terminalId: string): Promise<boolean> {
    const record = this.terminals.get(terminalId)
    return record ? this.attachRecord(record) : false
  }

  async close(terminalId: string): Promise<boolean> {
    const record = this.terminals.get(terminalId)
    if (!record || this.disposed) return false
    const result = await this.safeBridgeCall(() => this.bridge.close(terminalId))
    if (!result.ok) {
      this.publishTerminalError(record, result)
      return false
    }
    this.removeTerminal(record)
    return true
  }

  async closeWorkspace(ref: TerminalWorkspaceRef): Promise<void> {
    const workspace = this.workspace(ref)
    const terminalIds = workspace.snapshot.terminals.map((item) => item.terminalId)
    await Promise.all(terminalIds.map((terminalId) => this.close(terminalId)))
  }

  async submitPaste(terminalId: string, text: string): Promise<TerminalResult<void>> {
    const record = this.terminals.get(terminalId)
    if (!record || record.disposed) {
      return { ok: false, code: 'not_found', message: 'Terminal was not found' }
    }
    record.pendingPaste = undefined
    const payload = wrapBracketedPaste(text, record.terminal.modes.bracketedPasteMode)
    const previousLineInputState = record.lineInputState
    const pasteLineInputState = updateTerminalLineInput(previousLineInputState, text)
    record.lineInputState = pasteLineInputState
    this.publishInteraction(record)
    const result = await this.enqueueInput(record, payload)
    if (!result.ok && !record.disposed) {
      // Roll back only while this paste is still the newest line transformation.
      // Otherwise preserve a dirty state so later keyboard input is never hidden.
      record.lineInputState =
        record.lineInputState === pasteLineInputState
          ? previousLineInputState
          : {
              printableCharacters: Math.max(1, record.lineInputState.printableCharacters)
            }
      this.publishInteraction(record)
    }
    return result
  }

  discardPaste(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (record) record.pendingPaste = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.unsubscribeBridge()
    } catch {
      // Preload may already be gone during renderer teardown.
    }
    for (const record of this.terminals.values()) this.disposeTerminalRecord(record)
    this.terminals.clear()
    this.workspaces.clear()
    this.orphanStates.clear()
    this.listeners.clear()
  }

  private workspace(ref: TerminalWorkspaceRef): WorkspaceRecord {
    const key = workspaceClientKey(ref)
    let record = this.workspaces.get(key)
    if (!record) {
      record = {
        ref: { ...ref },
        snapshot: {
          workspaceKey: key,
          terminals: [],
          activeTerminalId: null,
          pending: false,
          error: null
        },
        initialized: false
      }
      this.workspaces.set(key, record)
    }
    return record
  }

  private async loadWorkspace(
    workspace: WorkspaceRecord,
    initialSize: TerminalSize,
    createIfEmpty: boolean
  ): Promise<TerminalWorkspaceSnapshot> {
    const result = await this.safeBridgeCall(() => this.bridge.list(workspace.ref))
    if (!result.ok) {
      workspace.initialized = false
      this.publish(workspace, { error: this.controllerError(result) })
      return workspace.snapshot
    }

    const records = result.value.map((snapshot) => this.ensureTerminalRecord(workspace, snapshot))
    const existingActive = workspace.snapshot.activeTerminalId
    const activeTerminalId = records.some((record) => record.snapshot.terminalId === existingActive)
      ? existingActive
      : (records[0]?.snapshot.terminalId ?? null)
    this.publish(workspace, {
      terminals: records.map((record) => record.snapshot),
      activeTerminalId,
      error: null
    })

    if (records.length === 0 && createIfEmpty) {
      await this.create(workspace.ref, initialSize)
    } else {
      await Promise.all(records.map((record) => this.attachRecord(record)))
    }
    return workspace.snapshot
  }

  private async createForWorkspace(
    workspace: WorkspaceRecord,
    initialSize: TerminalSize
  ): Promise<TerminalSnapshot | null> {
    const result = await this.safeBridgeCall(() =>
      this.bridge.create({
        workspace: workspace.ref,
        cols: initialSize.cols,
        rows: initialSize.rows,
        requestId: this.dependencies.createRequestId()
      })
    )
    if (!result.ok) {
      this.publish(workspace, { error: this.controllerError(result) })
      return null
    }

    const record = this.ensureTerminalRecord(workspace, result.value)
    this.publish(workspace, {
      terminals: this.workspaceTerminals(workspace),
      activeTerminalId: record.snapshot.terminalId,
      error: null
    })
    await this.attachRecord(record)
    return record.snapshot
  }

  private ensureTerminalRecord(
    workspace: WorkspaceRecord,
    initialSnapshot: TerminalSnapshot
  ): TerminalRecord {
    const existing = this.terminals.get(initialSnapshot.terminalId)
    if (existing) return existing

    const terminal = new this.dependencies.Terminal({
      allowProposedApi: false,
      cols: initialSnapshot.cols,
      rows: initialSnapshot.rows,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: createTerminalTheme('dark')
    })
    const fitAddon = new this.dependencies.FitAddon()
    terminal.loadAddon(fitAddon)
    const host = this.dependencies.createHost()
    terminal.open(host)

    const orphanState = this.orphanStates.get(initialSnapshot.terminalId)
    const newestSnapshot = orphanState ?? initialSnapshot
    this.orphanStates.delete(initialSnapshot.terminalId)
    const placeholder = {} as TerminalRecord
    const record: TerminalRecord = Object.assign(placeholder, {
      snapshot: { ...newestSnapshot },
      workspaceClientKey: workspace.snapshot.workspaceKey,
      terminal,
      fitAddon,
      host,
      epoch: null,
      attaching: false,
      attachVersion: 0,
      stateVersion: orphanState ? 1 : 0,
      pendingEvents: [],
      ackBatcher: new TerminalAckBatcher({
        terminalId: newestSnapshot.terminalId,
        ack: (terminalId, epoch, bytes) => this.bridge.ack(terminalId, epoch, bytes),
        setTimer: this.dependencies.setTimer,
        clearTimer: this.dependencies.clearTimer
      }),
      inputChain: Promise.resolve(),
      lineInputState: EMPTY_TERMINAL_LINE_INPUT,
      interactionListeners: new Set<() => void>(),
      pasteHandler: null,
      disposed: false
    })
    record.inputDisposable = bindTerminalInput({
      terminal,
      writeClipboard: this.dependencies.writeClipboard,
      onData: (data) => {
        record.lineInputState = updateTerminalLineInput(record.lineInputState, data)
        this.publishInteraction(record)
        void this.enqueueInput(record, data)
      },
      onMultilinePaste: (text) => {
        record.pendingPaste = text
        record.pasteHandler?.(text)
      }
    })
    record.selectionDisposable = terminal.onSelectionChange?.(() => this.publishInteraction(record))
    record.view = this.createView(record)
    this.terminals.set(record.snapshot.terminalId, record)
    return record
  }

  private createView(record: TerminalRecord): TerminalView {
    return {
      host: record.host,
      terminal: record.terminal,
      fitAndResize: async () => {
        if (record.disposed || this.disposed) return
        try {
          record.fitAddon.fit()
        } catch {
          return
        }
        if (record.snapshot.state !== 'open') return
        const result = await this.safeBridgeCall(() =>
          this.bridge.resize(record.snapshot.terminalId, record.terminal.cols, record.terminal.rows)
        )
        if (result.ok) {
          record.snapshot = {
            ...record.snapshot,
            cols: record.terminal.cols,
            rows: record.terminal.rows
          }
          this.publishTerminalSnapshot(record)
        } else {
          this.publishTerminalError(record, result)
        }
      },
      focus: () => {
        if (!record.disposed) record.terminal.focus()
      },
      setTheme: (theme) => {
        // Only assign the theme: spreading all options would re-set constructor-only ones (cols/rows) and throw.
        if (!record.disposed) record.terminal.options.theme = { ...theme }
      },
      setPasteHandler: (handler) => {
        record.pasteHandler = handler
        if (handler && record.pendingPaste !== undefined) handler(record.pendingPaste)
      },
      getSelection: () => (record.disposed ? '' : record.terminal.getSelection()),
      isCurrentLineDirty: () => isTerminalLineDirty(record.lineInputState),
      markCurrentLineClean: () => {
        if (record.disposed) return
        record.lineInputState = EMPTY_TERMINAL_LINE_INPUT
        this.publishInteraction(record)
      },
      subscribeInteraction: (listener) => {
        if (record.disposed) return () => undefined
        record.interactionListeners.add(listener)
        return () => record.interactionListeners.delete(listener)
      }
    }
  }

  private enqueueInput(record: TerminalRecord, data: string): Promise<TerminalResult<void>> {
    if (!isTerminalInputWithinLimit(data)) {
      const result = {
        ok: false,
        code: 'invalid',
        message: INPUT_TOO_LARGE_MESSAGE
      } as const
      this.publishTerminalError(record, result)
      return Promise.resolve(result)
    }

    const task = record.inputChain.then(async (): Promise<TerminalResult<void>> => {
      if (record.disposed || record.snapshot.state !== 'open') {
        return { ok: false, code: 'not_open', message: 'Terminal is not open' }
      }
      const result = await this.safeBridgeCall(() =>
        this.bridge.input(record.snapshot.terminalId, data)
      )
      if (!result.ok && result.code !== 'not_open') this.publishTerminalError(record, result)
      return result
    })
    record.inputChain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private async attachRecord(record: TerminalRecord): Promise<boolean> {
    if (record.disposed || this.disposed) return false
    const attachVersion = ++record.attachVersion
    const stateVersion = record.stateVersion
    record.attaching = true
    record.pendingEvents = []
    const result = await this.safeBridgeCall(() => this.bridge.attach(record.snapshot.terminalId))
    if (record.disposed || this.disposed || attachVersion !== record.attachVersion) return false
    if (!result.ok) {
      record.attaching = false
      record.pendingEvents = []
      this.publishTerminalError(record, result)
      return false
    }

    record.epoch = result.value.epoch
    if (record.stateVersion === stateVersion) record.snapshot = { ...result.value.snapshot }
    record.terminal.reset()
    for (const replay of result.value.records) {
      this.writeOutput(record, result.value.epoch, replay.data)
    }
    if (result.value.gap) this.writeGapNotice(record)

    const pendingEvents = record.pendingEvents
    record.pendingEvents = []
    record.attaching = false
    for (const event of pendingEvents) this.applyOutputEvent(record, event)
    this.publishTerminalSnapshot(record)
    return true
  }

  private handleEvent(event: TerminalEvent): void {
    if (this.disposed) return
    if (event.type === 'state') {
      const record = this.terminals.get(event.snapshot.terminalId)
      if (!record) {
        this.orphanStates.set(event.snapshot.terminalId, { ...event.snapshot })
        return
      }
      record.snapshot = { ...event.snapshot }
      record.stateVersion += 1
      this.publishTerminalSnapshot(record)
      return
    }

    const record = this.terminals.get(event.terminalId)
    if (!record || record.disposed) return
    if (record.attaching) {
      record.pendingEvents.push(event)
      return
    }
    this.applyOutputEvent(record, event)
  }

  private applyOutputEvent(
    record: TerminalRecord,
    event: Extract<TerminalEvent, { type: 'data' | 'gap' }>
  ): void {
    if (event.epoch !== record.epoch) return
    if (event.type === 'gap') this.writeGapNotice(record)
    else this.writeOutput(record, event.epoch, event.data)
  }

  private writeOutput(record: TerminalRecord, epoch: number, data: string): void {
    const bytes = terminalInputByteLength(data)
    try {
      record.terminal.write(data, () => {
        if (!record.disposed && bytes > 0) record.ackBatcher.queue(epoch, bytes)
      })
    } catch {
      // Never acknowledge output that xterm did not accept.
    }
  }

  private writeGapNotice(record: TerminalRecord): void {
    try {
      record.terminal.write(GAP_NOTICE)
    } catch {
      // A rendering failure must not disrupt the bridge event subscription.
    }
  }

  private removeTerminal(record: TerminalRecord): void {
    this.terminals.delete(record.snapshot.terminalId)
    this.disposeTerminalRecord(record)
    const workspace = this.workspaces.get(record.workspaceClientKey)
    if (!workspace) return
    const terminals = this.workspaceTerminals(workspace)
    const activeTerminalId =
      workspace.snapshot.activeTerminalId === record.snapshot.terminalId
        ? (terminals[0]?.terminalId ?? null)
        : workspace.snapshot.activeTerminalId
    this.publish(workspace, { terminals, activeTerminalId, error: null })
  }

  private disposeTerminalRecord(record: TerminalRecord): void {
    if (record.disposed) return
    record.disposed = true
    record.attachVersion += 1
    record.ackBatcher.dispose()
    try {
      record.inputDisposable.dispose()
    } catch {
      // Continue releasing the xterm instance.
    }
    try {
      record.selectionDisposable?.dispose()
    } catch {
      // Continue releasing the xterm instance.
    }
    record.interactionListeners.clear()
    try {
      record.fitAddon.dispose?.()
    } catch {
      // Continue releasing the xterm instance.
    }
    try {
      record.terminal.dispose()
    } catch {
      // Renderer teardown is best effort.
    }
  }

  private publishTerminalSnapshot(record: TerminalRecord): void {
    const workspace = this.workspaces.get(record.workspaceClientKey)
    if (!workspace) return
    this.publish(workspace, { terminals: this.workspaceTerminals(workspace) })
  }

  private publishInteraction(record: TerminalRecord): void {
    if (record.disposed) return
    for (const listener of record.interactionListeners) listener()
  }

  private publishTerminalError(
    record: TerminalRecord,
    error: { code: TerminalErrorCode; message: string }
  ): void {
    const workspace = this.workspaces.get(record.workspaceClientKey)
    if (workspace) this.publish(workspace, { error: this.controllerError(error) })
  }

  private workspaceTerminals(workspace: WorkspaceRecord): TerminalSnapshot[] {
    return [...this.terminals.values()]
      .filter((record) => record.workspaceClientKey === workspace.snapshot.workspaceKey)
      .map((record) => record.snapshot)
  }

  private publish(
    workspace: WorkspaceRecord,
    patch: Partial<Omit<TerminalWorkspaceSnapshot, 'workspaceKey'>>
  ): void {
    if (this.disposed) return
    const next = { ...workspace.snapshot, ...patch }
    workspace.snapshot = { ...next, terminals: [...next.terminals] }
    for (const listener of this.listeners) listener()
  }

  private controllerError(error: {
    code: TerminalErrorCode
    message: string
  }): TerminalControllerError {
    return { code: error.code, message: error.message }
  }

  private async safeBridgeCall<T>(
    action: () => Promise<TerminalResult<T>>
  ): Promise<TerminalResult<T>> {
    try {
      return await action()
    } catch {
      return { ok: false, code: 'unavailable', message: 'Terminal is unavailable' }
    }
  }
}

export function createTerminalController(options: {
  bridge: TerminalRendererBridge
  dependencies?: Partial<TerminalControllerDependencies>
}): TerminalController {
  return new RendererTerminalController(options.bridge, {
    ...defaultTerminalControllerDependencies,
    ...options.dependencies
  })
}

let singleton: TerminalController | null = null

export function getTerminalController(bridge?: TerminalRendererBridge): TerminalController {
  if (!singleton) {
    const resolvedBridge =
      bridge ?? (window as unknown as { api: { terminal: TerminalRendererBridge } }).api.terminal
    singleton = createTerminalController({ bridge: resolvedBridge })
  }
  return singleton
}

export function disposeTerminalController(): void {
  singleton?.dispose()
  singleton = null
}

export type {
  TerminalController,
  TerminalControllerDependencies,
  TerminalControllerError,
  TerminalSize,
  TerminalView,
  TerminalWorkspaceSnapshot,
  XtermFitAddonLike,
  XtermTerminalLike
} from './terminalControllerTypes'
