import { getOmpBridge, type OmpBridge } from './omp-bridge'
import { createDecisionClient } from './decision-client'
import { SessionRoutingEngine } from './session-routing-engine'
import {
  createFacadeSessionFactory,
  type FacadeSessionFactoryOptions
} from './rpc/facade-session-driver'
import type { RoutedSessionFactory } from './session-routing-engine'
import type { PhiEngine, ResolvedRuntimeCompactionPolicy } from './types'
import type { AutoCompactionOverrides } from '../../../shared/contextUsageTypes'
import { assertInProcessLocalProject } from './in-process/local-project-boundary'
import { KernelSessionFactory, type KernelSessionFactoryOptions } from './kernel-session-factory'

/** Engine-owned access to the legacy runtime bridge for desktop composition adapters. */
export type PhiEngineBridge = OmpBridge

export function getPhiEngineBridge(): PhiEngineBridge {
  return getOmpBridge()
}

function createLegacyMcp(bridge: OmpBridge): PhiEngine['mcp'] {
  return {
    configuredStdioTools: (params) => bridge.request('mcp.configuredStdioTools', params),
    cancelConfiguredStdioTools: (params) =>
      bridge.request('mcp.cancelConfiguredStdioTools', params),
    featuredTools: (params) => bridge.request('mcp.featuredTools', params),
    syncFeaturedApiKeys: (params) => bridge.request('mcp.syncFeaturedApiKeys', params),
    applyConnectorEnabled: (params) => bridge.request('mcp.applyConnectorEnabled', params),
    prepareRemoteAuth: (params) => bridge.request('mcp.prepareRemoteAuth', params),
    cancelRemoteAuth: (params) => bridge.request('mcp.cancelRemoteAuth', params),
    authorizeRemote: (params) => bridge.request('mcp.authorizeRemote', params),
    featuredAuthStatus: (params) => bridge.request('mcp.featuredAuthStatus', params),
    cancelFeaturedAuth: (params) => bridge.request('mcp.cancelFeaturedAuth', params),
    authorizeFeatured: (params) => bridge.request('mcp.authorizeFeatured', params)
  }
}

export function createInProcessEngine(bridge: OmpBridge): PhiEngine {
  return {
    decisions: createDecisionClient(bridge),
    sessions: {
      create: async (params) => {
        assertInProcessLocalProject(params)
        return bridge.request('session.create', params)
      },
      prompt: (params) => bridge.request('session.prompt', params),
      abort: (params) => bridge.request('session.abort', params),
      dispose: (params) => bridge.request('session.dispose', params),
      setModel: (params) => bridge.request('session.setModel', params),
      setThinkingLevel: (params) => bridge.request('session.setThinkingLevel', params),
      rename: (params) => bridge.request('session.rename', params),
      contextUsage: (params) => bridge.request('session.contextUsage', params),
      compact: (params) => bridge.request('session.compact', params),
      setAutoCompactionSettings: (params) =>
        bridge.request('session.setAutoCompactionSettings', params),
      enterPlanMode: (params) => bridge.request('session.plan.enter', params),
      cancelPlanMode: (params) => bridge.request('session.plan.cancel', params),
      has: (sessionId) => bridge.hasSession(sessionId)
    },
    history: {
      list: (params) => bridge.request('sessions.list', params),
      open: async (params) => {
        assertInProcessLocalProject(params)
        return bridge.request('sessions.open', params)
      },
      fork: (params) => bridge.request('sessions.fork', params),
      rename: (params) => bridge.request('sessions.rename', params)
    },
    events: {
      onSessionEvent: (sessionId, listener) => bridge.onSessionEvent(sessionId, listener),
      onSessionState: (sessionId, listener) => bridge.onSessionState(sessionId, listener),
      onToolApproval: (sessionId, listener) => bridge.onSessionToolApproval(sessionId, listener),
      respondToolApproval: (requestId, result) => bridge.sendToolApprovalResult(requestId, result)
    },
    models: {
      snapshot: (params) => bridge.request('modelRuntime.snapshot', params),
      login: (params) => bridge.request('modelRuntime.login', params),
      logout: (params) => bridge.request('modelRuntime.logout', params),
      onAuthPrompt: (listener) => bridge.onAuthPrompt(listener),
      onAuthNotify: (listener) => bridge.onAuthNotify(listener),
      respondAuthPrompt: (requestId, value) => bridge.sendAuthPromptResult(requestId, value),
      rejectAuthPrompt: (requestId, error) => bridge.sendAuthPromptError(requestId, error)
    },
    resources: { reload: (params) => bridge.request('resources.reload', params) },
    mcp: createLegacyMcp(bridge),
    memory: {
      read: (params) => bridge.request('memory.read', params),
      deleteLesson: (params) => bridge.request('memory.deleteLesson', params),
      clear: (params) => bridge.request('memory.clear', params)
    },
    settings: {
      autoCompactionDefaults: (params) => bridge.request('settings.autoCompactionDefaults', params),
      webSearch: {
        get: (params) => bridge.request('settings.webSearch.get', params),
        update: (params) => bridge.request('settings.webSearch.update', params),
        searxngEngines: (params) => bridge.request('settings.webSearch.searxngEngines', params),
        setApiKey: (params) => bridge.request('settings.webSearch.apiKey.set', params),
        clearApiKey: (params) => bridge.request('settings.webSearch.apiKey.clear', params)
      }
    },
    agentRuns: {
      start: (params) => bridge.request('agentRun.start', params),
      list: (params) => bridge.request('agentRuns.list', params),
      steer: (params) => bridge.request('agentRun.steer', params),
      stop: (params) => bridge.request('agentRun.stop', params)
    },
    shellJobs: {
      list: (params) => bridge.request('shellJobs.list', params),
      cancel: (params) => bridge.request('shellJobs.cancel', params)
    },
    host: {
      register: (method, handler) => bridge.registerHostHandler(method, handler)
    },
    stop: () => bridge.stop()
  }
}

let engine: SessionRoutingEngine | null = null
let remoteFactory: RoutedSessionFactory | undefined
let kernelFactory: KernelSessionFactory | undefined
let e5SmokeAllowed: ((projectId: string) => boolean) | undefined

const mirroredKernelHostHandlers = new Map<
  string,
  { handler: import('./types').PhiHostRequestHandler; remove?: () => void }
>()

const routedFactory: RoutedSessionFactory = {
  handles(params) {
    return Boolean(kernelFactory?.handles(params) || (params.remoteProject && remoteFactory))
  },
  create(params, signal, sink, control) {
    if (kernelFactory?.handles(params)) return kernelFactory.create(params, signal, sink, control)
    if (params.remoteProject && remoteFactory) {
      return remoteFactory.create(params, signal, sink, control)
    }
    throw new Error('No routed session factory owns this request.')
  },
  registerHostHandler(method, handler) {
    mirroredKernelHostHandlers.get(method)?.remove?.()
    const entry = {
      handler,
      ...(kernelFactory ? { remove: kernelFactory.registerHostHandler(method, handler) } : {})
    }
    mirroredKernelHostHandlers.set(method, entry)
    return () => {
      if (mirroredKernelHostHandlers.get(method)?.handler !== handler) return
      entry.remove?.()
      mirroredKernelHostHandlers.delete(method)
    }
  },
  historyOpen(params) {
    return kernelFactory?.historyOpen?.(params) ?? Promise.resolve(undefined)
  },
  historyFork(params) {
    return kernelFactory?.historyFork?.(params) ?? Promise.resolve(undefined)
  },
  discardHistoryFork(result) {
    return kernelFactory?.discardHistoryFork?.(result) ?? Promise.resolve(false)
  },
  async stop() {
    await kernelFactory?.stop()
  }
}

export function installKernelSessionRouting(options: KernelSessionFactoryOptions): () => void {
  const installed = new KernelSessionFactory(options)
  kernelFactory = installed
  for (const [method, entry] of mirroredKernelHostHandlers) {
    entry.remove?.()
    entry.remove = installed.registerHostHandler(method, entry.handler)
  }
  return () => {
    if (kernelFactory !== installed) return
    kernelFactory = undefined
    for (const entry of mirroredKernelHostHandlers.values()) {
      entry.remove?.()
      delete entry.remove
    }
    void installed.stop().catch(() => undefined)
  }
}

export function scopeE5RemoteFactory(
  ordinary: RoutedSessionFactory,
  createSmoke: () => RoutedSessionFactory,
  allow: (projectId: string) => boolean
): RoutedSessionFactory {
  let smoke: RoutedSessionFactory | undefined
  return {
    create: (params, signal, sink, control) => {
      if (params.remoteProject && allow(params.remoteProject.projectId)) {
        smoke ??= createSmoke()
        return smoke.create(params, signal, sink, control)
      }
      return ordinary.create(params, signal, sink, control)
    }
  }
}

/** Exact desktop baseline and overrides, resolved with the existing non-persistent settings policy. */
export function readRpcCompactionPolicy(
  agentDir: string,
  overrides: AutoCompactionOverrides
): Promise<ResolvedRuntimeCompactionPolicy> {
  return getOmpBridge().request('settings.autoCompactionDefaults', {
    cwd: agentDir,
    agentDir,
    overrides,
    includePolicy: true
  })
}

/** Main-process opt-in only. Existing sessions retain their captured driver and authority. */
export function installRemoteSessionRouting(
  options: Omit<FacadeSessionFactoryOptions, 'bridge' | 'models'> & {
    enabled: true
    /** Scoped development acceptance run; never persisted as an application setting. */
    e5SmokeProjectId?: string
    e5SmokeProjectAllowed?: (projectId: string) => boolean
  }
): () => void {
  if (options.enabled !== true) throw new Error('Remote session routing must be explicitly enabled')
  const bridge = getOmpBridge()
  const common = {
    ...options,
    bridge,
    compactionPolicy: readRpcCompactionPolicy,
    models: async (agentDir) => (await getPhiEngine().models.snapshot({ agentDir })).models
  }
  const ordinary = createFacadeSessionFactory({
    ...common,
    ...(options.e5SmokeProjectId
      ? {
          remotePlanExecutionEnabled: false,
          remotePlanDraftEnabled: false,
          remoteAutoPlanEnabled: false
        }
      : {})
  })
  const allowSmoke = (projectId: string): boolean =>
    projectId === options.e5SmokeProjectId && options.e5SmokeProjectAllowed?.(projectId) === true
  const factory = options.e5SmokeProjectId
    ? scopeE5RemoteFactory(ordinary, () => createFacadeSessionFactory(common), allowSmoke)
    : ordinary
  remoteFactory = factory
  e5SmokeAllowed = options.e5SmokeProjectId ? allowSmoke : undefined
  return () => {
    if (remoteFactory === factory) {
      remoteFactory = undefined
      e5SmokeAllowed = undefined
    }
  }
}

export function ownsRemoteRuntimeSession(sessionId: string): boolean {
  return engine?.owns(sessionId) ?? false
}

export function getPhiEngine(): PhiEngine {
  engine ??= new SessionRoutingEngine(
    createInProcessEngine(getOmpBridge()),
    () => (kernelFactory || remoteFactory ? routedFactory : undefined),
    {
      remotePlanExecutionEnabled: (projectId) => e5SmokeAllowed?.(projectId) === true
    }
  )
  return engine
}
