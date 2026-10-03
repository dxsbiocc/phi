import type { ProjectLocation } from '../../../shared/projectLocation'
import type { PromptImageInput } from '../../../shared/promptImageTypes'

export type SessionStatus =
  'idle' | 'running' | 'needs_approval' | 'needs_input' | 'failed' | 'completed_unread'
export type UnreadKind = 'completed' | 'failed' | 'approval' | 'input'
export type LastRunOutcome = 'completed' | 'failed' | 'interrupted' | 'stopped'

export interface SessionRuntimeState {
  status: SessionStatus
  unreadKind: UnreadKind | null
  lastRunOutcome?: LastRunOutcome
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

export interface SessionSummary extends SessionRuntimeState {
  path: string
  id: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  phiSessionId?: string
}

export interface SessionSwitchResult extends SessionRuntimeState {
  path: string
  phiSessionId?: string
  cwd: string
  displayCwd?: string
  projectId?: string
  projectLocation?: ProjectLocation
  sessionGeneration: number
  permissionMode: PermissionMode
  messages: unknown[]
}

export interface CurrentSession extends SessionRuntimeState {
  path: string | null
  phiSessionId?: string
  cwd: string
  displayCwd?: string
  projectId?: string
  projectLocation?: ProjectLocation
  sessionGeneration: number
  permissionMode: PermissionMode
  messages?: unknown[]
}

export interface PromptResult {
  path: string | null
  phiSessionId?: string
  sessionGeneration: number
}

export interface PromptTarget {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  images?: PromptImageInput[]
  planMode?: boolean
}

export type PermissionMode = 'auto' | 'ask' | 'full'

export interface ToolApprovalRequest {
  requestId: string
  agentRunId?: string
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  toolName: string
  summary: string
  browser?: {
    origin: string
    action: 'click' | 'typeText' | 'scroll' | 'keypress'
    consequence: 'read' | 'write' | 'irreversible'
    reason: 'external_origin' | 'form_submission' | 'irreversible'
  }
}
