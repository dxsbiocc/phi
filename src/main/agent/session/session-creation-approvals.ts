import type { ToolApprovalContext, ToolApprovalRequest } from '../tool-approval'
import { createApprovalExtension } from '../tool-approval'
import type { PermissionMode, Project } from '../projects'
import type { InlineExtension } from '../runtime/runtime-adapter'
import type { SessionSnapshot } from './session-lifecycle'

type ToolClassification = 'exec' | 'read' | 'write' | undefined

interface CreationPromptRun {
  phiSessionId: string
  sessionGeneration: number
  runId: string
}

export interface SessionCreationApprovalContext {
  useRpc: boolean
  signal: AbortSignal
  sessionKey: string
  snapshot: SessionSnapshot
  generation: number
  sessionManifestId?: string
  project?: Project
}

export interface SessionCreationApprovalDependencies {
  policy: {
    classifyLocal(toolName: string, input: Record<string, unknown>): ToolClassification
    permissionMode(sessionKey: string, snapshot: SessionSnapshot): PermissionMode
  }
  runs: {
    active(sessionKey: string): CreationPromptRun | undefined
    sessionPath(sessionId: string): string
    backgroundRequested(request: {
      sessionId: string
      agentRunId: string
      approvalId: string
      toolName: string
      summary: string
      cwd: string
    }): void
    backgroundResolved(approvalId: string, decision: 'approved' | 'denied' | 'cancelled'): void
    requested(
      sessionId: string,
      approvalId: string,
      metadata: {
        toolName: string
        summary: string
      }
    ): void
    approved(sessionId: string, approvalId: string): void
    denied(sessionId: string, approvalId: string): void
    cancelled(sessionId: string, approvalId: string): void
  }
}

export interface SessionCreationApprovalSources {
  classifyLocal(toolName: string, input: Record<string, unknown>): ToolClassification
  permissionMode(sessionKey: string, snapshot: SessionSnapshot): PermissionMode
  activeRun(sessionKey: string): CreationPromptRun | undefined
  sessionPath(sessionId: string): string
  background: Pick<
    SessionCreationApprovalDependencies['runs'],
    'backgroundRequested' | 'backgroundResolved'
  >
  runner: Pick<
    SessionCreationApprovalDependencies['runs'],
    'requested' | 'approved' | 'denied' | 'cancelled'
  >
}

export function createSessionCreationApprovalDependencies(
  sources: SessionCreationApprovalSources
): SessionCreationApprovalDependencies {
  return {
    policy: {
      classifyLocal: sources.classifyLocal,
      permissionMode: sources.permissionMode
    },
    runs: {
      active: sources.activeRun,
      sessionPath: sources.sessionPath,
      ...sources.background,
      ...sources.runner
    }
  }
}

function approvalLocation(
  context: SessionCreationApprovalContext
): Pick<ToolApprovalContext, 'cwd' | 'scopeNote' | 'writeScopeNote'> {
  return { cwd: context.snapshot.cwd }
}

function approvalContext(
  context: SessionCreationApprovalContext,
  dependencies: SessionCreationApprovalDependencies,
  event: { agentRunId?: string } | undefined
): ToolApprovalContext | null {
  const run = dependencies.runs.active(context.sessionKey)
  const phiSessionId = run?.phiSessionId ?? context.sessionManifestId
  if (!phiSessionId) return null
  return {
    sessionId: phiSessionId,
    sessionPath: dependencies.runs.sessionPath(phiSessionId),
    sessionGeneration: run?.sessionGeneration ?? context.generation,
    runId: event?.agentRunId ?? run?.runId ?? 'background-agent',
    ...approvalLocation(context),
    ...(context.project?.name ? { projectName: context.project.name } : {})
  }
}

function recordRequested(
  dependencies: SessionCreationApprovalDependencies,
  request: ToolApprovalRequest
): void {
  if (!request.sessionId) return
  if (request.agentRunId && request.cwd) {
    dependencies.runs.backgroundRequested({
      sessionId: request.sessionId,
      agentRunId: request.agentRunId,
      approvalId: request.requestId,
      toolName: request.toolName,
      summary: request.summary,
      cwd: request.cwd
    })
  } else {
    dependencies.runs.requested(request.sessionId, request.requestId, {
      toolName: request.toolName,
      summary: request.summary
    })
  }
}

function recordResolved(
  dependencies: SessionCreationApprovalDependencies,
  request: ToolApprovalRequest,
  approved: boolean
): void {
  if (!request.sessionId) return
  if (approved) {
    if (request.agentRunId) {
      dependencies.runs.backgroundResolved(request.requestId, 'approved')
    } else {
      dependencies.runs.approved(request.sessionId, request.requestId)
    }
  } else {
    if (request.agentRunId) {
      dependencies.runs.backgroundResolved(request.requestId, 'denied')
    } else {
      dependencies.runs.denied(request.sessionId, request.requestId)
    }
  }
}

function recordCancelled(
  dependencies: SessionCreationApprovalDependencies,
  request: ToolApprovalRequest
): void {
  if (!request.sessionId) return
  if (request.agentRunId) {
    dependencies.runs.backgroundResolved(request.requestId, 'cancelled')
  } else {
    dependencies.runs.cancelled(request.sessionId, request.requestId)
  }
}

export function createSessionCreationExtensionFactories(
  context: SessionCreationApprovalContext,
  dependencies: SessionCreationApprovalDependencies
): InlineExtension[] {
  if (context.useRpc) return []
  return [
    createApprovalExtension({
      signal: context.signal,
      classifyTool: (toolName, input) => dependencies.policy.classifyLocal(toolName, input),
      shouldGate: () =>
        dependencies.policy.permissionMode(context.sessionKey, context.snapshot) === 'ask',
      getContext: (event) => approvalContext(context, dependencies, event),
      onApprovalRequested: (request) => recordRequested(dependencies, request),
      onApprovalResolved: (request, approved) => recordResolved(dependencies, request, approved),
      onApprovalCancelled: (request) => recordCancelled(dependencies, request)
    })
  ]
}
