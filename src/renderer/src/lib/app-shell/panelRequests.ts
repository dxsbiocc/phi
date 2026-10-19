/**
 * One-shot requests from chat into a workspace side-panel surface.
 *
 * A link such as "open this connector's jobs" does not belong to the jobs panel
 * permanently: it is a value the panel consumes once an item scrolls into view.
 * The panel reports back the id it handled, and the request is cleared only if it
 * is still the current one — a slow panel must not erase a request that arrived
 * after it.
 *
 * The shell owns the state; these transitions are pure so the "consume the right
 * request" rule is testable without a renderer.
 */

export type TerminalPanelRequest = { id: string; text: string }

export type PanelRequestState = {
  connectorJobId: string | null
  backgroundJobKey: string | null
  terminalInput: TerminalPanelRequest | null
}

export const idlePanelRequests: PanelRequestState = {
  connectorJobId: null,
  backgroundJobKey: null,
  terminalInput: null
}

export function withConnectorJobRequest(
  state: PanelRequestState,
  jobId: string | null
): PanelRequestState {
  return state.connectorJobId === jobId ? state : { ...state, connectorJobId: jobId }
}

export function withConnectorJobConsumed(
  state: PanelRequestState,
  handledId: string
): PanelRequestState {
  return state.connectorJobId === handledId ? { ...state, connectorJobId: null } : state
}

export function withBackgroundJobRequest(state: PanelRequestState, key: string): PanelRequestState {
  return state.backgroundJobKey === key ? state : { ...state, backgroundJobKey: key }
}

export function withBackgroundJobConsumed(
  state: PanelRequestState,
  handledKey: string
): PanelRequestState {
  return state.backgroundJobKey === handledKey ? { ...state, backgroundJobKey: null } : state
}

export function withTerminalInputRequest(
  state: PanelRequestState,
  request: TerminalPanelRequest
): PanelRequestState {
  return { ...state, terminalInput: request }
}

export function withTerminalInputConsumed(
  state: PanelRequestState,
  handledId: string
): PanelRequestState {
  return state.terminalInput?.id === handledId ? { ...state, terminalInput: null } : state
}
