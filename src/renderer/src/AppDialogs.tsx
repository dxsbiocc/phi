import { useState } from 'react'
import { Snackbar } from '@mui/material'
import AppSnackbarCard, {
  type SnackbarNotice,
  type SnackbarSeverity
} from './components/AppSnackbarCard'
import SettingsDialog, { type SettingsCategory } from './components/SettingsDialog'
import AddProviderDialog from './components/AddProviderDialog'
import OnboardingDialog from './components/OnboardingDialog'
import NewProjectDialog from './features/project/NewProjectPanel'
import type { RemoteProjectCreateInput } from '../../shared/projectLocation'
import type { ManualCompactionTarget } from '../../shared/contextUsageTypes'
import type { OfficeAvailability } from '../../shared/officeAvailability'
import type { ThemeMode } from './theme'
import type { ThemeFamily } from './useThemeMode'
import type {
  ActiveAuthPrompt,
  EnvironmentSnapshot,
  EnvironmentToolId,
  ModelOption,
  PhiAppSettingsPatch,
  PermissionMode,
  Project,
  ProviderAuthStatus,
  RendererApi,
  ThinkingLevel,
  ToolApprovalRequest
} from './types'
import { EnvironmentSummaryDialog } from './features/environment/components/EnvironmentSummaryDialog'

export type { SnackbarNotice, SnackbarSeverity } from './components/AppSnackbarCard'

const emptySnackbarNotice: SnackbarNotice = { id: 0, severity: 'info', message: '' }
const snackbarDurationMs: Record<SnackbarSeverity, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  error: 10000
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
  themeFamily: ThemeFamily
  setThemeFamily: (family: ThemeFamily) => void
  noProjectTaskFolder: string
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  officeAvailability: OfficeAvailability
  isSavingAppSettings: boolean
  onUpdateAppSettings: (patch: PhiAppSettingsPatch) => void
  onPickNoProjectTaskFolder: () => void
  autoCompactionTarget: ManualCompactionTarget
  autoCompactionDisabled: boolean
  contextCompacting: boolean
  compactDisabled: boolean
  onCompactContext: () => void
  environmentSnapshot: EnvironmentSnapshot | null
  isLoadingEnvironment: boolean
  isRedetectingEnvironment: boolean
  onRedetectEnvironment: () => Promise<void>
  onSetEnvironmentToolPath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
  showEnvironmentSummary: boolean
  onDismissEnvironmentSummary: () => Promise<void>
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
  themeFamily,
  setThemeFamily,
  noProjectTaskFolder,
  preventSleepDuringRuns,
  nextActionSuggestionsEnabled,
  officeAvailability,
  isSavingAppSettings,
  onUpdateAppSettings,
  onPickNoProjectTaskFolder,
  autoCompactionTarget,
  autoCompactionDisabled,
  contextCompacting,
  compactDisabled,
  onCompactContext,
  environmentSnapshot,
  isLoadingEnvironment,
  isRedetectingEnvironment,
  onRedetectEnvironment,
  onSetEnvironmentToolPath,
  showEnvironmentSummary,
  onDismissEnvironmentSummary,
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
        noProjectTaskFolder={noProjectTaskFolder}
        preventSleepDuringRuns={preventSleepDuringRuns}
        nextActionSuggestionsEnabled={nextActionSuggestionsEnabled}
        officeAvailability={officeAvailability}
        isSavingAppSettings={isSavingAppSettings}
        onUpdateAppSettings={onUpdateAppSettings}
        onPickNoProjectTaskFolder={onPickNoProjectTaskFolder}
        autoCompactionTarget={autoCompactionTarget}
        autoCompactionDisabled={autoCompactionDisabled}
        contextCompacting={contextCompacting}
        compactDisabled={compactDisabled}
        onCompactContext={onCompactContext}
        environmentSnapshot={environmentSnapshot}
        isLoadingEnvironment={isLoadingEnvironment}
        isRedetectingEnvironment={isRedetectingEnvironment}
        onRedetectEnvironment={onRedetectEnvironment}
        onSetEnvironmentToolPath={onSetEnvironmentToolPath}
        themeMode={themeMode}
        onSelectThemeMode={setThemeMode}
        themeFamily={themeFamily}
        onSelectThemeFamily={setThemeFamily}
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
        autoHideDuration={
          snackbarNotice && !snackbarNotice.persistent
            ? snackbarDurationMs[snackbarNotice.severity]
            : null
        }
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
          '& .PhiSnackbar-card': {
            pointerEvents: 'auto'
          }
        }}
      >
        <AppSnackbarCard
          notice={snackbarNotice ?? emptySnackbarNotice}
          onClose={() => setSnackbarNotice(null)}
        />
      </Snackbar>
    </>
  )
}
