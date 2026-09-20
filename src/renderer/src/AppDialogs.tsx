import { Alert, Snackbar } from '@mui/material'
import SettingsDialog, { type SettingsCategory } from './components/SettingsDialog'
import AddProviderDialog from './components/AddProviderDialog'
import OnboardingDialog from './components/OnboardingDialog'
import NewProjectDialog from './components/NewProjectDialog'
import type { ThemeMode } from './theme'
import type {
  ActiveAuthPrompt,
  DbConnectorSettingsItem,
  DefaultProxyMode,
  ModelOption,
  PhiAppSettingsPatch,
  PermissionMode,
  Project,
  ProjectRemoteConnection,
  ProviderAuthStatus,
  ProxyTransportStatus,
  RendererApi,
  ThinkingLevel,
  ToolApprovalRequest
} from './types'

export type SnackbarSeverity = 'error' | 'info' | 'success' | 'warning'
export type SnackbarNotice = {
  id: number
  severity: SnackbarSeverity
  message: string
  persistent?: boolean
}

export type AppDialogsProps = {
  rendererApi: RendererApi

  isSettingsOpen: boolean
  setIsSettingsOpen: (open: boolean) => void
  settingsCategory: SettingsCategory
  setSettingsCategory: (category: SettingsCategory) => void
  providerStatuses: ProviderAuthStatus[]
  providerHints: Record<string, string>
  personaMarkdown: string | null
  onSavePersonaMarkdown: (markdown: string) => Promise<void>
  refreshAuthStatuses: () => Promise<void>
  openProviderDialog: (providerId?: string | null) => void
  logoutProvider: (providerId: string) => Promise<void>
  projects: Project[]
  availableModels: ModelOption[]
  pendingApproval: ToolApprovalRequest | null
  updatingPermissionProjectId: string | null
  onUpdateProjectPermissionMode: (projectId: string, permissionMode: PermissionMode) => void
  onUpdateProjectDefaults: (
    projectId: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => void
  updatingRemoteProjectId: string | null
  onUpdateProjectRemoteConnection: (
    projectId: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null,
    passphrase?: string | null
  ) => Promise<void>
  onUpdateProjectRemoteDefaults: (
    projectId: string,
    defaults: { defaultRemoteConnectionId?: string | null; remoteWorkspaceRoot?: string | null }
  ) => Promise<void>
  onOpenApprovalSession: (path: string) => void
  onRespondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  defaultProxyMode: DefaultProxyMode
  noProjectTaskFolder: string
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  proxyTransportStatus: ProxyTransportStatus
  isSavingDefaultProxyMode: boolean
  isSavingAppSettings: boolean
  onSelectDefaultProxyMode: (mode: DefaultProxyMode) => void
  onUpdateAppSettings: (patch: PhiAppSettingsPatch) => void
  onPickNoProjectTaskFolder: () => void
  dbConnectors: DbConnectorSettingsItem[]
  isLoadingDbConnectors: boolean
  updatingDbConnectorId: string | null
  onRefreshDbConnectors: () => Promise<void>
  onSetDbConnectorEnabled: (id: string, enabled: boolean) => Promise<void>

  showOnboarding: boolean
  onCompleteOnboarding: (description: string) => Promise<void>
  onSkipOnboarding: () => Promise<void>

  isProviderDialogOpen: boolean
  providerDialogProviderId: string | null
  selectedPrompts: ActiveAuthPrompt[]
  isBusy: boolean
  closeProviderDialog: () => void
  setProviderDialogProviderId: (providerId: string | null) => void
  submitProviderApiKey: (providerId: string, key: string) => Promise<void>
  submitProviderOAuth: (providerId: string) => Promise<void>
  onSubmitAuthPrompt: (requestId: string, value: string) => Promise<void>
  onUpdatePromptValue: (requestId: string, value: string) => void

  isNewProjectDialogOpen: boolean
  setIsNewProjectDialogOpen: (open: boolean) => void
  onCreateProject: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ) => Promise<void>

  snackbarNotice: SnackbarNotice | null
  setSnackbarNotice: (notice: SnackbarNotice | null) => void
  isChatWorkspaceView: boolean
  isSidebarOpen: boolean
  activityBarWidth: number
  sidebarWidth: number
  macTitlebarHeight: number
}

export default function AppDialogs({
  rendererApi,
  isSettingsOpen,
  setIsSettingsOpen,
  settingsCategory,
  setSettingsCategory,
  providerStatuses,
  providerHints,
  personaMarkdown,
  onSavePersonaMarkdown,
  refreshAuthStatuses,
  openProviderDialog,
  logoutProvider,
  projects,
  availableModels,
  pendingApproval,
  updatingPermissionProjectId,
  onUpdateProjectPermissionMode,
  onUpdateProjectDefaults,
  updatingRemoteProjectId,
  onUpdateProjectRemoteConnection,
  onUpdateProjectRemoteDefaults,
  onOpenApprovalSession,
  onRespondToolApproval,
  themeMode,
  setThemeMode,
  defaultProxyMode,
  noProjectTaskFolder,
  preventSleepDuringRuns,
  nextActionSuggestionsEnabled,
  proxyTransportStatus,
  isSavingDefaultProxyMode,
  isSavingAppSettings,
  onSelectDefaultProxyMode,
  onUpdateAppSettings,
  onPickNoProjectTaskFolder,
  dbConnectors,
  isLoadingDbConnectors,
  updatingDbConnectorId,
  onRefreshDbConnectors,
  onSetDbConnectorEnabled,
  showOnboarding,
  onCompleteOnboarding,
  onSkipOnboarding,
  isProviderDialogOpen,
  providerDialogProviderId,
  selectedPrompts,
  isBusy,
  closeProviderDialog,
  setProviderDialogProviderId,
  submitProviderApiKey,
  submitProviderOAuth,
  onSubmitAuthPrompt,
  onUpdatePromptValue,
  isNewProjectDialogOpen,
  setIsNewProjectDialogOpen,
  onCreateProject,
  snackbarNotice,
  setSnackbarNotice,
  isChatWorkspaceView,
  isSidebarOpen,
  activityBarWidth,
  sidebarWidth,
  macTitlebarHeight
}: AppDialogsProps): React.JSX.Element {
  return (
    <>
      <SettingsDialog
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        category={settingsCategory}
        onCategoryChange={setSettingsCategory}
        providers={providerStatuses}
        providerHints={providerHints}
        personaMarkdown={personaMarkdown}
        onSavePersonaMarkdown={onSavePersonaMarkdown}
        onRefresh={refreshAuthStatuses}
        onOpenAddProvider={() => {
          openProviderDialog(null)
        }}
        onLogout={logoutProvider}
        projects={projects}
        models={availableModels}
        pendingApproval={pendingApproval}
        updatingProjectId={updatingPermissionProjectId}
        onUpdateProjectPermissionMode={(projectId, permissionMode) => {
          void onUpdateProjectPermissionMode(projectId, permissionMode)
        }}
        onUpdateProjectDefaults={(projectId, defaults) => {
          void onUpdateProjectDefaults(projectId, defaults)
        }}
        updatingRemoteProjectId={updatingRemoteProjectId}
        onUpdateProjectRemoteConnection={onUpdateProjectRemoteConnection}
        onUpdateProjectRemoteDefaults={onUpdateProjectRemoteDefaults}
        onOpenApprovalSession={onOpenApprovalSession}
        onRespondApproval={onRespondToolApproval}
        onCopyDiagnostics={() => rendererApi.copyDiagnostics()}
        defaultProxyMode={defaultProxyMode}
        noProjectTaskFolder={noProjectTaskFolder}
        preventSleepDuringRuns={preventSleepDuringRuns}
        nextActionSuggestionsEnabled={nextActionSuggestionsEnabled}
        proxyTransportStatus={proxyTransportStatus}
        isSavingDefaultProxyMode={isSavingDefaultProxyMode}
        isSavingAppSettings={isSavingAppSettings}
        onSelectDefaultProxyMode={onSelectDefaultProxyMode}
        onUpdateAppSettings={onUpdateAppSettings}
        onPickNoProjectTaskFolder={onPickNoProjectTaskFolder}
        dbConnectors={dbConnectors}
        isLoadingDbConnectors={isLoadingDbConnectors}
        updatingDbConnectorId={updatingDbConnectorId}
        onRefreshDbConnectors={onRefreshDbConnectors}
        onSetDbConnectorEnabled={onSetDbConnectorEnabled}
        themeMode={themeMode}
        onSelectThemeMode={setThemeMode}
      />

      <OnboardingDialog
        open={showOnboarding}
        onComplete={onCompleteOnboarding}
        onSkip={onSkipOnboarding}
      />

      <AddProviderDialog
        open={isProviderDialogOpen}
        providers={providerStatuses}
        initialProviderId={providerDialogProviderId}
        activePrompts={selectedPrompts}
        providerHint={providerDialogProviderId ? providerHints[providerDialogProviderId] : ''}
        isProcessing={isBusy}
        onClose={closeProviderDialog}
        onSelectProvider={(provider) => {
          setProviderDialogProviderId(provider.providerId)
        }}
        onBackToList={() => {
          setProviderDialogProviderId(null)
        }}
        onSubmitApiKey={submitProviderApiKey}
        onStartOAuth={submitProviderOAuth}
        onSubmitPrompt={onSubmitAuthPrompt}
        onUpdatePromptValue={onUpdatePromptValue}
      />

      <NewProjectDialog
        open={isNewProjectDialogOpen}
        onClose={() => setIsNewProjectDialogOpen(false)}
        onPickDirectory={() => rendererApi.pickProjectDirectory()}
        onCreate={onCreateProject}
      />

      <Snackbar
        key={snackbarNotice?.id}
        open={Boolean(snackbarNotice)}
        autoHideDuration={snackbarNotice?.persistent ? null : 6000}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return
          setSnackbarNotice(null)
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        sx={{
          top: isSettingsOpen ? 24 : isChatWorkspaceView ? `${macTitlebarHeight + 12}px` : 16,
          left: isSettingsOpen
            ? 0
            : isChatWorkspaceView
              ? `${activityBarWidth + (isSidebarOpen ? sidebarWidth + 1 : 0)}px`
              : 0,
          right: 0,
          transform: 'none',
          justifyContent: 'center',
          pointerEvents: 'none',
          '& .MuiAlert-root': {
            pointerEvents: 'auto'
          }
        }}
      >
        <Alert
          severity={snackbarNotice?.severity ?? 'error'}
          variant="filled"
          onClose={() => setSnackbarNotice(null)}
          sx={{ maxWidth: 720, alignItems: 'center' }}
        >
          {snackbarNotice?.message}
        </Alert>
      </Snackbar>
    </>
  )
}
