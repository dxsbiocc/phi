import { randomBytes } from 'node:crypto'

import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  type TerminalAttachResult,
  type TerminalEvent,
  type TerminalSnapshot,
  type TerminalWorkspaceRef
} from '../../shared/terminalTypes'
import { TerminalError } from './terminal-error'
import { buildTerminalEnv, resolveTerminalShell, type TerminalShellLaunch } from './terminal-env'
import {
  TerminalHost,
  type TerminalCreateOptions,
  type TerminalHostEvent,
  type TerminalReplayResult
} from './terminal-host'

const MAX_TERMINALS_PER_WORKSPACE = 4
const MAX_TERMINALS_TOTAL = 8
const CREATE_REQUEST_CAP = 1_024
const CREATE_REQUEST_TTL_MS = 10 * 60 * 1_000
// Leave scheduling headroom inside the externally visible 1.5 second quit budget.
const DISPOSE_BUDGET_MS = 1_400
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u

export interface TerminalManagerWorkspace {
  workspaceKey: string
  cwd: string
  label: string
}

export interface TerminalHostLike {
  subscribe(listener: (event: TerminalHostEvent) => void): () => void
  createTerminal(options: TerminalCreateOptions): Promise<{ terminalId: string; pid: number }>
  input(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  credit(terminalId: string, bytes: number): Promise<void>
  setCredit(terminalId: string, bytes: number): Promise<void>
  replay(terminalId: string, fromSeq: number): Promise<TerminalReplayResult>
  close(terminalId: string, mode: 'user' | 'quit'): Promise<void>
  dispose(): Promise<void>
}

export interface TerminalManagerOptions {
  resolveWorkspace: (
    ref: TerminalWorkspaceRef
  ) => TerminalManagerWorkspace | Promise<TerminalManagerWorkspace>
  sink: (event: TerminalEvent) => void
  hostFactory?: () => TerminalHostLike
  now?: () => number
  randomTerminalId?: () => string
  environment?: NodeJS.ProcessEnv
  resolveShell?: (environment: NodeJS.ProcessEnv) => TerminalShellLaunch
}

interface OutputSubscription {
  epoch: number
  phase: 'attaching' | 'live'
  buffered: Array<Extract<TerminalHostEvent, { type: 'data' | 'gap' }>>
  nextSeq: number
  unackedBytes: number
  duplicateBytes: number
  replayBytesBySeq: Map<number, number>
  replayGap?: NonNullable<TerminalAttachResult['gap']>
}

interface ManagedTerminal {
  snapshot: TerminalSnapshot
  nextEpoch: number
  subscription?: OutputSubscription
  closePromise?: Promise<void>
  resizePromise?: Promise<void>
  pendingResize?: { cols: number; rows: number }
}

interface CreateRequestEntry {
  promise: Promise<TerminalSnapshot>
  settledAt?: number
}

function cloneSnapshot(snapshot: TerminalSnapshot): TerminalSnapshot {
  return { ...snapshot }
}

function terminalId(): string {
  return randomBytes(16).toString('base64url')
}

function isLive(snapshot: TerminalSnapshot): boolean {
  return snapshot.state === 'starting' || snapshot.state === 'open' || snapshot.state === 'closing'
}

function outputBytes(records: ReadonlyArray<{ data: string }>): number {
  return records.reduce((total, record) => total + Buffer.byteLength(record.data, 'utf8'), 0)
}

export class TerminalManager {
  private readonly resolveWorkspace: TerminalManagerOptions['resolveWorkspace']
  private readonly sink: TerminalManagerOptions['sink']
  private readonly host: TerminalHostLike
  private readonly now: () => number
  private readonly randomTerminalId: () => string
  private readonly environment: NodeJS.ProcessEnv
  private readonly shellResolver: (environment: NodeJS.ProcessEnv) => TerminalShellLaunch
  private readonly terminals = new Map<string, ManagedTerminal>()
  private readonly createRequests = new Map<string, CreateRequestEntry>()
  private readonly unsubscribeHost: () => void
  private disposing = false
  private disposePromise?: Promise<void>

  constructor(options: TerminalManagerOptions) {
    this.resolveWorkspace = options.resolveWorkspace
    this.sink = options.sink
    this.host = (options.hostFactory ?? (() => new TerminalHost()))()
    this.now = options.now ?? Date.now
    this.randomTerminalId = options.randomTerminalId ?? terminalId
    this.environment = options.environment ?? process.env
    this.shellResolver =
      options.resolveShell ?? ((environment) => resolveTerminalShell(environment))
    this.unsubscribeHost = this.host.subscribe((event) => this.handleHostEvent(event))
  }

  async list(workspaceRef: TerminalWorkspaceRef): Promise<TerminalSnapshot[]> {
    this.assertAvailable()
    const workspace = await this.resolve(workspaceRef)
    return [...this.terminals.values()]
      .filter((record) => record.snapshot.workspaceKey === workspace.workspaceKey)
      .map((record) => cloneSnapshot(record.snapshot))
  }

  async create(
    workspaceRef: TerminalWorkspaceRef,
    cols: number,
    rows: number,
    requestId: string
  ): Promise<TerminalSnapshot> {
    this.assertAvailable()
    this.assertDimensions(cols, rows)
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new TerminalError('invalid', 'Invalid terminal request')
    }
    this.pruneCreateRequests()
    const cached = this.createRequests.get(requestId)
    if (cached) return cloneSnapshot(await cached.promise)
    if (this.createRequests.size >= CREATE_REQUEST_CAP) {
      throw new TerminalError('busy', 'Terminal creation is busy')
    }

    const entry: CreateRequestEntry = {
      promise: this.performCreate(workspaceRef, cols, rows)
    }
    this.createRequests.set(requestId, entry)
    void entry.promise.then(
      () => {
        entry.settledAt = this.now()
      },
      () => {
        entry.settledAt = this.now()
      }
    )
    return cloneSnapshot(await entry.promise)
  }

  async input(terminalId: string, data: string): Promise<void> {
    this.assertAvailable()
    if (data.includes('\0') || Buffer.byteLength(data, 'utf8') > TERMINAL_MAX_INPUT_BYTES) {
      throw new TerminalError('invalid', 'Invalid terminal input')
    }
    const record = this.requireTerminal(terminalId)
    if (record.snapshot.state !== 'open') {
      throw new TerminalError('not_open', 'Terminal is not open')
    }
    await this.hostCall(() => this.host.input(terminalId, data))
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.assertAvailable()
    this.assertDimensions(cols, rows)
    const record = this.requireTerminal(terminalId)
    if (record.snapshot.state !== 'open') {
      throw new TerminalError('not_open', 'Terminal is not open')
    }
    record.pendingResize = { cols, rows }
    if (!record.resizePromise) {
      record.resizePromise = this.flushResizes(record).finally(() => {
        record.resizePromise = undefined
      })
    }
    return record.resizePromise
  }

  async attach(terminalId: string): Promise<TerminalAttachResult> {
    this.assertAvailable()
    const record = this.requireTerminal(terminalId)
    const subscription: OutputSubscription = {
      epoch: ++record.nextEpoch,
      phase: 'attaching',
      buffered: [],
      nextSeq: 1,
      unackedBytes: 0,
      duplicateBytes: 0,
      replayBytesBySeq: new Map()
    }
    record.subscription = subscription

    await this.hostCall(() => this.host.setCredit(terminalId, 0))
    this.assertCurrentSubscription(record, subscription)

    const records: Array<{ seq: number; data: string }> = []
    let gap: TerminalAttachResult['gap']
    let fromSeq = 1
    for (let pageCount = 0; pageCount < 64; pageCount += 1) {
      const page = await this.hostCall(() => this.host.replay(terminalId, fromSeq))
      this.assertCurrentSubscription(record, subscription)
      if (!gap && page.gap) gap = { ...page.gap }
      records.push(...page.records.map((item) => ({ ...item })))
      if (!page.more) {
        fromSeq = page.nextSeq
        break
      }
      if (page.nextSeq <= fromSeq) {
        throw new TerminalError('unavailable', 'Terminal replay is unavailable')
      }
      fromSeq = page.nextSeq
      if (pageCount === 63) {
        throw new TerminalError('unavailable', 'Terminal replay is unavailable')
      }
    }

    subscription.nextSeq = fromSeq
    subscription.unackedBytes = outputBytes(records)
    subscription.replayBytesBySeq = new Map(
      records.map((item) => [item.seq, Buffer.byteLength(item.data, 'utf8')])
    )
    subscription.replayGap = gap
    subscription.phase = 'live'
    const buffered = subscription.buffered.splice(0)
    for (const event of buffered) this.deliverOutput(record, subscription, event)
    // Buffered duplicates consumed the previous epoch's credit, which the absolute reset replaced.
    subscription.duplicateBytes = 0

    await this.hostCall(() => this.host.setCredit(terminalId, TERMINAL_CREDIT_WINDOW_BYTES))
    this.assertCurrentSubscription(record, subscription)
    while (subscription.duplicateBytes > 0) {
      const duplicateBytes = subscription.duplicateBytes
      subscription.duplicateBytes = 0
      await this.hostCall(() => this.host.credit(terminalId, duplicateBytes))
      this.assertCurrentSubscription(record, subscription)
    }
    subscription.replayBytesBySeq.clear()
    subscription.replayGap = undefined
    return {
      epoch: subscription.epoch,
      snapshot: cloneSnapshot(record.snapshot),
      records,
      ...(gap ? { gap } : {}),
      nextSeq: fromSeq
    }
  }

  async ack(terminalId: string, epoch: number, bytes: number): Promise<void> {
    this.assertAvailable()
    const record = this.terminals.get(terminalId)
    const subscription = record?.subscription
    if (!record || !subscription || subscription.epoch !== epoch) return
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > subscription.unackedBytes) {
      throw new TerminalError('invalid', 'Invalid terminal acknowledgement')
    }
    subscription.unackedBytes -= bytes
    try {
      await this.host.credit(terminalId, bytes)
    } catch {
      subscription.unackedBytes += bytes
      throw new TerminalError('unavailable', 'Terminal is unavailable')
    }
  }

  close(terminalId: string): Promise<void> {
    this.assertAvailable()
    const record = this.terminals.get(terminalId)
    if (!record) return Promise.resolve()
    if (!record.closePromise) {
      record.closePromise = this.closeRecord(terminalId, record)
    }
    return record.closePromise
  }

  async closeWorkspace(workspaceKey: string): Promise<void> {
    this.assertAvailable()
    const ids = [...this.terminals.entries()]
      .filter(([, record]) => record.snapshot.workspaceKey === workspaceKey)
      .map(([id]) => id)
    await Promise.all(ids.map((id) => this.close(id)))
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposing = true
    this.disposePromise = this.performDispose()
    return this.disposePromise
  }

  private async performCreate(
    workspaceRef: TerminalWorkspaceRef,
    cols: number,
    rows: number
  ): Promise<TerminalSnapshot> {
    const workspace = await this.resolve(workspaceRef)
    this.assertAvailable()
    const workspaceLive = [...this.terminals.values()].filter(
      (record) => record.snapshot.workspaceKey === workspace.workspaceKey && isLive(record.snapshot)
    ).length
    const totalLive = [...this.terminals.values()].filter((record) =>
      isLive(record.snapshot)
    ).length
    if (workspaceLive >= MAX_TERMINALS_PER_WORKSPACE || totalLive >= MAX_TERMINALS_TOTAL) {
      throw new TerminalError(
        'limit_reached',
        `Terminal limit reached (${workspaceLive}/${MAX_TERMINALS_PER_WORKSPACE} workspace, ${totalLive}/${MAX_TERMINALS_TOTAL} total)`
      )
    }

    let shell: TerminalShellLaunch
    try {
      shell = this.shellResolver(this.environment)
    } catch {
      throw new TerminalError('unavailable', 'Terminal shell is unavailable')
    }
    const id = this.randomTerminalId()
    const snapshot: TerminalSnapshot = {
      terminalId: id,
      workspaceKey: workspace.workspaceKey,
      title: `Terminal ${this.lowestFreeTitleNumber(workspace.workspaceKey)}`,
      host: 'local',
      initialCwd: workspace.cwd,
      shell: shell.application,
      state: 'starting',
      createdAt: new Date(this.now()).toISOString(),
      cols,
      rows,
      ...(shell.fallbackReason ? { message: shell.fallbackReason } : {})
    }
    const record: ManagedTerminal = { snapshot, nextEpoch: 0 }
    this.terminals.set(id, record)

    try {
      await this.host.createTerminal({
        terminalId: id,
        application: shell.application,
        args: shell.args,
        cwd: workspace.cwd,
        env: buildTerminalEnv(this.environment),
        cols,
        rows
      })
      if (this.terminals.get(id) !== record) {
        await this.host.close(id, 'user').catch(() => undefined)
        throw new TerminalError('unavailable', 'Terminal is unavailable')
      }
      if (record.snapshot.state === 'starting') this.updateState(record, { state: 'open' })
      return cloneSnapshot(record.snapshot)
    } catch (error) {
      if (this.terminals.get(id) === record && record.snapshot.state !== 'failed') {
        this.updateState(record, { state: 'failed', message: 'Terminal failed to start' })
      }
      if (error instanceof TerminalError) throw error
      throw new TerminalError('unavailable', 'Terminal failed to start')
    }
  }

  private async flushResizes(record: ManagedTerminal): Promise<void> {
    while (record.pendingResize) {
      const size = record.pendingResize
      record.pendingResize = undefined
      await this.hostCall(() => this.host.resize(record.snapshot.terminalId, size.cols, size.rows))
      record.snapshot.cols = size.cols
      record.snapshot.rows = size.rows
    }
  }

  private async closeRecord(terminalId: string, record: ManagedTerminal): Promise<void> {
    if (isLive(record.snapshot)) this.updateState(record, { state: 'closing' })
    record.subscription = undefined
    try {
      await this.hostCall(() => this.host.close(terminalId, 'user'))
    } finally {
      if (this.terminals.get(terminalId) === record) this.terminals.delete(terminalId)
    }
  }

  private async performDispose(): Promise<void> {
    this.unsubscribeHost()
    const cleanup = this.host.dispose().catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPOSE_BUDGET_MS)
        timer.unref()
      })
    ])
    if (timer) clearTimeout(timer)
    this.terminals.clear()
    this.createRequests.clear()
  }

  private handleHostEvent(event: TerminalHostEvent): void {
    const record = this.terminals.get(event.terminalId)
    if (!record) return
    switch (event.type) {
      case 'started':
        if (record.snapshot.state === 'starting') this.updateState(record, { state: 'open' })
        return
      case 'exit':
        this.updateState(record, { state: 'exited', exitCode: event.exitCode ?? undefined })
        return
      case 'failed':
        this.updateState(record, { state: 'failed', message: 'Terminal process failed' })
        return
      case 'data':
      case 'gap': {
        const subscription = record.subscription
        if (!subscription) return
        if (subscription.phase === 'attaching') subscription.buffered.push(event)
        else this.deliverOutput(record, subscription, event)
      }
    }
  }

  private deliverOutput(
    record: ManagedTerminal,
    subscription: OutputSubscription,
    event: Extract<TerminalHostEvent, { type: 'data' | 'gap' }>
  ): void {
    if (record.subscription !== subscription) return
    if (event.type === 'data') {
      if (event.seq < subscription.nextSeq) {
        subscription.duplicateBytes += Buffer.byteLength(event.data, 'utf8')
        return
      }
      subscription.nextSeq = event.seq + 1
      subscription.unackedBytes += Buffer.byteLength(event.data, 'utf8')
      this.emit({ ...event, epoch: subscription.epoch })
      return
    }
    if (event.toSeq < subscription.nextSeq) return
    const fromSeq = Math.max(event.fromSeq, subscription.nextSeq)
    let droppedBytes = event.droppedBytes
    if (fromSeq > event.fromSeq) {
      const replayGap = subscription.replayGap
      if (
        replayGap &&
        event.fromSeq <= replayGap.fromSeq &&
        event.toSeq >= replayGap.toSeq &&
        fromSeq > replayGap.toSeq
      ) {
        droppedBytes -= replayGap.droppedBytes
      }
      for (const [seq, bytes] of subscription.replayBytesBySeq) {
        if (seq >= event.fromSeq && seq < fromSeq) droppedBytes -= bytes
      }
    }
    subscription.nextSeq = event.toSeq + 1
    this.emit({
      ...event,
      epoch: subscription.epoch,
      fromSeq,
      droppedBytes: Math.max(0, droppedBytes)
    })
  }

  private updateState(
    record: ManagedTerminal,
    patch: Pick<TerminalSnapshot, 'state'> & Partial<Pick<TerminalSnapshot, 'exitCode' | 'message'>>
  ): void {
    Object.assign(record.snapshot, patch)
    this.emit({ type: 'state', snapshot: cloneSnapshot(record.snapshot) })
  }

  private emit(event: TerminalEvent): void {
    try {
      this.sink(event)
    } catch {
      // A renderer callback cannot disrupt terminal ownership or cleanup.
    }
  }

  private async resolve(ref: TerminalWorkspaceRef): Promise<TerminalManagerWorkspace> {
    try {
      return await this.resolveWorkspace(ref)
    } catch (error) {
      if (error instanceof TerminalError) throw error
      throw new TerminalError('unavailable', 'Terminal workspace is unavailable')
    }
  }

  private async hostCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof TerminalError) throw error
      throw new TerminalError('unavailable', 'Terminal is unavailable')
    }
  }

  private assertCurrentSubscription(
    record: ManagedTerminal,
    subscription: OutputSubscription
  ): void {
    if (record.subscription !== subscription) {
      throw new TerminalError('unavailable', 'Terminal attachment was replaced')
    }
  }

  private requireTerminal(id: string): ManagedTerminal {
    const record = this.terminals.get(id)
    if (!record) throw new TerminalError('not_found', 'Terminal was not found')
    return record
  }

  private assertAvailable(): void {
    if (this.disposing) throw new TerminalError('unavailable', 'Terminal manager is unavailable')
  }

  private assertDimensions(cols: number, rows: number): void {
    if (
      !Number.isSafeInteger(cols) ||
      cols < TERMINAL_MIN_COLS ||
      cols > TERMINAL_MAX_COLS ||
      !Number.isSafeInteger(rows) ||
      rows < TERMINAL_MIN_ROWS ||
      rows > TERMINAL_MAX_ROWS
    ) {
      throw new TerminalError('invalid', 'Invalid terminal size')
    }
  }

  private lowestFreeTitleNumber(workspaceKey: string): number {
    const used = new Set(
      [...this.terminals.values()]
        .filter((record) => record.snapshot.workspaceKey === workspaceKey)
        .map((record) => /^Terminal (\d+)$/u.exec(record.snapshot.title))
        .flatMap((match) => (match ? [Number(match[1])] : []))
    )
    let candidate = 1
    while (used.has(candidate)) candidate += 1
    return candidate
  }

  private pruneCreateRequests(): void {
    const cutoff = this.now() - CREATE_REQUEST_TTL_MS
    for (const [id, entry] of this.createRequests) {
      if (entry.settledAt !== undefined && entry.settledAt <= cutoff) {
        this.createRequests.delete(id)
      }
    }
  }
}
