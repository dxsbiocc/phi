/** Which long-lived connection to a server changed. */
export type ConnectionLayer = 'ssh' | 'kernel' | 'workspace'

export interface ConnectionEvent {
  layer: ConnectionLayer
  change: 'opened' | 'closed'
  /** The server or project the connection belongs to; never credentials. */
  target: string
  reason?: string
}

type ConnectionEventSink = (event: ConnectionEvent) => void

let sink: ConnectionEventSink | undefined

/** The app installs the log writer at startup; tests and scripts leave it unset. */
export function setConnectionEventSink(next: ConnectionEventSink | undefined): void {
  sink = next
}

export function reportConnection(event: ConnectionEvent): void {
  try {
    sink?.(event)
  } catch {
    // Reporting never affects the connection itself.
  }
}
