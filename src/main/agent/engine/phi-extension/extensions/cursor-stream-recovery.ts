import type {
  CreateAgentSessionResult,
  ExtensionContext,
  ExtensionFactory
} from '@oh-my-pi/pi-coding-agent'
import { randomUUID } from 'node:crypto'

const CURSOR_INCOMPLETE_STREAM = 'Cursor stream ended before turnEnded'
const CURSOR_CONTINUATION_CONTEXT =
  'The previous response was interrupted by the provider connection. Resume from the ' +
  'retained conversation and completed tool results; do not repeat completed work or ' +
  'side effects. Finish only the remaining response. If the task is already complete, ' +
  'confirm completion briefly.'

type Agent = CreateAgentSessionResult['session']['agent']
export type CursorRecoveryAgent = Pick<Agent, 'transformAssistantMessage'> &
  Partial<
    Pick<
      Agent,
      | 'followUp'
      | 'peekFollowUpQueue'
      | 'peekUndeliveredQueuedMessages'
      | 'replaceQueue'
      | 'onQueueChange'
      | 'subscribe'
      | 'isAborting'
    >
  >

const ownedContinuations = new WeakMap<CursorRecoveryAgent, Set<() => boolean>>()

/** Only a live, original message created by this module can authorize queued cancellation. */
export function hasOwnedCursorContinuation(agent: CursorRecoveryAgent): boolean {
  try {
    return [...(ownedContinuations.get(agent) ?? [])].some((pending) => pending())
  } catch {
    return false
  }
}

/** SDK abort preserves ordinary follow-ups; this extension owns only its generated message. */
function queueChildContinuation(
  agent: CursorRecoveryAgent,
  signal: AbortSignal | undefined,
  cleanups: Set<() => void>
): void {
  const followUp = agent.peekFollowUpQueue?.bind(agent)
  const undelivered = agent.peekUndeliveredQueuedMessages?.bind(agent)
  const enqueue = agent.followUp?.bind(agent)
  const replace = agent.replaceQueue?.bind(agent)
  const onChange = agent.onQueueChange?.bind(agent)
  const subscribe = agent.subscribe?.bind(agent)
  if (
    !signal ||
    signal.aborted ||
    !followUp ||
    !undelivered ||
    !enqueue ||
    !replace ||
    !onChange ||
    !subscribe
  )
    return
  const id = randomUUID()
  const owned = (message: ReturnType<Agent['peekFollowUpQueue']>[number]): boolean =>
    message.role === 'custom' &&
    message.customType === 'cursor-stream-continuation' &&
    !!message.details &&
    typeof message.details === 'object' &&
    (message.details as Record<string, unknown>).phiCursorRecovery === id
  let pruning = false
  let retired = false
  let cancelled = false
  let continuation: ReturnType<Agent['peekFollowUpQueue']>[number] | undefined
  const pending = (): boolean =>
    !retired &&
    !cancelled &&
    !signal.aborted &&
    agent.isAborting !== true &&
    !!continuation &&
    owned(continuation) &&
    followUp().includes(continuation) &&
    undelivered().length === 0
  const proofs = ownedContinuations.get(agent) ?? new Set<() => boolean>()
  let detach = (): void => {}
  let detachMessage = (): void => {}
  const cleanup = (): void => {
    if (retired) return
    retired = true
    detach()
    detachMessage()
    signal.removeEventListener('abort', changed)
    cleanups.delete(cleanup)
    proofs.delete(pending)
    if (!proofs.size && ownedContinuations.get(agent) === proofs) ownedContinuations.delete(agent)
    const queue = followUp()
    if (queue.some(owned) && undelivered().length === 0)
      replace(
        'followUp',
        queue.filter((message) => !owned(message))
      )
  }
  const changed = (): void => {
    if (retired || pruning) return
    cancelled ||= signal.aborted || agent.isAborting === true
    const queue = followUp()
    const present = queue.some(owned)
    // Replacing a queue also retires its in-flight delivery records. Let abort
    // restore them first so other, not-yet-recorded user messages remain intact.
    if (cancelled && present && undelivered().length === 0) {
      pruning = true
      replace(
        'followUp',
        queue.filter((message) => !owned(message))
      )
      pruning = false
    }
  }
  detach = onChange(changed)
  // Queue disappearance may only mean that asynchronous preparation claimed it.
  // Retire on actual transcript delivery; retain aborted watches until shutdown.
  detachMessage = subscribe((event) => {
    if (event.type === 'message_end' && owned(event.message)) cleanup()
    if (event.type === 'agent_end') {
      cancelled ||=
        agent.isAborting === true ||
        event.messages.some(
          (message) => message.role === 'assistant' && message.stopReason === 'aborted'
        )
      changed()
    }
  })
  signal.addEventListener('abort', changed, { once: true })
  cleanups.add(cleanup)
  proofs.add(pending)
  ownedContinuations.set(agent, proofs)
  try {
    // The public Agent API inserts synchronously: SDK image normalization cannot
    // cross stop -> idle and turn this into a new, unauthorized child prompt.
    continuation = {
      role: 'custom',
      customType: 'cursor-stream-continuation',
      content: CURSOR_CONTINUATION_CONTEXT,
      display: false,
      details: { phiCursorRecovery: id },
      attribution: 'agent',
      timestamp: Date.now()
    }
    enqueue(continuation)
    changed()
  } catch (error) {
    cleanup()
    throw error
  }
}

export function createCursorStreamRecoveryExtension(
  getAgent: (ctx: ExtensionContext) => CursorRecoveryAgent | undefined = () => undefined
): ExtensionFactory {
  return (pi) => {
    let attempted = false
    let installedAgent: CursorRecoveryAgent | undefined
    const cleanups = new Set<() => void>()
    pi.on('session_shutdown', () => {
      for (const cleanup of [...cleanups]) cleanup()
    })
    pi.on('before_agent_start', (_event, ctx) => {
      attempted = false
      const agent = getAgent(ctx)
      if (!agent || installedAgent === agent) return
      installedAgent = agent
      const child = ctx.agent.kind === 'sub'
      const previous = agent.transformAssistantMessage
      agent.transformAssistantMessage = async (message, signal) => {
        await previous?.call(agent, message, signal)
        const cursorStreamEnded =
          !signal?.aborted &&
          message.api === 'cursor-agent' &&
          message.stopReason === 'error' &&
          message.errorMessage?.trim() === CURSOR_INCOMPLETE_STREAM
        const hasToolCall = message.content.some((block) => block.type === 'toolCall')
        if (cursorStreamEnded && !hasToolCall) {
          // OMP 18.10 classifies this provider error as retryable before session_stop.
          // Keep the partial text and let Phi's single bounded continuation own recovery.
          message.errorId = 0
          if (child && !attempted) {
            // The pinned SDK skips session_stop for subagents. Its follow-up queue
            // resumes the existing agent loop without opening a new child prompt.
            attempted = true
            queueChildContinuation(agent, signal, cleanups)
          }
        }
        if (attempted || !cursorStreamEnded || !hasToolCall) return
        // The SDK already resumes interrupted tool turns only after every call is paired.
        // Normalize this equivalent provider error so that path can preserve completed work.
        attempted = true
        message.errorMessage = `stream closed before a terminal response event: ${CURSOR_INCOMPLETE_STREAM}`
      }
    })
    pi.on('session_stop', (event) => {
      const message = event.last_assistant_message
      if (
        attempted ||
        event.stop_hook_active ||
        event.signal.aborted ||
        message?.role !== 'assistant' ||
        message.api !== 'cursor-agent' ||
        message.stopReason !== 'error' ||
        message.errorMessage?.trim() !== CURSOR_INCOMPLETE_STREAM ||
        message.content.some((block) => block.type === 'toolCall')
      )
        return undefined

      // Text-only partials retain their history and use the native hidden continuation.
      attempted = true
      return {
        continue: true,
        additionalContext: CURSOR_CONTINUATION_CONTEXT
      }
    })
  }
}
