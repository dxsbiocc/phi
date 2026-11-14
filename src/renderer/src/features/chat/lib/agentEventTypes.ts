import type { AssistantRetryRecovery } from '../../../../../shared/assistantRetryRecoveryTypes'

export interface AgentMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
  /**
   * Present on a failed assistant attempt that an automatic retry later superseded. `recovered`
   * means the retry succeeded, so replaying this message must not add a visible error item.
   */
  retryRecovery?: AssistantRetryRecovery
  /** Assistant message timestamp; identifies the attempt a recovered retry superseded. */
  timestamp?: number
  summary?: string
  shortSummary?: string
  tokensBefore?: number
  tokensAfter?: number
  noticeText?: string
  content?: Array<{
    type?: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    arguments?: unknown
  }>
}

export interface AgentEventSummary {
  source?: string
  type: string
  phiSessionId?: string
  eventId?: string
  createdAt?: string
  runId?: string
  files?: unknown
  totalChanged?: number
  truncated?: boolean
  durationMs?: number
  approvalId?: string
  summary?: string
  shortSummary?: string
  sessionGeneration?: number
  sessionPath?: string | null
  cwd?: string
  message?: AgentMessage
  assistantMessageEvent?: {
    type?: string
    delta?: string
    contentIndex?: number
    partial?: { content?: AgentMessage['content'] }
  }
  toolCallId?: string
  toolName?: string
  args?: unknown
  output?: string
  outputPath?: string
  outputBytes?: number
  outputTruncated?: boolean
  outputArtifact?: { kind: 'tool_output'; path: string; bytes: number }
  activeCount?: number
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  agentName?: string
  agentRunId?: string
  agentSessionId?: string
  /** Why an agent run ended in error (agent_execution_completed). */
  error?: string
  /** An agent run was stopped rather than failing (agent_execution_completed). */
  cancelled?: boolean
  /** What the user told a running agent (agent_execution_steered). */
  text?: string
  task?: string
  step?: unknown
  finalReport?: string
  finalReportPath?: string
  finalReportBytes?: number
  finalReportTruncated?: boolean
  finalReportArtifact?: {
    kind: 'tool_output'
    path: string
    bytes: number
  }
  toolCalls?: number
  reason?: string
  state?: unknown
  shellJob?: unknown
  action?: string
  execute?: boolean
  aborted?: boolean
  willRetry?: boolean
  skipped?: boolean
  /** `auto_retry_end` outcome: true when the retry recovered the failed attempt. */
  success?: boolean
  /** Assistant attempts a retry saga recovered; one `auto_retry_end` can carry several. */
  retryErrors?: Array<{ retryRecovery?: AssistantRetryRecovery }>
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  finalError?: string
  errorMessage?: string
  errorCode?: string
  errorDetail?: unknown
  phase?: string
  file?: string
  bytesTransferred?: number
  totalBytes?: number
  fromProviderId?: string
  fromModelId?: string
  toProviderId?: string
  toModelId?: string
  toModelName?: string
}
