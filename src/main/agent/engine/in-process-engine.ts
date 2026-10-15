import { getOmpBridge, type OmpBridge } from './omp-bridge'
import { SessionRoutingEngine } from './session-routing-engine'
import {
  createFacadeSessionFactory,
  type FacadeSessionFactoryOptions
} from './rpc/facade-session-driver'
import type { RoutedSessionFactory } from './session-routing-engine'
import type { PhiEngine, ResolvedRuntimeCompactionPolicy } from './types'
import type { AutoCompactionOverrides } from '../../../shared/contextUsageTypes'

export function createInProcessEngine(bridge: OmpBridge): PhiEngine {
  return {
    sessions: {
      create: (params) => bridge.request('session.create', params),
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
      has: (sessionId) => bridge.hasSession(sessionId)
    },
    history: {
      list: (params) => bridge.request('sessions.list', params),
      open: (params) => bridge.request('sessions.open', params),
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
    resources: {
      reload: (params) => bridge.request('resources.reload', params)
    },
    mcp: {
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
    },
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
  options: Omit<FacadeSessionFactoryOptions, 'bridge' | 'models'> & { enabled: true }
): () => void {
  if (options.enabled !== true) throw new Error('Remote session routing must be explicitly enabled')
  const bridge = getOmpBridge()
  const factory = createFacadeSessionFactory({
    ...options,
    bridge,
    compactionPolicy: readRpcCompactionPolicy,
    models: async (agentDir) => (await getPhiEngine().models.snapshot({ agentDir })).models
  })
  remoteFactory = factory
  return () => {
    if (remoteFactory === factory) remoteFactory = undefined
  }
}

export function ownsRemoteRuntimeSession(sessionId: string): boolean {
  return engine?.owns(sessionId) ?? false
}

export function getPhiEngine(): PhiEngine {
  engine ??= new SessionRoutingEngine(createInProcessEngine(getOmpBridge()), () => remoteFactory)
  return engine
}
