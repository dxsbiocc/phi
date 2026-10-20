import type { ToolApprovalContext, ToolApprovalRequest } from '../tool-approval'
import { createApprovalExtension } from '../tool-approval'
import type { PermissionMode, Project } from '../projects'
import type { InlineExtension } from '../runtime/runtime-adapter'
import type { SessionSnapshot } from './session-lifecycle'
import type { RemoteSessionProject } from './session-creation-options'

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
  remoteProject: RemoteSessionProject | null
}

export interface RemoteApprovalTicket {
  projectId: string
  approvedCwd: string
  approvalDigest: string
  expiresAt: number
}

export interface SessionCreationApprovalDependencies {
  policy: {
    classifyLocal(toolName: string, input: Record<string, unknown>): ToolClassification
    classifyRemote(toolName: string, input: Record<string, unknown>): ToolClassification
    permissionMode(sessionKey: string, snapshot: SessionSnapshot): PermissionMode
    remoteHost(hostProfileId: string): { hostAlias: string } | undefined
    remoteScope(hostAlias: string, canonicalRoot: string): string
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
  tickets: {
    key(sessionId: string, toolCallId: string): string
    bash: Map<string, RemoteApprovalTicket>
    write: Map<string, RemoteApprovalTicket>
    edit: Map<string, RemoteApprovalTicket>
  }
}

export interface SessionCreationApprovalSources {
  classifyLocal(toolName: string, input: Record<string, unknown>): ToolClassification
  classifyRemote(toolName: string, input: Record<string, unknown>): ToolClassification
  permissionMode(sessionKey: string, snapshot: SessionSnapshot): PermissionMode
  remoteHost(hostProfileId: string): { hostAlias: string } | undefined
  remoteScope(hostAlias: string, canonicalRoot: string): string
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
  key(sessionId: string, toolCallId: string): string
  bash: Map<string, RemoteApprovalTicket>
  write: Map<string, RemoteApprovalTicket>
  edit: Map<string, RemoteApprovalTicket>
}

export function createSessionCreationApprovalDependencies(
  sources: SessionCreationApprovalSources
): SessionCreationApprovalDependencies {
  return {
    policy: {
      classifyLocal: sources.classifyLocal,
      classifyRemote: sources.classifyRemote,
      permissionMode: sources.permissionMode,
      remoteHost: sources.remoteHost,
      remoteScope: sources.remoteScope
    },
    runs: {
      active: sources.activeRun,
      sessionPath: sources.sessionPath,
      ...sources.background,
      ...sources.runner
    },
    tickets: {
      key: sources.key,
      bash: sources.bash,
      write: sources.write,
      edit: sources.edit
    }
  }
}

function approvalLocation(
  context: SessionCreationApprovalContext,
  dependencies: SessionCreationApprovalDependencies
): Pick<ToolApprovalContext, 'cwd' | 'scopeNote' | 'writeScopeNote'> {
  const remoteHost =
    context.project?.location.kind === 'ssh'
      ? dependencies.policy.remoteHost(context.project.location.hostProfileId)
      : undefined
  if (context.project?.location.kind === 'ssh' && !remoteHost) {
    throw new Error('远程项目的 SSH 服务器档案不可用')
  }
  if (context.project?.location.kind === 'ssh' && remoteHost) {
    return {
      cwd: `ssh://${remoteHost.hostAlias}${context.project.location.canonicalRoot}`,
      scopeNote: dependencies.policy.remoteScope(
        remoteHost.hostAlias,
        context.project.location.canonicalRoot
      ),
      writeScopeNote: `SSH ${remoteHost.hostAlias} · 项目 ${context.project.location.canonicalRoot}；新建文件或修改已读取且未变化的文件。`
    }
  }
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
    ...approvalLocation(context, dependencies),
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

function approvedTicket(
  context: SessionCreationApprovalContext,
  request: ToolApprovalRequest
): RemoteApprovalTicket | null {
  if (
    !context.remoteProject ||
    !request.sessionId ||
    !request.toolCallId ||
    !request.approvalDigest ||
    !request.cwd
  ) {
    return null
  }
  return {
    projectId: context.remoteProject.projectId,
    approvedCwd: request.cwd,
    approvalDigest: request.approvalDigest,
    expiresAt: Date.now() + 120_000
  }
}

function recordApprovedRemoteCall(
  context: SessionCreationApprovalContext,
  dependencies: SessionCreationApprovalDependencies,
  request: ToolApprovalRequest
): void {
  const ticket = approvedTicket(context, request)
  if (!ticket || !request.sessionId || !request.toolCallId) return
  const key = dependencies.tickets.key(request.sessionId, request.toolCallId)
  if (request.toolName === 'bash') dependencies.tickets.bash.set(key, ticket)
  if (request.toolName === 'write') dependencies.tickets.write.set(key, ticket)
  if (request.toolName === 'edit') dependencies.tickets.edit.set(key, ticket)
}

function clearDeniedRemoteCalls(
  context: SessionCreationApprovalContext,
  dependencies: SessionCreationApprovalDependencies,
  request: ToolApprovalRequest
): void {
  if (!context.remoteProject || !request.sessionId || !request.toolCallId) return
  const key = dependencies.tickets.key(request.sessionId, request.toolCallId)
  dependencies.tickets.bash.delete(key)
  dependencies.tickets.write.delete(key)
  dependencies.tickets.edit.delete(key)
}

function recordResolved(
  context: SessionCreationApprovalContext,
  dependencies: SessionCreationApprovalDependencies,
  request: ToolApprovalRequest,
  approved: boolean
): void {
  if (!request.sessionId) return
  if (approved) {
    recordApprovedRemoteCall(context, dependencies, request)
    if (request.agentRunId) {
      dependencies.runs.backgroundResolved(request.requestId, 'approved')
    } else {
      dependencies.runs.approved(request.sessionId, request.requestId)
    }
  } else {
    clearDeniedRemoteCalls(context, dependencies, request)
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
      classifyTool: (toolName, input) =>
        context.remoteProject
          ? dependencies.policy.classifyRemote(toolName, input)
          : dependencies.policy.classifyLocal(toolName, input),
      shouldGate: () =>
        dependencies.policy.permissionMode(context.sessionKey, context.snapshot) === 'ask',
      getContext: (event) => approvalContext(context, dependencies, event),
      onApprovalRequested: (request) => recordRequested(dependencies, request),
      onApprovalResolved: (request, approved) =>
        recordResolved(context, dependencies, request, approved),
      onApprovalCancelled: (request) => recordCancelled(dependencies, request)
    })
  ]
}
