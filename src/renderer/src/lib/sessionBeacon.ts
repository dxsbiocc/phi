export const SESSION_ROW_GUTTER_PX = 16
export const INDENTED_SESSION_ROW_GUTTER_PX = 32
export const RUNNING_BEACON_SIZE_PX = 8

export type SessionBeaconKind = 'running' | 'approval' | 'failed' | 'completed'

export function sessionBeaconKind(session: {
  status: string
  unreadKind?: string | null
}): SessionBeaconKind | null {
  if (session.status === 'running') return 'running'
  if (session.status === 'needs_approval' || session.unreadKind === 'approval') return 'approval'
  if (session.status === 'failed' || session.unreadKind === 'failed') return 'failed'
  if (session.status === 'completed_unread' || session.unreadKind === 'completed')
    return 'completed'
  return null
}

export function sessionRunningBeaconSlotWidth(indent?: boolean): number {
  return indent ? INDENTED_SESSION_ROW_GUTTER_PX : SESSION_ROW_GUTTER_PX
}
