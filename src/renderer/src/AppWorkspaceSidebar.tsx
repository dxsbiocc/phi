import type { MouseEvent, ReactNode } from 'react'
import { Box, Button, Popover } from '@mui/material'
import SessionSidebar from './components/SessionSidebar'
import type { AppView } from './App'
import type { WorkspaceSidebarMode } from './lib/workspaceSidebar'
import type { Project, SessionRuntimeState, SessionSummary } from './types'

const macTitlebarHeight = 44
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

export type AppWorkspaceSidebarProps = {
  isChatWorkspaceView: boolean
  isSidebarOpen: boolean
  sidebarWidth: number
  activeView: AppView
  activeChatView: ReactNode
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void

  analysisSessionSelectorAnchor: HTMLElement | null
  setAnalysisSessionSelectorAnchor: (anchor: HTMLElement | null) => void
  activeWorkspaceIsProject: boolean
  activeWorkspaceTitle: string
  activeWorkspaceScopeLabel: string

  workspaceSidebarMode: WorkspaceSidebarMode
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

export default function AppWorkspaceSidebar({
  isChatWorkspaceView,
  isSidebarOpen,
  sidebarWidth,
  activeView,
  activeChatView,
  onStartSidebarResize,
  analysisSessionSelectorAnchor,
  setAnalysisSessionSelectorAnchor,
  activeWorkspaceIsProject,
  activeWorkspaceTitle,
  activeWorkspaceScopeLabel,
  workspaceSidebarMode,
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
}: AppWorkspaceSidebarProps): React.JSX.Element | null {
  if (!isChatWorkspaceView || !isSidebarOpen) return null

  return (
    <>
      <Box
        className="app-sidebar-shell"
        sx={{
          width: sidebarWidth,
          flexShrink: 0,
          position: 'relative',
          zIndex: 1,
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          '& > *': {
            position: 'relative',
            zIndex: 8
          }
        }}
      >
        {activeView === 'analysis' ? (
          <Box
            data-phi-analysis-sidebar="true"
            sx={{
              height: '100%',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
          >
            <Box
              sx={{
                flexShrink: 0,
                minHeight: isMac ? macTitlebarHeight : 0,
                WebkitAppRegion: 'drag'
              }}
            />
            <Box
              data-phi-analysis-session-selector="true"
              sx={{
                px: 1.5,
                pb: 1,
                flexShrink: 0
              }}
            >
              <Button
                fullWidth
                variant="outlined"
                aria-haspopup="menu"
                aria-expanded={analysisSessionSelectorAnchor ? 'true' : undefined}
                data-phi-analysis-session-select-button="true"
                onClick={(event) => setAnalysisSessionSelectorAnchor(event.currentTarget)}
                sx={{
                  minHeight: 48,
                  justifyContent: 'space-between',
                  gap: 1,
                  borderRadius: 2,
                  px: 1.25,
                  py: 0.75,
                  fontWeight: 700,
                  textTransform: 'none',
                  color: 'text.primary',
                  borderColor: activeWorkspaceIsProject ? 'primary.light' : 'divider',
                  bgcolor: (theme) =>
                    theme.palette.mode === 'dark'
                      ? 'rgba(255, 255, 255, 0.035)'
                      : 'rgba(255, 255, 255, 0.92)',
                  boxShadow: (theme) =>
                    theme.palette.mode === 'dark'
                      ? '0 10px 28px rgba(0, 0, 0, 0.22)'
                      : '0 12px 34px rgba(24, 74, 86, 0.10)',
                  '&:hover': {
                    borderColor: 'primary.main',
                    bgcolor: (theme) =>
                      theme.palette.mode === 'dark'
                        ? 'rgba(255, 255, 255, 0.055)'
                        : 'rgba(248, 253, 255, 0.98)',
                    boxShadow: (theme) =>
                      theme.palette.mode === 'dark'
                        ? '0 12px 30px rgba(0, 0, 0, 0.28)'
                        : '0 14px 36px rgba(24, 74, 86, 0.14)'
                  }
                }}
              >
                <Box
                  component="span"
                  sx={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: 'left',
                    fontSize: '0.92rem'
                  }}
                >
                  {activeWorkspaceTitle}
                </Box>
                <Box
                  component="span"
                  data-phi-analysis-session-scope-label={
                    activeWorkspaceIsProject ? 'project' : 'ordinary'
                  }
                  title={activeWorkspaceScopeLabel}
                  sx={{
                    flexShrink: 0,
                    maxWidth: 132,
                    minWidth: 52,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    borderRadius: 999,
                    px: 1,
                    py: 0.35,
                    textAlign: 'center',
                    color: activeWorkspaceIsProject ? 'primary.dark' : 'text.secondary',
                    bgcolor: activeWorkspaceIsProject
                      ? 'rgba(46, 159, 179, 0.12)'
                      : 'action.selected',
                    border: 1,
                    borderColor: activeWorkspaceIsProject ? 'primary.light' : 'divider',
                    fontSize: '0.76rem',
                    fontWeight: 800,
                    lineHeight: 1.35
                  }}
                >
                  {activeWorkspaceScopeLabel}
                </Box>
              </Button>
              <Popover
                open={Boolean(analysisSessionSelectorAnchor)}
                anchorEl={analysisSessionSelectorAnchor}
                onClose={() => setAnalysisSessionSelectorAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                slotProps={{
                  paper: {
                    sx: {
                      mt: 0.75,
                      width: Math.max(280, sidebarWidth - 24),
                      height: 'min(360px, calc(100vh - 132px))',
                      overflow: 'hidden',
                      borderRadius: 2,
                      border: 1,
                      borderColor: 'divider',
                      boxShadow: '0 18px 45px rgba(12, 26, 32, 0.18)'
                    }
                  }
                }}
              >
                <Box
                  data-phi-analysis-session-select-menu="true"
                  sx={{ width: '100%', height: '100%', display: 'flex', minHeight: 0 }}
                >
                  <SessionSidebar
                    hideWindowDragSpacer
                    mode={workspaceSidebarMode}
                    sessions={sessions}
                    activeSessionPath={activeSessionPath}
                    activeCwd={activeCwd}
                    projects={projects}
                    projectSessionRefreshKey={projectSessionRefreshKey}
                    onNewChat={() => {
                      setAnalysisSessionSelectorAnchor(null)
                      void onNewChat()
                    }}
                    onNewProject={() => setIsNewProjectDialogOpen(true)}
                    onSelectSession={(path) => {
                      setAnalysisSessionSelectorAnchor(null)
                      void onSelectSession(path)
                    }}
                    onRenameSession={(path, name) => {
                      void onRenameSession(path, name)
                    }}
                    onDeleteSession={(path) => {
                      void onDeleteSession(path)
                    }}
                    onStartProjectChat={(project) => {
                      setAnalysisSessionSelectorAnchor(null)
                      void onStartProjectChat(project)
                    }}
                    onDeleteProject={(project) => {
                      void onDeleteProjectEntry(project)
                    }}
                    onFetchProjectSessions={onFetchProjectSessions}
                    getSessionRuntimeState={getSessionRuntimeState}
                  />
                </Box>
              </Popover>
            </Box>
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
              <Box
                data-phi-analysis-chat-panel="true"
                sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}
              >
                {activeChatView}
              </Box>
            </Box>
          </Box>
        ) : (
          <SessionSidebar
            mode={workspaceSidebarMode}
            sessions={sessions}
            activeSessionPath={activeSessionPath}
            activeCwd={activeCwd}
            projects={projects}
            projectSessionRefreshKey={projectSessionRefreshKey}
            onNewChat={() => {
              void onNewChat()
            }}
            onNewProject={() => setIsNewProjectDialogOpen(true)}
            onSelectSession={(path) => {
              void onSelectSession(path)
            }}
            onRenameSession={(path, name) => {
              void onRenameSession(path, name)
            }}
            onDeleteSession={(path) => {
              void onDeleteSession(path)
            }}
            onStartProjectChat={(project) => {
              void onStartProjectChat(project)
            }}
            onDeleteProject={(project) => {
              void onDeleteProjectEntry(project)
            }}
            onFetchProjectSessions={onFetchProjectSessions}
            getSessionRuntimeState={getSessionRuntimeState}
          />
        )}
      </Box>

      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={onStartSidebarResize}
        sx={{
          width: '1px',
          flexShrink: 0,
          position: 'relative',
          cursor: 'col-resize',
          bgcolor: (muiTheme) =>
            muiTheme.palette.mode === 'dark'
              ? 'rgba(241, 246, 246, 0.18)'
              : 'rgba(15, 42, 48, 0.18)',
          zIndex: 5,
          WebkitAppRegion: 'no-drag',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: -4,
            right: -4
          }
        }}
      />
    </>
  )
}
