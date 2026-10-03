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
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import { preserveSessionListOrder } from '../../lib/sessionOrder'
import {
  plainSidebarRowSx,
  ROW_LABEL_FONT_SIZE,
  ROW_META_FONT_SIZE,
  useSessionOrder
} from '../../lib/sessionSidebarShared'
import type { Project, SessionRuntimeState, SessionSummary } from '../../types'
import { projectLocationSummary } from '../../lib/projectTypes'
import { SortableSessionRow } from './SessionRow'

const AddCommentIcon = PhiIcons.action.addSession
const ExpandMoreIcon = PhiIcons.action.expand
const FolderIcon = PhiIcons.entity.folder
const ServerIcon = PhiIcons.settings.remoteExecution
const MoreHorizIcon = PhiIcons.action.more
const DeleteIcon = PhiIcons.action.delete

function projectGitStatusLabel(project: Project): string | null {
  if (!project.gitStatus) return null
  return project.gitStatus.dirty ? `${project.gitStatus.branch} · 有改动` : project.gitStatus.branch
}

type ProjectRowProps = {
  project: Project
  expanded: boolean
  refreshKey: number
  searchSessions?: SessionSummary[]
  onToggleExpanded: () => void
  activeSessionPath: string | null
  onStartChat: () => void
  onSelectSession: (path: string) => void
  onRenameSession: (path: string, name: string) => void
  onDeleteSession: (path: string) => void
  onExportSession: (session: SessionSummary) => void
  onDeleteProject: () => void
  onFetchSessions: (workingDirectory: string, projectId?: string) => Promise<SessionSummary[]>
  getSessionRuntimeState?: (
    path: string,
    cwd: string,
    phiSessionId?: string | null
  ) => SessionRuntimeState | null
  compactHoverPreview?: boolean
  onPreviewInteractionChange?: (active: boolean) => void
}

function projectRowPropsMatch(left: ProjectRowProps, right: ProjectRowProps): boolean {
  return (
    left.project === right.project &&
    left.expanded === right.expanded &&
    left.refreshKey === right.refreshKey &&
    left.searchSessions === right.searchSessions &&
    left.activeSessionPath === right.activeSessionPath &&
    left.compactHoverPreview === right.compactHoverPreview
  )
}

function ProjectRowImpl({
  project,
  expanded,
  refreshKey,
  searchSessions,
  onToggleExpanded,
  activeSessionPath,
  onStartChat,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onExportSession,
  onDeleteProject,
  onFetchSessions,
  getSessionRuntimeState,
  compactHoverPreview = false,
  onPreviewInteractionChange
}: ProjectRowProps): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const isRemote = project.location?.kind === 'ssh'
  const gitStatusLabel = projectGitStatusLabel(project)
  const remoteSummary = projectLocationSummary(project)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const sourceSessions = searchSessions ?? sessions ?? []
  const sessionsReady = searchSessions !== undefined || sessions !== null
  const { orderedSessions, handleDragEnd } = useSessionOrder(
    isRemote ? `project:${project.id}` : `project:${project.workingDirectory}`,
    sourceSessions
  )

  useEffect(() => {
    if (!expanded || searchSessions !== undefined) return
    let cancelled = false
    void onFetchSessions(project.workingDirectory, project.id).then((nextSessions) => {
      if (!cancelled) {
        setSessions((previous) => preserveSessionListOrder(previous ?? [], nextSessions))
      }
    })
    return () => {
      cancelled = true
    }
  }, [expanded, onFetchSessions, project.id, project.workingDirectory, refreshKey, searchSessions])

  // This project's own ticking clock for live elapsed-time display, gated on
  // whether any of ITS sessions are actually active — separate from
  // SessionSidebar's own timer (which only covers the top-level conversation
  // list), since project sessions live in this component's own fetched
  // `sessions` state and aren't visible to the parent.
  const hasActiveAttention = sourceSessions.some((session) => {
    const runtimeState =
      getSessionRuntimeState?.(session.path, project.workingDirectory, session.phiSessionId) ?? null
    const status = runtimeState?.status ?? session.status
    return status === 'running' || status === 'needs_approval' || status === 'needs_input'
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
          transition: 'background-color 0.15s ease, box-shadow 0.15s ease',
          // plainSidebarRowSx forces a transparent resting background, so the
          // lift only reads once hover paints the surface.
          '&:hover': {
            backgroundColor: 'background.paper !important',
            boxShadow: (theme: Theme) => theme.customShadows?.listItem ?? theme.shadows[2]
          },
          '&:hover .project-actions': { opacity: 1 },
          '&:hover .project-toggle-icon': { opacity: 1 }
        }}
      >
        {isRemote ? (
          <ServerIcon fontSize="small" sx={{ mr: 1.5, flexShrink: 0, color: 'text.secondary' }} />
        ) : (
          <FolderIcon fontSize="small" sx={{ mr: 1.5, flexShrink: 0, color: 'text.secondary' }} />
        )}
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
          {remoteSummary && (
            <Typography
              component="div"
              noWrap
              sx={{ fontSize: ROW_META_FONT_SIZE, color: 'text.secondary' }}
            >
              {remoteSummary}
            </Typography>
          )}
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
          <Tooltip title={isRemote ? '新对话（远程文件与命令工具已可用）' : '新对话'}>
            <span>
              <IconButton
                size="small"
                onClick={(event) => {
                  event.stopPropagation()
                  onStartChat()
                }}
              >
                <AddCommentIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </ListItemButton>

      <Menu
        anchorEl={menuAnchor}
        open={menuAnchor !== null}
        onClose={closeProjectMenu}
        slotProps={{
          paper: {
            elevation: 0,
            sx: {
              minWidth: 160,
              borderRadius: 1.5,
              boxShadow: (theme: Theme) => theme.customShadows.dropdown
            }
          }
        }}
        sx={
          compactHoverPreview ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 1 } : undefined
        }
      >
        <MenuItem
          sx={{
            minHeight: 36,
            mx: 0.5,
            my: 0.25,
            px: 1.5,
            py: 1,
            gap: 1.5,
            borderRadius: 1,
            fontSize: ROW_LABEL_FONT_SIZE,
            fontWeight: 500,
            color: 'error.main',
            '& svg': { flexShrink: 0, color: 'error.main' },
            '&:hover': { bgcolor: (theme: Theme) => alpha(theme.palette.error.main, 0.08) }
          }}
          onClick={() => {
            closeProjectMenu()
            onDeleteProject()
          }}
        >
          <DeleteIcon aria-hidden fontSize="small" />
          删除项目
        </MenuItem>
      </Menu>

      <Collapse in={expanded} unmountOnExit>
        {isRemote && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ pl: 4, pr: 1, py: 0.75, fontSize: ROW_META_FONT_SIZE }}
          >
            远程读取、搜索、命令和文件新建、修改已可用；修改前需先读取。Git、Notebook 和项目级
            Skills/MCP 暂未支持。对话历史保存在 Phi 中。
          </Typography>
        )}
        {sessionsReady && orderedSessions.length > 0 && (
          <DndContext
            sensors={searchSessions === undefined ? sensors : []}
            collisionDetection={closestCenter}
            onDragEnd={searchSessions === undefined ? handleDragEnd : undefined}
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
                    getSessionRuntimeState?.(
                      session.path,
                      project.workingDirectory,
                      session.phiSessionId
                    ) ?? null
                  }
                  isActive={session.path === activeSessionPath}
                  indent
                  nowMs={nowMs}
                  compactHoverPreview={compactHoverPreview}
                  onPreviewInteractionChange={onPreviewInteractionChange}
                  onSelect={() => onSelectSession(session.path)}
                  onRename={(name) => onRenameSession(session.path, name)}
                  onDelete={() => onDeleteSession(session.path)}
                  onExport={() => onExportSession(session)}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
        {sessionsReady && orderedSessions.length === 0 && (
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
