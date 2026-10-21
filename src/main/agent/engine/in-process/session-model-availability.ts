import type { ModelRegistry, CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import { isModelEnabled, readModelAvailability } from '../../model-availability'
import { isRecord, type RuntimeModel } from './common'

export interface SessionModelAvailability {
  registry: ModelRegistry
  refresh(): void
  enabled(model: Pick<RuntimeModel, 'provider' | 'id'>): boolean
}

const MODEL_LISTS = new Set([
  'getAll',
  'getAvailable',
  'getAvailableForProviders',
  'getProviderModels'
])

/** Selection/auth view owned by one session; the shared management catalog remains raw. */
export function createSessionModelAvailability(
  registry: ModelRegistry,
  agentDir?: string
): SessionModelAvailability {
  let policy = readModelAvailability(agentDir)
  const enabled = (model: Pick<RuntimeModel, 'provider' | 'id'>): boolean =>
    isModelEnabled(policy, model.provider, model.id)
  const allowed = (subject: unknown, options?: unknown): boolean => {
    if (typeof subject === 'string') {
      const modelId =
        isRecord(options) && typeof options.modelId === 'string' ? options.modelId : undefined
      return isModelEnabled(policy, subject, modelId)
    }
    return (
      !isRecord(subject) ||
      typeof subject.provider !== 'string' ||
      isModelEnabled(
        policy,
        subject.provider,
        typeof subject.id === 'string' ? subject.id : undefined
      )
    )
  }
  const methods = new Map<PropertyKey, unknown>()
  const scoped = new Proxy(registry, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key)
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      const method = (...args: unknown[]): unknown => {
        if (MODEL_LISTS.has(String(key)))
          return (Reflect.apply(value, target, args) as RuntimeModel[]).filter(enabled)
        if (key === 'find') {
          if (!isModelEnabled(policy, String(args[0]), String(args[1]))) return undefined
        } else if (key === 'hasConfiguredAuth' || key === 'hasConcreteAuth') {
          if (!allowed(args[0])) return false
        } else if (key === 'getApiKey' || key === 'getApiKeyAndHeaders') {
          if (!allowed(args[0])) return Promise.reject(new Error('Model disabled in Phi'))
        } else if (key === 'resolver' && !allowed(args[0], args[1])) {
          return async () => {
            throw new Error('Model disabled in Phi')
          }
        }
        return Reflect.apply(value, target, args)
      }
      methods.set(key, method)
      return method
    }
  })
  return {
    registry: scoped,
    refresh: () => {
      policy = readModelAvailability(agentDir)
    },
    enabled
  }
}

/** Refresh only at an idle submission boundary; toggles never mutate an active run's policy. */
export function bindSessionModelAvailability(
  session: CreateAgentSessionResult['session'],
  scope: SessionModelAvailability
): void {
  const prompt = session.prompt.bind(session)
  session.prompt = async (...args) => {
    if (!session.isStreaming) {
      scope.refresh()
      if (session.model && !scope.enabled(session.model))
        throw new Error('Current model is disabled in Phi')
    }
    return prompt(...args)
  }
  const setModel = session.setModel.bind(session)
  session.setModel = async (model, ...args) => {
    if (!session.isStreaming) scope.refresh()
    if (!scope.enabled(model)) throw new Error('Model disabled in Phi')
    return setModel(model, ...args)
  }
}
