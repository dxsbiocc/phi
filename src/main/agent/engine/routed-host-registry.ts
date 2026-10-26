import type { PhiEngine, PhiHostRequestHandler, PhiSessionCreateParams } from './types'
import type { RoutedSessionFactory, RoutedSessionSink } from './session-routing-engine'

export class RoutedHostRegistry {
  private readonly handlers = new Map<
    string,
    { handler: PhiHostRequestHandler; legacyRemove?: () => void }
  >()
  private readonly syncedFactories = new WeakMap<
    RoutedSessionFactory,
    Map<string, { handler: PhiHostRequestHandler; remove: () => void }>
  >()

  readonly host: PhiEngine['host'] = {
    register: (method, handler) => this.register(method, handler)
  }

  constructor(
    private readonly legacy: PhiEngine['host'],
    private readonly currentFactory: () => RoutedSessionFactory | undefined
  ) {}

  sync(factory: RoutedSessionFactory): void {
    if (!factory.registerHostHandler) return
    let registrations = this.syncedFactories.get(factory)
    if (!registrations) {
      registrations = new Map()
      this.syncedFactories.set(factory, registrations)
    }
    for (const [method, entry] of this.handlers) {
      const current = registrations.get(method)
      if (current?.handler === entry.handler) continue
      current?.remove()
      registrations.set(method, {
        handler: entry.handler,
        remove: factory.registerHostHandler(method, entry.handler)
      })
    }
  }

  registerRouted(method: string, handler: PhiHostRequestHandler): () => void {
    return this.register(method, handler, false)
  }

  private register(
    method: string,
    handler: PhiHostRequestHandler,
    includeLegacy = true
  ): () => void {
    this.handlers.get(method)?.legacyRemove?.()
    const legacyRemove = includeLegacy ? this.legacy.register(method, handler) : undefined
    this.handlers.set(method, { handler, ...(legacyRemove ? { legacyRemove } : {}) })
    const factory = this.currentFactory()
    if (factory) this.sync(factory)
    return () => {
      const current = this.handlers.get(method)
      if (!current || current.handler !== handler) return
      current.legacyRemove?.()
      this.handlers.delete(method)
      const activeFactory = this.currentFactory()
      const registered = activeFactory
        ? this.syncedFactories.get(activeFactory)?.get(method)
        : undefined
      if (registered?.handler === handler) {
        registered.remove()
        this.syncedFactories.get(activeFactory!)?.delete(method)
      }
    }
  }
}

export function observeRouted<T>(listeners: Set<(value: T) => void> | undefined, value: T): void {
  for (const listener of listeners ?? []) {
    try {
      listener(value)
    } catch {
      // One UI observer cannot change session authority.
    }
  }
}

export function createRoutedSink(input: {
  params: PhiSessionCreateParams
  live(): boolean
  events: Map<string, Set<(value: import('./event-types').PhiAgentEvent) => void>>
  states: Map<string, Set<(value: unknown) => void>>
  approvals: Map<string, Set<(value: unknown) => void>>
  approvalOwners: Map<string, string>
}): RoutedSessionSink {
  const id = input.params.sessionId
  return {
    event: (event) => {
      if (input.live()) observeRouted(input.events.get(id), event)
    },
    state: (state) => {
      if (input.live()) observeRouted(input.states.get(id), state)
    },
    approval: (request) => {
      if (!input.live()) return
      const requestId =
        request && typeof request === 'object' && 'requestId' in request
          ? String((request as { requestId: unknown }).requestId)
          : undefined
      if (requestId) input.approvalOwners.set(requestId, id)
      observeRouted(input.approvals.get(id), request)
    }
  }
}
