import { IPC } from '../../shared/ipcChannels'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

import type {
  AgentUserInteractionQuestion,
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../../shared/agentInteractionTypes'

type InteractionWindow = BrowserWindow

type PendingInteraction = {
  request: AgentUserInteractionRequest
  settle: (response: AgentUserInteractionResponse) => void
  /** Only the window showing the request may answer it; null while no window shows it. */
  senderId: number | null
  detachWindow: () => void
}

export type AgentUserInteractionInput = {
  requestId?: string
  questions: AgentUserInteractionQuestion[]
  planReview?: AgentUserInteractionRequest['planReview']
  missingTool?: AgentUserInteractionRequest['missingTool']
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
  cancelled = false,
  senderId?: number
): void {
  const pending = pendingInteractions.get(requestId)
  if (!pending || (senderId !== undefined && pending.senderId !== senderId)) return
  pending.settle({ ...response, requestId, cancelled })
}

export function cancelAgentUserInteractions(): void {
  for (const [requestId, pending] of [...pendingInteractions.entries()]) {
    pending.settle({ requestId, answers: [], cancelled: true })
  }
}

/**
 * Shows a pending question in `window`. Losing that window does not cancel it: the run keeps
 * waiting, and the next window to load receives it again.
 */
function showInteraction(pending: PendingInteraction, window: InteractionWindow): void {
  pending.detachWindow()
  const senderId = window.webContents.id
  pending.senderId = senderId
  const release = (): void => {
    pending.detachWindow()
    if (pending.senderId === senderId) pending.senderId = null
  }
  pending.detachWindow = addWindowUnavailableListener(window, release)
  try {
    window.webContents.send(IPC.agent.interactionRequested, pending.request)
  } catch {
    release()
  }
}

/** A newly loaded window takes over every question still waiting for an answer. */
export function showPendingAgentUserInteractions(window: InteractionWindow): void {
  if (!isUsableWindow(window)) return
  for (const pending of pendingInteractions.values()) showInteraction(pending, window)
}

export function waitForAgentUserInteraction(
  input: AgentUserInteractionInput,
  window: InteractionWindow | null,
  signals: ReadonlyArray<AbortSignal | undefined> = []
): Promise<AgentUserInteractionResponse> {
  return new Promise<AgentUserInteractionResponse>((resolve) => {
    const request: AgentUserInteractionRequest = {
      requestId: input.requestId ?? randomUUID(),
      questions: input.questions,
      ...(input.planReview ? { planReview: input.planReview } : {}),
      ...(input.missingTool ? { missingTool: input.missingTool } : {}),
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

    const pending: PendingInteraction = {
      request,
      settle,
      senderId: null,
      detachWindow: () => undefined
    }
    pendingInteractions.set(request.requestId, pending)
    cleanupFns.push(() => pending.detachWindow())

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

    if (isUsableWindow(window)) showInteraction(pending, window)
  })
}
