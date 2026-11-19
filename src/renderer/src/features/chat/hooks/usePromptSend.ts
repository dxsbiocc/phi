import { useCallback, useLayoutEffect, useRef } from 'react'

import type { PromptTarget } from '../../../lib/sessionTypes'
import { useSessionStore } from '../../../stores/sessionStore'
import { sendPrompt, type PromptSendDeps, type SendPromptOptions } from '../lib/promptSend'

/**
 * Binds the prompt send pipeline to the composer's shell state.
 *
 * The shell owns the state and re-renders often. A latest-value ref keeps the
 * callback stable while each send reads the current values.
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
