import { useState } from 'react'
import { Alert, Snackbar } from '@mui/material'
import SettingsDialog, { type SettingsCategory } from './components/SettingsDialog'
import AddProviderDialog from './components/AddProviderDialog'
import OnboardingDialog from './components/OnboardingDialog'
import NewProjectDialog from './features/project/NewProjectPanel'
import type { RemoteProjectCreateInput } from '../../shared/projectLocation'
import type { ThemeMode } from './theme'
import type {
  ActiveAuthPrompt,
  DbConnectorSettingsItem,
  DefaultProxyMode,
  EnvironmentSnapshot,
  EnvironmentToolId,
  ModelOption,
  PhiAppSettingsPatch,
  PermissionMode,
  Project,
  ProviderAuthStatus,
  ProxyTransportStatus,
  RendererApi,
  ThinkingLevel,
  ToolApprovalRequest
} from './types'
import { EnvironmentSummaryDialog } from './features/environment/components/EnvironmentSummaryDialog'

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
  environmentSnapshot: EnvironmentSnapshot | null
  isLoadingEnvironment: boolean
  isRedetectingEnvironment: boolean
  onRedetectEnvironment: () => Promise<void>
  onSetEnvironmentToolPath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
  showEnvironmentSummary: boolean
  onDismissEnvironmentSummary: () => Promise<void>
  dbConnectors: DbConnectorSettingsItem[]
  isLoadingDbConnectors: boolean
  updatingDbConnectorId: string | null
  onRefreshDbConnectors: () => Promise<void>
  onSetDbConnectorEnabled: (id: string, enabled: boolean) => Promise<void>
  onSetDbConnectorApiKey: (id: string, apiKey: string) => Promise<void>
  onClearDbConnectorApiKey: (id: string) => Promise<void>

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
  onCreateRemoteProject: (input: RemoteProjectCreateInput) => Promise<void>

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
  environmentSnapshot,
  isLoadingEnvironment,
  isRedetectingEnvironment,
  onRedetectEnvironment,
  onSetEnvironmentToolPath,
  showEnvironmentSummary,
  onDismissEnvironmentSummary,
  dbConnectors,
  isLoadingDbConnectors,
  updatingDbConnectorId,
  onRefreshDbConnectors,
  onSetDbConnectorEnabled,
  onSetDbConnectorApiKey,
  onClearDbConnectorApiKey,
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
  onCreateRemoteProject,
  snackbarNotice,
  setSnackbarNotice,
  isChatWorkspaceView,
  isSidebarOpen,
  activityBarWidth,
  sidebarWidth,
  macTitlebarHeight
}: AppDialogsProps): React.JSX.Element {
  const [returnToNewProject, setReturnToNewProject] = useState(false)
  return (
    <>
      <SettingsDialog
        open={isSettingsOpen}
        onClose={() => {
          setIsSettingsOpen(false)
          if (returnToNewProject) {
            setReturnToNewProject(false)
            setIsNewProjectDialogOpen(true)
          }
        }}
        category={settingsCategory}
        onCategoryChange={setSettingsCategory}
        providers={providerStatuses}
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
        environmentSnapshot={environmentSnapshot}
        isLoadingEnvironment={isLoadingEnvironment}
        isRedetectingEnvironment={isRedetectingEnvironment}
        onRedetectEnvironment={onRedetectEnvironment}
        onSetEnvironmentToolPath={onSetEnvironmentToolPath}
        dbConnectors={dbConnectors}
        isLoadingDbConnectors={isLoadingDbConnectors}
        updatingDbConnectorId={updatingDbConnectorId}
        onRefreshDbConnectors={onRefreshDbConnectors}
        onSetDbConnectorEnabled={onSetDbConnectorEnabled}
        onSetDbConnectorApiKey={onSetDbConnectorApiKey}
        onClearDbConnectorApiKey={onClearDbConnectorApiKey}
        themeMode={themeMode}
        onSelectThemeMode={setThemeMode}
      />

      <EnvironmentSummaryDialog
        open={showEnvironmentSummary}
        snapshot={environmentSnapshot}
        onClose={() => {
          void onDismissEnvironmentSummary()
        }}
        onOpenSettings={() => {
          void onDismissEnvironmentSummary()
          setSettingsCategory('environment')
          setIsSettingsOpen(true)
        }}
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
        onCreateRemote={onCreateRemoteProject}
        onOpenRemoteSettings={() => {
          setReturnToNewProject(true)
          setIsNewProjectDialogOpen(false)
          setSettingsCategory('remote')
          setIsSettingsOpen(true)
        }}
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
