import { memo, type MouseEvent, type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
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

function AppWorkspaceSidebarImpl({
  isChatWorkspaceView,
  isSidebarOpen,
  sidebarWidth,
  activeView,
  activeChatView,
  onStartSidebarResize,
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
              data-phi-analysis-session-header="true"
              sx={{
                px: 1.5,
                pb: 1,
                flexShrink: 0
              }}
            >
              <Box
                sx={{
                  minHeight: 48,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                  px: 0.75,
                  py: 0.75,
                  color: 'text.primary'
                }}
              >
                <Typography
                  variant="subtitle1"
                  title={activeWorkspaceTitle}
                  sx={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 700,
                    lineHeight: 1.35
                  }}
                >
                  {activeWorkspaceTitle}
                </Typography>
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
              </Box>
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

// App() re-renders on essentially every agent-stream event, but that almost
// never changes anything this component actually shows: `sessions`/`projects`
// only get new array references when their data genuinely changes (plain
// useState, not recreated per render), and `projectSessionRefreshKey` is
// bumped specifically whenever any session's runtime state changes anywhere
// (including project sessions this component can't see directly) — so
// comparing those plus the other primitive props is enough to catch every
// real update while skipping the rest.
//
// `activeChatView` is the one exception: in the 'analysis' branch it's
// rendered directly, but it's a fresh React element every render of App(),
// so memoizing wouldn't help there anyway — require an exact match whenever
// either side is in 'analysis' mode so a stale chat view is never displayed.
function appWorkspaceSidebarPropsEqual(
  prev: AppWorkspaceSidebarProps,
  next: AppWorkspaceSidebarProps
): boolean {
  if (prev.activeView !== next.activeView) return false
  if (prev.activeView === 'analysis' && prev.activeChatView !== next.activeChatView) {
    return false
  }

  return (
    prev.isChatWorkspaceView === next.isChatWorkspaceView &&
    prev.isSidebarOpen === next.isSidebarOpen &&
    prev.sidebarWidth === next.sidebarWidth &&
    prev.activeWorkspaceIsProject === next.activeWorkspaceIsProject &&
    prev.activeWorkspaceTitle === next.activeWorkspaceTitle &&
    prev.activeWorkspaceScopeLabel === next.activeWorkspaceScopeLabel &&
    prev.workspaceSidebarMode === next.workspaceSidebarMode &&
    prev.sessions === next.sessions &&
    prev.activeSessionPath === next.activeSessionPath &&
    prev.activeCwd === next.activeCwd &&
    prev.projects === next.projects &&
    prev.projectSessionRefreshKey === next.projectSessionRefreshKey
  )
}

const AppWorkspaceSidebar = memo(AppWorkspaceSidebarImpl, appWorkspaceSidebarPropsEqual)

export default AppWorkspaceSidebar
