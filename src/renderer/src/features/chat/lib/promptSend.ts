import type { PromptImageInput } from '../../../../../shared/promptImageTypes'
import type { SettingsCategory } from '../../../components/SettingsDialog'
import { messagesForUserRetry } from '../../../lib/chatRetry'
import { getPromptReadiness } from '../../../lib/promptReadiness'
import { sessionDraftKey, updateSessionDraft } from '../../../lib/sessionDrafts'
import { activeTabKeyAfterPrompt, workspaceSessionTabKey } from '../../../lib/workspaceResourceTabs'
import type { SendPromptOptions } from './promptQueue'
import { modelOptionFromSelection } from '../../../useModelSelection'
import type {
  ChatItem,
  ModelOption,
  PromptResult,
  PromptTarget,
  ProviderAuthStatus,
  RendererApi
} from '../../../types'
import { appCopy } from '../../../lib/appCopy'

/**
 * The prompt send pipeline.
 *
 * "Send this text" is not one call: it validates the composer and provider
 * readiness, records the user's message optimistically, dispatches, then applies
 * a receipt only when the reply still belongs to the same generation and request
 * token. The guards are the whole subject — a late reply must not steer a newer
 * session, and a failed send must give the draft back without overwriting newer
 * typing.
 *
 * The shell passes its state in; these functions do not read React state. The
 * request token and the in-flight flag stay with the caller for now, so the same
 * refs continue to guard stop generation and the event bridge.
 */

export type PromptSendReadiness = {
  modelStateReady: boolean
  providers: ProviderAuthStatus[]
  availableModels: ModelOption[]
  models: ModelOption[]
  selectedModel: ModelOption | null
  openSettings: (category?: SettingsCategory) => void
}

export type PromptSendActions = {
  updateMessages: (updater: (previous: ChatItem[]) => ChatItem[]) => void
  setIsSendingMessage: (value: boolean) => void
  setDraftImagesBySession: (
    updater: (previous: Record<string, PromptImageInput[]>) => Record<string, PromptImageInput[]>
  ) => void
  setDraftInputs: (updater: (previous: Record<string, string>) => Record<string, string>) => void
  setActiveSessionPath: (path: string) => void
  setActivePhiSessionId: (id: string) => void
  setClosedWorkspaceSessionTabKeys: (updater: (keys: Set<string>) => Set<string>) => void
  setActiveWorkspaceTabKey: (updater: (key: string | null) => string | null) => void
  setSelectedModel: (updater: (previous: ModelOption | null) => ModelOption | null) => void
  moveQueuedPromptsToSession: (key: string, target: PromptTarget) => void
  refreshSessions: () => Promise<void> | void
  showSnackbarError: (error: unknown, fallback: string) => void
}

export type PromptSendDeps = {
  rendererApi: Pick<RendererApi, 'sendPrompt' | 'getSelectedModel'>
  readiness: PromptSendReadiness
  actions: PromptSendActions
  /** Draft the prompt was typed in; the queue and failure draft are keyed by it. */
  activeDraftKey: string
  activeSessionPath: string | null
  isSendingRef: { current: boolean }
  sendRequestRef: { current: number }
  /** Live session identity, read at reply time rather than captured. */
  getSession: () => { activeSessionGeneration: number; activePhiSessionId: string | null }
}

type SendReceipt = { submitGeneration: number; sendRequest: number }

function sameGeneration(deps: PromptSendDeps, generation: number): boolean {
  return deps.getSession().activeSessionGeneration === generation
}

function isCurrentRequest(deps: PromptSendDeps, sendRequest: number): boolean {
  return sendRequest === deps.sendRequestRef.current
}

function canSend(deps: PromptSendDeps, text: string, images: PromptImageInput[]): boolean {
  if ((!text.trim() && images.length === 0) || deps.isSendingRef.current) return false
  if (images.length && deps.readiness.selectedModel?.supportsImages === false) {
    deps.actions.showSnackbarError(new Error(appCopy.imagesUnsupported), appCopy.sendImagesFailed)
    return false
  }
  const readiness = getPromptReadiness({
    modelStateReady: deps.readiness.modelStateReady,
    providers: deps.readiness.providers,
    availableModels: deps.readiness.availableModels
  })
  if (!readiness.ready) {
    if (readiness.reason !== 'providers_loading') deps.readiness.openSettings('providers')
    return false
  }
  return true
}

function appendOptimisticUserMessage(
  deps: PromptSendDeps,
  text: string,
  images: PromptImageInput[],
  options: SendPromptOptions
): void {
  if (options.retryUserMessageId) {
    deps.actions.updateMessages((prev) =>
      messagesForUserRetry(prev, options.retryUserMessageId as string)
    )
    return
  }
  if (options.appendUserMessage === false) return
  const optimisticUserMessageId = `user-${Date.now()}`
  deps.actions.updateMessages((prev) => [
    ...prev,
    {
      id: optimisticUserMessageId,
      role: 'user',
      content: text,
      ...(images.length ? { images } : {})
    }
  ])
}

async function applySendReceipt(
  deps: PromptSendDeps,
  result: PromptResult,
  target: PromptTarget
): Promise<void> {
  if (result.path) {
    const materializedQueueKey = sessionDraftKey({
      phiSessionId: result.phiSessionId ?? null,
      path: result.path,
      cwd: target.cwd,
      sessionGeneration: result.sessionGeneration
    })
    if (materializedQueueKey !== deps.activeDraftKey) {
      deps.actions.moveQueuedPromptsToSession(materializedQueueKey, {
        path: result.path,
        phiSessionId: result.phiSessionId,
        cwd: target.cwd,
        sessionGeneration: result.sessionGeneration
      })
    }
  }

  if (result.path && result.path !== deps.activeSessionPath) {
    // First prompt of a fresh chat: it just became a stable Phi session — pick it up so
    // the sidebar can highlight it.
    deps.actions.setActiveSessionPath(result.path)
  }
  if (result.path) {
    const tabKey = workspaceSessionTabKey(result.path, result.sessionGeneration)
    deps.actions.setClosedWorkspaceSessionTabKeys((keys) => {
      if (!keys.has(tabKey)) return keys
      const nextKeys = new Set(keys)
      nextKeys.delete(tabKey)
      return nextKeys
    })
    deps.actions.setActiveWorkspaceTabKey((currentKey) =>
      activeTabKeyAfterPrompt(currentKey, tabKey)
    )
  }
  if (result.phiSessionId && result.phiSessionId !== deps.getSession().activePhiSessionId) {
    deps.actions.setActivePhiSessionId(result.phiSessionId)
  }
  void deps.actions.refreshSessions()
  if (!deps.readiness.selectedModel) {
    const active = await deps.rendererApi.getSelectedModel()
    if (active) {
      deps.actions.setSelectedModel(
        (prev) => prev ?? modelOptionFromSelection(active, deps.readiness.models) ?? prev
      )
    }
  }
}

function isCurrentReply(deps: PromptSendDeps, receipt: SendReceipt, result: PromptResult): boolean {
  return (
    isCurrentRequest(deps, receipt.sendRequest) &&
    result.sessionGeneration === deps.getSession().activeSessionGeneration
  )
}

function restoreFailedDraft(
  deps: PromptSendDeps,
  text: string,
  images: PromptImageInput[],
  options: SendPromptOptions
): void {
  if (images.length && options.appendUserMessage !== false) {
    deps.actions.setDraftImagesBySession((prev) =>
      prev[deps.activeDraftKey]?.length ? prev : { ...prev, [deps.activeDraftKey]: images }
    )
    deps.actions.setDraftInputs((prev) => updateSessionDraft(prev, deps.activeDraftKey, text))
  }
}

function settleSend(deps: PromptSendDeps, receipt: SendReceipt): void {
  if (
    !isCurrentRequest(deps, receipt.sendRequest) ||
    !sameGeneration(deps, receipt.submitGeneration)
  ) {
    return
  }
  deps.isSendingRef.current = false
  deps.actions.setIsSendingMessage(false)
}

export async function sendPrompt(
  deps: PromptSendDeps,
  text: string,
  target: PromptTarget,
  options: SendPromptOptions = {}
): Promise<boolean> {
  const images = options.images ?? []
  if (!canSend(deps, text, images)) return false

  deps.isSendingRef.current = true
  const receipt: SendReceipt = {
    submitGeneration: target.sessionGeneration,
    sendRequest: ++deps.sendRequestRef.current
  }
  appendOptimisticUserMessage(deps, text, images, options)
  deps.actions.setIsSendingMessage(true)

  try {
    const result = await deps.rendererApi.sendPrompt(
      text,
      options.suppressUserMessageEvent
        ? {
            ...target,
            ...(images.length ? { images } : {}),
            ...(options.planMode ? { planMode: true } : {}),
            ...(options.planExecute ? { planExecute: true } : {}),
            suppressUserMessageEvent: true,
            ...(options.retryUserMessageId
              ? { retryUserMessageId: options.retryUserMessageId }
              : {})
          }
        : {
            ...target,
            ...(images.length ? { images } : {}),
            ...(options.planMode ? { planMode: true } : {}),
            ...(options.planExecute ? { planExecute: true } : {})
          }
    )
    if (!result || !isCurrentReply(deps, receipt, result)) return true
    await applySendReceipt(deps, result, target)
    return true
  } catch (error) {
    if (
      !isCurrentRequest(deps, receipt.sendRequest) ||
      !sameGeneration(deps, receipt.submitGeneration)
    ) {
      return true
    }
    deps.actions.showSnackbarError(error, appCopy.sendMessageFailed)
    restoreFailedDraft(deps, text, images, options)
    return true
  } finally {
    settleSend(deps, receipt)
  }
}
