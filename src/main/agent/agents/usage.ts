import { redactSensitiveText } from '../redaction'

/**
 * What one delegated agent run cost, recorded so prompt and tool changes can be judged on
 * numbers. Sizes and names only: the task, argument values and tool output are never stored.
 */

export type AgentRunStatus = 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface AgentTokenUsage {
  /** Prompt tokens that were not served from cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Reasoning tokens, a subset of `output`, counted only where the provider reports them. */
  reasoning: number
  total: number
}

export interface AgentToolUsage {
  name: string
  /** Top-level argument names only, sorted; whether a call named its database says much about accuracy. */
  argKeys: string[]
  argChars: number
  resultChars: number
  durationMs?: number
  isError: boolean
  /** First words of the error, redacted; the reason a call was rejected. */
  errorHead?: string
  /** The run ended before this call did. */
  unfinished?: true
}

export interface AgentRunUsageRecord {
  version: 1
  /** When the run started, ISO. */
  timestamp: string
  agent: string
  /** The registry's id for the run, matching its card in the UI. */
  runId?: string
  /** The conversation that delegated it. */
  sessionId?: string
  status: AgentRunStatus
  model?: string
  durationMs: number
  taskChars: number
  reportChars: number
  /** Model calls made. */
  turns: number
  /**
   * Prompt size of the first model call: system prompt, tool schemas and the task, before the
   * agent has done anything. What every delegation costs regardless of the question.
   */
  firstTurnPromptTokens?: number
  usage: AgentTokenUsage
  toolCalls: number
  toolErrors: number
  toolResultChars: number
  tools: AgentToolUsage[]
  /** `tools` was cut at the cap; the counts above still cover every call. */
  toolsTruncated?: true
}

const MAX_TOOL_RECORDS = 100
const MAX_ERROR_HEAD_CHARS = 160

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

interface OpenTool {
  index: number
  startedAt: number
}

export class AgentUsageCollector {
  private readonly startedAt: number
  private readonly startedIso: string
  private readonly usage: AgentTokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0
  }
  private readonly tools: AgentToolUsage[] = []
  private readonly open = new Map<string, OpenTool>()
  private turns = 0
  private firstTurnPromptTokens: number | undefined
  private model: string | undefined
  private toolCalls = 0
  private toolErrors = 0
  private toolResultChars = 0

  constructor(
    private readonly options: {
      agent: string
      task: string
      runId?: string
      /** Milliseconds; injectable so tests do not depend on wall time. */
      clock?: () => number
    }
  ) {
    this.startedAt = this.now()
    this.startedIso = new Date().toISOString()
  }

  private now(): number {
    return (this.options.clock ?? Date.now)()
  }

  /** Takes one assistant message from the session; only messages that carry usage count as a model call. */
  assistantMessage(message: unknown): void {
    if (!isRecord(message) || message.role !== 'assistant' || !isRecord(message.usage)) return
    const usage = message.usage
    const input = count(usage.input)
    const output = count(usage.output)
    const cacheRead = count(usage.cacheRead)
    const cacheWrite = count(usage.cacheWrite)
    this.turns += 1
    this.usage.input += input
    this.usage.output += output
    this.usage.cacheRead += cacheRead
    this.usage.cacheWrite += cacheWrite
    this.usage.reasoning += count(usage.reasoningTokens)
    this.usage.total += count(usage.totalTokens) || input + output + cacheRead + cacheWrite
    if (this.firstTurnPromptTokens === undefined) {
      this.firstTurnPromptTokens = input + cacheRead + cacheWrite
    }
    if (typeof message.model === 'string' && message.model) this.model = message.model
  }

  toolStarted(id: string, name: string, args: unknown): void {
    this.toolCalls += 1
    const argKeys = isRecord(args) ? Object.keys(args).sort() : []
    const record: AgentToolUsage = {
      name,
      argKeys,
      argChars: jsonChars(args),
      resultChars: 0,
      isError: false
    }
    if (this.tools.length < MAX_TOOL_RECORDS) {
      this.open.set(id, { index: this.tools.length, startedAt: this.now() })
      this.tools.push(record)
    }
  }

  toolEnded(
    id: string,
    result: { resultChars: number; isError: boolean; errorText?: string }
  ): void {
    this.toolResultChars += result.resultChars
    if (result.isError) this.toolErrors += 1
    const open = this.open.get(id)
    if (!open) return
    this.open.delete(id)
    this.tools[open.index] = {
      ...this.tools[open.index],
      resultChars: result.resultChars,
      durationMs: this.now() - open.startedAt,
      isError: result.isError,
      ...(result.isError && result.errorText
        ? { errorHead: redactSensitiveText(result.errorText).slice(0, MAX_ERROR_HEAD_CHARS) }
        : {})
    }
  }

  finish(status: AgentRunStatus, report: string): AgentRunUsageRecord {
    return {
      version: 1,
      timestamp: this.startedIso,
      agent: this.options.agent,
      ...(this.options.runId ? { runId: this.options.runId } : {}),
      status,
      ...(this.model ? { model: this.model } : {}),
      durationMs: this.now() - this.startedAt,
      taskChars: this.options.task.length,
      reportChars: report.length,
      turns: this.turns,
      ...(this.firstTurnPromptTokens === undefined
        ? {}
        : { firstTurnPromptTokens: this.firstTurnPromptTokens }),
      usage: { ...this.usage },
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      toolResultChars: this.toolResultChars,
      // Calls still open when the run ended (cancelled, timed out) never got a result.
      tools: this.tools.map((tool, index) =>
        [...this.open.values()].some((open) => open.index === index)
          ? { ...tool, unfinished: true as const }
          : tool
      ),
      ...(this.toolCalls > this.tools.length ? { toolsTruncated: true as const } : {})
    }
  }
}
