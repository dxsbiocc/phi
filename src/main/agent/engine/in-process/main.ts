import {
  createDesktopProjectMemory,
  ingestDesktopProjectMemory,
  learnDesktopProjectMemory,
  cancelDesktopProjectMemory,
  closeDesktopProjectMemory,
  closeAllDesktopProjectMemory
} from '../rpc/desktop-project-memory-runtime'
import { createInterface } from 'node:readline'
import {
  clearProjectMemory,
  deleteProjectMemoryLesson,
  readProjectMemory
} from '../../memory/project-memory-worker'
import { IncomingRequest, isRecord, stringValue } from './common'
import { handleHostResponse, isHostResponse, send } from './ipc'
import { handleMcpRequest } from './mcp-runtime'
import { closeAllDesktopMcpScopes } from './desktop-mcp-runtime'
import { reloadResources } from './resources'
import { loginModelRuntime, logoutModelRuntime, modelRuntimeSnapshot } from './runtime-context'
import { createSession } from './session-creation'
import { forkSession, listSessions, openSession, renameSession } from './session-history'
import {
  abortSession,
  cancelSessionShellJob,
  compactSession,
  disposeSession,
  enterSessionPlanMode,
  listSessionShellJobs,
  promptSession,
  readAutoCompactionDefaults,
  renameLiveSession,
  sessionContextUsage,
  setSessionAutoCompactionSettings,
  setSessionModel,
  setSessionThinkingLevel
} from './session-runtime'
import { pendingAuthPrompts, pendingToolApprovals } from './state'
import { controlSessionAgentRun, listSessionAgentRuns } from './subagents'
import { handleWebSearchRequest } from './web-search'
import {
  createModelGatewayLease,
  revokeModelGatewayLease,
  closeAllModelGatewayLeases
} from './model-gateway'

import { errorMessage } from '../../../../shared/errorCodes'
async function handleRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'modelGateway.create':
      return createModelGatewayLease(params as Parameters<typeof createModelGatewayLease>[0])
    case 'modelGateway.revoke':
      return revokeModelGatewayLease(params as Parameters<typeof revokeModelGatewayLease>[0])
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
    case 'mcp.authorizeFeatured':
      return handleMcpRequest(method, params)
    case 'modelRuntime.snapshot':
      return modelRuntimeSnapshot(params)
    case 'modelRuntime.login':
      return loginModelRuntime(params)
    case 'modelRuntime.logout':
      return logoutModelRuntime(params)
    case 'resources.reload':
      return reloadResources(params)
    case 'session.create':
      return createSession(params)
    case 'session.prompt':
      return promptSession(params)
    case 'session.contextUsage':
      return sessionContextUsage(params)
    case 'memory.desktopCreate':
      return createDesktopProjectMemory(params)
    case 'memory.desktopIngest':
      return ingestDesktopProjectMemory(params)
    case 'memory.desktopLearn':
      return learnDesktopProjectMemory(params)
    case 'memory.desktopCancel':
      return cancelDesktopProjectMemory(params)
    case 'memory.desktopClose':
      return closeDesktopProjectMemory(params)
    case 'memory.read':
      return readProjectMemory(params)
    case 'memory.deleteLesson':
      return deleteProjectMemoryLesson(params)
    case 'memory.clear':
      return clearProjectMemory(params)
    case 'settings.autoCompactionDefaults':
      return readAutoCompactionDefaults(params)
    case 'settings.webSearch.get':
    case 'settings.webSearch.update':
    case 'settings.webSearch.apiKey.set':
    case 'settings.webSearch.apiKey.clear':
    case 'settings.webSearch.searxngEngines':
      return handleWebSearchRequest(method, params)
    case 'session.setAutoCompactionSettings':
      return setSessionAutoCompactionSettings(params)
    case 'session.compact':
      return compactSession(params)
    case 'session.plan.enter':
      return enterSessionPlanMode(params)
    case 'session.abort':
      return abortSession(params)
    case 'session.dispose':
      return disposeSession(params)
    case 'agentRun.steer':
      return controlSessionAgentRun('steer', params)
    case 'agentRun.stop':
      return controlSessionAgentRun('stop', params)
    case 'agentRuns.list':
      return listSessionAgentRuns()
    case 'shellJobs.list':
      return listSessionShellJobs()
    case 'shellJobs.cancel':
      return cancelSessionShellJob(params)
    case 'session.setModel':
      return setSessionModel(params)
    case 'session.setThinkingLevel':
      return setSessionThinkingLevel(params)
    case 'session.rename':
      return renameLiveSession(params)
    case 'sessions.list':
      return listSessions(params)
    case 'sessions.open':
      return openSession(params)
    case 'sessions.fork':
      return forkSession(params)
    case 'sessions.rename':
      return renameSession(params)
    case 'toolApproval.result': {
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const resolve = pendingToolApprovals.get(requestId)
      if (resolve) {
        pendingToolApprovals.delete(requestId)
        resolve(record.result ?? null)
      }
      return undefined
    }
    case 'auth.promptResult': {
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const pending = pendingAuthPrompts.get(requestId)
      if (pending) {
        pendingAuthPrompts.delete(requestId)
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

// Bounded so a stuck cleanup cannot keep an orphaned worker alive after the host is gone.
const HOST_EXIT_CLEANUP_TIMEOUT_MS = 1000

let hostExitStarted = false
function shutdownAfterHostExit(): void {
  if (hostExitStarted) return
  hostExitStarted = true
  const cleanup = Promise.allSettled([
    closeAllDesktopMcpScopes(),
    closeAllDesktopProjectMemory(),
    closeAllModelGatewayLeases()
  ])
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, HOST_EXIT_CLEANUP_TIMEOUT_MS))
  void Promise.race([cleanup, timeout]).finally(() => process.exit(0))
}

const input = createInterface({ input: process.stdin })
input.once('close', shutdownAfterHostExit)
process.stdin.once('error', shutdownAfterHostExit)
process.stdout.once('error', shutdownAfterHostExit)
input.on('line', (line) => {
  void (async () => {
    let request: IncomingRequest | undefined
    try {
      const message = JSON.parse(line) as unknown
      if (isHostResponse(message)) {
        handleHostResponse(message)
        return
      }
      request = message as IncomingRequest
      const result = await handleRequest(request.method, request.params)
      send({ id: request.id, ok: true, result })
    } catch (error) {
      const message = errorMessage(error)
      const stack = error instanceof Error ? error.stack : undefined
      const detail =
        isRecord(error) && typeof error.detail === 'string'
          ? error.detail.slice(0, 4096)
          : undefined
      send({ id: request?.id ?? '', ok: false, error: message, stack, detail })
    }
  })()
})
