import { memo, useCallback, useRef, type FocusEvent } from 'react'
import { Box, IconButton, Paper, Popper, Tooltip } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'
import type { IconType } from 'react-icons'
import {
  GoBook,
  GoComment,
  GoContainer,
  GoFileDirectory,
  GoGear,
  GoPackage,
  GoProject,
  GoTools
} from 'react-icons/go'
import SessionSidebar from './components/SessionSidebar'
import { PhiIcons } from './icons'
import type { WorkspaceSidebarMode } from './lib/workspaceSidebar'
import type { Project, SessionRuntimeState, SessionSummary } from './types'

const activityBarWidth = 48
const macTitlebarHeight = 44
const macContentTopGap = 8
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
type PhiIconComponent = typeof PhiIcons.nav.settings
type ActivityBarIconFontSize = 'inherit' | 'small' | 'medium' | 'large'
type ActivityBarIconProps = {
  fontSize?: ActivityBarIconFontSize
  size?: number | string
}
type ActivityBarIconComponent = (props: ActivityBarIconProps) => React.JSX.Element
const activityBarIconBoxSize = 24
const activityBarPhiIconGlyphSize = 24
const activityBarReactIconGlyphSize = 20

function activityBarIconSize(
  fontSize?: ActivityBarIconFontSize,
  size?: number | string,
  defaultSize: number | string = activityBarPhiIconGlyphSize
): number | string {
  if (size !== undefined) return size
  if (fontSize === 'inherit') return '1em'
  if (fontSize === 'small') return defaultSize
  if (fontSize === 'large') return '2.1875rem'
  return defaultSize
}

function ActivityBarIconBox({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box
      component="span"
      sx={{
        alignItems: 'center',
        display: 'inline-flex',
        flexShrink: 0,
        height: activityBarIconBoxSize,
        justifyContent: 'center',
        lineHeight: 0,
        width: activityBarIconBoxSize
      }}
    >
      {children}
    </Box>
  )
}

function createActivityBarPhiIcon(Icon: PhiIconComponent): ActivityBarIconComponent {
  return function ActivityBarPhiIcon({ fontSize, size }: ActivityBarIconProps): React.JSX.Element {
    return (
      <ActivityBarIconBox>
        <Icon size={activityBarIconSize(fontSize, size, activityBarPhiIconGlyphSize)} />
      </ActivityBarIconBox>
    )
  }
}

function createActivityBarReactIcon(Icon: IconType): ActivityBarIconComponent {
  return function ActivityBarReactIcon({
    fontSize,
    size
  }: ActivityBarIconProps): React.JSX.Element {
    return (
      <ActivityBarIconBox>
        <Icon
          aria-hidden
          focusable="false"
          size={activityBarIconSize(fontSize, size, activityBarReactIconGlyphSize)}
          style={{ display: 'block' }}
        />
      </ActivityBarIconBox>
    )
  }
}

function activityBarButtonSx(active: boolean): SxProps<Theme> {
  return {
    color: active ? 'primary.main' : 'text.secondary',
    '&:hover': {
      color: active ? 'primary.main' : 'text.primary',
      bgcolor: 'action.hover'
    },
    '& svg': {
      color: 'inherit'
    }
  } as const
}

const NavChatIcon = createActivityBarReactIcon(GoComment)
const NavProjectsIcon = createActivityBarReactIcon(GoProject)
const NavFilesIcon = createActivityBarReactIcon(GoFileDirectory)
const NavRuntimeIcon = createActivityBarPhiIcon(PhiIcons.nav.runtime)
const NavPluginsIcon = createActivityBarReactIcon(GoPackage)
const NavSkillsIcon = createActivityBarReactIcon(GoBook)
const NavMcpIcon = createActivityBarReactIcon(GoTools)
const NavWrappersIcon = createActivityBarReactIcon(GoContainer)
const NavSettingsIcon = createActivityBarReactIcon(GoGear)

function WorkspaceSidebarNavButton({
  mode,
  label,
  icon: Icon,
  active,
  useContentPreview,
  onPreviewOpen,
  onPreviewClose,
  onClick
}: {
  mode: WorkspaceSidebarMode
  label: string
  icon: typeof NavChatIcon
  active: boolean
  useContentPreview: boolean
  onPreviewOpen: (mode: WorkspaceSidebarMode, anchorEl: HTMLElement) => void
  onPreviewClose: () => void
  onClick: () => void
}): React.JSX.Element {
  const button = (
    <IconButton
      size="small"
      aria-label={label}
      color={active ? 'primary' : 'default'}
      sx={activityBarButtonSx(active)}
      onMouseEnter={(event) => {
        if (useContentPreview) onPreviewOpen(mode, event.currentTarget)
      }}
      onMouseLeave={useContentPreview ? onPreviewClose : undefined}
      onFocus={(event) => {
        if (useContentPreview) onPreviewOpen(mode, event.currentTarget)
      }}
      onBlur={useContentPreview ? onPreviewClose : undefined}
      onClick={onClick}
    >
      <Icon fontSize="small" />
    </IconButton>
  )

  return useContentPreview ? (
    button
  ) : (
    <Tooltip title={label} placement="right">
      {button}
    </Tooltip>
  )
}

export type AppActivityBarProps = {
  activeView: string
  isWorkspaceSidebarModeExpanded: (mode: WorkspaceSidebarMode) => boolean
  shouldUseWorkspaceSidebarPreview: (mode: WorkspaceSidebarMode) => boolean
  openWorkspaceSidebarPreview: (mode: WorkspaceSidebarMode, anchorEl: HTMLElement) => void
  scheduleWorkspaceSidebarPreviewClose: () => void
  onSelectWorkspaceView: (view: 'chat' | 'projects') => void
  onSelectWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => void
  refreshAnalysisJupyterRuntimeStatus: () => Promise<void>
  refreshPlugins: () => Promise<void>
  refreshSkills: () => Promise<void>
  refreshMcpServers: () => Promise<void>
  setIsSettingsOpen: (open: boolean) => void

  isWorkspaceSidebarPreviewOpen: boolean
  visibleWorkspaceSidebarPreview: { mode: WorkspaceSidebarMode; anchorEl: HTMLElement } | null
  workspaceSidebarPreviewMode: WorkspaceSidebarMode
  workspaceSidebarPreviewWidth: number
  clearWorkspaceSidebarPreviewCloseTimer: () => void
  closeWorkspaceSidebarPreview: () => void

  sessions: SessionSummary[]
  activeSessionPath: string | null
  activeCwd: string
  projects: Project[]
  projectSessionRefreshKey: number
  onNewChat: () => Promise<void>
  setIsNewProjectDialogOpen: (open: boolean) => void
  onSelectSession: (path: string) => Promise<void>
  onRenameSession: (path: string, name: string) => Promise<void>
  onDeleteSession: (path: string) => Promise<void>
  onStartProjectChat: (project: Project) => Promise<void>
  onDeleteProjectEntry: (project: Project) => Promise<void>
  onFetchProjectSessions: (workingDirectory: string) => Promise<SessionSummary[]>
  getSessionRuntimeState: (
    path: string,
    cwd: string,
    phiSessionId?: string | null
  ) => SessionRuntimeState | null
}

function AppActivityBarImpl({
  isWorkspaceSidebarModeExpanded,
  shouldUseWorkspaceSidebarPreview,
  openWorkspaceSidebarPreview,
  scheduleWorkspaceSidebarPreviewClose,
  onSelectWorkspaceView,
  onSelectWorkspaceSidebarMode,
  refreshAnalysisJupyterRuntimeStatus,
  refreshPlugins,
  refreshSkills,
  refreshMcpServers,
  setIsSettingsOpen,
  isWorkspaceSidebarPreviewOpen,
  visibleWorkspaceSidebarPreview,
  workspaceSidebarPreviewMode,
  workspaceSidebarPreviewWidth,
  clearWorkspaceSidebarPreviewCloseTimer,
  closeWorkspaceSidebarPreview,
  sessions,
  activeSessionPath,
  activeCwd,
  projects,
  projectSessionRefreshKey,
  onNewChat,
  setIsNewProjectDialogOpen,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onStartProjectChat,
  onDeleteProjectEntry,
  onFetchProjectSessions,
  getSessionRuntimeState
}: AppActivityBarProps): React.JSX.Element {
  const previewInteractionLockedRef = useRef(false)
  const previewSurfaceActiveRef = useRef(false)
  const requestWorkspaceSidebarPreviewClose = useCallback((): void => {
    if (previewInteractionLockedRef.current) {
      clearWorkspaceSidebarPreviewCloseTimer()
      return
    }
    scheduleWorkspaceSidebarPreviewClose()
  }, [clearWorkspaceSidebarPreviewCloseTimer, scheduleWorkspaceSidebarPreviewClose])
  const handleWorkspaceSidebarPreviewInteractionChange = useCallback(
    (active: boolean): void => {
      previewInteractionLockedRef.current = active
      if (active) {
        clearWorkspaceSidebarPreviewCloseTimer()
      } else if (!previewSurfaceActiveRef.current) {
        scheduleWorkspaceSidebarPreviewClose()
      }
    },
    [clearWorkspaceSidebarPreviewCloseTimer, scheduleWorkspaceSidebarPreviewClose]
  )
  const handleWorkspaceSidebarPreviewEnter = useCallback((): void => {
    previewSurfaceActiveRef.current = true
    clearWorkspaceSidebarPreviewCloseTimer()
  }, [clearWorkspaceSidebarPreviewCloseTimer])
  const handleWorkspaceSidebarPreviewLeave = useCallback((): void => {
    previewSurfaceActiveRef.current = false
    requestWorkspaceSidebarPreviewClose()
  }, [requestWorkspaceSidebarPreviewClose])
  const handleWorkspaceSidebarPreviewBlur = useCallback(
    (event: FocusEvent<HTMLElement>): void => {
      const nextFocusedElement = event.relatedTarget
      if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) {
        return
      }
      previewSurfaceActiveRef.current = false
      requestWorkspaceSidebarPreviewClose()
    },
    [requestWorkspaceSidebarPreviewClose]
  )
  const sessionSidebarPreviewMode =
    workspaceSidebarPreviewMode === 'projects' ? 'projects' : 'conversations'

  return (
    <>
      <Box
        className="app-activity-bar"
        sx={{
          width: activityBarWidth,
          height: '100vh',
          flexShrink: 0,
          position: 'relative',
          zIndex: 1,
          pt: isMac ? `${macTitlebarHeight + macContentTopGap}px` : 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0.5,
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          '& > *': {
            position: 'relative',
            zIndex: 8
          }
        }}
      >
        <WorkspaceSidebarNavButton
          mode="conversations"
          label="对话"
          icon={NavChatIcon}
          active={isWorkspaceSidebarModeExpanded('conversations')}
          useContentPreview={shouldUseWorkspaceSidebarPreview('conversations')}
          onPreviewOpen={openWorkspaceSidebarPreview}
          onPreviewClose={requestWorkspaceSidebarPreviewClose}
          onClick={() => onSelectWorkspaceView('chat')}
        />
        <WorkspaceSidebarNavButton
          mode="projects"
          label="项目"
          icon={NavProjectsIcon}
          active={isWorkspaceSidebarModeExpanded('projects')}
          useContentPreview={shouldUseWorkspaceSidebarPreview('projects')}
          onPreviewOpen={openWorkspaceSidebarPreview}
          onPreviewClose={requestWorkspaceSidebarPreviewClose}
          onClick={() => onSelectWorkspaceView('projects')}
        />
        <WorkspaceSidebarNavButton
          mode="files"
          label="文件"
          icon={NavFilesIcon}
          active={isWorkspaceSidebarModeExpanded('files')}
          useContentPreview={false}
          onPreviewOpen={openWorkspaceSidebarPreview}
          onPreviewClose={requestWorkspaceSidebarPreviewClose}
          onClick={() => onSelectWorkspaceSidebarMode('files')}
        />
        <Tooltip title="运行时" placement="right">
          <IconButton
            size="small"
            color={isWorkspaceSidebarModeExpanded('runtime') ? 'primary' : 'default'}
            sx={activityBarButtonSx(isWorkspaceSidebarModeExpanded('runtime'))}
            onClick={() => {
              onSelectWorkspaceSidebarMode('runtime')
              void refreshAnalysisJupyterRuntimeStatus()
            }}
          >
            <NavRuntimeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="插件" placement="right">
          <IconButton
            size="small"
            color={isWorkspaceSidebarModeExpanded('plugins') ? 'primary' : 'default'}
            sx={activityBarButtonSx(isWorkspaceSidebarModeExpanded('plugins'))}
            onClick={() => {
              onSelectWorkspaceSidebarMode('plugins')
              void refreshPlugins()
            }}
          >
            <NavPluginsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="技能" placement="right">
          <IconButton
            size="small"
            color={isWorkspaceSidebarModeExpanded('skills') ? 'primary' : 'default'}
            sx={activityBarButtonSx(isWorkspaceSidebarModeExpanded('skills'))}
            onClick={() => {
              onSelectWorkspaceSidebarMode('skills')
              void refreshSkills()
            }}
          >
            <NavSkillsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="MCP" placement="right">
          <IconButton
            size="small"
            color={isWorkspaceSidebarModeExpanded('mcp') ? 'primary' : 'default'}
            sx={activityBarButtonSx(isWorkspaceSidebarModeExpanded('mcp'))}
            onClick={() => {
              onSelectWorkspaceSidebarMode('mcp')
              void refreshMcpServers()
            }}
          >
            <NavMcpIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Wrappers" placement="right">
          <IconButton
            size="small"
            color={isWorkspaceSidebarModeExpanded('wrappers') ? 'primary' : 'default'}
            sx={activityBarButtonSx(isWorkspaceSidebarModeExpanded('wrappers'))}
            onClick={() => onSelectWorkspaceSidebarMode('wrappers')}
          >
            <NavWrappersIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="设置" placement="right">
          <IconButton
            size="small"
            onClick={() => setIsSettingsOpen(true)}
            sx={{ ...activityBarButtonSx(false), mb: 1 }}
          >
            <NavSettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Popper
        open={isWorkspaceSidebarPreviewOpen}
        anchorEl={visibleWorkspaceSidebarPreview?.anchorEl ?? null}
        placement="right-start"
        modifiers={[
          {
            name: 'offset',
            options: { offset: [0, 6] }
          },
          {
            name: 'preventOverflow',
            options: { padding: 8 }
          }
        ]}
        sx={{ zIndex: (muiTheme) => muiTheme.zIndex.tooltip }}
      >
        <Paper
          data-phi-workspace-sidebar-hover-preview={workspaceSidebarPreviewMode}
          elevation={8}
          onMouseEnter={handleWorkspaceSidebarPreviewEnter}
          onMouseLeave={handleWorkspaceSidebarPreviewLeave}
          onFocus={handleWorkspaceSidebarPreviewEnter}
          onBlur={handleWorkspaceSidebarPreviewBlur}
          sx={{
            width: workspaceSidebarPreviewWidth,
            maxHeight: 'min(420px, calc(100vh - 96px))',
            mt: isMac ? -0.5 : 0.5,
            overflow: 'hidden',
            borderRadius: 2,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
            boxShadow: (muiTheme) =>
              muiTheme.palette.mode === 'dark'
                ? '0 18px 46px rgba(0, 0, 0, 0.48)'
                : '0 18px 46px rgba(12, 26, 32, 0.18)'
          }}
        >
          <SessionSidebar
            hideWindowDragSpacer
            compactHoverPreview
            onPreviewInteractionChange={handleWorkspaceSidebarPreviewInteractionChange}
            mode={sessionSidebarPreviewMode}
            sessions={sessions}
            activeSessionPath={activeSessionPath}
            activeCwd={activeCwd}
            projects={projects}
            projectSessionRefreshKey={projectSessionRefreshKey}
            onNewChat={() => {
              closeWorkspaceSidebarPreview()
              void onNewChat()
            }}
            onNewProject={() => {
              closeWorkspaceSidebarPreview()
              setIsNewProjectDialogOpen(true)
            }}
            onSelectSession={(path) => {
              closeWorkspaceSidebarPreview()
              void onSelectSession(path)
            }}
            onRenameSession={(path, name) => {
              void onRenameSession(path, name)
            }}
            onDeleteSession={(path) => {
              void onDeleteSession(path)
            }}
            onStartProjectChat={(project) => {
              closeWorkspaceSidebarPreview()
              void onStartProjectChat(project)
            }}
            onDeleteProject={(project) => {
              void onDeleteProjectEntry(project)
            }}
            onFetchProjectSessions={onFetchProjectSessions}
            getSessionRuntimeState={getSessionRuntimeState}
          />
        </Paper>
      </Popper>
    </>
  )
}

// Same rationale as AppWorkspaceSidebar's comparator: App() re-renders on
// every agent-stream event, but this bar's own visible state only depends on
// these fields — `sessions`/`projects` are reference-stable except when their
// data actually changes, and `projectSessionRefreshKey` reliably bumps
// whenever any session's runtime state changes anywhere in the app.
function appActivityBarPropsEqual(prev: AppActivityBarProps, next: AppActivityBarProps): boolean {
  return (
    prev.activeView === next.activeView &&
    prev.isWorkspaceSidebarModeExpanded === next.isWorkspaceSidebarModeExpanded &&
    prev.shouldUseWorkspaceSidebarPreview === next.shouldUseWorkspaceSidebarPreview &&
    prev.isWorkspaceSidebarPreviewOpen === next.isWorkspaceSidebarPreviewOpen &&
    prev.visibleWorkspaceSidebarPreview?.mode === next.visibleWorkspaceSidebarPreview?.mode &&
    prev.visibleWorkspaceSidebarPreview?.anchorEl ===
      next.visibleWorkspaceSidebarPreview?.anchorEl &&
    prev.workspaceSidebarPreviewMode === next.workspaceSidebarPreviewMode &&
    prev.workspaceSidebarPreviewWidth === next.workspaceSidebarPreviewWidth &&
    prev.sessions === next.sessions &&
    prev.activeSessionPath === next.activeSessionPath &&
    prev.activeCwd === next.activeCwd &&
    prev.projects === next.projects &&
    prev.projectSessionRefreshKey === next.projectSessionRefreshKey
  )
}

const AppActivityBar = memo(AppActivityBarImpl, appActivityBarPropsEqual)

export default AppActivityBar
