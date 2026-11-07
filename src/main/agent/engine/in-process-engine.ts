import { randomUUID } from 'node:crypto'

import { getOmpBridge, type OmpBridge } from './omp-bridge'
import { createDecisionClient } from './decision-client'
import { SessionRoutingEngine } from './session-routing-engine'
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
      login: async (params, signal) => {
        signal?.throwIfAborted()
        const attemptId = params.type === 'oauth' ? (params.attemptId ?? randomUUID()) : undefined
        const cancel = (): void => {
          void bridge.request('modelRuntime.cancelLogin', { attemptId }).catch(() => undefined)
        }
        if (attemptId) signal?.addEventListener('abort', cancel, { once: true })
        try {
          return await bridge.request('modelRuntime.login', { ...params, attemptId }, { signal })
        } catch (error) {
          signal?.throwIfAborted()
          throw error
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      },
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
let kernelFactory: KernelSessionFactory | undefined

const mirroredKernelHostHandlers = new Map<
  string,
  { handler: import('./types').PhiHostRequestHandler; remove?: () => void }
>()

const routedFactory: RoutedSessionFactory = {
  create(params, signal, sink, control) {
    if (kernelFactory) return kernelFactory.create(params, signal, sink, control)
    throw new Error('The Phi kernel session factory is unavailable.')
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

export function ownsRemoteRuntimeSession(sessionId: string): boolean {
  return engine?.owns(sessionId) ?? false
}

export function getPhiEngine(): PhiEngine {
  engine ??= new SessionRoutingEngine(
    createInProcessEngine(getOmpBridge()),
    () => (kernelFactory ? routedFactory : undefined),
    { remotePlanExecutionEnabled: true }
  )
  return engine
}
