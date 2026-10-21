import { SessionManager, type ModelRegistry } from '@oh-my-pi/pi-coding-agent'
import {
  createAgentSession as createLegacyAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import { isRecord, stringValue } from './common'
import {
  bindSessionModelAvailability,
  createSessionModelAvailability
} from './session-model-availability'

export async function createAgentSession(
  options: Parameters<typeof createLegacyAgentSession>[0]
): ReturnType<typeof createLegacyAgentSession> {
  const scope = options?.modelRegistry
    ? createSessionModelAvailability(options.modelRegistry, options.agentDir)
    : undefined
  if (options?.model && scope && !scope.enabled(options.model))
    throw new Error('Model disabled in Phi')
  const result = await createSessionWithRestorePolicy(
    scope ? { ...options, modelRegistry: scope.registry } : options
  )
  if (scope) bindSessionModelAvailability(result.session, scope)
  return result
}

async function createSessionWithRestorePolicy(
  options: Parameters<typeof createLegacyAgentSession>[0]
): ReturnType<typeof createLegacyAgentSession> {
  try {
    return await createLegacyAgentSession(options)
  } catch (error) {
    const unavailable =
      error instanceof Error && /^Could not restore model (.+)$/.exec(error.message)
    if (!unavailable || !options?.modelRegistry || options.model || options.modelPattern)
      throw error
    const savedModels = options.sessionManager?.buildSessionContext().models
    if (!savedModels || !Object.values(savedModels).includes(unavailable[1])) throw error
    // Explicit patterns suppress startup fallback, but OMP also fuzzy-matches
    // them. Hide candidates during this retry so a retired ID cannot select a
    // similarly named model. The real registry is visible again after creation;
    // an unset session does not auto-rebind on catalog discovery.
    const selection = withoutStartupModelCandidates(options.modelRegistry)
    try {
      return await createLegacyAgentSession({
        ...options,
        modelRegistry: selection.registry,
        modelPattern: unavailable[1]
      })
    } finally {
      selection.release()
    }
  }
}

function withoutStartupModelCandidates(registry: ModelRegistry): {
  registry: ModelRegistry
  release(): void
} {
  let blocked = true
  const methods = new Map<PropertyKey, unknown>()
  return {
    registry: new Proxy(registry, {
      get(target, key) {
        if (methods.has(key)) return methods.get(key)
        const value = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        const method =
          key === 'getAll' || key === 'getAvailable' || key === 'getAvailableForProviders'
            ? (...args: unknown[]) => (blocked ? [] : Reflect.apply(value, target, args))
            : value.bind(target)
        methods.set(key, method)
        return method
      }
    }),
    release: () => {
      blocked = false
    }
  }
}

export async function makeSessionManager(
  params: unknown,
  cwd: string,
  agentDir: string
): Promise<SessionManager> {
  if (!isRecord(params))
    return SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
  const kind = stringValue(params.kind, 'persistent')
  if (kind === 'memory') return SessionManager.inMemory(cwd)
  if (kind === 'open') {
    const path = stringValue(params.path)
    if (!path) throw new Error('Missing session path')
    return SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  }
  return SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
}

export {
  DefaultResourceLoader,
  SettingsManager,
  initializeExtensions as initializeAgentExtensions,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
}
