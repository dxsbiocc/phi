import { memo, useEffect, useState } from 'react'
import { useSortable, type AnimateLayoutChanges } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Box,
  Divider,
  IconButton,
  ListItemButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { GoDownload, GoKebabHorizontal, GoPencil, GoTrash } from 'react-icons/go'
import { SessionRenamePanel } from '../../features/session-actions/SessionRenamePanel'
import {
  sessionBeaconKind,
  sessionRunningBeaconSlotWidth,
  RUNNING_BEACON_SIZE_PX
} from '../../lib/sessionBeacon'
import {
  plainSidebarRowSx,
  ROW_LABEL_FONT_SIZE,
  ROW_META_FONT_SIZE,
  editableSessionTitle,
  sessionTitle
} from '../../lib/sessionSidebarShared'
import type { SessionRuntimeState, SessionSummary } from '../../types'

const sessionActionButtonSx = {
  width: 30,
  height: 30,
  p: 0.5,
  color: 'text.secondary',
  '&:hover': {
    bgcolor: 'transparent',
    color: 'primary.main'
  },
  '&.Mui-focusVisible': {
    outline: '2px solid',
    outlineColor: 'primary.main',
    outlineOffset: 1
  }
} as const
const sessionMenuItemSx = {
  minHeight: 36,
  mx: 0.5,
  my: 0.25,
  px: 1.5,
  py: 1,
  gap: 1.5,
  borderRadius: 1,
  fontSize: ROW_LABEL_FONT_SIZE,
  fontWeight: 500,
  '& svg': { flexShrink: 0, color: 'action.active' }
} as const
const animateSortableLayoutChanges: AnimateLayoutChanges = ({ isSorting, wasDragging }) =>
  isSorting || wasDragging

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(iso).toLocaleDateString()
}

function formatElapsedTime(iso: string, nowMs = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒`
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`
}

function sessionStatusLabel(session: SessionSummary): string | null {
  if (session.status === 'needs_approval') return '请求权限'
  if (session.status === 'needs_input') return '等待输入'
  if (session.status === 'running') return '运行中'
  if (session.status === 'failed' || session.unreadKind === 'failed') return '失败'
  if (session.status === 'completed_unread' || session.unreadKind === 'completed') return '已完成'
  return null
}

function sessionStatusColor(session: SessionSummary): string {
  if (session.status === 'needs_approval') return 'warning.main'
  if (session.status === 'needs_input') return 'warning.main'
  if (session.status === 'running') return 'info.main'
  if (session.status === 'failed' || session.unreadKind === 'failed') return 'error.main'
  if (session.status === 'completed_unread' || session.unreadKind === 'completed') {
    return 'success.main'
  }
  return 'text.disabled'
}

function SessionAttentionBeacon({
  session,
  indent
}: {
  session: SessionSummary
  indent?: boolean
}): React.JSX.Element | null {
  const kind = sessionBeaconKind(session)
  if (!kind) return null
  const isRunning = kind === 'running'
  const labelByKind = {
    running: '会话运行中',
    approval: '会话请求权限',
    input: '会话等待输入',
    failed: '会话失败未读',
    completed: '会话已完成未读'
  } satisfies Record<NonNullable<ReturnType<typeof sessionBeaconKind>>, string>

  return (
    <Box
      component="span"
      data-phi-slot="session-attention-beacon-slot"
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: `${sessionRunningBeaconSlotWidth(indent)}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        '@keyframes sessionRunningBeacon': {
          '0%, 100%': { opacity: 0.45 },
          '50%': { opacity: 1 }
        }
      }}
    >
      <Box
        component="span"
        aria-label={labelByKind[kind]}
        title={labelByKind[kind]}
        data-phi-slot="session-attention-beacon"
        data-phi-beacon-kind={kind}
        sx={{
          width: `${RUNNING_BEACON_SIZE_PX}px`,
          height: `${RUNNING_BEACON_SIZE_PX}px`,
          borderRadius: '50%',
          flexShrink: 0,
          bgcolor: sessionStatusColor(session),
          opacity: isRunning ? 0.78 : 0.95,
          boxShadow: isRunning ? 'none' : '0 0 0 3px rgba(0, 0, 0, 0.04)',
          animation: isRunning ? 'sessionRunningBeacon 1.45s ease-in-out infinite' : 'none',
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
            opacity: 0.9
          }
        }}
      />
    </Box>
  )
}

function sessionSecondaryText(session: SessionSummary, nowMs = Date.now()): string {
  const status = sessionStatusLabel(session)
  if (
    (session.status === 'running' ||
      session.status === 'needs_approval' ||
      session.status === 'needs_input') &&
    session.currentRunStartedAt
  ) {
    return `${status ?? '运行中'} · ${formatElapsedTime(session.currentRunStartedAt, nowMs)}`
  }
  const time = formatRelativeTime(session.lastActivityAt ?? session.modified)
  return status ? `${status} · ${time}` : time
}

type SessionRowProps = {
  session: SessionSummary
  runtimeState?: SessionRuntimeState | null
  isActive: boolean
  indent?: boolean
  nowMs: number
  onSelect: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onExport?: () => void
  compactHoverPreview?: boolean
  onPreviewInteractionChange?: (active: boolean) => void
}

function sessionRuntimeStatesMatch(
  left: SessionRuntimeState | null | undefined,
  right: SessionRuntimeState | null | undefined
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.status === right.status &&
    left.unreadKind === right.unreadKind &&
    left.lastRunOutcome === right.lastRunOutcome &&
    left.currentRunId === right.currentRunId &&
    left.currentRunStartedAt === right.currentRunStartedAt &&
    left.lastActivityAt === right.lastActivityAt
  )
}

function sessionSummariesMatch(left: SessionSummary, right: SessionSummary): boolean {
  if (left === right) return true
  return (
    left.path === right.path &&
    left.id === right.id &&
    left.name === right.name &&
    left.created === right.created &&
    left.modified === right.modified &&
    left.messageCount === right.messageCount &&
    left.firstMessage === right.firstMessage &&
    left.phiSessionId === right.phiSessionId &&
    sessionRuntimeStatesMatch(left, right)
  )
}

function sessionUsesLiveElapsedTime(session: SessionSummary): boolean {
  return (
    (session.status === 'running' ||
      session.status === 'needs_approval' ||
      session.status === 'needs_input') &&
    Boolean(session.currentRunStartedAt)
  )
}

function mergedSessionForDisplay({
  session,
  runtimeState
}: Pick<SessionRowProps, 'session' | 'runtimeState'>): SessionSummary {
  return runtimeState ? { ...session, ...runtimeState } : session
}

function sessionRowPropsMatch(left: SessionRowProps, right: SessionRowProps): boolean {
  if (left.isActive !== right.isActive || left.indent !== right.indent) return false
  if (
    left.compactHoverPreview !== right.compactHoverPreview ||
    left.onPreviewInteractionChange !== right.onPreviewInteractionChange
  ) {
    return false
  }
  if (!sessionSummariesMatch(left.session, right.session)) return false
  if (!sessionRuntimeStatesMatch(left.runtimeState, right.runtimeState)) return false

  const leftUsesLiveElapsedTime = sessionUsesLiveElapsedTime(mergedSessionForDisplay(left))
  const rightUsesLiveElapsedTime = sessionUsesLiveElapsedTime(mergedSessionForDisplay(right))
  if ((leftUsesLiveElapsedTime || rightUsesLiveElapsedTime) && left.nowMs !== right.nowMs) {
    return false
  }

  return true
}

const SessionRow = memo(function SessionRow({
  session,
  runtimeState,
  isActive,
  indent,
  nowMs,
  onSelect,
  onRename,
  onDelete,
  onExport,
  compactHoverPreview = false,
  onPreviewInteractionChange
}: SessionRowProps): React.JSX.Element {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [editingName, setEditingName] = useState('')
  const displaySession = mergedSessionForDisplay({ session, runtimeState })
  const hasAttentionWeight = Boolean(
    displaySession.status === 'needs_approval' ||
    displaySession.status === 'needs_input' ||
    displaySession.unreadKind
  )

  const interactionOpen = menuAnchor !== null || renameOpen
  const exportDisabled =
    displaySession.status === 'running' ||
    displaySession.status === 'needs_approval' ||
    displaySession.status === 'needs_input'
  const closeMenu = (): void => setMenuAnchor(null)
  const openRename = (): void => {
    closeMenu()
    setEditingName(editableSessionTitle(session))
    setRenameOpen(true)
  }
  const commitRename = (): void => {
    const nextName = editingName.trim()
    if (!nextName) return
    if (nextName !== editableSessionTitle(session)) onRename(nextName)
    setRenameOpen(false)
  }

  useEffect(() => {
    if (!compactHoverPreview || !interactionOpen) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [compactHoverPreview, interactionOpen, onPreviewInteractionChange])

  return (
    <>
      <Box
        data-phi-session-row-shell="true"
        sx={{
          position: 'relative',
          '&:hover .session-actions, &:focus-within .session-actions': {
            opacity: 1
          },
          '&:hover .session-time, &:focus-within .session-time': { opacity: 0 }
        }}
      >
        <ListItemButton
          selected={isActive}
          data-phi-session-row={isActive ? 'active' : 'inactive'}
          onClick={onSelect}
          sx={{
            ...plainSidebarRowSx,
            alignItems: 'center',
            minHeight: 36,
            py: 0.5,
            pl: `${sessionRunningBeaconSlotWidth(indent)}px`,
            pr: 1,
            position: 'relative',
            overflow: 'hidden',
            border: 1,
            borderColor: isActive
              ? (theme: Theme) => alpha(theme.palette.primary.main, 0.5)
              : 'transparent',
            borderRadius: isActive ? '999px' : 1.5,
            bgcolor: isActive
              ? (theme: Theme) =>
                  alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)
              : 'transparent',
            boxShadow: 'none',
            transition: 'border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease',
            '&.Mui-selected': {
              backgroundColor: isActive
                ? (theme: Theme) =>
                    `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)} !important`
                : 'transparent !important'
            },
            '&.Mui-selected:hover': {
              backgroundColor: isActive
                ? (theme: Theme) =>
                    `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)} !important`
                : 'transparent !important'
            },
            '&:hover': {
              backgroundColor: isActive
                ? (theme: Theme) =>
                    `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)} !important`
                : 'transparent !important'
            }
          }}
        >
          <SessionAttentionBeacon session={displaySession} indent={indent} />
          <Box
            sx={{
              minWidth: 0,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 0.75
            }}
          >
            <Typography
              component="span"
              noWrap
              sx={{
                minWidth: 0,
                flex: 1,
                fontSize: ROW_LABEL_FONT_SIZE,
                fontWeight: hasAttentionWeight ? 600 : 400
              }}
            >
              {sessionTitle(displaySession)}
            </Typography>
            <Typography
              component="span"
              className="session-time"
              noWrap
              sx={{
                maxWidth: 92,
                flexShrink: 0,
                textAlign: 'right',
                fontSize: ROW_META_FONT_SIZE,
                color: sessionStatusLabel(displaySession)
                  ? sessionStatusColor(displaySession)
                  : 'text.secondary',
                opacity: menuAnchor ? 0 : 1,
                transition: 'opacity 0.15s ease'
              }}
            >
              {sessionSecondaryText(displaySession, nowMs)}
            </Typography>
          </Box>
        </ListItemButton>
        <Box
          className="session-actions"
          sx={{
            position: 'absolute',
            right: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: menuAnchor ? 1 : 0,
            transition: 'opacity 0.15s ease',
            zIndex: 1,
            WebkitAppRegion: 'no-drag'
          }}
        >
          <Tooltip title="更多操作">
            <IconButton
              size="small"
              aria-label="更多会话操作"
              aria-haspopup="menu"
              aria-expanded={menuAnchor !== null}
              sx={{
                ...sessionActionButtonSx,
                ...(menuAnchor && {
                  color: 'primary.main'
                })
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                setMenuAnchor(event.currentTarget)
              }}
            >
              <GoKebabHorizontal aria-hidden size={18} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      <Menu
        anchorEl={menuAnchor}
        open={menuAnchor !== null}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              width: 208,
              borderRadius: 1.5,
              boxShadow: (theme: Theme) => theme.customShadows.dropdown
            }
          }
        }}
        sx={
          compactHoverPreview ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 1 } : undefined
        }
      >
        <MenuItem sx={sessionMenuItemSx} onClick={openRename}>
          <GoPencil aria-hidden size={18} />
          重命名
        </MenuItem>
        {session.phiSessionId && onExport && (
          <MenuItem
            disabled={exportDisabled}
            title={exportDisabled ? '运行结束后可导出' : undefined}
            sx={sessionMenuItemSx}
            onClick={() => {
              closeMenu()
              onExport()
            }}
          >
            <GoDownload aria-hidden size={18} />
            导出会话
          </MenuItem>
        )}
        <Divider sx={{ mx: 1, my: 0.75 }} />
        <MenuItem
          sx={{
            ...sessionMenuItemSx,
            color: 'error.main',
            '& svg': { flexShrink: 0, color: 'error.main' },
            '&:hover': { bgcolor: (theme: Theme) => alpha(theme.palette.error.main, 0.08) }
          }}
          onClick={() => {
            closeMenu()
            onDelete()
          }}
        >
          <GoTrash aria-hidden size={18} />
          删除
        </MenuItem>
      </Menu>
      <SessionRenamePanel
        open={renameOpen}
        title={editingName}
        compactHoverPreview={compactHoverPreview}
        onTitleChange={setEditingName}
        onClose={() => setRenameOpen(false)}
        onSave={commitRename}
      />
    </>
  )
}, sessionRowPropsMatch)

export const SortableSessionRow = memo(function SortableSessionRow(
  props: SessionRowProps
): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.session.path,
    animateLayoutChanges: animateSortableLayoutChanges
  })
  const hasSortableTransform = transform !== null

  return (
    <Box
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: isDragging || hasSortableTransform ? transition : undefined,
        opacity: isDragging ? 0.72 : undefined,
        position: 'relative',
        zIndex: isDragging ? 2 : undefined,
        willChange: isDragging || hasSortableTransform ? 'transform' : undefined
      }}
      {...attributes}
      {...listeners}
    >
      <SessionRow {...props} />
    </Box>
  )
})
