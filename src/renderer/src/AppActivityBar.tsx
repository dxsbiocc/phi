import { Box, IconButton, Paper, Popper, Tooltip } from '@mui/material'
import SessionSidebar from './components/SessionSidebar'
import { PhiIcons } from './icons'
import type { WorkspaceSidebarMode } from './lib/workspaceSidebar'
import type { AppView } from './App'
import type { Project, SessionRuntimeState, SessionSummary } from './types'

const activityBarWidth = 48
const macTitlebarHeight = 44
const macContentTopGap = 8
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const NavChatIcon = PhiIcons.nav.chat
const NavProjectsIcon = PhiIcons.nav.projects
const NavRuntimeIcon = PhiIcons.nav.runtime
const NavPluginsIcon = PhiIcons.nav.plugins
const NavSkillsIcon = PhiIcons.nav.skills
const NavMcpIcon = PhiIcons.nav.mcp
const NavWrappersIcon = PhiIcons.nav.wrappers
const NavSettingsIcon = PhiIcons.nav.settings

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
  activeView: AppView
  setActiveView: (view: AppView) => void
  isWorkspaceSidebarModeExpanded: (mode: WorkspaceSidebarMode) => boolean
  shouldUseWorkspaceSidebarPreview: (mode: WorkspaceSidebarMode) => boolean
  openWorkspaceSidebarPreview: (mode: WorkspaceSidebarMode, anchorEl: HTMLElement) => void
  scheduleWorkspaceSidebarPreviewClose: () => void
  onSelectWorkspaceView: (view: 'chat' | 'projects') => void
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

export default function AppActivityBar({
  activeView,
  setActiveView,
  isWorkspaceSidebarModeExpanded,
  shouldUseWorkspaceSidebarPreview,
  openWorkspaceSidebarPreview,
  scheduleWorkspaceSidebarPreviewClose,
  onSelectWorkspaceView,
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
          onPreviewClose={scheduleWorkspaceSidebarPreviewClose}
          onClick={() => onSelectWorkspaceView('chat')}
        />
        <WorkspaceSidebarNavButton
          mode="projects"
          label="项目"
          icon={NavProjectsIcon}
          active={isWorkspaceSidebarModeExpanded('projects')}
          useContentPreview={shouldUseWorkspaceSidebarPreview('projects')}
          onPreviewOpen={openWorkspaceSidebarPreview}
          onPreviewClose={scheduleWorkspaceSidebarPreviewClose}
          onClick={() => onSelectWorkspaceView('projects')}
        />
        <Tooltip title="运行时" placement="right">
          <IconButton
            size="small"
            color={activeView === 'runtime' ? 'primary' : 'default'}
            onClick={() => {
              setActiveView('runtime')
              void refreshAnalysisJupyterRuntimeStatus()
            }}
          >
            <NavRuntimeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="插件" placement="right">
          <IconButton
            size="small"
            color={activeView === 'plugins' ? 'primary' : 'default'}
            onClick={() => {
              setActiveView('plugins')
              void refreshPlugins()
            }}
          >
            <NavPluginsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="技能" placement="right">
          <IconButton
            size="small"
            color={activeView === 'skills' ? 'primary' : 'default'}
            onClick={() => {
              setActiveView('skills')
              void refreshSkills()
            }}
          >
            <NavSkillsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="MCP" placement="right">
          <IconButton
            size="small"
            color={activeView === 'mcp' ? 'primary' : 'default'}
            onClick={() => {
              setActiveView('mcp')
              void refreshMcpServers()
            }}
          >
            <NavMcpIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Wrappers" placement="right">
          <IconButton
            size="small"
            color={activeView === 'wrappers' ? 'primary' : 'default'}
            onClick={() => setActiveView('wrappers')}
          >
            <NavWrappersIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="设置" placement="right">
          <IconButton size="small" onClick={() => setIsSettingsOpen(true)} sx={{ mb: 1 }}>
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
          onMouseEnter={clearWorkspaceSidebarPreviewCloseTimer}
          onMouseLeave={scheduleWorkspaceSidebarPreviewClose}
          onFocus={clearWorkspaceSidebarPreviewCloseTimer}
          onBlur={scheduleWorkspaceSidebarPreviewClose}
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
            mode={workspaceSidebarPreviewMode}
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
