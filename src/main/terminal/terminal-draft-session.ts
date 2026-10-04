import { extractAssistantText } from '../agent/agents/runner'
import type { createAgentSession } from '../agent/session/session-manager'
import type {
  CreateAgentSessionOptions,
  ModelRuntime,
  RuntimeModel,
  RuntimeSessionManager,
  ThinkingLevel
} from '../agent/runtime/runtime-adapter'
import { TerminalError } from './terminal-error'
import type {
  TerminalDraftSessionContext,
  TerminalDraftSessionFactory
} from './terminal-command-draft'

type MaybePromise<T> = T | Promise<T>

export interface TerminalDraftResolvedSession {
  modelRuntime: ModelRuntime
  model?: RuntimeModel | null
  thinkingLevel?: ThinkingLevel
}

export interface TerminalDraftSessionFactoryBuilderOptions {
  createAgentSession: typeof createAgentSession
  createSessionManager: (cwd: string) => RuntimeSessionManager
  resolveSession: (
    context: TerminalDraftSessionContext
  ) => MaybePromise<TerminalDraftResolvedSession>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assistantMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => assistantMessages(item))
  if (!isRecord(value)) return []
  return [
    ...(value.role === 'assistant' ? [value] : []),
    ...assistantMessages(value.message),
    ...assistantMessages(value.messages),
    ...assistantMessages(value.result)
  ]
}

function eventAssistantText(summary: Record<string, unknown>, current: string): string {
  const event = isRecord(summary.assistantMessageEvent) ? summary.assistantMessageEvent : undefined
  if (
    summary.type === 'message_update' &&
    event?.type === 'text_delta' &&
    typeof event.delta === 'string'
  ) {
    return `${current}${event.delta}`
  }

  const candidates = [
    event?.message,
    event?.partial,
    summary.message,
    summary.messages,
    summary.result
  ].flatMap((value) => assistantMessages(value))
  const text = extractAssistantText(candidates.at(-1)).trim()
  return text || current
}

export function buildTerminalDraftSessionFactory(
  options: TerminalDraftSessionFactoryBuilderOptions
): TerminalDraftSessionFactory {
  return async (context) => {
    const resolved = await options.resolveSession(context)
    if (!resolved.model) throw new TerminalError('unavailable', '请先配置模型')

    let streamedText = ''
    const sessionOptions: CreateAgentSessionOptions = {
      modelRuntime: resolved.modelRuntime,
      model: resolved.model,
      cwd: context.cwd,
      noTools: 'all',
      sessionManager: options.createSessionManager(context.cwd),
      ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {})
    }
    const { session } = await options.createAgentSession(sessionOptions, (summary) => {
      streamedText = eventAssistantText(summary, streamedText)
    })

    return {
      prompt: async (text) => {
        await session.prompt(text, {
          expandPromptTemplates: false,
          userInitiated: true,
          skipCompactionCheck: true
        })
      },
      assistantText: () => {
        const lastAssistant = [...session.messages]
          .reverse()
          .find((message) => isRecord(message) && message.role === 'assistant')
        return extractAssistantText(lastAssistant).trim() || streamedText.trim()
      },
      abort: async () => await session.abort(),
      dispose: async () => await session.dispose()
    }
  }
}
