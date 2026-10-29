import type {
  PhiEngine,
  PhiHostRequestHandler,
  PhiSessionCreateParams
} from '../../src/main/agent/engine/types'
import type { KernelSessionClient } from '../../src/main/agent/engine/kernel-session-factory'
import type { KernelHostRequestContext } from '../../src/main/agent/engine/kernel-client'
import type { JsonValue, KernelEventFrame } from '../../src/shared/kernel-protocol'
import { KernelClientError } from '../../src/main/agent/engine/kernel-client'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export class FakeKernelClient implements KernelSessionClient {
  readonly requests: Array<{
    method: string
    params: JsonValue
    context: { sessionId?: string; runId?: string }
  }> = []
  readonly host = new Map<
    string,
    (params: JsonValue, context: KernelHostRequestContext) => unknown | Promise<unknown>
  >()
  private readonly listeners = new Set<(event: KernelEventFrame) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly completions = new Map<string, ReturnType<typeof deferred<JsonValue>>>()
  private nextSession = 0
  private nextRun = 0
  onCreate?: (kernelSessionId: string) => void
  onOpen?: (kernelSessionId: string) => void | Promise<void>
  asyncCreate = false
  approvalResponseError?: ConstructorParameters<typeof KernelClientError>[0]
  snapshotModel: JsonValue | undefined = { provider: 'test', id: 'model' }

  request(
    method: string,
    params: JsonValue,
    context: { sessionId?: string; runId?: string } = {}
  ): Promise<JsonValue> {
    this.requests.push({ method, params, context })
    if (method === 'session.create') {
      const sessionId = `kernel-${++this.nextSession}`
      const created = {
        sessionId,
        ...((params as { sessionManager?: { kind?: unknown } }).sessionManager?.kind ===
        'persistent'
          ? { sessionFile: `/agent/phi-kernel/sessions/${sessionId}/journal.jsonl` }
          : {})
      }
      if (this.asyncCreate) {
        return new Promise((resolveCreate) => {
          queueMicrotask(() => {
            this.onCreate?.(sessionId)
            resolveCreate(created)
          })
        })
      }
      this.onCreate?.(sessionId)
      return Promise.resolve(created)
    }
    if (method === 'session.open') {
      const sessionId = String((params as { sessionId?: unknown }).sessionId)
      return Promise.resolve(this.onOpen?.(sessionId)).then(() => ({ sessionId }))
    }
    if (method === 'session.adopt')
      return Promise.resolve({
        sessionId: 'kernel-adopted',
        migration: { state: 'complete', sourceSha256: 'c'.repeat(64) }
      })
    if (method === 'session.fork') {
      const sessionId = `kernel-${++this.nextSession}`
      return Promise.resolve({
        sessionId,
        sessionFile: `/agent/phi-kernel/sessions/${sessionId}/journal.jsonl`
      })
    }
    if (method === 'session.snapshot') {
      return Promise.resolve({
        sessionId: context.sessionId!,
        cwd: '/project',
        messages: [],
        ...(this.snapshotModel === undefined ? {} : { model: this.snapshotModel })
      })
    }
    if (method === 'session.prompt') {
      const runId = `run-${++this.nextRun}`
      const completion = deferred<JsonValue>()
      this.completions.set(runId, completion)
      queueMicrotask(() => {
        this.emit({
          kind: 'event',
          seq: this.nextRun,
          type: 'run.completed',
          sessionId: context.sessionId,
          runId,
          payload: {
            runId,
            status: 'completed',
            model: { provider: 'test', id: 'model' },
            resourceVersion: 'resource-v1'
          }
        })
        completion.resolve({ accepted: true, runId })
      })
      return completion.promise
    }
    if (method === 'session.close') return Promise.resolve({ closed: true })
    if (method === 'session.abort') return Promise.resolve({ cancelled: true })
    if (method === 'session.setModel' || method === 'session.setThinkingLevel') {
      return this.request('session.snapshot', {}, context)
    }
    if (method === 'session.contextUsage') return Promise.resolve(null)
    if (method === 'session.getAutoCompaction') {
      return Promise.resolve({ enabled: false, thresholdPercent: 80, thresholdTokens: 0 })
    }
    if (method === 'session.setAutoCompaction') {
      return Promise.resolve({ enabled: false, thresholdPercent: 80, thresholdTokens: 0 })
    }
    if (method === 'session.compact') {
      return Promise.resolve({
        summary: { summary: 'done', tokensBefore: 1 },
        state: {
          sessionId: context.sessionId!,
          cwd: '/project',
          messages: [],
          model: { provider: 'test', id: 'model' }
        }
      })
    }
    if (method === 'approval.respond') {
      return this.approvalResponseError
        ? Promise.reject(new KernelClientError(this.approvalResponseError))
        : Promise.resolve({ accepted: true })
    }
    if (method === 'agentRuns.list' || method === 'shellJobs.list') return Promise.resolve([])
    throw new Error(`Unexpected fake request: ${method}`)
  }

  subscribe(): Promise<JsonValue> {
    return Promise.resolve({ subscribed: true, lastSeq: 0 })
  }

  onEvent(listener: (event: KernelEventFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  registerHostHandler(
    method: string,
    handler: (params: JsonValue, context: KernelHostRequestContext) => unknown | Promise<unknown>
  ): () => void {
    this.host.set(method, handler)
    return () => this.host.delete(method)
  }

  emit(event: KernelEventFrame): void {
    for (const listener of this.listeners) listener(event)
  }
}

export function legacyEngine(): PhiEngine {
  const host = new Map<string, PhiHostRequestHandler>()
  const unsupported = async (): Promise<never> => {
    throw new Error('legacy session path was used')
  }
  return {
    decisions: { models: async () => [], evaluate: unsupported },
    sessions: {
      create: unsupported,
      prompt: unsupported,
      abort: unsupported,
      dispose: unsupported,
      setModel: unsupported,
      setThinkingLevel: unsupported,
      rename: unsupported,
      contextUsage: unsupported,
      compact: unsupported,
      setAutoCompactionSettings: unsupported,
      enterPlanMode: unsupported,
      cancelPlanMode: unsupported,
      has: () => false
    },
    history: {
      list: async () => [],
      open: unsupported,
      fork: unsupported,
      rename: unsupported
    },
    events: {
      onSessionEvent: () => () => undefined,
      onSessionState: () => () => undefined,
      onToolApproval: () => () => undefined,
      respondToolApproval: async () => undefined
    },
    models: {
      snapshot: async () => ({ providers: [], models: [], credentials: [] }),
      login: unsupported,
      logout: unsupported,
      onAuthPrompt: () => () => undefined,
      onAuthNotify: () => () => undefined,
      respondAuthPrompt: async () => undefined,
      rejectAuthPrompt: async () => undefined
    },
    resources: { reload: unsupported },
    mcp: {
      configuredStdioTools: unsupported,
      cancelConfiguredStdioTools: unsupported,
      featuredTools: unsupported,
      syncFeaturedApiKeys: unsupported,
      applyConnectorEnabled: unsupported,
      prepareRemoteAuth: unsupported,
      cancelRemoteAuth: unsupported,
      authorizeRemote: unsupported,
      featuredAuthStatus: unsupported,
      cancelFeaturedAuth: unsupported,
      authorizeFeatured: unsupported
    },
    memory: { read: unsupported, deleteLesson: unsupported, clear: unsupported },
    settings: {
      autoCompactionDefaults: unsupported,
      webSearch: {
        get: unsupported,
        update: unsupported,
        searxngEngines: unsupported,
        setApiKey: unsupported,
        clearApiKey: unsupported
      }
    },
    agentRuns: {
      start: unsupported,
      list: async () => [],
      steer: unsupported,
      stop: unsupported
    },
    shellJobs: { list: async () => [], cancel: unsupported },
    host: {
      register(method, handler) {
        host.set(method, handler)
        return () => host.delete(method)
      }
    },
    stop: async () => undefined
  }
}

export function params(sessionId: string): PhiSessionCreateParams {
  return {
    sessionId,
    cwd: '/project',
    agentDir: '/agent',
    model: { provider: 'test', id: 'model', name: 'Model', reasoning: false },
    sessionManager: { kind: 'persistent', cwd: '/project' },
    enableToolApproval: true,
    phiAgents: [
      {
        name: 'TestAgent',
        description: 'test',
        tools: [],
        skills: [],
        environment: undefined,
        systemPrompt: 'test',
        source: 'phi',
        filePath: '/agent/TestAgent.md',
        visibility: 'entry',
        warnings: []
      }
    ]
  }
}
