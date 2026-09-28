// Non-component helpers shared by SessionSidebar, ProjectRow, and SessionRow.
// Kept out of session-sidebar/SessionRow.tsx (a component file) because
// react-refresh only supports fast-refreshing files that export components
// alone.
import { useCallback, useMemo, useState } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import {
  orderSessionsForDisplay,
  readSessionOrder,
  reconcileSessionOrder,
  sessionPaths,
  writeSessionOrder
} from './sessionOrder'
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

export function useSessionOrder(
  scopeKey: string,
  sessions: SessionSummary[]
): {
  orderedSessions: SessionSummary[]
  handleDragEnd: (event: DragEndEvent) => void
} {
  const [storedOrder, setStoredOrder] = useState<{ scopeKey: string; order: string[] }>(() => ({
    scopeKey,
    order: readSessionOrder(scopeKey)
  }))

  const order = storedOrder.scopeKey === scopeKey ? storedOrder.order : readSessionOrder(scopeKey)
  const orderedSessions = useMemo(
    () => (order.length > 0 ? orderSessionsForDisplay(sessions, order) : sessions),
    [sessions, order]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const activePath = String(active.id)
      const overPath = String(over.id)

      setStoredOrder((previous) => {
        const previousOrder =
          previous.scopeKey === scopeKey ? previous.order : readSessionOrder(scopeKey)
        const current = reconcileSessionOrder(
          sessions,
          previousOrder.length > 0 ? previousOrder : sessionPaths(sessions)
        )
        const activeIndex = current.indexOf(activePath)
        const overIndex = current.indexOf(overPath)
        if (activeIndex < 0 || overIndex < 0) return previous

        const next = arrayMove(current, activeIndex, overIndex)
        writeSessionOrder(scopeKey, next)
        return { scopeKey, order: next }
      })
    },
    [scopeKey, sessions]
  )

  return { orderedSessions, handleDragEnd }
}
