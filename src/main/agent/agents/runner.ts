/**
 * Drives one sub-agent session to completion. The session itself is
 * injected (`createSession`), so this stays free of SDK/worker internals and is
 * testable with a fake — see tests/phi-agents.test.ts.
 */

/** The slice of the SDK's AgentSession this runner relies on. */
export interface AgentSessionLike {
  subscribe(listener: (event: unknown) => void): () => void
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void> | void
  getLastAssistantMessage():
    { stopReason?: string; errorMessage?: string; content?: unknown } | undefined
}

export interface AgentRunRequest {
  task: string
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

export interface AgentRunResult {
  text: string
  toolCalls: number
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

export function createAgentRunner(deps: {
  /** Agent name, used in error messages. */
  agent: string
  createSession: () => Promise<AgentSessionLike>
  timeoutMs?: number
}): (request: AgentRunRequest) => Promise<AgentRunResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async ({ task, signal, onProgress }) => {
    if (signal?.aborted) throw new AgentCancelledError(deps.agent)

    const session = await deps.createSession()
    let toolCalls = 0
    let cancelled = false
    let timedOut = false

    const unsubscribe = session.subscribe((event) => {
      if (!isRecord(event) || event.type !== 'tool_execution_start') return
      toolCalls += 1
      onProgress?.(describeToolStart(String(event.toolName ?? 'tool'), event.args))
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
