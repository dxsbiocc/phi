// Non-component helpers shared by SessionSidebar, ProjectRow, and SessionRow.
import type { SessionSummary } from '../types'
import { messageContentTitleText } from '../../../shared/sessionTitle'

// One consistent scale for every row/button label in the sidebar — mixing
// MUI's own defaults (Button ~14px, ListItemText primary ~16px) made items
// that sit right next to each other read as visually mismatched.
export const ROW_LABEL_FONT_SIZE = '0.875rem'
export const ROW_META_FONT_SIZE = '0.8rem'
export const plainSidebarRowSx = {
  backgroundColor: 'transparent !important',
  '&:hover': { backgroundColor: 'transparent !important' },
  '&.Mui-selected': {
    backgroundColor: 'transparent !important'
  },
  '&.Mui-selected:hover': { backgroundColor: 'transparent !important' }
} as const

export function editableSessionTitle(session: SessionSummary): string {
  return (
    messageContentTitleText(session.name) ||
    messageContentTitleText(session.firstMessage) ||
    '新对话'
  )
}

export function sessionTitle(session: SessionSummary): string {
  const raw = editableSessionTitle(session)
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
}
