import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  type AnimateLayoutChanges,
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Box,
  Button,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PhiIcons } from '../icons'
import { resolveProjectExpandedIds } from '../lib/projectSidebar'
import { SessionDeleteDialogs } from './session-sidebar/SessionDeleteDialogs'
import {
  RUNNING_BEACON_SIZE_PX,
  sessionBeaconKind,
  sessionRunningBeaconSlotWidth
} from '../lib/sessionBeacon'
import {
  orderSessionsForDisplay,
  preserveSessionListOrder,
  readSessionOrder,
  reconcileSessionOrder,
  sessionPaths,
  writeSessionOrder
} from '../lib/sessionOrder'
import type { Project, SessionRuntimeState, SessionSummary } from '../types'
import { messageContentTitleText } from '../../../shared/sessionTitle'

const AddIcon = PhiIcons.action.add
const AddCommentIcon = PhiIcons.action.addSession
const CheckIcon = PhiIcons.state.check
const CloseIcon = PhiIcons.action.close
const DeleteIcon = PhiIcons.action.delete
const EditIcon = PhiIcons.action.edit
const ExpandMoreIcon = PhiIcons.action.expand
const FolderIcon = PhiIcons.entity.folder
const MoreHorizIcon = PhiIcons.action.more

// One consistent scale for every row/button label in the sidebar — mixing
// MUI's own defaults (Button ~14px, ListItemText primary ~16px) made items
// that sit right next to each other read as visually mismatched.
const ROW_LABEL_FONT_SIZE = '0.875rem'
const ROW_META_FONT_SIZE = '0.8rem'
const CONTENT_TOP_GAP = 1
const HOVER_PREVIEW_MAX_HEIGHT = 'min(420px, calc(100vh - 96px))'
const HOVER_PREVIEW_LIST_MAX_HEIGHT = 'min(320px, calc(100vh - 176px))'
const sessionActionButtonSx = {
  width: 26,
  height: 26,
  p: 0,
  borderRadius: 1.25,
  '& svg': {
    fontSize: 16
  }
} as const
const plainSidebarRowSx = {
  backgroundColor: 'transparent !important',
  '&:hover': { backgroundColor: 'transparent !important' },
  '&.Mui-selected': {
    backgroundColor: 'transparent !important'
  },
  '&.Mui-selected:hover': { backgroundColor: 'transparent !important' }
} as const
const CONVERSATION_SESSION_ORDER_SCOPE = 'conversation'
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

function sessionTitle(session: SessionSummary): string {
  const raw =
    messageContentTitleText(session.name) ||
    messageContentTitleText(session.firstMessage) ||
    '新对话'
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
}

function sessionStatusLabel(session: SessionSummary): string | null {
  if (session.status === 'needs_approval') return '请求权限'
  if (session.status === 'running') return '运行中'
  if (session.status === 'failed' || session.unreadKind === 'failed') return '失败'
  if (session.status === 'completed_unread' || session.unreadKind === 'completed') return '已完成'
  return null
}

function projectGitStatusLabel(project: Project): string | null {
  if (!project.gitStatus) return null
  return project.gitStatus.dirty ? `${project.gitStatus.branch} · 有改动` : project.gitStatus.branch
}

function sessionStatusColor(session: SessionSummary): string {
  if (session.status === 'needs_approval') return 'warning.main'
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
    (session.status === 'running' || session.status === 'needs_approval') &&
    session.currentRunStartedAt
  ) {
    return `${status ?? '运行中'} · ${formatElapsedTime(session.currentRunStartedAt, nowMs)}`
  }
  const time = formatRelativeTime(session.lastActivityAt ?? session.modified)
  return status ? `${status} · ${time}` : time
}

// macOS's traffic-light window controls float over the top-left of the window
// (see the frameless BrowserWindow setup in main/index.ts) — reserve room so
// nothing sits under them, and make this strip draggable.
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

function useSessionOrder(
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

type SessionRowProps = {
  session: SessionSummary
  runtimeState?: SessionRuntimeState | null
  isActive: boolean
  indent?: boolean
  nowMs: number
  onSelect: () => void
  onRename: (name: string) => void
  onDelete: () => void
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
    (session.status === 'running' || session.status === 'needs_approval') &&
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
  onDelete
}: SessionRowProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editingName, setEditingName] = useState(sessionTitle(session))
  const displaySession = mergedSessionForDisplay({ session, runtimeState })

  const commitRename = (): void => {
    if (editingName.trim()) onRename(editingName.trim())
    setIsEditing(false)
  }

  return (
    <ListItemButton
      selected={isActive}
      onClick={() => {
        if (!isEditing) onSelect()
      }}
      sx={{
        ...plainSidebarRowSx,
        alignItems: 'center',
        minHeight: 36,
        py: 0.5,
        pl: `${sessionRunningBeaconSlotWidth(indent)}px`,
        pr: 1,
        position: 'relative',
        border: 1,
        borderColor: isActive ? 'primary.main' : 'transparent',
        boxShadow: isActive
          ? (theme: Theme) => `inset 3px 0 0 ${theme.palette.primary.main}`
          : 'none',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        '&:hover .session-actions': { opacity: 1 },
        '&:hover .session-time': { opacity: 0 }
      }}
    >
      <SessionAttentionBeacon session={displaySession} indent={indent} />
      {isEditing ? (
        <TextField
          autoFocus
          size="small"
          fullWidth
          value={editingName}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setEditingName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') setIsEditing(false)
          }}
          slotProps={{
            input: {
              endAdornment: (
                <Stack direction="row">
                  <IconButton
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation()
                      commitRename()
                    }}
                  >
                    <CheckIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation()
                      setIsEditing(false)
                    }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Stack>
              )
            }
          }}
        />
      ) : (
        <>
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
                fontWeight:
                  isActive ||
                  displaySession.status === 'needs_approval' ||
                  displaySession.unreadKind
                    ? 600
                    : 400
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
                transition: 'opacity 0.15s ease'
              }}
            >
              {sessionSecondaryText(displaySession, nowMs)}
            </Typography>
          </Box>
          <Stack
            direction="row"
            className="session-actions"
            sx={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              opacity: 0,
              transition: 'opacity 0.15s ease',
              flexShrink: 0,
              bgcolor: 'background.default'
            }}
          >
            <Tooltip title="重命名">
              <IconButton
                size="small"
                sx={sessionActionButtonSx}
                onClick={(event) => {
                  event.stopPropagation()
                  setEditingName(sessionTitle(session))
                  setIsEditing(true)
                }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="删除">
              <IconButton
                size="small"
                sx={sessionActionButtonSx}
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete()
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </>
      )}
    </ListItemButton>
  )
}, sessionRowPropsMatch)

const SortableSessionRow = memo(function SortableSessionRow(
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
}, sessionRowPropsMatch)

type ProjectRowProps = {
  project: Project
  expanded: boolean
  refreshKey: number
  onToggleExpanded: () => void
  activeSessionPath: string | null
  onStartChat: () => void
  onSelectSession: (path: string) => void
  onRenameSession: (path: string, name: string) => void
  onDeleteSession: (path: string) => void
  onDeleteProject: () => void
  onFetchSessions: (workingDirectory: string) => Promise<SessionSummary[]>
  getSessionRuntimeState?: (path: string, cwd: string) => SessionRuntimeState | null
  compactHoverPreview?: boolean
  onPreviewInteractionChange?: (active: boolean) => void
  nowMs: number
}

function ProjectRow({
  project,
  expanded,
  refreshKey,
  onToggleExpanded,
  activeSessionPath,
  onStartChat,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onDeleteProject,
  onFetchSessions,
  getSessionRuntimeState,
  compactHoverPreview = false,
  onPreviewInteractionChange,
  nowMs
}: ProjectRowProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const gitStatusLabel = projectGitStatusLabel(project)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const { orderedSessions, handleDragEnd } = useSessionOrder(
    `project:${project.workingDirectory}`,
    sessions ?? []
  )

  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    void onFetchSessions(project.workingDirectory).then((nextSessions) => {
      if (!cancelled) {
        setSessions((previous) => preserveSessionListOrder(previous ?? [], nextSessions))
      }
    })
    return () => {
      cancelled = true
    }
  }, [expanded, onFetchSessions, project.workingDirectory, refreshKey])

  const handleToggle = async (): Promise<void> => {
    onToggleExpanded()
  }
  const closeProjectMenu = useCallback((): void => {
    setMenuAnchor(null)
  }, [])

  useEffect(() => {
    if (!compactHoverPreview || menuAnchor === null) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [compactHoverPreview, menuAnchor, onPreviewInteractionChange])

  return (
    <Box>
      <ListItemButton
        onClick={() => void handleToggle()}
        sx={{
          ...plainSidebarRowSx,
          // Cancel the global MuiListItemButton left/right margin (theme.ts) so this
          // top-level row's icon lines up flush with the "项目" header above it —
          // only nested SessionRows (indent prop) are meant to sit further in.
          marginLeft: 0,
          marginRight: 0,
          '&:hover .project-actions': { opacity: 1 },
          '&:hover .project-toggle-icon': { opacity: 1 }
        }}
      >
        <FolderIcon fontSize="small" sx={{ mr: 1.5, flexShrink: 0, color: 'text.secondary' }} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Box sx={{ display: 'inline-flex', maxWidth: '100%', alignItems: 'center', gap: 0.75 }}>
            <Typography component="span" noWrap sx={{ minWidth: 0, fontSize: ROW_LABEL_FONT_SIZE }}>
              {project.name}
            </Typography>
            <ExpandMoreIcon
              className="project-toggle-icon"
              sx={{
                opacity: 0,
                flexShrink: 0,
                fontSize: '1rem',
                color: 'text.secondary',
                transition: 'opacity 0.15s ease, transform 0.15s ease',
                transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)'
              }}
            />
          </Box>
          {gitStatusLabel ? (
            <Typography
              component="div"
              noWrap
              sx={{
                fontSize: ROW_META_FONT_SIZE,
                color: project.gitStatus?.dirty ? 'warning.main' : 'text.secondary'
              }}
            >
              {gitStatusLabel}
            </Typography>
          ) : null}
        </Box>
        <Stack
          direction="row"
          className="project-actions"
          sx={{
            opacity: 0,
            flexShrink: 0,
            transition: 'opacity 0.15s ease'
          }}
        >
          <Tooltip title="更多">
            <IconButton
              size="small"
              onClick={(event) => {
                event.stopPropagation()
                setMenuAnchor(event.currentTarget)
              }}
            >
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="新对话">
            <IconButton
              size="small"
              onClick={(event) => {
                event.stopPropagation()
                onStartChat()
              }}
            >
              <AddCommentIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </ListItemButton>

      <Menu
        anchorEl={menuAnchor}
        open={menuAnchor !== null}
        onClose={closeProjectMenu}
        sx={
          compactHoverPreview ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 1 } : undefined
        }
      >
        <MenuItem
          onClick={() => {
            closeProjectMenu()
            onDeleteProject()
          }}
        >
          删除项目
        </MenuItem>
      </Menu>

      <Collapse in={expanded} unmountOnExit>
        {sessions && sessions.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedSessions.map((session) => session.path)}
              strategy={verticalListSortingStrategy}
            >
              {orderedSessions.map((session) => (
                <SortableSessionRow
                  key={session.path}
                  session={session}
                  runtimeState={
                    getSessionRuntimeState?.(session.path, project.workingDirectory) ?? null
                  }
                  isActive={session.path === activeSessionPath}
                  indent
                  nowMs={nowMs}
                  onSelect={() => onSelectSession(session.path)}
                  onRename={(name) => onRenameSession(session.path, name)}
                  onDelete={() => onDeleteSession(session.path)}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
        {sessions && sessions.length === 0 && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ pl: 4, pr: 1, py: 0.75, fontSize: ROW_META_FONT_SIZE }}
          >
            暂无对话
          </Typography>
        )}
      </Collapse>
    </Box>
  )
}

type SessionSidebarProps = {
  mode: 'conversations' | 'projects'
  hideWindowDragSpacer?: boolean
  compactHoverPreview?: boolean
  onPreviewInteractionChange?: (active: boolean) => void
  sessions: SessionSummary[]
  activeSessionPath: string | null
  activeCwd: string
  projects: Project[]
  projectSessionRefreshKey: number
  onNewChat: () => void
  onNewProject: () => void
  onSelectSession: (path: string) => void
  onRenameSession: (path: string, name: string) => void
  onDeleteSession: (path: string) => void
  onStartProjectChat: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onFetchProjectSessions: (workingDirectory: string) => Promise<SessionSummary[]>
  getSessionRuntimeState?: (path: string, cwd: string) => SessionRuntimeState | null
}

function SessionSidebar({
  mode,
  hideWindowDragSpacer = false,
  compactHoverPreview = false,
  onPreviewInteractionChange,
  sessions,
  activeSessionPath,
  activeCwd,
  projects,
  projectSessionRefreshKey,
  onNewChat,
  onNewProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onStartProjectChat,
  onDeleteProject,
  onFetchProjectSessions,
  getSessionRuntimeState
}: SessionSidebarProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [projectExpansionOverrides, setProjectExpansionOverrides] = useState<
    Record<string, boolean | undefined>
  >({})
  const expandedProjectIds = resolveProjectExpandedIds(
    projectExpansionOverrides,
    mode,
    projects,
    activeCwd
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const { orderedSessions, handleDragEnd } = useSessionOrder(
    CONVERSATION_SESSION_ORDER_SCOPE,
    sessions
  )
  const previewDialogOpen =
    compactHoverPreview && (deleteTarget !== null || deleteProjectTarget !== null)

  useEffect(() => {
    if (!previewDialogOpen) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [onPreviewInteractionChange, previewDialogOpen])

  const hasActiveAttention =
    mode === 'projects' ||
    sessions.some((session) => {
      const runtimeState = getSessionRuntimeState?.(session.path, activeCwd) ?? null
      const status = runtimeState?.status ?? session.status
      return status === 'running' || status === 'needs_approval'
    })

  useEffect(() => {
    if (!hasActiveAttention) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActiveAttention])

  const toggleProjectExpanded = (id: string): void => {
    const isExpanded = expandedProjectIds.has(id)
    setProjectExpansionOverrides((prev) => ({ ...prev, [id]: !isExpanded }))
  }

  const isProjectsMode = mode === 'projects'
  const isConversationsMode = mode === 'conversations'

  return (
    <Box
      className="app-sidebar-surface"
      data-phi-session-sidebar-variant={compactHoverPreview ? 'hover-preview' : 'sidebar'}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        minWidth: 0,
        height: compactHoverPreview ? 'auto' : '100%',
        maxHeight: compactHoverPreview ? HOVER_PREVIEW_MAX_HEIGHT : undefined,
        backgroundColor: 'background.default'
      }}
    >
      {!hideWindowDragSpacer ? (
        // No label here by design — this strip exists only so macOS's traffic
        // lights have room, and so the window has something to drag by.
        <Box
          sx={{
            flexShrink: 0,
            minHeight: 44,
            pl: isMac ? '80px' : '16px'
          }}
        />
      ) : null}

      <Stack
        spacing={1}
        sx={{
          px: compactHoverPreview ? 1 : 1.5,
          pt: compactHoverPreview ? 1 : CONTENT_TOP_GAP,
          pb: compactHoverPreview ? 0.75 : 1,
          flexShrink: 0,
          backgroundColor: 'transparent !important'
        }}
      >
        {isProjectsMode ? (
          <Button
            fullWidth
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={onNewProject}
            sx={{
              minHeight: compactHoverPreview ? 38 : 44,
              justifyContent: 'flex-start',
              fontSize: ROW_LABEL_FONT_SIZE
            }}
          >
            新建项目
          </Button>
        ) : (
          <Button
            fullWidth
            variant="outlined"
            startIcon={<AddCommentIcon />}
            onClick={onNewChat}
            sx={{
              minHeight: compactHoverPreview ? 38 : 44,
              justifyContent: 'flex-start',
              fontSize: ROW_LABEL_FONT_SIZE
            }}
          >
            新对话
          </Button>
        )}
      </Stack>

      <List
        sx={{
          flex: compactHoverPreview ? '0 1 auto' : 1,
          minHeight: 0,
          maxHeight: compactHoverPreview ? HOVER_PREVIEW_LIST_MAX_HEIGHT : undefined,
          overflowY: 'auto',
          px: 0.5,
          pb: compactHoverPreview ? 0.5 : undefined,
          backgroundColor: 'transparent !important'
        }}
        disablePadding
      >
        {isProjectsMode &&
          projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              expanded={expandedProjectIds.has(project.id)}
              refreshKey={projectSessionRefreshKey}
              onToggleExpanded={() => toggleProjectExpanded(project.id)}
              activeSessionPath={activeSessionPath}
              onStartChat={() => onStartProjectChat(project)}
              onSelectSession={onSelectSession}
              onRenameSession={onRenameSession}
              onDeleteSession={onDeleteSession}
              onDeleteProject={() => setDeleteProjectTarget(project)}
              onFetchSessions={onFetchProjectSessions}
              getSessionRuntimeState={getSessionRuntimeState}
              compactHoverPreview={compactHoverPreview}
              onPreviewInteractionChange={onPreviewInteractionChange}
              nowMs={nowMs}
            />
          ))}

        {isConversationsMode && sessions.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedSessions.map((session) => session.path)}
              strategy={verticalListSortingStrategy}
            >
              {orderedSessions.map((session) => (
                <SortableSessionRow
                  key={session.path}
                  session={session}
                  runtimeState={getSessionRuntimeState?.(session.path, activeCwd) ?? null}
                  isActive={session.path === activeSessionPath}
                  nowMs={nowMs}
                  onSelect={() => onSelectSession(session.path)}
                  onRename={(name) => onRenameSession(session.path, name)}
                  onDelete={() => setDeleteTarget(session)}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </List>

      <SessionDeleteDialogs
        deleteSessionOpen={deleteTarget !== null}
        deleteSessionTitle={deleteTarget ? sessionTitle(deleteTarget) : ''}
        deleteProjectOpen={deleteProjectTarget !== null}
        deleteProjectName={deleteProjectTarget?.name ?? ''}
        compactHoverPreview={compactHoverPreview}
        onCancelSessionDelete={() => setDeleteTarget(null)}
        onConfirmSessionDelete={() => {
          if (deleteTarget) onDeleteSession(deleteTarget.path)
          setDeleteTarget(null)
        }}
        onCancelProjectDelete={() => setDeleteProjectTarget(null)}
        onConfirmProjectDelete={() => {
          if (deleteProjectTarget) onDeleteProject(deleteProjectTarget)
          setDeleteProjectTarget(null)
        }}
      />
    </Box>
  )
}

export default SessionSidebar
