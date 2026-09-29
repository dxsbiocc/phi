import { memo, type MouseEvent, type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import SessionSidebar from './components/SessionSidebar'
import { McpSidebar } from './features/mcp/McpView'
import { PluginSidebar } from './features/plugin/PluginView'
import { RuntimeSidebar } from './features/runtime/RuntimeView'
import { SkillSidebar } from './features/skill/SkillView'
import { WrapperSidebar } from './features/wrapper/WrapperView'
import { WorkspaceFilesPane } from './components/WorkspaceSidePanel'
import { RemoteConnectionNotice } from './features/project/components/RemoteConnectionNotice'
import type { AppView } from './App'
import type { WorkspaceSidebarMode } from './lib/workspaceSidebar'
import type { WrapperCompositionManifest } from '../../shared/wrapperCompositionManifestTypes'
import type { RemoteProjectConnectionState } from '../../shared/projectLocation'
import type {
  AnalysisJupyterRuntimeStatus,
  DirectoryListing,
  McpServerSummary,
  PluginCatalogItem,
  Project,
  SessionRuntimeState,
  SessionSummary,
  SkillSummary
} from './types'

const macTitlebarHeight = 44
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

export type AppWorkspaceSidebarProps = {
  isSidebarOpen: boolean
  sidebarWidth: number
  activeView: AppView
  activeChatView: ReactNode
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void

  activeWorkspaceIsProject: boolean
  activeWorkspaceTitle: string
  activeWorkspaceScopeLabel: string

  workspaceSidebarMode: WorkspaceSidebarMode

  workspaceRootPath: string
  isRemoteProject: boolean
  remoteHostAlias?: string
  remoteConnection?: RemoteProjectConnectionState
  onRetryRemoteConnection: () => void
  activeWorkspacePath: string | null
  workspaceFileTreeRevision: number
  onOpenWorkspaceFile: (path: string) => void
  onListWorkspaceDirectory: (path: string) => Promise<DirectoryListing>

  runtimeProjectCwd: string
  runtimeStatus: AnalysisJupyterRuntimeStatus | null
  isRuntimeLoading: boolean
  runtimeClosingNotebookPath: string | null
  onOpenRuntimeNotebook: (notebookPath: string) => void
  onRefreshRuntime: () => void
  onStartRuntime: (cwd: string) => void
  onStopRuntime: (cwd: string) => void
  onStopRuntimeNotebookKernel: (notebookPath: string) => void

  plugins: PluginCatalogItem[]
  activePluginId: string | null
  isLoadingPlugins: boolean
  onOpenPlugin: (plugin: PluginCatalogItem) => void
  onRefreshPlugins: () => void

  skills: SkillSummary[]
  activeSkillId: string | null
  isLoadingSkills: boolean
  onOpenSkill: (skill: SkillSummary) => void

  mcpServers: McpServerSummary[]
  activeMcpServerId: string | null
  onOpenMcpServer: (server: McpServerSummary) => void
  onRefreshMcpServers: () => Promise<void>

  wrapperCatalog: WrapperCompositionManifest[]
  selectedWrapperId: string | null
  isLoadingWrappers: boolean
  onOpenWrapper: (entry: WrapperCompositionManifest) => void
  onRefreshWrappers: () => void

  sessions: SessionSummary[]
  activeSessionPath: string | null
  activeCwd: string
  activeProjectId: string | null
  projects: Project[]
  projectSessionRefreshKey: number
  onNewChat: () => Promise<void>
  setIsNewProjectDialogOpen: (open: boolean) => void
  onSelectSession: (path: string) => Promise<void>
  onRenameSession: (path: string, name: string) => Promise<void>
  onDeleteSession: (path: string) => Promise<void>
  onExportSession: (session: SessionSummary) => void
  onStartProjectChat: (project: Project) => Promise<void>
  onDeleteProjectEntry: (project: Project) => Promise<void>
  onFetchProjectSessions: (
    workingDirectory: string,
    projectId?: string
  ) => Promise<SessionSummary[]>
  getSessionRuntimeState: (
    path: string,
    cwd: string,
    phiSessionId?: string | null
  ) => SessionRuntimeState | null
}

function AppWorkspaceSidebarImpl({
  isSidebarOpen,
  sidebarWidth,
  activeView,
  activeChatView,
  onStartSidebarResize,
  activeWorkspaceIsProject,
  activeWorkspaceTitle,
  activeWorkspaceScopeLabel,
  workspaceSidebarMode,
  workspaceRootPath,
  isRemoteProject,
  remoteHostAlias,
  remoteConnection,
  onRetryRemoteConnection,
  activeWorkspacePath,
  workspaceFileTreeRevision,
  onOpenWorkspaceFile,
  onListWorkspaceDirectory,
  runtimeProjectCwd,
  runtimeStatus,
  isRuntimeLoading,
  runtimeClosingNotebookPath,
  onOpenRuntimeNotebook,
  onRefreshRuntime,
  onStartRuntime,
  onStopRuntime,
  onStopRuntimeNotebookKernel,
  plugins,
  activePluginId,
  isLoadingPlugins,
  onOpenPlugin,
  onRefreshPlugins,
  skills,
  activeSkillId,
  isLoadingSkills,
  onOpenSkill,
  mcpServers,
  activeMcpServerId,
  onOpenMcpServer,
  onRefreshMcpServers,
  wrapperCatalog,
  selectedWrapperId,
  isLoadingWrappers,
  onOpenWrapper,
  onRefreshWrappers,
  sessions,
  activeSessionPath,
  activeCwd,
  activeProjectId,
  projects,
  projectSessionRefreshKey,
  onNewChat,
  setIsNewProjectDialogOpen,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onExportSession,
  onStartProjectChat,
  onDeleteProjectEntry,
  onFetchProjectSessions,
  getSessionRuntimeState
}: AppWorkspaceSidebarProps): React.JSX.Element | null {
  if (!isSidebarOpen) return null

  const sidebarContent =
    activeView === 'analysis' && workspaceSidebarMode === 'conversations' ? (
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
                bgcolor: activeWorkspaceIsProject ? 'rgba(46, 159, 179, 0.12)' : 'action.selected',
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
    ) : workspaceSidebarMode === 'files' ? (
      <Box
        data-phi-files-sidebar="true"
        sx={{
          width: '100%',
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          pt: isMac ? `${macTitlebarHeight + 8}px` : 2,
          WebkitAppRegion: 'no-drag'
        }}
      >
        {isRemoteProject ? (
          <RemoteConnectionNotice
            hostAlias={remoteHostAlias}
            connection={remoteConnection}
            onRetry={onRetryRemoteConnection}
            compact
          />
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {isRemoteProject && !workspaceRootPath ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              服务器档案或会话不可用，暂时无法显示远程文件。
            </Typography>
          ) : (
            <WorkspaceFilesPane
              rootPath={workspaceRootPath}
              activePath={activeWorkspacePath}
              treeRevision={workspaceFileTreeRevision}
              onOpenFile={onOpenWorkspaceFile}
              onListDirectory={onListWorkspaceDirectory}
            />
          )}
        </Box>
      </Box>
    ) : workspaceSidebarMode === 'runtime' ? (
      isRemoteProject ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          远程项目的 Notebook/Jupyter 暂不可用。
        </Typography>
      ) : (
        <RuntimeSidebar
          projectCwd={runtimeProjectCwd}
          runtimeStatus={runtimeStatus}
          isLoading={isRuntimeLoading}
          onOpenNotebook={onOpenRuntimeNotebook}
          closingNotebookPath={runtimeClosingNotebookPath}
          onRefresh={onRefreshRuntime}
          onStartJupyter={onStartRuntime}
          onStopJupyter={onStopRuntime}
          onStopNotebookKernel={onStopRuntimeNotebookKernel}
        />
      )
    ) : workspaceSidebarMode === 'plugins' ? (
      <PluginSidebar
        plugins={plugins}
        isLoading={isLoadingPlugins}
        activePluginId={activePluginId}
        onSelectPlugin={onOpenPlugin}
        onRefresh={onRefreshPlugins}
      />
    ) : workspaceSidebarMode === 'skills' ? (
      isRemoteProject ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            远程项目级 Skills 暂未接通；下方仅显示全局 Skills。
          </Typography>
          <SkillSidebar
            skills={skills}
            isLoading={isLoadingSkills}
            activeSkillId={activeSkillId}
            onSelectSkill={onOpenSkill}
          />
        </Box>
      ) : (
        <SkillSidebar
          skills={skills}
          isLoading={isLoadingSkills}
          activeSkillId={activeSkillId}
          onSelectSkill={onOpenSkill}
        />
      )
    ) : workspaceSidebarMode === 'mcp' ? (
      isRemoteProject ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            远程项目级 MCP 暂未接通；下方仅显示全局配置。
          </Typography>
          <McpSidebar
            servers={mcpServers}
            activeServerId={activeMcpServerId}
            onSelectServer={onOpenMcpServer}
            onRefreshServers={onRefreshMcpServers}
          />
        </Box>
      ) : (
        <McpSidebar
          servers={mcpServers}
          activeServerId={activeMcpServerId}
          onSelectServer={onOpenMcpServer}
          onRefreshServers={onRefreshMcpServers}
        />
      )
    ) : workspaceSidebarMode === 'wrappers' ? (
      <WrapperSidebar
        catalog={wrapperCatalog}
        selectedId={selectedWrapperId}
        isLoading={isLoadingWrappers}
        onSelect={onOpenWrapper}
        onRefresh={onRefreshWrappers}
      />
    ) : (
      <SessionSidebar
        mode={workspaceSidebarMode}
        sessions={sessions}
        activeSessionPath={activeSessionPath}
        activeCwd={activeCwd}
        activeProjectId={activeProjectId}
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
        onExportSession={onExportSession}
        onStartProjectChat={(project) => {
          void onStartProjectChat(project)
        }}
        onDeleteProject={(project) => {
          void onDeleteProjectEntry(project)
        }}
        onFetchProjectSessions={onFetchProjectSessions}
        getSessionRuntimeState={getSessionRuntimeState}
      />
    )

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
        {sidebarContent}
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

const AppWorkspaceSidebar = memo(AppWorkspaceSidebarImpl)

export default AppWorkspaceSidebar
