import assert from 'node:assert/strict'
import {
  createCursorStreamRecoveryExtension,
  hasOwnedCursorContinuation,
  type CursorRecoveryAgent
} from '../../src/main/agent/engine/phi-extension/extensions/cursor-stream-recovery'

type QueueMessage = ReturnType<NonNullable<CursorRecoveryAgent['peekFollowUpQueue']>>[number]
type QueueListener = Parameters<NonNullable<CursorRecoveryAgent['onQueueChange']>>[0]
type MessageListener = Parameters<NonNullable<CursorRecoveryAgent['subscribe']>>[0]

/** Pure public-hook queue fixture; real Task and SDK queue behavior are exercised separately. */
export function childHook(kind = 'sub'): {
  start(): void
  message(signal?: AbortSignal, tools?: boolean): Promise<Record<string, unknown>>
  queued: Array<{ content: unknown }>
  pending(): readonly QueueMessage[]
  queueUser(): QueueMessage
  claim(userOnly?: boolean): void
  restore(): void
  abort(): void
  abortContinuation(): void
  consume(): void
  shutdown(): void
  listeners(): number
  ownsContinuation(): boolean
  cloneQueuedContinuation(): void
} {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>()
  const controller = new AbortController()
  const queueListeners = new Set<QueueListener>()
  const messageListeners = new Set<MessageListener>()
  let pending: QueueMessage[] = []
  let claimed: QueueMessage[] = []
  let isAborting = false
  const queued: Array<{ content: unknown }> = []
  const changed = (): void => {
    for (const listener of queueListeners) listener()
  }
  const agent: CursorRecoveryAgent = {
    followUp: (message) => {
      queued.push({ content: message.role === 'custom' ? message.content : undefined })
      pending.push(message)
      changed()
    },
    get isAborting() {
      return isAborting
    },
    peekFollowUpQueue: () => pending,
    peekUndeliveredQueuedMessages: () => claimed,
    replaceQueue: (name, messages) => {
      assert.equal(name, 'followUp', 'steering must stay untouched')
      assert.equal(claimed.length, 0, 'undelivered user records must survive')
      pending = [...messages]
      changed()
    },
    onQueueChange: (listener) => {
      queueListeners.add(listener)
      return () => {
        queueListeners.delete(listener)
      }
    },
    subscribe: (listener) => {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    }
  }
  createCursorStreamRecoveryExtension(() => agent)({
    on: (name: string, handler: (event: unknown, context: unknown) => void) =>
      handlers.set(name, handler)
  } as never)
  const start = (): void => {
    handlers.get('before_agent_start')?.({}, { agent: { kind } })
  }
  start()
  return {
    start,
    queued,
    pending: () => pending,
    ownsContinuation: () => hasOwnedCursorContinuation(agent),
    cloneQueuedContinuation: () => {
      pending = pending.map((message) => ({ ...message }))
    },
    queueUser: () => {
      const user: QueueMessage = {
        role: 'user',
        content: [{ type: 'text', text: 'user follow-up' }],
        timestamp: Date.now()
      }
      pending.push(user)
      changed()
      return user
    },
    claim: (userOnly = false) => {
      if (userOnly) {
        claimed = pending.filter((message) => message.role === 'user')
        pending = pending.filter((message) => message.role !== 'user')
      } else claimed = pending.splice(0)
      changed()
    },
    restore: () => {
      pending.unshift(...claimed)
      claimed = []
      changed()
    },
    abort: () => controller.abort(),
    abortContinuation: () => {
      isAborting = true
      changed()
    },
    consume: () => {
      const consumed = pending.splice(0)
      changed()
      for (const message of consumed)
        for (const listener of messageListeners) listener({ type: 'message_end', message })
    },
    shutdown: () => handlers.get('session_shutdown')?.({}, { agent: { kind } }),
    listeners: () => queueListeners.size + messageListeners.size,
    async message(signal = controller.signal, tools = false) {
      const message = {
        role: 'assistant',
        api: 'cursor-agent',
        stopReason: 'error',
        errorId: 0x21000,
        errorMessage: 'Cursor stream ended before turnEnded',
        content: tools
          ? [{ type: 'toolCall', id: 'completed-call', name: 'todo', arguments: {} }]
          : [{ type: 'text', text: 'retained partial' }]
      }
      await agent.transformAssistantMessage?.(message as never, signal)
      return message
    }
  }
}
