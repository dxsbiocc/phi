import type { BrowserWindow } from 'electron'

import type { PhiHostRequestContext } from '../engine/types'
import type { ConfirmBuildRequest } from '../content/skill-host'
import { BUILD_NOW } from '../content/environment-build-prompt'
import { ADD_PACKAGES, type EnvironmentRequestConfirm } from '../content/env-request'
import type { ToolApprovalRequest } from '../tool-approval'

export interface HostConfirmationPromptRun {
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  sessionGeneration: number
}

interface ConfirmationProject {
  name?: string
}

type ApprovalDecision = 'approved' | 'denied' | 'cancelled'

export interface HostConfirmationDeps {
  interactions: {
    request(params: unknown): Promise<unknown>
    buildQuestion(request: ConfirmBuildRequest): string
    buildConfirmed(response: unknown): boolean
    requestConfirmed(response: unknown): boolean
  }
  runs: {
    findByRuntimeSessionId(runtimeSessionId: string): HostConfirmationPromptRun | null
    sessionPath(sessionId: string): string
  }
  projects: {
    getById(projectId: string): ConfirmationProject | undefined
    getByCwd(cwd: string): ConfirmationProject | undefined
  }
  sessions: {
    findById(sessionId: string): unknown
  }
  approvals: {
    createId(): string
    request(
      request: ToolApprovalRequest,
      signal: AbortSignal,
      getWindow: () => BrowserWindow | null
    ): Promise<ApprovalDecision>
    getActiveWindow(): BrowserWindow | null
    markNeedsApproval(sessionId: string, requestId: string, request: ToolApprovalRequest): void
    markApproved(sessionId: string, requestId: string): void
    markDenied(sessionId: string, requestId: string): void
    markCancelled(sessionId: string, requestId: string): void
    sendCancelled(requestId: string): void
    notifySessionChanged(): void
  }
  capability: {
    assertCurrent(context: PhiHostRequestContext): void
  }
}

interface ApprovalContext {
  run: HostConfirmationPromptRun
  request: ToolApprovalRequest
  signal: AbortSignal
}

function approvalContext(
  runtimeSessionId: string,
  toolName: string,
  summary: string,
  context: PhiHostRequestContext,
  deps: HostConfirmationDeps
): ApprovalContext | null {
  const run = deps.runs.findByRuntimeSessionId(runtimeSessionId)
  if (!run || !context.signal || !context.toolCallId) return null
  const project = run.projectId
    ? deps.projects.getById(run.projectId)
    : deps.projects.getByCwd(run.cwd)
  return {
    run,
    signal: context.signal,
    request: {
      requestId: deps.approvals.createId(),
      sessionId: run.phiSessionId,
      sessionPath: deps.runs.sessionPath(run.phiSessionId),
      sessionGeneration: run.sessionGeneration,
      runId: run.runId,
      cwd: run.cwd,
      ...(project?.name ? { projectName: project.name } : {}),
      toolCallId: context.toolCallId,
      toolName,
      summary
    }
  }
}

function recordApprovalDecision(
  approval: ApprovalContext,
  decision: ApprovalDecision,
  deps: HostConfirmationDeps
): void {
  const { request, run } = approval
  if (decision === 'approved') {
    deps.approvals.markApproved(run.phiSessionId, request.requestId)
  } else if (decision === 'denied') {
    deps.approvals.markDenied(run.phiSessionId, request.requestId)
  } else {
    deps.approvals.markCancelled(run.phiSessionId, request.requestId)
    deps.approvals.sendCancelled(request.requestId)
  }
}

async function confirmEnvironmentBuild(
  request: ConfirmBuildRequest,
  deps: HostConfirmationDeps
): Promise<boolean> {
  try {
    const response = await deps.interactions.request({
      runtimeSessionId: request.runtimeSessionId,
      questions: [
        {
          header: '环境',
          question: deps.interactions.buildQuestion(request),
          options: [
            { label: BUILD_NOW, description: '下载并安装这个环境' },
            { label: '暂不', description: '这次先不安装' }
          ]
        }
      ]
    })
    return deps.interactions.buildConfirmed(response)
  } catch {
    return false
  }
}

async function confirmEnvironmentRequest(
  request: EnvironmentRequestConfirm,
  deps: HostConfirmationDeps
): Promise<boolean> {
  try {
    const response = await deps.interactions.request({
      runtimeSessionId: request.runtimeSessionId,
      questions: [
        {
          header: '环境',
          question: request.question,
          options: [
            { label: ADD_PACKAGES, description: '求解并安装这些包' },
            { label: '取消', description: '不添加这些包' }
          ]
        }
      ]
    })
    return deps.interactions.requestConfirmed(response)
  } catch {
    return false
  }
}

async function confirmHostToolApproval(
  runtimeSessionId: string,
  toolName: string,
  summary: string,
  context: PhiHostRequestContext,
  deps: HostConfirmationDeps
): Promise<boolean> {
  const approval = approvalContext(runtimeSessionId, toolName, summary, context, deps)
  if (!approval) return false
  deps.approvals.markNeedsApproval(
    approval.run.phiSessionId,
    approval.request.requestId,
    approval.request
  )
  const decision = await deps.approvals.request(
    approval.request,
    approval.signal,
    deps.approvals.getActiveWindow
  )
  recordApprovalDecision(approval, decision, deps)
  deps.approvals.notifySessionChanged()
  return decision === 'approved'
}

async function confirmAgentModuleInstallation(
  runtimeSessionId: string,
  summary: string,
  context: PhiHostRequestContext,
  deps: HostConfirmationDeps
): Promise<boolean> {
  deps.capability.assertCurrent(context)
  const approved = await confirmHostToolApproval(
    runtimeSessionId,
    'capability_install',
    summary,
    context,
    deps
  )
  deps.capability.assertCurrent(context)
  return approved
}

async function approveRemoteJupyterStart(
  identity: { runtimeSessionId: string; sessionId: string },
  info: { serverLabel: string; projectName: string },
  context: PhiHostRequestContext,
  deps: HostConfirmationDeps
): Promise<boolean> {
  const manifest = deps.sessions.findById(identity.sessionId)
  if (!manifest) throw new Error('远程 Jupyter 启动审批所属会话不可用')
  const approved = await confirmHostToolApproval(
    identity.runtimeSessionId,
    'remote_jupyter_start',
    `启动远程 Jupyter（会占用服务器资源）\n服务器：${info.serverLabel}\n项目：${info.projectName}`,
    context,
    deps
  )
  context.signal?.throwIfAborted()
  return approved
}

export function createHostConfirmations(deps: HostConfirmationDeps): {
  confirmEnvironmentBuild(request: ConfirmBuildRequest): Promise<boolean>
  confirmEnvironmentRequest(request: EnvironmentRequestConfirm): Promise<boolean>
  confirmAgentModuleInstallation(
    runtimeSessionId: string,
    summary: string,
    context: PhiHostRequestContext
  ): Promise<boolean>
  approveRemoteJupyterStart(
    identity: { runtimeSessionId: string; sessionId: string },
    info: { serverLabel: string; projectName: string },
    context: PhiHostRequestContext
  ): Promise<boolean>
  confirmHostToolApproval(
    runtimeSessionId: string,
    toolName: string,
    summary: string,
    context: PhiHostRequestContext
  ): Promise<boolean>
} {
  return {
    confirmEnvironmentBuild: (request) => confirmEnvironmentBuild(request, deps),
    confirmEnvironmentRequest: (request) => confirmEnvironmentRequest(request, deps),
    confirmAgentModuleInstallation: (runtimeSessionId, summary, context) =>
      confirmAgentModuleInstallation(runtimeSessionId, summary, context, deps),
    approveRemoteJupyterStart: (identity, info, context) =>
      approveRemoteJupyterStart(identity, info, context, deps),
    confirmHostToolApproval: (runtimeSessionId, toolName, summary, context) =>
      confirmHostToolApproval(runtimeSessionId, toolName, summary, context, deps)
  }
}
