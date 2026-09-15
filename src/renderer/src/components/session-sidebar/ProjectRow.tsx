import { memo, useCallback, useEffect, useState } from 'react'
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  Box,
  Collapse,
  IconButton,
  ListItemButton,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import { preserveSessionListOrder } from '../../lib/sessionOrder'
import {
  plainSidebarRowSx,
  ROW_LABEL_FONT_SIZE,
  ROW_META_FONT_SIZE,
  useSessionOrder
} from '../../lib/sessionSidebarShared'
import type { Project, SessionRuntimeState, SessionSummary } from '../../types'
import { SortableSessionRow } from './SessionRow'

const AddCommentIcon = PhiIcons.action.addSession
const ExpandMoreIcon = PhiIcons.action.expand
const FolderIcon = PhiIcons.entity.folder
const MoreHorizIcon = PhiIcons.action.more

function projectGitStatusLabel(project: Project): string | null {
  if (!project.gitStatus) return null
  return project.gitStatus.dirty ? `${project.gitStatus.branch} · 有改动` : project.gitStatus.branch
}

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
}

function projectRowPropsMatch(left: ProjectRowProps, right: ProjectRowProps): boolean {
  return (
    left.project === right.project &&
    left.expanded === right.expanded &&
    left.refreshKey === right.refreshKey &&
    left.activeSessionPath === right.activeSessionPath &&
    left.compactHoverPreview === right.compactHoverPreview
  )
}

function ProjectRowImpl({
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
  onPreviewInteractionChange
}: ProjectRowProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
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

  // This project's own ticking clock for live elapsed-time display, gated on
  // whether any of ITS sessions are actually active — separate from
  // SessionSidebar's own timer (which only covers the top-level conversation
  // list), since project sessions live in this component's own fetched
  // `sessions` state and aren't visible to the parent.
  const hasActiveAttention = (sessions ?? []).some((session) => {
    const runtimeState = getSessionRuntimeState?.(session.path, project.workingDirectory) ?? null
    const status = runtimeState?.status ?? session.status
    return status === 'running' || status === 'needs_approval'
  })

  useEffect(() => {
    if (!hasActiveAttention) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActiveAttention])

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

// `project` keeps a stable object reference between unrelated App() renders
// (the store only creates a new Project object when project data actually
// changes), and `refreshKey` is bumped on every session runtime-state change
// anywhere in the app (see App.tsx's onAgentEvent handler), so this project's
// own useEffect above will re-fetch and this row will re-render whenever
// something relevant to it actually changes — a memoized ProjectRow can
// safely skip re-rendering (and re-running its DnD/git-status setup) for
// every unrelated agent-stream tick otherwise.
export const ProjectRow = memo(ProjectRowImpl, projectRowPropsMatch)
