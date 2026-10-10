import { memo, type MouseEvent, type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import SessionSidebar from './components/SessionSidebar'
import { McpSidebar } from './features/mcp/McpView'
import { PhiPluginSidebar } from './features/phi-plugin/PhiPluginsView'
import type { PhiPluginDisplayItem } from './features/phi-plugin/hooks/usePhiPlugins'
import { RuntimeSidebar } from './features/runtime/RuntimeView'
import { SkillSidebar } from './features/skill/SkillView'
import { WrapperSidebar } from './features/wrapper/WrapperView'
import { WorkspaceFilesPane } from './components/WorkspaceSidePanel'
import { RemoteConnectionNotice } from './features/project/components/RemoteConnectionNotice'
import { RetainedCatalogSidebars } from './components/RetainedCatalogSidebars'
import { CompanionChatToggle } from './features/chat/components/CompanionChatToggle'
import type { AppView } from './App'
import type { WorkspaceSidebarMode } from './lib/workspaceSidebar'
import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest
} from '../../shared/wrapperCompositionManifestTypes'
import type { RemoteProjectConnectionState } from '../../shared/projectLocation'
import type {
  AnalysisJupyterRuntimeStatus,
  DirectoryListing,
  McpServerSummary,
  Project,
  SessionRuntimeState,
  SessionSummary,
  SkillSummary
} from './types'

const macTitlebarHeight = 44
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

export type AppWorkspaceSidebarProps = {
  isSidebarOpen: boolean
  compactHoverPreview?: boolean
  onPreviewInteractionChange?: (active: boolean) => void
  onPreviewDialogChange?: (active: boolean) => void
  onPreviewNavigate?: () => void
  sidebarWidth: number
  activeView: AppView
  activeChatView: ReactNode
  onRestoreConversationToMain: () => void
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
  onOpenRemoteSettings?: () => void
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

  phiPlugins: PhiPluginDisplayItem[]
  activePhiPluginId: string | null
  isLoadingPhiPlugins: boolean
  busyPhiPluginId?: string | null
  onSetPhiPluginEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => Promise<boolean>
  onOpenPhiPlugin: (plugin: PhiPluginDisplayItem) => void
  onOpenPhiPluginCatalog: () => void
  isPhiPluginCatalogOpen?: boolean

  skills: SkillSummary[]
  activeSkillId: string | null
  isLoadingSkills: boolean
  busySkillId?: string | null
  onSetSkillEnabled: (skill: SkillSummary, enabled: boolean) => Promise<void>
  onOpenSkill: (skill: SkillSummary) => void
  onOpenSkillCatalog: () => void

  mcpServers: McpServerSummary[]
  activeMcpServerId: string | null
  onOpenMcpServer: (server: McpServerSummary) => void
  onRefreshMcpServers: () => Promise<void>

  wrapperCatalog: WrapperCompositionCatalogItem[]
  selectedWrapperId: string | null
  isLoadingWrappers: boolean
  onOpenWrapper: (entry: WrapperCompositionManifest) => void
  onRefreshWrappers: () => void | Promise<void>
  busyWrapperPackageId?: string | null
  onSetWrapperPackageEnabled: (packageId: string, enabled: boolean) => Promise<boolean>

  sessions: SessionSummary[]
  activeSessionPath: string | null
  activeCwd: string
  activeProjectId: string | null
  projects: Project[]
  projectSessionRefreshKey: number
  onNewChat: () => Promise<void>
  setIsNewProjectDialogOpen: (open: boolean) => void
  requestTrustedOverlay: (key: string, publish: () => void, onCancel: () => void) => void
  cancelTrustedOverlay: (key: string) => void
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

export type WorkspaceSidebarDataProps = Omit<
  AppWorkspaceSidebarProps,
  | 'isSidebarOpen'
  | 'sidebarWidth'
  | 'onStartSidebarResize'
  | 'activeView'
  | 'activeChatView'
  | 'workspaceSidebarMode'
  | 'compactHoverPreview'
  | 'onPreviewInteractionChange'
  | 'onPreviewDialogChange'
  | 'onPreviewNavigate'
>

function AppWorkspaceSidebarImpl({
  isSidebarOpen,
  compactHoverPreview = false,
  onPreviewInteractionChange,
  onPreviewDialogChange,
  onPreviewNavigate,
  sidebarWidth,
  activeView,
  activeChatView,
  onRestoreConversationToMain,
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
  onOpenRemoteSettings,
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
  phiPlugins,
  activePhiPluginId,
  isLoadingPhiPlugins,
  busyPhiPluginId,
  onSetPhiPluginEnabled,
  onOpenPhiPlugin,
  onOpenPhiPluginCatalog,
  isPhiPluginCatalogOpen,
  skills,
  activeSkillId,
  isLoadingSkills,
  busySkillId,
  onSetSkillEnabled,
  onOpenSkill,
  onOpenSkillCatalog,
  mcpServers,
  activeMcpServerId,
  onOpenMcpServer,
  onRefreshMcpServers,
  wrapperCatalog,
  selectedWrapperId,
  isLoadingWrappers,
  onOpenWrapper,
  onRefreshWrappers,
  busyWrapperPackageId,
  onSetWrapperPackageEnabled,
  sessions,
  activeSessionPath,
  activeCwd,
  activeProjectId,
  projects,
  projectSessionRefreshKey,
  onNewChat,
  setIsNewProjectDialogOpen,
  requestTrustedOverlay,
  cancelTrustedOverlay,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onExportSession,
  onStartProjectChat,
  onDeleteProjectEntry,
  onFetchProjectSessions,
  getSessionRuntimeState
}: AppWorkspaceSidebarProps): React.JSX.Element | null {
  if (!isSidebarOpen && compactHoverPreview) return null

  const navigate = (action: () => void | Promise<void>): void => {
    const pending = action()
    onPreviewNavigate?.()
    if (pending && onPreviewNavigate) void pending.then(onPreviewNavigate, onPreviewNavigate)
  }

  const sidebarContent = (
    mode: WorkspaceSidebarMode = workspaceSidebarMode,
    visible = true
  ): ReactNode =>
    !compactHoverPreview && activeView === 'analysis' && mode === 'conversations' ? (
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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
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
              <CompanionChatToggle destination="tab" onToggle={onRestoreConversationToMain} />
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
    ) : mode === 'files' ? (
      <Box
        className="app-sidebar-surface"
        data-phi-files-sidebar="true"
        sx={{
          width: '100%',
          minWidth: 0,
          maxWidth: '100%',
          height: '100%',
          overflow: 'hidden',
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
            onOpenRemoteSettings={onOpenRemoteSettings}
            compact
          />
        ) : null}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
          {isRemoteProject && !workspaceRootPath ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              服务器档案或会话不可用，暂时无法显示远程文件。
            </Typography>
          ) : (
            <WorkspaceFilesPane
              rootPath={workspaceRootPath}
              activePath={activeWorkspacePath}
              treeRevision={workspaceFileTreeRevision}
              onOpenFile={(path) => navigate(() => onOpenWorkspaceFile(path))}
              onListDirectory={onListWorkspaceDirectory}
            />
          )}
        </Box>
      </Box>
    ) : mode === 'runtime' ? (
      <RuntimeSidebar
        projectCwd={runtimeProjectCwd}
        runtimeStatus={runtimeStatus}
        isLoading={isRuntimeLoading}
        onOpenNotebook={(path) => navigate(() => onOpenRuntimeNotebook(path))}
        closingNotebookPath={runtimeClosingNotebookPath}
        onRefresh={onRefreshRuntime}
        onStartJupyter={onStartRuntime}
        onStopJupyter={onStopRuntime}
        onStopNotebookKernel={onStopRuntimeNotebookKernel}
      />
    ) : mode === 'plugins' ? (
      <PhiPluginSidebar
        plugins={phiPlugins}
        loading={isLoadingPhiPlugins}
        busyPluginId={busyPhiPluginId}
        onSetEnabled={onSetPhiPluginEnabled}
        activePluginId={activePhiPluginId}
        onSelectPlugin={(plugin) => navigate(() => onOpenPhiPlugin(plugin))}
        onOpenCatalog={() => navigate(onOpenPhiPluginCatalog)}
        catalogOpen={isPhiPluginCatalogOpen}
      />
    ) : mode === 'skills' ? (
      <SkillSidebar
        visible={visible}
        skills={skills}
        isLoading={isLoadingSkills}
        busySkillId={busySkillId}
        onSetEnabled={onSetSkillEnabled}
        activeSkillId={activeSkillId}
        onSelectSkill={(skill) => navigate(() => onOpenSkill(skill))}
        onOpenCatalog={() => navigate(onOpenSkillCatalog)}
        notice={isRemoteProject ? '远程项目级 Skills 暂未接通；当前仅显示全局 Skills。' : undefined}
      />
    ) : mode === 'mcp' ? (
      <McpSidebar
        visible={visible}
        servers={mcpServers}
        activeServerId={activeMcpServerId}
        onSelectServer={(server) => navigate(() => onOpenMcpServer(server))}
        onRefreshServers={onRefreshMcpServers}
        requestTrustedOverlay={requestTrustedOverlay}
        cancelTrustedOverlay={cancelTrustedOverlay}
        onPreviewInteractionChange={onPreviewDialogChange ?? onPreviewInteractionChange}
        notice={isRemoteProject ? '远程项目级 MCP 暂未接通；当前仅显示全局配置。' : undefined}
      />
    ) : mode === 'wrappers' ? (
      <WrapperSidebar
        visible={visible}
        catalog={wrapperCatalog}
        selectedId={selectedWrapperId}
        isLoading={isLoadingWrappers}
        onSelect={(entry) => navigate(() => onOpenWrapper(entry))}
        onRefresh={onRefreshWrappers}
        busyPackageId={busyWrapperPackageId}
        onSetPackageEnabled={onSetWrapperPackageEnabled}
        requestTrustedOverlay={requestTrustedOverlay}
        cancelTrustedOverlay={cancelTrustedOverlay}
        onPreviewInteractionChange={onPreviewDialogChange ?? onPreviewInteractionChange}
      />
    ) : (
      <SessionSidebar
        mode={mode}
        hideWindowDragSpacer={compactHoverPreview}
        compactHoverPreview={compactHoverPreview}
        onPreviewInteractionChange={onPreviewInteractionChange}
        requestTrustedOverlay={requestTrustedOverlay}
        cancelTrustedOverlay={cancelTrustedOverlay}
        sessions={sessions}
        activeSessionPath={activeSessionPath}
        activeCwd={activeCwd}
        activeProjectId={activeProjectId}
        projects={projects}
        projectSessionRefreshKey={projectSessionRefreshKey}
        onNewChat={() => {
          navigate(onNewChat)
        }}
        onNewProject={() => navigate(() => setIsNewProjectDialogOpen(true))}
        onSelectSession={(path) => {
          navigate(() => onSelectSession(path))
        }}
        onRenameSession={(path, name) => {
          void onRenameSession(path, name)
        }}
        onDeleteSession={(path) => {
          void onDeleteSession(path)
        }}
        onExportSession={(session) => navigate(() => onExportSession(session))}
        onStartProjectChat={(project) => {
          navigate(() => onStartProjectChat(project))
        }}
        onDeleteProject={(project) => {
          void onDeleteProjectEntry(project)
        }}
        onFetchProjectSessions={onFetchProjectSessions}
        getSessionRuntimeState={getSessionRuntimeState}
      />
    )

  if (compactHoverPreview) {
    const sessionsPreview =
      workspaceSidebarMode === 'conversations' || workspaceSidebarMode === 'projects'
    return (
      <Box
        data-phi-sidebar-content-preview={workspaceSidebarMode}
        sx={{
          height: sessionsPreview ? 'auto' : 'min(420px, calc(100vh - 96px))',
          maxHeight: 'min(420px, calc(100vh - 96px))',
          minHeight: 0,
          overflow: 'hidden',
          pt: sessionsPreview ? 0 : 1,
          '& .app-sidebar-surface': {
            pt: 0,
            ...(sessionsPreview ? {} : { minHeight: 0, flex: '1 1 auto' })
          }
        }}
      >
        {sidebarContent()}
      </Box>
    )
  }

  return (
    <>
      <Box
        className="app-sidebar-shell"
        sx={{
          display: isSidebarOpen ? 'block' : 'none',
          width: sidebarWidth,
          maxWidth: sidebarWidth,
          minWidth: 0,
          height: '100%',
          overflow: 'hidden',
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
        <RetainedCatalogSidebars
          mode={workspaceSidebarMode}
          open={isSidebarOpen}
          scopeKey={activeCwd}
          renderPanel={sidebarContent}
        />
      </Box>

      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={onStartSidebarResize}
        sx={{
          display: isSidebarOpen ? 'block' : 'none',
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
