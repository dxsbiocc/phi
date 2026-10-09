import { memo, useCallback, useEffect, useState } from 'react'
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
import { orderSessionsForDisplay } from '../../lib/sessionOrder'
import {
  plainSidebarRowSx,
  ROW_LABEL_FONT_SIZE,
  ROW_META_FONT_SIZE
} from '../../lib/sessionSidebarShared'
import type { Project, SessionRuntimeState, SessionSummary } from '../../types'
import { loadProjectSessionsCached, shouldPrefetchProjectSessions } from './projectSessionLoading'
import { ProjectHoverCard } from './ProjectHoverCard'
import { projectRowMetaLabel } from './projectHoverDetails'
import { SessionRow } from './SessionRow'

const AddCommentIcon = PhiIcons.action.addSession
const ExpandMoreIcon = PhiIcons.action.expand
const FolderIcon = PhiIcons.entity.folder
const ServerIcon = PhiIcons.settings.remoteExecution
const MoreHorizIcon = PhiIcons.action.more
const DeleteIcon = PhiIcons.action.delete

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
  const [hoverDetailsOpen, setHoverDetailsOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const isRemote = project.location?.kind === 'ssh'
  const rowMetaLabel = projectRowMetaLabel(project)
  const sourceSessions = searchSessions ?? sessions ?? []
  const sessionsReady = searchSessions !== undefined || sessions !== null
  const orderedSessions = orderSessionsForDisplay(
    sourceSessions.map((session) => ({
      ...session,
      ...getSessionRuntimeState?.(session.path, project.workingDirectory, session.phiSessionId)
    }))
  )

  useEffect(() => {
    if (!shouldPrefetchProjectSessions(expanded, searchSessions !== undefined)) return
    let cancelled = false
    void loadProjectSessionsCached(project.id, refreshKey, () =>
      onFetchSessions(project.workingDirectory, project.id)
    ).then(
      (nextSessions) => {
        if (!cancelled) setSessions(orderSessionsForDisplay(nextSessions))
      },
      () => {
        if (!cancelled) setSessions([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [expanded, onFetchSessions, project.id, project.workingDirectory, refreshKey, searchSessions])

  // This project's own ticking clock for live elapsed-time display, gated on
  // whether any of ITS sessions are actually active — separate from
  // SessionSidebar's own timer (which only covers the top-level conversation
  // list), since project sessions live in this component's own fetched
  // `sessions` state and aren't visible to the parent.
  const hasActiveAttention = orderedSessions.some(
    (session) =>
      session.status === 'running' ||
      session.status === 'needs_approval' ||
      session.status === 'needs_input'
  )

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
    if (!compactHoverPreview || (menuAnchor === null && !hoverDetailsOpen)) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [compactHoverPreview, hoverDetailsOpen, menuAnchor, onPreviewInteractionChange])

  return (
    <Box>
      <Tooltip
        describeChild
        open={hoverDetailsOpen && menuAnchor === null}
        onOpen={() => setHoverDetailsOpen(true)}
        onClose={() => setHoverDetailsOpen(false)}
        placement="right"
        enterDelay={450}
        enterNextDelay={250}
        disableTouchListener
        title={
          menuAnchor === null ? (
            <ProjectHoverCard
              project={project}
              sessionsReady={sessionsReady}
              sessionCount={orderedSessions.length}
            />
          ) : (
            ''
          )
        }
        slotProps={{
          tooltip: {
            sx: {
              maxWidth: 'min(360px, calc(100vw - 32px))',
              px: 1.5,
              py: 1.25,
              bgcolor: 'background.paper',
              color: 'text.primary',
              border: 1,
              borderColor: 'divider',
              boxShadow: (theme: Theme) => theme.customShadows?.dropdown ?? theme.shadows[4]
            }
          },
          popper: {
            sx: compactHoverPreview
              ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 2 }
              : undefined
          }
        }}
      >
        <ListItemButton
          data-phi-project-row="true"
          aria-expanded={expanded}
          onClick={() => {
            setHoverDetailsOpen(false)
            void handleToggle()
          }}
          sx={{
            ...plainSidebarRowSx,
            // Cancel the global MuiListItemButton left/right margin (theme.ts) so this
            // top-level row's icon lines up flush with the "项目" header above it —
            // only nested SessionRows (indent prop) are meant to sit further in.
            marginLeft: 0,
            marginRight: 0,
            border: 1,
            borderColor: 'transparent',
            borderRadius: 1.25,
            minHeight: 40,
            px: 1,
            py: 0.25,
            transition:
              'background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
            // plainSidebarRowSx forces a transparent resting background, so the
            // lift only reads once hover paints the surface.
            '&:hover, &.Mui-focusVisible, &:has(.project-actions :focus-visible)': {
              backgroundColor: (theme: Theme) =>
                `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.065)} !important`,
              borderColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.32),
              boxShadow: (theme: Theme) => theme.customShadows?.listItem ?? theme.shadows[2]
            },
            '&.Mui-focusVisible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 1
            },
            '&:hover .project-actions, &:has(.project-actions :focus-visible) .project-actions': {
              opacity: 1
            },
            '&:hover .project-row-meta, &:has(.project-actions :focus-visible) .project-row-meta': {
              opacity: 0
            },
            '&:hover .project-toggle-icon, &.Mui-focusVisible .project-toggle-icon': { opacity: 1 }
          }}
        >
          {isRemote ? (
            <ServerIcon fontSize="small" sx={{ mr: 1, flexShrink: 0, color: 'text.secondary' }} />
          ) : (
            <FolderIcon fontSize="small" sx={{ mr: 1, flexShrink: 0, color: 'text.secondary' }} />
          )}
          <Box
            sx={{
              display: 'inline-flex',
              minWidth: 0,
              flex: 1,
              alignItems: 'center',
              gap: 0.5
            }}
          >
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
          <Box
            sx={{
              position: 'relative',
              width: rowMetaLabel ? 104 : 68,
              height: 32,
              minWidth: 0,
              flexShrink: 0
            }}
          >
            {rowMetaLabel ? (
              <Typography
                component="span"
                className="project-row-meta"
                noWrap
                title={rowMetaLabel}
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  textAlign: 'right',
                  minWidth: 0,
                  fontSize: ROW_META_FONT_SIZE,
                  color: project.gitStatus?.dirty ? 'warning.main' : 'text.secondary',
                  transition: 'opacity 0.15s ease',
                  opacity: menuAnchor ? 0 : 1
                }}
              >
                {rowMetaLabel}
              </Typography>
            ) : null}
            <Stack
              direction="row"
              className="project-actions"
              spacing={0.25}
              sx={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'flex-end',
                opacity: menuAnchor ? 1 : 0,
                transition: 'opacity 0.15s ease'
              }}
            >
              <Tooltip title="更多">
                <IconButton
                  size="small"
                  aria-label="更多项目操作"
                  sx={{ width: 32, height: 32, p: 0.5 }}
                  onClick={(event) => {
                    event.stopPropagation()
                    setHoverDetailsOpen(false)
                    setMenuAnchor(event.currentTarget)
                  }}
                >
                  <MoreHorizIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="新对话">
                <span>
                  <IconButton
                    size="small"
                    aria-label="新建项目对话"
                    sx={{ width: 32, height: 32, p: 0.5 }}
                    onClick={(event) => {
                      event.stopPropagation()
                      setHoverDetailsOpen(false)
                      onStartChat()
                    }}
                  >
                    <AddCommentIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        </ListItemButton>
      </Tooltip>

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
        {!sessionsReady && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ pl: 4, pr: 1, py: 0.75, fontSize: ROW_META_FONT_SIZE }}
          >
            正在读取对话…
          </Typography>
        )}
        {sessionsReady && orderedSessions.length > 0 && (
          <>
            {orderedSessions.map((session) => (
              <SessionRow
                key={session.path}
                session={session}
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
          </>
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
