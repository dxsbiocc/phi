export interface AgentMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
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
  action?: string
  aborted?: boolean
  willRetry?: boolean
  skipped?: boolean
  errorMessage?: string
  fromProviderId?: string
  fromModelId?: string
  toProviderId?: string
  toModelId?: string
  toModelName?: string
}
