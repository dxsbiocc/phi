import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrowserOutcome,
  BrowserRendererBridge,
  BrowserUiCommand
} from '../../../../../shared/browserTypes'
import {
  createBrowserRequestIdFactory,
  createBrowserWorkspaceController,
  type BrowserWorkspaceController,
  type BrowserWorkspaceViewState
} from '../lib/browserPanelState'

const EMPTY_STATE: BrowserWorkspaceViewState = {
  snapshot: null,
  loading: false,
  busy: false,
  error: null
}
const LOADING_STATE: BrowserWorkspaceViewState = { ...EMPTY_STATE, loading: true }

interface SessionBrowserState {
  sessionId: string
  state: BrowserWorkspaceViewState
}

export interface BrowserWorkspaceHookValue extends BrowserWorkspaceViewState {
  execute(command: BrowserUiCommand): Promise<BrowserOutcome | null>
  nextRequestId(): string
}

export function useBrowserWorkspace(
  bridge: BrowserRendererBridge,
  activePhiSessionId: string | null
): BrowserWorkspaceHookValue {
  const [sessionState, setSessionState] = useState<SessionBrowserState | null>(null)
  const controllerRef = useRef<BrowserWorkspaceController | null>(null)
  const controllerSessionRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const requestIdFactoryRef = useRef(createBrowserRequestIdFactory())

  useEffect(() => {
    const generation = ++generationRef.current
    controllerRef.current?.dispose()
    controllerRef.current = null
    controllerSessionRef.current = null
    if (!activePhiSessionId) return

    const controller = createBrowserWorkspaceController({
      bridge,
      sessionId: activePhiSessionId,
      onState: (nextState) => {
        if (generationRef.current === generation) {
          setSessionState({ sessionId: activePhiSessionId, state: nextState })
        }
      }
    })
    controllerRef.current = controller
    controllerSessionRef.current = activePhiSessionId
    controller.start()
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
      if (controllerSessionRef.current === activePhiSessionId) {
        controllerSessionRef.current = null
      }
      controller.dispose()
    }
  }, [activePhiSessionId, bridge])

  const execute = useCallback(
    (command: BrowserUiCommand): Promise<BrowserOutcome | null> => {
      if (controllerSessionRef.current !== activePhiSessionId) return Promise.resolve(null)
      return controllerRef.current?.execute(command) ?? Promise.resolve(null)
    },
    [activePhiSessionId]
  )
  const nextRequestId = useCallback((): string => requestIdFactoryRef.current(), [])

  const state = !activePhiSessionId
    ? EMPTY_STATE
    : sessionState?.sessionId === activePhiSessionId
      ? sessionState.state
      : LOADING_STATE
  return { ...state, execute, nextRequestId }
}
