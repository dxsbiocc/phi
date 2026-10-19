import { useCallback, useState } from 'react'

import {
  idlePanelRequests,
  withBackgroundJobConsumed,
  withBackgroundJobRequest,
  withConnectorJobConsumed,
  withConnectorJobRequest,
  withTerminalInputConsumed,
  withTerminalInputRequest,
  type PanelRequestState,
  type TerminalPanelRequest
} from './panelRequests'

/**
 * Side-panel requests the shell keeps for the jobs and terminal panels.
 *
 * The panel props keep the names the shell used when this was three `useState`
 * pairs (`requestedConnectorJobId`, …), so the wiring stayed put; what moved is
 * the rule that consuming a request only clears the one still pending.
 */
export type PanelRequests = PanelRequestState & {
  requestConnectorJob: (jobId?: string) => void
  consumeConnectorJob: (handledId: string) => void
  requestBackgroundJob: (key: string) => void
  consumeBackgroundJob: (handledKey: string) => void
  requestTerminalInput: (text: string) => void
  consumeTerminalInput: (handledId: string) => void
}

export function usePanelRequests(): PanelRequests {
  const [state, setState] = useState<PanelRequestState>(idlePanelRequests)

  const requestConnectorJob = useCallback((jobId?: string): void => {
    setState((current) => withConnectorJobRequest(current, jobId ?? null))
  }, [])
  const consumeConnectorJob = useCallback((handledId: string): void => {
    setState((current) => withConnectorJobConsumed(current, handledId))
  }, [])

  const requestBackgroundJob = useCallback((key: string): void => {
    setState((current) => withBackgroundJobRequest(current, key))
  }, [])
  const consumeBackgroundJob = useCallback((handledKey: string): void => {
    setState((current) => withBackgroundJobConsumed(current, handledKey))
  }, [])

  const requestTerminalInput = useCallback((text: string): void => {
    const request: TerminalPanelRequest = { id: globalThis.crypto.randomUUID(), text }
    setState((current) => withTerminalInputRequest(current, request))
  }, [])
  const consumeTerminalInput = useCallback((handledId: string): void => {
    setState((current) => withTerminalInputConsumed(current, handledId))
  }, [])

  return {
    ...state,
    requestConnectorJob,
    consumeConnectorJob,
    requestBackgroundJob,
    consumeBackgroundJob,
    requestTerminalInput,
    consumeTerminalInput
  }
}
