/**
 * Drives one sub-agent session to completion. The session itself is
 * injected (`createSession`), so this stays free of SDK/worker internals and is
 * testable with a fake — see tests/phi-agents.test.ts.
 */

/** The slice of the SDK's AgentSession this runner relies on. */
export interface AgentSessionLike {
  subscribe(listener: (event: unknown) => void): () => void
  prompt(text: string): Promise<void>
  /** Queues a message that reaches the agent mid-run, after its current tool call. */
  steer?(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void> | void
  getLastAssistantMessage():
    { stopReason?: string; errorMessage?: string; content?: unknown } | undefined
}

/** What a caller can do to a run while it is in flight. */
export interface AgentRunControl {
  steer(text: string): Promise<void>
}

export interface AgentRunRequest {
  task: string
  signal?: AbortSignal
  onProgress?: (line: string) => void
  onToolStep?: (step: AgentRunToolStep) => void
  /** Called once the session exists, so the caller can steer the run from then on. */
  onControl?: (control: AgentRunControl) => void
}

export interface AgentRunResult {
  text: string
  toolCalls: number
}

export type AgentToolStepStatus = 'running' | 'done' | 'error'

export interface AgentRunToolStep {
  id: string
  toolName: string
  status: AgentToolStepStatus
  args?: unknown
  output?: string
  error?: string
  createdAt?: string
  completedAt?: string
}

export class AgentCancelledError extends Error {
  constructor(readonly agent: string) {
    super(`The ${agent} agent was cancelled.`)
    this.name = 'AgentCancelledError'
  }
}

export class AgentTimeoutError extends Error {
  constructor(
    readonly agent: string,
    readonly timeoutMs: number
  ) {
    super(`The ${agent} agent timed out after ${Math.round(timeoutMs / 60000)} minute(s).`)
    this.name = 'AgentTimeoutError'
  }
}

// A backstop, not a run limit: stopping is reliable (wrapper_run kills Nextflow's process
// group), and real pipelines such as nf-core/rnaseq routinely take hours.
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000
const MAX_PROGRESS_LENGTH = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Concatenates the text parts of an assistant message, ignoring thinking and tool calls. */
export function extractAssistantText(message: unknown): string {
  if (!isRecord(message)) return ''
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''
    )
    .join('')
}

function textFromToolContentParts(content: unknown[]): string {
  return content
    .map((part) => {
      if (!isRecord(part)) return ''
      const text = part.text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

function extractToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textFromToolContentParts(value)
  if (isRecord(value)) {
    if (Array.isArray(value.content)) {
      const text = textFromToolContentParts(value.content)
      if (text) return text
    }
    if (typeof value.output === 'string') return value.output
    if (typeof value.text === 'string') return value.text
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return value == null ? '' : String(value)
}

function errorTextFromToolResult(value: unknown): string {
  if (!isRecord(value)) return ''
  if (typeof value.errorMessage === 'string') return value.errorMessage
  if (typeof value.error === 'string') return value.error
  return ''
}

const PREVIEW_ARG_KEYS = ['id', 'run_id', 'query', 'command', 'path', 'file_path', 'pattern']

/** One short line describing a tool call, e.g. `wrapper_run nf-core/modules/fastqc`. */
export function describeToolStart(toolName: string, args: unknown): string {
  let preview = ''
  if (isRecord(args)) {
    const key = PREVIEW_ARG_KEYS.find((k) => typeof args[k] === 'string' && args[k])
    if (key) preview = String(args[key]).replace(/\s+/g, ' ').trim()
  }
  const line = preview ? `${toolName} ${preview}` : toolName
  return line.length > MAX_PROGRESS_LENGTH ? `${line.slice(0, MAX_PROGRESS_LENGTH - 1)}…` : line
}

function eventString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function eventToolCallId(event: Record<string, unknown>, fallback: string): string {
  return eventString(event.toolCallId) ?? eventString(event.id) ?? fallback
}

function optionalCreatedAt(
  value: string | undefined
): { createdAt: string } | Record<string, never> {
  return value ? { createdAt: value } : {}
}

export function createAgentRunner(deps: {
  /** Agent name, used in error messages. */
  agent: string
  createSession: () => Promise<AgentSessionLike>
  timeoutMs?: number
}): (request: AgentRunRequest) => Promise<AgentRunResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async ({ task, signal, onProgress, onToolStep, onControl }) => {
    if (signal?.aborted) throw new AgentCancelledError(deps.agent)

    const session = await deps.createSession()
    onControl?.({
      steer: async (text) => {
        if (!session.steer) throw new Error(`The ${deps.agent} agent cannot be steered.`)
        await session.steer(text)
      }
    })
    let toolCalls = 0
    let cancelled = false
    let timedOut = false
    const startedAtByToolCallId = new Map<string, string | undefined>()

    const unsubscribe = session.subscribe((event) => {
      if (!isRecord(event)) return
      if (event.type === 'tool_execution_start') {
        toolCalls += 1
        const toolName = String(event.toolName ?? 'tool')
        const id = eventToolCallId(event, `${toolName}-${toolCalls}`)
        const createdAt = eventString(event.createdAt)
        startedAtByToolCallId.set(id, createdAt)
        if (onToolStep) {
          onToolStep({
            id,
            toolName,
            status: 'running',
            args: event.args,
            ...optionalCreatedAt(createdAt)
          })
        } else {
          onProgress?.(describeToolStart(toolName, event.args))
        }
        return
      }

      if (event.type === 'tool_execution_update') {
        const toolName = String(event.toolName ?? 'tool')
        const id = eventToolCallId(event, `${toolName}-${toolCalls + 1}`)
        const output = extractToolText(event.partialResult)
        if (!output || !onToolStep) return
        onToolStep({
          id,
          toolName,
          status: 'running',
          output,
          ...optionalCreatedAt(startedAtByToolCallId.get(id))
        })
        return
      }

      if (event.type === 'tool_execution_end') {
        const toolName = String(event.toolName ?? 'tool')
        const id = eventToolCallId(event, `${toolName}-${toolCalls + 1}`)
        const output = extractToolText(event.result)
        const isError = event.isError === true
        const completedAt = eventString(event.createdAt)
        onToolStep?.({
          id,
          toolName,
          status: isError ? 'error' : 'done',
          output,
          ...(isError ? { error: errorTextFromToolResult(event.result) || output } : {}),
          ...optionalCreatedAt(startedAtByToolCallId.get(id)),
          ...(completedAt ? { completedAt } : {})
        })
      }
    })

    const stop = (): void => {
      void Promise.resolve(session.abort()).catch(() => undefined)
    }
    const onAbort = (): void => {
      cancelled = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)

    try {
      await session.prompt(task)
      if (cancelled) throw new AgentCancelledError(deps.agent)
      if (timedOut) throw new AgentTimeoutError(deps.agent, timeoutMs)

      const message = session.getLastAssistantMessage()
      if (message?.stopReason === 'error') {
        throw new Error(message.errorMessage || 'The agent stopped with a model error.')
      }
      return { text: extractAssistantText(message), toolCalls }
    } catch (error) {
      if (cancelled) throw new AgentCancelledError(deps.agent)
      if (timedOut) throw new AgentTimeoutError(deps.agent, timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      await Promise.resolve(session.dispose()).catch(() => undefined)
    }
  }
}
