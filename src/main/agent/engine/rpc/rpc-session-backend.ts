import { phiEventFromWire } from '../events'
import type {
  PhiAgentEvent,
  RuntimeModel,
  ThinkingLevel,
  WorkerCreateSessionResult,
  WorkerSessionState
} from '../types'
import { RpcConnection } from './connection'
import type { RpcConnectionOptions, RpcPromptOptions, RpcPromptResult, RpcTransport } from './types'

/** Launch-only inputs. Host tools, approvals and history restoration have their own later bridges. */
export interface RpcSessionCreateParams {
  sessionId: string
  cwd: string
  agentDir: string
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
}

export type RpcSessionTransportFactory = (
  params: RpcSessionCreateParams,
  signal: AbortSignal
) => RpcTransport | Promise<RpcTransport>

export type RpcSessionStatus =
  { phase: 'ready' | 'running' } | { phase: 'interrupted'; error: Error }

export class RpcPromptError extends Error {
  constructor(readonly result: RpcPromptResult) {
    super(result.error?.message ?? 'RPC prompt failed', { cause: result.error })
    this.name = 'RpcPromptError'
  }
}

type Session = {
  connection: RpcConnection
  cwd: string
  state: WorkerSessionState
  activePrompt?: Promise<WorkerSessionState>
  unsubscribe: Array<() => void>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid RPC ${label}`)
  }
  return value as Record<string, unknown>
}

const thinkingLevels: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

function sessionState(rawState: unknown, rawMessages: unknown, cwd: string): WorkerSessionState {
  const state = object(rawState, 'session state')
  const { messages } = object(rawMessages, 'messages')
  if (!Array.isArray(messages)) throw new Error('Invalid RPC messages array')
  if (state.sessionFile !== undefined && typeof state.sessionFile !== 'string') {
    throw new Error('Invalid RPC session file')
  }
  let model: RuntimeModel | undefined
  if (state.model !== undefined) {
    const value = object(state.model, 'model')
    if (
      typeof value.provider !== 'string' ||
      typeof value.id !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.reasoning !== 'boolean'
    ) {
      throw new Error('Invalid RPC model')
    }
    model = {
      provider: value.provider,
      id: value.id,
      name: value.name,
      reasoning: value.reasoning,
      supportsImages: Array.isArray(value.input) && value.input.includes('image')
    }
  }
  // OMP's non-reasoning model state uses "off"; Phi represents that as undefined.
  const thinkingLevel =
    typeof state.thinkingLevel === 'string' &&
    thinkingLevels.includes(state.thinkingLevel as ThinkingLevel)
      ? (state.thinkingLevel as ThinkingLevel)
      : undefined
  if (state.thinkingLevel !== undefined && state.thinkingLevel !== 'off' && !thinkingLevel) {
    throw new Error('Invalid RPC thinking level')
  }
  return { cwd, sessionFile: state.sessionFile, messages, model, thinkingLevel }
}

/** A session backend only; desktop-owned auth, resources and tools never acquire fake RPC stubs. */
export class RpcSessionBackend {
  private readonly sessions = new Map<string, Session>()
  private readonly eventListeners = new Map<string, Set<(event: PhiAgentEvent) => void>>()
  private readonly stateListeners = new Map<string, Set<(state: WorkerSessionState) => void>>()
  private readonly statusListeners = new Map<string, Set<(status: RpcSessionStatus) => void>>()

  constructor(
    private readonly open: RpcSessionTransportFactory,
    private readonly options: RpcConnectionOptions = {}
  ) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  async create(params: RpcSessionCreateParams): Promise<WorkerCreateSessionResult> {
    if (!params.sessionId || this.sessions.has(params.sessionId)) {
      throw new Error(`RPC session already exists or has an empty id: ${params.sessionId}`)
    }
    const connection = new RpcConnection((signal) => this.open(params, signal), this.options)
    const entry: Session = {
      connection,
      cwd: params.cwd,
      state: { cwd: params.cwd },
      unsubscribe: []
    }
    this.sessions.set(params.sessionId, entry)
    entry.unsubscribe.push(
      connection.onEvent((frame) => {
        if (this.sessions.get(params.sessionId) !== entry) return
        const event = phiEventFromWire(frame)
        if (event) this.emit(this.eventListeners, params.sessionId, event)
      }),
      connection.onDisconnect(({ error, expected }) => {
        if (!expected && this.sessions.get(params.sessionId) === entry) {
          this.emit(this.statusListeners, params.sessionId, { phase: 'interrupted', error })
        }
      })
    )
    try {
      await connection.start()
      this.requireCurrent(params.sessionId, entry)
      if (params.model) {
        await connection.request({
          type: 'set_model',
          provider: params.model.provider,
          modelId: params.model.id
        })
        this.requireCurrent(params.sessionId, entry)
      }
      if (params.thinkingLevel) {
        await connection.request({ type: 'set_thinking_level', level: params.thinkingLevel })
        this.requireCurrent(params.sessionId, entry)
      }
      const state = await this.refresh(params.sessionId, entry)
      this.emit(this.statusListeners, params.sessionId, { phase: 'ready' })
      this.requireCurrent(params.sessionId, entry)
      return { sessionId: params.sessionId, state }
    } catch (error) {
      if (this.sessions.get(params.sessionId) === entry) this.sessions.delete(params.sessionId)
      for (const unsubscribe of entry.unsubscribe) unsubscribe()
      await connection.close()
      throw error
    }
  }

  async prompt(params: {
    sessionId: string
    text: string
    options?: RpcPromptOptions
  }): Promise<WorkerSessionState> {
    const entry = this.session(params.sessionId)
    if (entry.activePrompt) throw new Error(`RPC session is already running: ${params.sessionId}`)
    let complete!: (state: WorkerSessionState) => void
    let fail!: (error: unknown) => void
    const pending = new Promise<WorkerSessionState>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    // Both the lock and command precede observers and same-tick cancellation.
    entry.activePrompt = pending
    void (async (): Promise<WorkerSessionState> => {
      this.requireCurrent(params.sessionId, entry)
      const completion = entry.connection.prompt(params.text, params.options)
      // A running observer may synchronously dispose before the await below.
      void completion.catch(() => undefined)
      this.emit(this.statusListeners, params.sessionId, { phase: 'running' })
      this.requireCurrent(params.sessionId, entry)
      const result = await completion
      // agent_end is a streaming event, not an authoritative history snapshot.
      const state = await this.refresh(params.sessionId, entry)
      this.requireCurrent(params.sessionId, entry)
      if (entry.activePrompt === pending) entry.activePrompt = undefined
      this.emit(this.statusListeners, params.sessionId, { phase: 'ready' })
      this.requireCurrent(params.sessionId, entry)
      if (result.status === 'error') {
        throw new RpcPromptError(result)
      }
      return state
    })().then(complete, fail)
    try {
      return await pending
    } finally {
      if (entry.activePrompt === pending) entry.activePrompt = undefined
    }
  }

  async abort(params: { sessionId: string }): Promise<WorkerSessionState> {
    const entry = this.session(params.sessionId)
    const pending = entry.activePrompt
    await entry.connection.abort()
    // The command acknowledges cancellation; prompt_result proves that the turn settled.
    const state = pending ? await pending : await this.refresh(params.sessionId, entry)
    this.requireCurrent(params.sessionId, entry)
    return state
  }

  async dispose(params: { sessionId: string }): Promise<void> {
    const entry = this.sessions.get(params.sessionId)
    // Detach this generation before awaiting shutdown: an explicit replacement
    // may register new listeners while the old process is still closing.
    this.eventListeners.delete(params.sessionId)
    this.stateListeners.delete(params.sessionId)
    this.statusListeners.delete(params.sessionId)
    if (!entry) return
    this.sessions.delete(params.sessionId)
    for (const unsubscribe of entry.unsubscribe) unsubscribe()
    await entry.connection.close()
  }

  onSessionEvent(sessionId: string, listener: (event: PhiAgentEvent) => void): () => void {
    return this.subscribe(this.eventListeners, sessionId, listener)
  }

  onSessionState(sessionId: string, listener: (state: WorkerSessionState) => void): () => void {
    return this.subscribe(this.stateListeners, sessionId, listener)
  }

  onSessionStatus(sessionId: string, listener: (status: RpcSessionStatus) => void): () => void {
    return this.subscribe(this.statusListeners, sessionId, listener)
  }

  private session(sessionId: string): Session {
    const entry = this.sessions.get(sessionId)
    if (!entry?.connection.isReady) throw new Error(`RPC session is unavailable: ${sessionId}`)
    return entry
  }

  private requireCurrent(sessionId: string, entry: Session): void {
    if (this.sessions.get(sessionId) !== entry)
      throw new Error(`RPC session disposed: ${sessionId}`)
  }

  private async refresh(sessionId: string, entry: Session): Promise<WorkerSessionState> {
    const [state, messages] = await Promise.all([
      entry.connection.request({ type: 'get_state' }),
      entry.connection.request({ type: 'get_messages' })
    ])
    this.requireCurrent(sessionId, entry)
    entry.state = sessionState(state, messages, entry.cwd)
    this.emit(this.stateListeners, sessionId, entry.state)
    this.requireCurrent(sessionId, entry)
    return entry.state
  }

  private subscribe<T>(
    map: Map<string, Set<(value: T) => void>>,
    id: string,
    listener: (value: T) => void
  ): () => void {
    let listeners = map.get(id)
    if (!listeners) map.set(id, (listeners = new Set()))
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size && map.get(id) === listeners) map.delete(id)
    }
  }

  private emit<T>(map: Map<string, Set<(value: T) => void>>, id: string, value: T): void {
    for (const listener of map.get(id) ?? []) {
      try {
        void Promise.resolve(listener(value)).catch(() => undefined)
      } catch {
        // Observers cannot fail a protocol operation or suppress other observers.
      }
    }
  }
}
