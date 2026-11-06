import {
  loadWorkerDecisionRuntime,
  loadWorkerMcpRuntime,
  memoryRuntime,
  modelGatewayRuntime
} from './worker-subsystems'
import { DESKTOP_MODEL_ACCESS_WORKER_METHODS } from '../kernel-host/model-access-broker'

let modelRuntime: Promise<typeof import('./runtime-context')> | undefined

export async function handleWorkerRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case DESKTOP_MODEL_ACCESS_WORKER_METHODS.credentials:
    case DESKTOP_MODEL_ACCESS_WORKER_METHODS.refresh: {
      const modelAccess = await import('./desktop-model-access')
      return method === DESKTOP_MODEL_ACCESS_WORKER_METHODS.credentials
        ? modelAccess.desktopModelAccessCredentials(params)
        : modelAccess.desktopModelAccessRefresh(params)
    }
    case 'decisions.models':
    case 'decisions.evaluate':
    case 'decisions.cancel': {
      const { handleDecisionRequest } = await loadWorkerDecisionRuntime()
      return handleDecisionRequest(method, params)
    }
    case 'modelGateway.create': {
      const { createModelGatewayLease } = await modelGatewayRuntime()
      return createModelGatewayLease(params as Parameters<typeof createModelGatewayLease>[0])
    }
    case 'modelGateway.revoke': {
      const { revokeModelGatewayLease } = await modelGatewayRuntime()
      return revokeModelGatewayLease(params as Parameters<typeof revokeModelGatewayLease>[0])
    }
    case 'mcp.configuredStdioTools':
    case 'mcp.desktopCreate':
    case 'mcp.desktopCall':
    case 'mcp.desktopCancel':
    case 'mcp.desktopClose':
    case 'mcp.cancelConfiguredStdioTools':
    case 'mcp.featuredTools':
    case 'mcp.syncFeaturedApiKeys':
    case 'mcp.applyConnectorEnabled':
    case 'mcp.prepareRemoteAuth':
    case 'mcp.cancelRemoteAuth':
    case 'mcp.authorizeRemote':
    case 'mcp.featuredAuthStatus':
    case 'mcp.cancelFeaturedAuth':
    case 'mcp.authorizeFeatured': {
      const { handleMcpRequest } = await loadWorkerMcpRuntime()
      return handleMcpRequest(method, params)
    }
    case 'modelRuntime.snapshot': {
      const { modelRuntimeSnapshot } = await import('./runtime-context')
      return modelRuntimeSnapshot(params)
    }
    case 'modelRuntime.login':
    case 'modelRuntime.cancelLogin': {
      // Keep login and cancellation ordered even when the module is still loading.
      const runtime = await (modelRuntime ??= import('./runtime-context'))
      return method === 'modelRuntime.login'
        ? runtime.loginModelRuntime(params)
        : runtime.cancelModelLogin(params)
    }
    case 'modelRuntime.logout': {
      const { logoutModelRuntime } = await import('./runtime-context')
      return logoutModelRuntime(params)
    }
    case 'resources.reload': {
      const { reloadResources } = await import('./resources')
      return reloadResources(params)
    }
    case 'session.create': {
      const { createSession } = await import('./session-creation')
      return createSession(params)
    }
    case 'session.prompt': {
      const { promptSession } = await import('./session-runtime')
      return promptSession(params)
    }
    case 'session.contextUsage': {
      const { sessionContextUsage } = await import('./session-runtime')
      return sessionContextUsage(params)
    }
    case 'memory.desktopCreate':
    case 'memory.desktopIngest':
    case 'memory.desktopLearn':
    case 'memory.desktopCancel':
    case 'memory.desktopClose': {
      const memory = await memoryRuntime()
      if (method === 'memory.desktopCreate') return memory.createDesktopProjectMemory(params)
      if (method === 'memory.desktopIngest') return memory.ingestDesktopProjectMemory(params)
      if (method === 'memory.desktopLearn') return memory.learnDesktopProjectMemory(params)
      if (method === 'memory.desktopCancel') return memory.cancelDesktopProjectMemory(params)
      return memory.closeDesktopProjectMemory(params)
    }
    case 'memory.read':
    case 'memory.deleteLesson':
    case 'memory.clear': {
      const memory = await import('../../memory/project-memory-worker')
      if (method === 'memory.read') return memory.readProjectMemory(params)
      if (method === 'memory.deleteLesson') return memory.deleteProjectMemoryLesson(params)
      return memory.clearProjectMemory(params)
    }
    case 'settings.autoCompactionDefaults': {
      const { readAutoCompactionDefaults } = await import('./session-runtime')
      return readAutoCompactionDefaults(params)
    }
    case 'settings.webSearch.get':
    case 'settings.webSearch.update':
    case 'settings.webSearch.apiKey.set':
    case 'settings.webSearch.apiKey.clear':
    case 'settings.webSearch.searxngEngines': {
      const { handleWebSearchRequest } = await import('./web-search')
      return handleWebSearchRequest(method, params)
    }
    case 'session.setAutoCompactionSettings':
    case 'session.compact':
    case 'session.plan.enter':
    case 'session.plan.cancel':
    case 'session.abort':
    case 'session.dispose':
    case 'shellJobs.list':
    case 'shellJobs.cancel':
    case 'session.setModel':
    case 'session.setThinkingLevel':
    case 'session.rename': {
      const runtime = await import('./session-runtime')
      if (method === 'session.setAutoCompactionSettings') {
        return runtime.setSessionAutoCompactionSettings(params)
      }
      if (method === 'session.compact') return runtime.compactSession(params)
      if (method === 'session.plan.enter') return runtime.enterSessionPlanMode(params)
      if (method === 'session.plan.cancel') return runtime.cancelSessionPlanMode(params)
      if (method === 'session.abort') return runtime.abortSession(params)
      if (method === 'session.dispose') return runtime.disposeSession(params)
      if (method === 'shellJobs.list') return runtime.listSessionShellJobs()
      if (method === 'shellJobs.cancel') return runtime.cancelSessionShellJob(params)
      if (method === 'session.setModel') return runtime.setSessionModel(params)
      if (method === 'session.setThinkingLevel') return runtime.setSessionThinkingLevel(params)
      return runtime.renameLiveSession(params)
    }
    case 'agentRun.steer':
    case 'agentRun.stop': {
      const { controlSessionAgentRun } = await import('./subagents')
      return controlSessionAgentRun(method === 'agentRun.steer' ? 'steer' : 'stop', params)
    }
    case 'agentRun.start': {
      const { startSessionAgentRun } = await import('./agent-run-start')
      return startSessionAgentRun(params)
    }
    case 'agentRuns.list': {
      const { listSessionAgentRuns } = await import('./subagents')
      return listSessionAgentRuns()
    }
    case 'sessions.list':
    case 'sessions.open':
    case 'sessions.fork':
    case 'sessions.rename': {
      const history = await import('./session-history')
      if (method === 'sessions.list') return history.listSessions(params)
      if (method === 'sessions.open') return history.openSession(params)
      if (method === 'sessions.fork') return history.forkSession(params)
      return history.renameSession(params)
    }
    case 'toolApproval.result': {
      const [{ isRecord, stringValue }, { pendingToolApprovals }] = await Promise.all([
        import('./common'),
        import('./state')
      ])
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const resolve = pendingToolApprovals.get(requestId)
      if (!resolve) return false
      pendingToolApprovals.delete(requestId)
      resolve(record.result ?? null)
      return true
    }
    case 'auth.promptResult': {
      const [{ isRecord, stringValue }, { pendingAuthPrompts }] = await Promise.all([
        import('./common'),
        import('./state')
      ])
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const pending = pendingAuthPrompts.get(requestId)
      if (pending) {
        if (typeof record.error === 'string' && record.error) {
          pending.reject(new Error(record.error))
        } else {
          pending.resolve(stringValue(record.value))
        }
      }
      return undefined
    }
    default:
      throw new Error(`Unknown OMP worker method: ${method}`)
  }
}
