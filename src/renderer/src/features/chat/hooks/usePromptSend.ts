import { useCallback, useLayoutEffect, useRef } from 'react'

import type { PromptTarget } from '../../../lib/sessionTypes'
import { useSessionStore } from '../../../stores/sessionStore'
import type { SendPromptOptions } from '../lib/promptQueue'
import { sendPrompt, type PromptSendDeps } from '../lib/promptSend'

/**
 * Binds the prompt send pipeline to the composer's shell state.
 *
 * The shell owns the values (readiness, draft, setters) and re-renders often; the
 * returned sender must keep one identity so the queue drain effect does not
 * cancel its own microtask on every render. A latest-value ref gives both: the
 * send reads the current state, the callback itself never changes.
 *
 * The generation and Phi id are read at reply time rather than captured, so a
 * late reply is compared with the session that is active when it lands.
 */
const getSession = (): {
  activeSessionGeneration: number
  activePhiSessionId: string | null
} => {
  const state = useSessionStore.getState()
  return {
    activeSessionGeneration: state.activeSessionGeneration,
    activePhiSessionId: state.activePhiSessionId
  }
}

export type PromptSendInput = Omit<PromptSendDeps, 'getSession'>

export function usePromptSend(
  input: PromptSendInput
): (text: string, target: PromptTarget, options?: SendPromptOptions) => Promise<boolean> {
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  }, [input])

  return useCallback(
    (text: string, target: PromptTarget, options: SendPromptOptions = {}) =>
      sendPrompt({ ...latest.current, getSession }, text, target, options),
    []
  )
}
