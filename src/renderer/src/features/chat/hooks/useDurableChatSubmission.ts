import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { ChatQueueReceipt, ChatQueueTarget } from '../../../../../shared/chatQueueTypes'
import type { TaskEventNotice } from '../../../../../shared/taskEventTypes'
import type { PromptImageInput } from '../../../../../shared/promptImageTypes'
import { moveSessionDraft, sessionDraftKey, updateSessionDraft } from '../../../lib/sessionDrafts'
import { useSessionStore } from '../../../stores/sessionStore'
import type { CurrentSession, RendererApi } from '../../../types'
import { createChatPromptRequests } from '../lib/chatPromptRequests'

interface DurableChatSubmissionOptions {
  api: Pick<RendererApi, 'submitQueuedPrompt' | 'routeTaskEvent' | 'getCurrentSession'>
  navigationRequest: { current: number }
  setDraftImages: Dispatch<SetStateAction<Record<string, PromptImageInput[]>>>
  onMaterialized: (session: CurrentSession) => void
  onTaskEvent: (notice: TaskEventNotice) => void
  onError: (error: unknown) => void
}

function canMaterialize(target: ChatQueueTarget): boolean {
  const active = useSessionStore.getState()
  return (
    !target.phiSessionId &&
    !active.activePhiSessionId &&
    !active.isSessionChanging &&
    active.activeSessionPath === target.path &&
    active.activeCwd === target.cwd &&
    active.activeSessionGeneration === target.sessionGeneration &&
    (target.path !== null || (Boolean(target.draftId) && active.activeDraftId === target.draftId))
  )
}

interface DraftSubmission {
  key: string
  images?: PromptImageInput[]
}

function homeRequestKey(owner: string): string {
  return `home:${owner}`
}

export function useDurableChatSubmission({
  api,
  navigationRequest,
  setDraftImages,
  onMaterialized,
  onTaskEvent,
  onError
}: DurableChatSubmissionOptions): {
  draftEdited: (key: string) => void
  restoreHomeDraft: (text: string, target: CurrentSession) => void
  submit: (
    text: string,
    target: ChatQueueTarget,
    draft?: DraftSubmission
  ) => Promise<boolean | 'editable'>
} {
  const [requests] = useState(createChatPromptRequests)

  const materialize = useCallback(
    async (
      target: ChatQueueTarget,
      receipt: ChatQueueReceipt,
      navigation: number
    ): Promise<void> => {
      if (navigationRequest.current !== navigation || !canMaterialize(target)) return
      const session = await api.getCurrentSession()
      if (
        navigationRequest.current !== navigation ||
        !canMaterialize(target) ||
        session.phiSessionId !== receipt.sessionId ||
        session.path !== receipt.path
      ) {
        return
      }
      const store = useSessionStore.getState()
      const from = sessionDraftKey({ ...target, sessionGeneration: target.sessionGeneration ?? 0 })
      const to = sessionDraftKey(session)
      requests.move(from, to)
      store.setDraftInputs((previous) => moveSessionDraft(previous, from, to))
      setDraftImages((previous) => moveSessionDraft(previous, from, to))
      store.applyCurrentSession(session)
      onMaterialized(session)
    },
    [api, navigationRequest, onMaterialized, requests, setDraftImages]
  )

  const submit = useCallback(
    async (
      text: string,
      target: ChatQueueTarget,
      draft?: DraftSubmission
    ): Promise<boolean | 'editable'> => {
      const owner = sessionDraftKey({ ...target, sessionGeneration: target.sessionGeneration ?? 0 })
      const requestKey = target.retryUserMessageId
        ? `retry:${owner}:${target.retryUserMessageId}`
        : homeRequestKey(owner)
      const attempt = requests.begin(draft?.key ?? requestKey)
      if (!attempt) return true
      const navigation = navigationRequest.current
      let receipt: ChatQueueReceipt | undefined
      let keepDraft = false
      try {
        if (target.retryUserMessageId) {
          receipt = await api.submitQueuedPrompt(text.trim(), target, attempt.requestId)
        } else {
          const result = await api.routeTaskEvent(text.trim(), target, attempt.requestId)
          if (result.kind === 'submitted') {
            receipt = result.receipt
          } else {
            onTaskEvent(result)
            keepDraft = result.kind === 'clarify' || result.kind === 'unavailable'
          }
        }
      } catch (error) {
        attempt.finish(false)
        if (draft || target.retryUserMessageId) onError(error)
        return false
      }

      const key = attempt.finish(true)
      if (draft && key && !keepDraft) {
        useSessionStore
          .getState()
          .setDraftInputs((previous) =>
            previous[key] === text ? updateSessionDraft(previous, key, '') : previous
          )
        if (draft.images?.length) {
          setDraftImages((previous) => {
            if (previous[key] !== draft.images) return previous
            const next = { ...previous }
            delete next[key]
            return next
          })
        }
      }
      useSessionStore.getState().scheduleSessionRefresh()
      // The acceptance is already durable even if the adoption fetch fails or the user navigates.
      if (receipt) void materialize(target, receipt, navigation).catch(onError)
      return keepDraft && !draft ? 'editable' : true
    },
    [api, materialize, navigationRequest, onError, onTaskEvent, requests, setDraftImages]
  )

  const restoreHomeDraft = useCallback(
    (text: string, target: CurrentSession): void => {
      const key = sessionDraftKey(target)
      const store = useSessionStore.getState()
      if (!store.draftInputs[key]) requests.move(homeRequestKey(key), key)
      store.setDraftInputs((previous) =>
        updateSessionDraft(previous, key, [text, previous[key]].filter(Boolean).join('\n\n'))
      )
    },
    [requests]
  )

  return { submit, draftEdited: requests.edited, restoreHomeDraft }
}
