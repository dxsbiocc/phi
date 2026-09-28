import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'

import type {
  AgentUserInteractionQuestion,
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../../shared/agentInteractionTypes'

type InteractionWindow = BrowserWindow

type PendingInteraction = {
  settle: (response: AgentUserInteractionResponse) => void
}

export type AgentUserInteractionInput = {
  requestId?: string
  questions: AgentUserInteractionQuestion[]
  planReview?: AgentUserInteractionRequest['planReview']
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
}

const pendingInteractions = new Map<string, PendingInteraction>()

function isUsableWindow(window: InteractionWindow | null): window is InteractionWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed?.())
}

function addWindowUnavailableListener(window: InteractionWindow, callback: () => void): () => void {
  const webContents = window.webContents
  const onUnavailable = (): void => callback()
  const onNavigation = (...args: unknown[]): void => {
    const isInPlace = args[2]
    const isMainFrame = args[3]
    if (isInPlace === true || isMainFrame === false) return
    callback()
  }

  window.once('closed', onUnavailable)
  webContents.once('destroyed', onUnavailable)
  webContents.once('render-process-gone', onUnavailable)
  webContents.on('did-start-navigation', onNavigation)

  return () => {
    window.removeListener('closed', onUnavailable)
    webContents.removeListener('destroyed', onUnavailable)
    webContents.removeListener('render-process-gone', onUnavailable)
    webContents.removeListener('did-start-navigation', onNavigation)
  }
}

export function resolveAgentUserInteraction(
  requestId: string,
  response: AgentUserInteractionResponse,
  cancelled = false
): void {
  pendingInteractions.get(requestId)?.settle({ ...response, requestId, cancelled })
}

export function cancelAgentUserInteractions(): void {
  for (const [requestId, pending] of [...pendingInteractions.entries()]) {
    pending.settle({ requestId, answers: [], cancelled: true })
  }
}

export function waitForAgentUserInteraction(
  input: AgentUserInteractionInput,
  window: InteractionWindow,
  signals: ReadonlyArray<AbortSignal | undefined> = []
): Promise<AgentUserInteractionResponse> {
  return new Promise<AgentUserInteractionResponse>((resolve) => {
    const request: AgentUserInteractionRequest = {
      requestId: input.requestId ?? randomUUID(),
      questions: input.questions,
      ...(input.planReview ? { planReview: input.planReview } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      ...(typeof input.sessionGeneration === 'number'
        ? { sessionGeneration: input.sessionGeneration }
        : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.projectName ? { projectName: input.projectName } : {})
    }
    let settled = false
    const cleanupFns: Array<() => void> = []

    const settle = (response: AgentUserInteractionResponse): void => {
      if (settled) return
      settled = true
      pendingInteractions.delete(request.requestId)
      for (const cleanup of cleanupFns.splice(0)) {
        cleanup()
      }
      resolve(response)
    }

    pendingInteractions.set(request.requestId, { settle })

    for (const signal of signals) {
      if (!signal) continue
      if (signal.aborted) {
        settle({ requestId: request.requestId, answers: [], cancelled: true })
        return
      }
      const onAbort = (): void =>
        settle({ requestId: request.requestId, answers: [], cancelled: true })
      signal.addEventListener('abort', onAbort, { once: true })
      cleanupFns.push(() => signal.removeEventListener('abort', onAbort))
    }

    cleanupFns.push(
      addWindowUnavailableListener(window, () =>
        settle({ requestId: request.requestId, answers: [], cancelled: true })
      )
    )

    try {
      window.webContents.send('agent:interaction-request', request)
    } catch {
      settle({ requestId: request.requestId, answers: [], cancelled: true })
    }
  })
}

export function canRequestAgentUserInteraction(
  window: InteractionWindow | null
): window is InteractionWindow {
  return isUsableWindow(window)
}
