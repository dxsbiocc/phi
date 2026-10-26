import type {
  JsonValue,
  KernelModelDescriptor,
  ModelAccessConfigureParams,
  ModelAccessStatus
} from '../../shared/kernel-protocol'
import type { KernelMethodHandlers } from '../protocol'
import { makeProtocolError } from '../protocol/errors'
import type { KernelModelAccess } from '../model-access'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  return sessionId
}

export function readModelAccessCatalog(modelAccess?: KernelModelAccess): {
  models: KernelModelDescriptor[]
  providers: Array<{ provider: string; status: ModelAccessStatus }>
} {
  if (!modelAccess) {
    throw makeProtocolError('CAPABILITY_UNAVAILABLE', 'Model access is not configured.')
  }
  const models = modelAccess.catalog().map((model): KernelModelDescriptor => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input.filter(
      (input): input is 'text' | 'image' => input === 'text' || input === 'image'
    ),
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    ...(model.cost ? { cost: { ...model.cost } } : {})
  }))
  const statuses = new Map(modelAccess.status().map((entry) => [entry.provider, entry.status]))
  const providers = [...new Set(models.map((model) => model.provider))].sort().map((provider) => ({
    provider,
    status: statuses.get(provider) ?? ('unauthenticated' as const)
  }))
  return { models, providers }
}

export async function requireAvailableModel(
  modelAccess: KernelModelAccess | undefined,
  requested: { provider: string; id: string }
): Promise<void> {
  if (!modelAccess) return
  await modelAccess.authStorage.credentials.revalidate().catch(() => undefined)
  const inCatalog = (): boolean =>
    modelAccess
      .catalog()
      .some((model) => model.provider === requested.provider && model.id === requested.id)
  // The kernel outlives configuration edits: re-read models.yml once (no network) before failing.
  if (!inCatalog()) {
    try {
      await modelAccess.modelRegistry.refresh('offline')
    } catch {
      // A failed reload leaves the current catalog; the miss below is reported as unavailable.
    }
  }
  const present = inCatalog()
  if (!present) throw makeProtocolError('MODEL_UNAVAILABLE', 'The requested model is unavailable.')
  if (!modelAccess.modelRegistry.find(requested.provider, requested.id)) {
    throw makeProtocolError('MODEL_UNAVAILABLE', 'The requested model is unavailable.')
  }
  const providerStatus = modelAccess.status().find((entry) => entry.provider === requested.provider)
  const status = providerStatus?.status
  if (status === 'available') return
  const code =
    status === 'unreachable'
      ? 'MODEL_UNREACHABLE'
      : status === 'unauthenticated'
        ? 'MODEL_UNAUTHENTICATED'
        : 'MODEL_UNAVAILABLE'
  throw makeProtocolError(
    code,
    providerStatus?.reason === 'desktop_credential_broker_not_connected'
      ? 'The desktop credential broker is not connected.'
      : 'The requested model is unavailable.',
    providerStatus?.reason ? { reason: providerStatus.reason } : undefined
  )
}

export function createModelAccessWorkerHandlers(options: {
  agentDir: string
  modelAccess?: KernelModelAccess
  callWorker: WorkerCall
  requireLoadedSession(sessionId: string): unknown
  snapshot(sessionId: string): Promise<JsonValue>
}): KernelMethodHandlers {
  const configure = options.modelAccess?.configure?.bind(options.modelAccess)
  const sessionId = (value: string | undefined): string => {
    const id = requiredSessionId(value)
    options.requireLoadedSession(id)
    return id
  }
  return {
    async 'session.setModel'(params, _context, request) {
      const id = sessionId(request.sessionId)
      const requested = (params as { model: { provider: string; id: string } }).model
      await requireAvailableModel(options.modelAccess, requested)
      await options.callWorker('session.setModel', {
        sessionId: id,
        model: requested,
        agentDir: options.agentDir
      })
      return options.snapshot(id)
    },
    async 'session.setThinkingLevel'(params, _context, request) {
      const id = sessionId(request.sessionId)
      const selection = params as { level: string }
      await options.callWorker('session.setThinkingLevel', {
        sessionId: id,
        level: selection.level
      })
      return options.snapshot(id)
    },
    async 'session.contextUsage'(_params, _context, request) {
      return (await options.callWorker('session.contextUsage', {
        sessionId: sessionId(request.sessionId)
      })) as JsonValue
    },
    async 'session.compact'(_params, _context, request) {
      const id = sessionId(request.sessionId)
      const compacted = (await options.callWorker('session.compact', { sessionId: id })) as {
        summary: JsonValue
      }
      return { summary: compacted.summary, state: await options.snapshot(id) }
    },
    async 'session.getAutoCompaction'(_params, _context, request) {
      return (await options.callWorker('session.getAutoCompaction', {
        sessionId: sessionId(request.sessionId),
        overrides: {}
      })) as JsonValue
    },
    async 'session.setAutoCompaction'(params, _context, request) {
      return (await options.callWorker('session.setAutoCompaction', {
        sessionId: sessionId(request.sessionId),
        overrides: params
      })) as JsonValue
    },
    async 'models.catalog'() {
      await options.modelAccess?.authStorage.credentials.revalidate().catch(() => undefined)
      return readModelAccessCatalog(options.modelAccess)
    },
    ...(configure
      ? {
          async 'modelAccess.configure'(params, callContext) {
            if (!callContext.trusted) {
              throw makeProtocolError(
                'CAPABILITY_UNAVAILABLE',
                'Model access cannot be configured here.'
              )
            }
            await configure(params as unknown as ModelAccessConfigureParams)
            return { configured: true as const }
          }
        }
      : {})
  }
}
