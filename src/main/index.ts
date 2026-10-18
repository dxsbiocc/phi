import {
  registerRuntimeSessionOrigin,
  resolveRuntimeSessionOrigin
} from './agent/session/runtime-origin-store'
import type { AgentRunFinishedEvent } from '../shared/agentRunNotice'
import type { PhiAgentEvent, PhiAgentEventSummary } from './agent/engine/types'
import type {
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget,
  RuntimeRecoveryIssue,
  RuntimeRecoverySummary
} from '../shared/runtimeRecoveryTypes'
import {
  createRuntimeRecoveryController,
  runtimeRecoveryMessage,
  type RuntimeRecoveryScope
} from './agent/session/runtime-recovery-ipc'
import {
  buildRuntimeRecoverySummary,
  readRuntimeRecoverySummarySeed
} from './agent/session/recovery-summary'
import {
  RemoteRecoveryError,
  describeRemoteRecoveryFailure
} from './agent/engine/rpc/session-recovery'
import {
  parseRuntimeReference,
  assertRuntimeReferenceProject,
  assertRuntimeScope,
  RuntimeReferenceError
} from './agent/session/runtime-reference'
import { facadeBindingHash } from './agent/engine/rpc/facade-session-driver'
import { selectionThinking } from './agent/engine/rpc/runtime-selection-control'
import { isPhiEventType, isPhiMessageUpdateSummary } from './agent/engine/events'
import type { BackgroundAgentJob, BackgroundShellJob } from '../shared/backgroundJobTypes'
import type {
  AutoCompactionOverrides,
  AutoCompactionSettingsPatch,
  CurrentAutoCompactionSettings,
  CurrentContextUsage,
  ManualCompactionOutcome,
  ManualCompactionTarget
} from '../shared/contextUsageTypes'
import type { WrapperRunFinishedEvent } from '../shared/wrapperRunNotice'
import type {
  PhiPluginInstallPreview,
  PhiPluginListItem,
  PhiPluginMutationResult,
  PhiPluginProblemView
} from '../shared/phiPluginTypes'
import type { EnablementItemKey, EnablementScope } from '../shared/enablementTypes'
import type { PromptAgentSummary } from '../shared/promptAgentTypes'
import { localizePhiPluginProblemMessage } from '../shared/phiPluginProblems'
import { declaredExternalOutputRoot } from '../shared/wrapperResultTypes'
import {
  hoverMediaPreviewType,
  mediaPreviewType,
  type PreviewImageMimeType
} from './file-preview-media'
import { shouldBlockHtmlReportNavigation } from '../shared/htmlReportPreview'
import {
  installNotebookOutputProtocol,
  registerNotebookOutputScheme
} from './agent/notebook/notebook-output-protocol'
import { isPluginSkillPreviewPath } from './agent/plugins/preview'
import type {
  WrapperRetargetRequest,
  WrapperRun,
  WrapperSubmitConfirmation
} from '../shared/wrapperTypes'
import './agent-env'
import { createMainWindowStartup } from './window-startup'
import {
  validatePermissionMode,
  validateSessionPermissionModeUpdate
} from './agent/session/permission-mode-control'
import { registerWorkspaceFileIpc } from './workspace-file-ipc'
import { nativeUiCopy } from './native-ui-copy'
import {
  createStartupSplashWindow,
  dismissStartupSplashWindow,
  type StartupSplashWindow
} from './startup-splash'
import { createMacMenuBar } from './menu-bar'
import type { MenuBarController } from './menu-bar-controller'
import type { MenuBarAction } from '../shared/menuBarTypes'
import type { IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import {
  app,
  shell,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeImage,
  net,
  Notification,
  powerSaveBlocker
} from 'electron'
import {
  BrowserIpcCoordinator,
  registerBrowserRendererIpc,
  routeBrowserAppShellWindowOpen,
  type BrowserIpcSession
} from './browser/browser-ipc'
import { FileSystemBrowserCheckpointStore } from './browser/browser-checkpoints'
import { ElectronBrowserEngine } from './browser/electron-browser-engine'
import { BrowserWorkspaceRegistry } from './browser/browser-workspace-registry'
import { createWebLinkPreviewService } from './web-link-preview'
import type { BrowserActionApprovalPrompt } from './browser/browser-approval'
import { BrowserToolHostCoordinator } from './agent/browser/browser-tool-host'
import { TerminalIpcCoordinator, registerTerminalRendererIpc } from './terminal/terminal-ipc'
import { TerminalDraftService } from './terminal/terminal-command-draft'
import { buildTerminalDraftSessionFactory } from './terminal/terminal-draft-session'
import { TerminalManager } from './terminal/terminal-manager'
import { resolveTerminalWorkspace } from './terminal/terminal-workspace'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import semver from 'semver'
import { createAgentSession } from './agent/session/session-manager'
import { promptWithAutomaticModelFallback } from './agent/session/automatic-model-fallback'
import { NotebookAiGenerationJobs } from './agent/notebook/notebook-ai-generation-jobs'
import { getAuthManager } from './agent/auth-manager'
import {
  fallbackMarkdownFromDescription,
  getPersonaMarkdown,
  isOnboarded,
  setPersonaMarkdown,
  skipOnboarding
} from './agent/persona-manager'
import {
  acknowledgeSession,
  createSessionManager,
  deleteSession,
  isPhiOnlySessionPath,
  listSessions,
  phiOnlySessionPath,
  phiSessionIdFromPath,
  renameSession
} from './agent/session/sessions'
import { getHomeActivity } from './agent/session/home-activity'
import {
  createProject,
  deleteProject,
  assertProjectPathAvailable,
  getProject,
  getProjectByCwd,
  listLocalProjectAllowRoots,
  listProjects,
  subscribeRemoteProjectConnection,
  updateProjectPermissionMode,
  updateProjectDefaults,
  updateProjectMemory,
  updateProjectRemoteDefaults,
  type PermissionMode,
  type ModelSelection,
  type Project,
  type ProjectRemoteConnection
} from './agent/projects'
import {
  isLocalFilePathAllowedByRoots,
  isPathInsideRoot,
  localFileAllowRoots
} from './agent/local-file-access'
import {
  deleteRemoteHostProfile,
  getRemoteHostProfile,
  remoteConnectionConfigForProfile,
  saveRemoteHostProfile
} from './agent/remote-hosts'
import {
  clearRemoteEnvironmentSetting,
  clearRemoteMicromambaMirrorSetting,
  clearRemoteRuntimeRootSetting,
  listRemoteHostsWithRuntimeRoots,
  remoteHostProfileWithRuntimeRoot,
  saveRemoteEnvironmentSetting,
  saveRemoteMicromambaMirrorSetting,
  saveRemoteRuntimeRootSetting,
  updateProjectRemoteConnectionRuntimeAware
} from './agent/remote-runtime-root-settings'
import { listOpenSshHosts } from './agent/ssh-config-discovery'
import { saveOpenSshHost } from './agent/ssh-config-editor'
import { createDefaultSshBootstrapCoordinator } from './agent/ssh-bootstrap/default-coordinator'
import { registerSshBootstrapIpc } from './agent/ssh-bootstrap/ipc'
import { registerRemoteMicromambaIpc } from './agent/remote-micromamba-ipc'
import { registerRemoteRipgrepIpc } from './agent/remote-ripgrep-ipc'
import { remoteMicromambaManifestVersion } from './agent/remote-micromamba-artifact'
import { readHostRuntimeRoot } from './agent/remote-runtime-root-store'
import { readHostRemoteEnvironmentPaths } from './agent/remote-environment-store'
import { resolveRemoteRuntimeRoot } from './agent/remote-runtime-root'
import {
  RemoteRuntimeController,
  controlRemoteRuntimeWorkspace,
  type RemoteRuntimeDispatchControl
} from './agent/remote-runtime/controller'
import { createDesktopWebSearchAdapter } from './agent/engine/rpc/desktop-websearch-adapter'
import { createDesktopMcpAdapter } from './agent/engine/rpc/desktop-mcp-adapter'
import { RemoteLibraryService } from './agent/engine/rpc/remote-library-service'
import { readColdChildRuns } from './agent/session/child-run-recovery'
import { resolveRemoteBaseEnvironment } from './agent/remote-runtime/base-environment'
import { resolveProjectRuntimeRoot } from './agent/remote-runtime/project-runtime-root'
import {
  openRemoteRuntimeWorkspace,
  type RemoteRuntimeTarget
} from './agent/remote-runtime/workspace'
import { sshConfigHostId, type OpenSshHostInput } from '../shared/remoteHostProfile'
import { remoteDoctor } from './agent/remote-doctor'
import { listRemoteProjectDirectories } from './agent/remote-directory-browser'
import { createCursorH2Bridge } from './agent/cursor-h2-bridge'
import { installRemoteNextflow } from './agent/remote-nextflow-install'
import { RemoteProjectConnectionTracker } from './agent/remote-project-connection'
import { createCheckedRemoteProject } from './agent/remote-project-create'
import { RemoteProjectUploadService } from './agent/remote-project-upload'
import { remoteTransferHostKey } from './agent/transfer'
import { loadRemoteProjectInstructions } from './agent/remote-project-instructions'
import { resolveRemoteRuntimePromptContext } from './agent/remote-runtime-context'
import {
  createDesktopProjectMemoryAdapter,
  retireDesktopProjectMemoryAdapters
} from './agent/engine/rpc/desktop-project-memory-adapter'
import {
  remoteBashApprovalScope,
  resolveAuthorizedRemoteConnectionConfig,
  resolveRemoteBashContext,
  resolveRemoteWorkspaceHostBinding,
  resolveRemoteWorkspacePath
} from './agent/remote-workspace-boundary'
import { readRemoteWorkspacePath } from './agent/remote-workspace-read'
import {
  listRemoteWorkspaceDirectory,
  previewRemoteWorkspaceFile
} from './agent/remote-workspace-file-ui'
import { remoteGlob, remoteGrep } from './agent/remote-workspace-search'
import { RemoteWorkspaceBashManager, type RemoteBashRequest } from './agent/remote-workspace-bash'
import { RemoteProjectDownloadManager } from './agent/download/remote-project-download'
import type { RemoteWriteRequest } from './agent/remote-workspace-write'
import {
  RemoteWorkspaceMutationManager,
  RemoteWorkspaceReadBasis,
  type RemoteEditRequest
} from './agent/remote-workspace-edit'
import {
  ensureRemoteProjectAnchor,
  isRemoteProjectAnchorPath,
  remoteProjectAnchorPath
} from './agent/remote-project-anchor'
import type { RemoteDoctorOptions } from '../shared/remoteDoctorTypes'
import type {
  RemoteEnvironmentSettingInput,
  RemoteEnvironmentToolId
} from '../shared/remoteEnvironmentTypes'
import type { ProjectLocation, RemoteProjectCreateInput } from '../shared/projectLocation'
import { renderMoleculeSvg } from './molecule-renderer'
import {
  bashApprovalDigest,
  editApprovalDigest,
  cancelToolApprovals,
  createApprovalExtension,
  requestToolApproval,
  requestRuntimeToolApproval,
  resolveToolApproval,
  writeApprovalDigest
} from './agent/tool-approval'
import { createEnvironmentBuilds } from './agent/content/environment-builds'
import { buildEnvironment } from './agent/content/environment-refs'
import { bindAgentSession } from './agent/content/environment-gate'
import {
  createSkillHost,
  type ConfirmBuildRequest,
  type PresentArtifactsRequest
} from './agent/content/skill-host'
import {
  loadRemoteProjectSkillCatalog,
  readRemoteProjectSkillContent,
  readRemoteProjectSkillResource,
  revokeRemoteProjectSkillTrust,
  trustRemoteProjectSkill,
  type RemoteProjectSkillCatalog,
  type RemoteProjectSkillContext
} from './agent/content/remote-project-skill-service'
import {
  loadRemoteProjectMcpCatalog,
  revokeRemoteProjectMcpTrust,
  trustRemoteProjectMcp,
  type RemoteProjectMcpCatalog,
  type RemoteProjectMcpContext
} from './agent/mcp/remote-project-mcp-service'
import { getRuntimeRoot } from './agent/envs/runtime'
import { collectGarbage } from './agent/envs/gc'
import { cleanupInactiveMcpVersions } from './agent/packages/mcp-version-cleanup'
import { capabilityApprovalSummary } from './agent/packages/capability-approval'
import { createCapabilityHost } from './agent/packages/capability-host'
import { createCapabilityService } from './agent/packages/capability-service'
import { createExternalSkillService } from './agent/packages/external-skills'
import { searchOfficialCatalog } from './agent/packages/official-catalog-api'
import {
  BUILD_NOW,
  confirmedEnvironmentBuild,
  environmentBuildQuestion
} from './agent/content/environment-build-prompt'
import {
  ADD_PACKAGES,
  confirmedEnvironmentRequest,
  requestProjectEnvironment,
  type EnvironmentRequestConfirm
} from './agent/content/env-request'
import {
  canRequestAgentUserInteraction,
  cancelAgentUserInteractions,
  resolveAgentUserInteraction,
  waitForAgentUserInteraction
} from './agent/user-interaction'
import {
  createInMemoryRuntimeSessionManager,
  createRuntimeResourceLoader,
  getBundledAgentsDir,
  getCoreAuthoringSkillDir,
  openRuntimeSessionManager,
  readAutoCompactionDefaults,
  type Skill as RuntimeSkill,
  type ModelRuntime,
  type RuntimeModel,
  type RuntimeResourceLoader
} from './agent/runtime/runtime-adapter'
import {
  installPlugin as installPhiPlugin,
  listInstalledPlugins,
  loadedPlugins,
  setPluginEnabled,
  uninstallPlugin as uninstallPhiPlugin,
  upgradePlugin,
  type PluginLifecycleResult,
  type PluginNamespace
} from './agent/plugins/loader'
import { validatePlugin, type PluginProblem } from './agent/plugins/validate'
import { buildPhiPluginListItem } from './agent/plugins/details'
import { readPluginRegistry, writePluginRegistry } from './agent/plugins/store'
import {
  getEnablementSnapshot,
  isCoreSkill,
  migrateEnablementFromHistory,
  setEnabled
} from './agent/enablement'
import {
  applyPackageUpdate,
  applyPackageUpdates,
  cleanupStalePackageStaging,
  importOfflinePackage,
  installPackages as installRegistryPackages,
  listKnownRegistries,
  listInstalledPackages as listRegistryPackages,
  listPackageUpdates,
  loadKnownRegistryIndexes,
  planInstall as planRegistryInstall,
  previewOfflinePackageImport,
  removeKnownRegistry,
  type PackageUpdate,
  uninstallPackage as uninstallRegistryPackage
} from './agent/packages/installer'
import { prepareContentPackageInstall, readContentRegistry } from './agent/packages/content-source'
import type { InstallerOptions } from './agent/packages/installer-types'
import type { PackageType } from './agent/packages/manifest'
import { readSkillPackageDetail } from './agent/packages/skill-detail'
import { readWrapperPackageDetail } from './agent/packages/wrapper-detail'
import { withConnectorMetadata } from './agent/mcp-server-view'
import { runPackageMutation } from './agent/packages/mutation-queue'
import { removeWrapperPackage } from './agent/packages/wrapper-removal'
import { syncPreferredOfficialRegistry } from './agent/packages/official-website-registry'
import { syncOfficialConnectorRegistry } from './agent/packages/official-connector-registry'
import { packageRegistryIconView } from './agent/packages/icon-views'
import {
  addGithubSource,
  applyGithubSourceUpdate,
  checkGithubSourceUpdate,
  listGithubSources,
  previewGithubSource,
  removeGithubSource
} from './agent/packages/github-source'
import { readResourceIcon } from './agent/resource-icons'
import type { RemoteMcpConnectorOptions } from '../shared/mcpConnectorCatalog'
import {
  addRemoteMcpConnector,
  connectorEnvironmentBuildAction,
  disableFeaturedApiKeyAutoDiscovery,
  installCatalogConnector,
  listConnectorCatalog,
  mcpOAuthAuthorizationOrigin,
  readCustomRemoteMcpConnector,
  refreshPersistedManagedStdioServers,
  readMcpServerEntry,
  removeRemoteMcpConnector,
  setMcpConnectorEnabled,
  setMcpPackageEnabled,
  uninstallCatalogConnector,
  validateName
} from './agent/mcp-connectors'
import {
  addLocalMcpConnector,
  listLocalMcpRuntimes,
  removeLocalMcpConnector,
  validateLocalConnectorRequest
} from './agent/mcp/custom-stdio'
import { ConnectorSetupTracker, type ConnectorSetupReporter } from './agent/mcp/connector-setup'
import { createLocalConnectorJobs } from './agent/mcp/local-connector-jobs'
import {
  API_KEY_CONNECTOR_IDS,
  apiKeyConnector,
  clearFeaturedMcpApiKey,
  isFeaturedMcpApiKeyInstalled,
  readFeaturedMcpApiKey,
  setFeaturedMcpApiKey
} from './agent/mcp-key-credentials'
import { McpApiKeyValidationError, validateFeaturedMcpApiKey } from './agent/mcp-key-validation'
import { validateSkill } from './agent/content/skill'
import {
  deleteSkill,
  listGlobalMcpServers,
  listGlobalSkills,
  listMcpServers,
  listPromptAgents,
  listSkills,
  readSkillContent,
  readGlobalSkillContent,
  setSkillDisabled
} from './agent/resources'
import {
  addCustomWrapper,
  migrateLegacyCustomWrappers,
  listWrapperCatalog
} from './agent/wrappers/catalog'
import {
  listWrapperCompositionCatalogStatus,
  readWrapperCompositionDag,
  readWrapperModuleDetails,
  resetWrapperCompositionCatalogCache
} from './agent/wrappers/composition/discovery'
import {
  wrapperJobHostHandlers,
  createWrapperJobHostScope
} from './agent/wrappers/composition/job-host-handlers'
import { shouldContinueConversation } from './agent/wrappers/composition/job-continue'
import { deliverWrapperRunFinished } from './agent/wrappers/composition/job-notify'
import { WrapperJobManager } from './agent/wrappers/composition/job-manager'
import { markInterruptedCompositionRuns } from './agent/wrappers/composition/run-record'
import { resolveProjectRemoteTarget } from './agent/wrappers/remote-connection-resolver'
import { reconcileRemoteWrapperRuns } from './agent/wrappers/executor-slurm-reconcile'
import { listWrapperResultDirectory } from './agent/wrappers/remote-results'
import { previewWrapperResult, readWrapperResultRange } from './agent/wrappers/remote-result-read'
import {
  downloadWrapperResultToPath,
  validateWrapperResultDownloadRequest
} from './agent/wrappers/remote-result-download'
import { discoverPhiAgents } from './agent/agents/discovery'
import {
  loadRemoteAgentCatalog,
  revokeRemoteAgent,
  trustRemoteAgent,
  type RemoteAgentProjectContext
} from './agent/agents/remote-agent-service'
import { BackgroundAgentApprovalTracker } from './agent/agents/background-approval'
import { buildAgentLeaderPrompt } from './agent/agents/leader-prompt'
import {
  continuationPrompt,
  shouldContinueAfterAgentRun,
  type ContinuationEvent
} from './agent/agents/run-continue'
import { agentRunHostHandlers } from './agent/agents/run-host'
import { buildWrapperReproducibilityBundle } from './agent/wrappers/reproducibility'
import { recordWrapperUploadedInput, retargetWrapperRunPlan } from './agent/wrappers/plans'
import { connectRemoteSshSession } from './agent/wrappers/remote-ssh-session'
import { cancelWrapperRun, cancelWrapperRunPlan, submitWrapperRunPlan } from './agent/wrappers/runs'
import {
  listWrapperRuns,
  readWrapperPlan,
  readWrapperPlanArtifact,
  readWrapperRun
} from './agent/wrappers/store'
import { cleanupOldLogs, writeAppLog } from './agent/app-logger'
import {
  configureSystemUiLanguage,
  readAppSettings,
  readLastSelectedModel,
  updateAppSettings,
  writeLastSelectedModel
} from './agent/app-settings'
import { isSecretMetadataKey, redactSensitiveText } from './agent/redaction'
import {
  emptyNotebookRegistry,
  initializeProjectAnalysis,
  listProjectNotebooks
} from './agent/notebook/analysis-notebooks'
import {
  closeProjectNotebook,
  createProjectNotebook,
  deleteProjectNotebook,
  openProjectNotebook,
  saveProjectNotebook,
  type SaveProjectNotebookInput
} from './agent/notebook/analysis-notebook-files'
import { AnalysisNotebookFileWatcher } from './agent/notebook/analysis-notebook-watch'
import {
  createManagedEnvironmentActions,
  detectConfiguredAnalysisKernels,
  getCustomToolPath,
  listManagedEnvironments
} from './agent/environment'
import { createBackgroundEnvironment } from './agent/environment/background'
import { JupyterServerRegistry } from './agent/notebook/analysis-jupyter-server'
import {
  AnalysisNotebookExecutor,
  type JupyterKernelCompletionResult,
  type NotebookVariableIntrospection
} from './agent/notebook/analysis-jupyter-execution'
import {
  completeNotebookPythonStaticCompletion,
  mergeNotebookCompletionResults
} from './agent/notebook/analysis-notebook-completion'
import { formatNotebookCellSource } from './agent/notebook/analysis-notebook-formatting'
import { AnalysisNotebookSessionRegistry } from './agent/notebook/analysis-jupyter-sessions'
import {
  buildNotebookCodeGenerationRepairPrompt,
  buildNotebookCodeGenerationPrompt,
  generatedNotebookCellsSource,
  notebookCellPromptContext,
  notebookGenerationEmptyResultMessage,
  parseFinalGeneratedNotebookCompletion,
  parseGeneratedNotebookCompletionSnapshot
} from './agent/notebook/notebook-code-generation'
import {
  NotebookCompletionCollector,
  type NotebookCompletionSelection
} from './agent/notebook/notebook-completion'
import { AnalysisNotebookToolExecutor } from './agent/notebook/notebook-tool-executor'
import {
  createRemoteAnalysisNotebookBackend,
  remoteNotebookFileChange,
  type RemoteAnalysisNotebookBackend
} from './agent/notebook/remote-analysis-notebook-backend'
import { NotebookToolHostRouter } from './agent/notebook/notebook-tool-host-router'
import {
  getPhiEngine,
  ownsRemoteRuntimeSession,
  readRpcCompactionPolicy
} from './agent/engine/in-process-engine'
import {
  installAppRemoteSessionRouting,
  createAppRemoteSessionManager,
  type AppRemoteSessionRoutingOptions
} from './agent/remote-session-routing'
import { checkForAppUpdate, RELEASES_PAGE_URL, RELEASES_REPOSITORY } from './app-update-check'
import { RemoteJupyterStartJobs } from './agent/notebook/remote-jupyter-start-jobs'
import {
  normalizeProjectMemorySettings,
  type ProjectMemorySnapshot
} from '../shared/projectMemoryTypes'
import { validatePresentedFiles } from './agent/deliverables/present-files'
import { validateRemotePresentedFiles } from './agent/deliverables/remote-present-files'
import { MAX_PRESENTED_FILES, type PresentedFile } from '../shared/presentedFileTypes'
import {
  isStaleSessionError,
  StaleSessionError,
  SessionLifecycle,
  type SessionLifecycleRecord,
  type SessionSnapshot
} from './agent/session/session-lifecycle'
import { SessionRunnerRegistry } from './agent/session/session-runner-registry'
import { exportPhiSession } from './agent/session/session-export'
import {
  beginWorkspaceChangeCapture,
  finishWorkspaceChangeCapture
} from './agent/session/workspace-changes'
import { persistWorkspaceDiff, readWorkspaceDiff } from './agent/session/workspace-diffs'
import { SessionTitleGenerator } from './agent/session/session-title-generation'
import {
  persistPromptImages,
  readPromptImage,
  validatePromptImages
} from './agent/session/prompt-images'
import type { PromptImageInput } from '../shared/promptImageTypes'
import {
  appendSessionEvent,
  createPhiSession,
  forkPhiSession,
  createRunId,
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  persistToolOutput,
  readSessionEvents,
  recoverInterruptedPhiSessions,
  updateSessionManifest,
  type LastRunOutcome,
  type PhiSessionManifest,
  type SessionEventInput,
  type SessionStatus,
  type StoredSessionEvent,
  type UnreadKind,
  listPhiSessions,
  toolResultDetailsForSession
} from './agent/session/session-store'
import {
  updateNotebookCell,
  type JsonObject,
  type NotebookDocument
} from '../shared/notebookDocument'
import { notebookCellMetadataWithExecutionDuration } from '../shared/notebookExecutionMetadata'
import { messageContentTitleText } from '../shared/sessionTitle'
import type { AgentUserInteractionQuestion } from '../shared/agentInteractionTypes'
import { createBeforeQuitHandler } from './app-quit'
import icon from '../../resources/icon.png?asset'

// Compatibility boundary: Electron derives userData and macOS "Phi Safe Storage" from this name.
const APP_NAME = 'Phi'
const APP_QUIT_CLEANUP_TIMEOUT_MS = 2_000
const APP_ID = 'cn.phiscience.phi'
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 860
const MIN_WINDOW_HEIGHT = 560
const appIcon = nativeImage.createFromPath(icon)
const macFilenameExtensionTagClass = 'public.filename-extension'
const macContentTypesByExtension: Record<string, string[]> = {
  csv: ['public.comma-separated-values-text'],
  htm: ['public.html'],
  html: ['public.html'],
  key: ['com.apple.keynote.key'],
  numbers: ['com.apple.iwork.numbers.numbers'],
  pages: ['com.apple.iwork.pages.pages'],
  pdf: ['com.adobe.pdf', 'public.pdf'],
  ppt: ['com.microsoft.powerpoint.ppt'],
  pptx: ['org.openxmlformats.presentationml.presentation'],
  tsv: ['public.tab-separated-values-text'],
  xls: ['com.microsoft.excel.xls'],
  xlsx: ['org.openxmlformats.spreadsheetml.sheet'],
  doc: ['com.microsoft.word.doc'],
  docx: ['org.openxmlformats.wordprocessingml.document']
}
const macFallbackApplicationBundleIdByExtension: Record<string, string> = {
  avif: 'com.apple.preview',
  bmp: 'com.apple.preview',
  gif: 'com.apple.preview',
  heic: 'com.apple.preview',
  jpeg: 'com.apple.preview',
  jpg: 'com.apple.preview',
  pdf: 'com.apple.preview',
  png: 'com.apple.preview',
  tif: 'com.apple.preview',
  tiff: 'com.apple.preview',
  webp: 'com.apple.preview'
}
const macApplicationPathsByBundleId: Record<string, string[]> = {
  'com.apple.preview': ['/System/Applications/Preview.app', '/Applications/Preview.app'],
  'com.apple.textedit': ['/System/Applications/TextEdit.app', '/Applications/TextEdit.app'],
  'com.apple.iwork.keynote': ['/Applications/Keynote.app'],
  'com.apple.iwork.numbers': ['/Applications/Numbers.app'],
  'com.apple.iwork.pages': ['/Applications/Pages.app'],
  'com.google.chrome': ['/Applications/Google Chrome.app'],
  'com.microsoft.excel': ['/Applications/Microsoft Excel.app'],
  'com.microsoft.powerpoint': ['/Applications/Microsoft PowerPoint.app'],
  'com.microsoft.vscode': ['/Applications/Visual Studio Code.app'],
  'com.microsoft.word': ['/Applications/Microsoft Word.app']
}

type MacLaunchServicesHandler = {
  LSHandlerContentTag?: string
  LSHandlerContentTagClass?: string
  LSHandlerContentType?: string
  LSHandlerRoleAll?: string
  LSHandlerRoleViewer?: string
  LSHandlerRoleEditor?: string
}

let macLaunchServicesHandlers: Promise<MacLaunchServicesHandler[]> | null = null
const macApplicationPathQueries = new Map<string, Promise<string[]>>()
// Set by agent-env.ts before this module's own top-level code runs.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR as string
let cachedPackageUpdates: PackageUpdate[] = []

app.setName(APP_NAME)

function applyDockIcon(): void {
  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon)
  }
}

const mainWindowStartups = new WeakMap<BrowserWindow, ReturnType<typeof createMainWindowStartup>>()
let mainWindow: BrowserWindow | null = null
let startupSplashWindow: StartupSplashWindow | null = null
let menuBarController: MenuBarController | null = null
let pendingMenuBarAction: MenuBarAction | null = null
let mainWindowCleanupStarted = false
type BrowserRegistryLifecycle = 'idle' | 'disposing' | 'failed'
let browserWorkspaceRegistry: BrowserWorkspaceRegistry | null = null
let browserWorkspaceRegistryLifecycle: BrowserRegistryLifecycle = 'idle'
let browserWorkspaceRegistryDisposal: Promise<void> | null = null
let terminalManager: TerminalManager | null = null
let terminalDraftService: TerminalDraftService | null = null
let mainWindowCleanupPromise: Promise<void> | null = null

function showMainWindowFromMenuBar(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (startupSplashWindow && !startupSplashWindow.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

function queueMenuBarAction(action: MenuBarAction): void {
  pendingMenuBarAction = action
  showMainWindowFromMenuBar()
}

function hideMainWindowFromMenuBar(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
}

function requireMainWindowRenderer(event: IpcMainInvokeEvent): BrowserWindow {
  const window = mainWindow
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Window renderer is not authorized')
  }
  return window
}

const webLinkPreviews = createWebLinkPreviewService()

function finishStartupSplash(window: BrowserWindow | null): void {
  const splash = startupSplashWindow
  startupSplashWindow = null
  if (!window) {
    if (splash && !splash.isDestroyed()) splash.close()
    return
  }
  dismissStartupSplashWindow(splash, window)
}

function sendMainWindowFullscreenState(window: BrowserWindow, fullscreen: boolean): void {
  if (mainWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  window.webContents.send('window:fullscreen-changed', fullscreen)
}
const browserCheckpointStore = new FileSystemBrowserCheckpointStore({ agentDir: AGENT_DIR })

function browserPolicyContext(): { applicationOrigins?: string[] } {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  return rendererUrl ? { applicationOrigins: [rendererUrl] } : {}
}

function getBrowserWorkspaceRegistry(): BrowserWorkspaceRegistry {
  if (mainWindowCleanupStarted || browserWorkspaceRegistryLifecycle !== 'idle') {
    throw new Error('Browser workspace is unavailable')
  }
  if (!browserWorkspaceRegistry) {
    browserWorkspaceRegistry = new BrowserWorkspaceRegistry({
      engineFactory: () =>
        new ElectronBrowserEngine({
          WebContentsView,
          getOwningWindow: () => {
            const window = mainWindow
            return window && !window.isDestroyed() ? window : null
          },
          policyContext: browserPolicyContext()
        }),
      policyContext: browserPolicyContext(),
      checkpointStore: browserCheckpointStore,
      openExternal: (url) => shell.openExternal(url),
      approveAgentAction: requestBrowserActionApproval
    })
    const current = getCurrentSessionPayload()
    void browserWorkspaceRegistry.setActiveSession(current.phiSessionId ?? null).catch(() => {
      writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
    })
  }
  return browserWorkspaceRegistry
}

async function requestBrowserActionApproval(
  prompt: BrowserActionApprovalPrompt,
  signal: AbortSignal
): Promise<'approved' | 'denied' | 'cancelled'> {
  const run = [...activePromptRuns.values()].find(
    (candidate) =>
      candidate.phiSessionId === prompt.sessionId &&
      candidate.runId === prompt.runId &&
      !candidate.cancelled
  )
  if (!run) return 'cancelled'
  const manifest = findPhiSessionById(run.phiSessionId)
  if (!manifest || signal.aborted) return 'cancelled'
  const project = manifest.projectId ? getProject(manifest.projectId) : undefined
  return requestToolApproval({
    signal,
    getWindow: () => {
      const window = mainWindow
      return window && !window.isDestroyed() ? window : null
    },
    context: {
      sessionId: run.phiSessionId,
      sessionPath: phiOnlySessionPath(run.phiSessionId),
      sessionGeneration: run.sessionGeneration,
      runId: run.runId,
      cwd: run.cwd,
      ...(project?.name ? { projectName: project.name } : {})
    },
    toolCallId: prompt.toolCallId,
    browser: {
      origin: prompt.origin,
      action: prompt.action,
      consequence: prompt.consequence,
      reason: prompt.reason
    },
    onApprovalRequested: (request) => {
      runnerRegistry.markNeedsApproval(run.phiSessionId, request.requestId, {
        toolName: request.toolName,
        summary: request.summary
      })
    },
    onApprovalResolved: (request, approved) => {
      if (approved) runnerRegistry.markApprovalApproved(run.phiSessionId, request.requestId)
      else runnerRegistry.markApprovalDenied(run.phiSessionId, request.requestId)
    },
    onApprovalCancelled: (request) => {
      runnerRegistry.markApprovalCancelled(run.phiSessionId, request.requestId)
      sendToAllWindows('tool:approval-cancelled', request.requestId)
    }
  })
}

function cleanupBrowserWorkspaceRegistry(): Promise<void> {
  const registry = browserWorkspaceRegistry
  if (!registry) return browserWorkspaceRegistryDisposal ?? Promise.resolve()
  if (browserWorkspaceRegistryLifecycle !== 'idle') {
    return browserWorkspaceRegistryDisposal ?? Promise.resolve()
  }
  browserWorkspaceRegistryLifecycle = 'disposing'
  let disposal: Promise<void>
  try {
    disposal = registry.disposeAll()
  } catch {
    browserWorkspaceRegistryLifecycle = 'failed'
    writeAppLog({ level: 'error', event: 'browser_registry_cleanup_failed' })
    return Promise.resolve()
  }
  browserWorkspaceRegistryDisposal = disposal
  void disposal.then(
    () => {
      if (browserWorkspaceRegistry !== registry || browserWorkspaceRegistryDisposal !== disposal) {
        return
      }
      browserWorkspaceRegistry = null
      browserWorkspaceRegistryDisposal = null
      browserWorkspaceRegistryLifecycle = 'idle'
    },
    () => {
      if (browserWorkspaceRegistry !== registry || browserWorkspaceRegistryDisposal !== disposal) {
        return
      }
      browserWorkspaceRegistryLifecycle = 'failed'
      writeAppLog({ level: 'error', event: 'browser_registry_cleanup_failed' })
    }
  )
  return disposal
}

function getTerminalManager(): TerminalManager {
  if (mainWindowCleanupStarted) throw new Error('Terminal manager is unavailable')
  if (!terminalManager) {
    terminalManager = new TerminalManager({
      resolveWorkspace: (ref) =>
        resolveTerminalWorkspace(ref, {
          getProject,
          noProjectTaskFolder: getNoProjectTaskFolder,
          realDirectory: (path) => realDirectoryPath(path),
          isRemoteAnchor: (path) => isRemoteProjectAnchorPath(path, AGENT_DIR),
          resolveRemoteWorkspaceHostBinding: (input, options) => {
            const binding = resolveRemoteWorkspaceHostBinding(input, {
              agentDir: AGENT_DIR
            })
            const authorized = resolveAuthorizedRemoteConnectionConfig(input, {
              agentDir: AGENT_DIR,
              userInitiated: options.userInitiated
            })
            return {
              hostAlias: binding.hostAlias,
              remoteRoot: binding.remoteRoot,
              connection: {
                ...authorized.connection,
                userInitiated: options.userInitiated
              }
            }
          }
        }),
      sink: (event) => {
        if (
          event.type === 'state' &&
          (event.snapshot.state === 'closing' ||
            event.snapshot.state === 'exited' ||
            event.snapshot.state === 'failed')
        ) {
          terminalDraftService?.terminalClosed(event.snapshot.terminalId)
        }
        terminalIpcCoordinator.sendEvent(event)
      }
    })
  }
  return terminalManager
}

function getTerminalDraftService(): TerminalDraftService {
  if (mainWindowCleanupStarted) throw new Error('Terminal draft service is unavailable')
  if (!terminalDraftService) {
    terminalDraftService = new TerminalDraftService({
      createSession: buildTerminalDraftSessionFactory({
        createAgentSession,
        createSessionManager: createInMemoryRuntimeSessionManager,
        resolveSession: async (context) => {
          const runtime = await getAuthManager().getRuntime()
          const project = context.workspaceKey.startsWith('project:')
            ? getProject(context.workspaceKey.slice('project:'.length))
            : undefined
          const modelSelection = project?.defaultModel ?? selectedModel
          const model = modelSelection
            ? resolveRuntimeModelSelection(runtime, modelSelection)?.model
            : undefined
          return {
            modelRuntime: runtime,
            model,
            thinkingLevel: project?.defaultThinkingLevel ?? selectedThinkingLevel
          }
        }
      }),
      manager: getTerminalManager()
    })
  }
  return terminalDraftService
}

async function disposeTerminalManager(): Promise<void> {
  const draftService = terminalDraftService
  const manager = terminalManager
  terminalDraftService = null
  terminalManager = null
  await Promise.all([draftService?.dispose(), manager?.dispose()])
}

function browserSessionForPhiId(phiSessionId: string): BrowserIpcSession | undefined {
  const manifest = findPhiSessionById(phiSessionId)
  if (!manifest) return undefined
  const project = manifest.projectId ? getProject(manifest.projectId) : undefined
  const location = manifest.projectLocation ?? project?.location
  return {
    sessionId: phiSessionId,
    owner: location ? { kind: 'project', location } : { kind: 'ordinary' }
  }
}

const browserIpcCoordinator = new BrowserIpcCoordinator({
  getRegistry: getBrowserWorkspaceRegistry,
  getTrustedRenderer: () => {
    const window = mainWindow
    return window && !window.isDestroyed() ? window.webContents : null
  },
  resolveHumanSession: () => {
    const current = getCurrentSessionPayload()
    if (!current.phiSessionId) return undefined
    return {
      sessionId: current.phiSessionId,
      sessionGeneration: current.sessionGeneration,
      owner: current.projectLocation
        ? { kind: 'project', location: current.projectLocation }
        : { kind: 'ordinary' }
    }
  },
  resolveAgentSession: (originSessionId) => {
    const origin = resolveOriginSession(originSessionId)
    return origin ? browserSessionForPhiId(origin.phiSessionId) : undefined
  }
})

const terminalIpcCoordinator = new TerminalIpcCoordinator({
  getManager: getTerminalManager,
  getDraftService: getTerminalDraftService,
  getTrustedRenderer: () => {
    const window = mainWindow
    return window && !window.isDestroyed() ? window.webContents : null
  }
})

// The desktop uses Chromium networking so the operating system's proxy settings also
// apply to catalog metadata and package archives. The transport remains usable in Node/tests.
const officialRegistryFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init)

/** Package changes share registries on disk, so they run one after another (see mutation-queue). */
function serializedPackageMutation<Args extends unknown[], Result>(
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result>
): (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> {
  return (event, ...args) => runPackageMutation(() => handler(event, ...args))
}

function officialContentSourceOptions(): {
  agentDir: string
  appVersion: string
  fetch: typeof fetch
  buildMcpEnvironment: NonNullable<InstallerOptions['buildMcpEnvironment']>
  verifyMcpStdio: NonNullable<InstallerOptions['verifyMcpStdio']>
} {
  return {
    agentDir: AGENT_DIR,
    appVersion: app.getVersion(),
    fetch: officialRegistryFetch,
    buildMcpEnvironment: (descriptor) =>
      environmentBuilds.start(descriptor, {
        ref: descriptor.ref,
        requestedBy: { mcp: descriptor.owner ?? descriptor.spec.name }
      }),
    verifyMcpStdio: (request) => getPhiEngine().mcp.configuredStdioTools(request)
  }
}

function knownContentSourceOptions(
  type?: PackageType,
  forceRefresh = false
): {
  agentDir: string
  loadOfficialRegistry: () => ReturnType<typeof syncPreferredOfficialRegistry>
} {
  return {
    agentDir: AGENT_DIR,
    loadOfficialRegistry: () =>
      (type === 'mcp' ? syncOfficialConnectorRegistry : syncPreferredOfficialRegistry)({
        ...officialContentSourceOptions(),
        forceRefresh
      })
  }
}

async function loadPackageRegistries(
  type?: PackageType,
  forceRefresh = false
): ReturnType<typeof loadKnownRegistryIndexes> {
  const loaded = await loadKnownRegistryIndexes(
    knownContentSourceOptions(type ?? 'mcp', forceRefresh)
  )
  if (type) return loaded
  try {
    const website = await syncPreferredOfficialRegistry({
      ...officialContentSourceOptions(),
      forceRefresh
    })
    return {
      ...loaded,
      registries: [
        ...loaded.registries,
        { ...website, packages: website.packages.filter((entry) => entry.type !== 'mcp') }
      ]
    }
  } catch (error) {
    return {
      ...loaded,
      errors: [
        ...loaded.errors,
        `Phi 官网其他模块：${error instanceof Error ? error.message : String(error)}`
      ]
    }
  }
}

function packageUpdateViews(updates: readonly PackageUpdate[]): PackageUpdate[] {
  return [...updates]
}

async function refreshCachedPackageUpdates(): Promise<PackageUpdate[]> {
  const loaded = await loadPackageRegistries()
  cachedPackageUpdates = listPackageUpdates(loaded.registries, {
    agentDir: AGENT_DIR,
    appVersion: app.getVersion()
  })
  return cachedPackageUpdates
}

async function refreshGithubSourceDependants(): Promise<void> {
  cachedPackageUpdates = []
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('packages:updatesAvailable', [])
  }
}

function scheduleStartupPackageUpdateCheck(): void {
  setImmediate(async () => {
    try {
      const updates = await refreshCachedPackageUpdates()
      if (updates.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('packages:updatesAvailable', packageUpdateViews(updates))
      }
    } catch (error) {
      writeAppLog({
        level: 'warn',
        event: 'package_update_check_failed',
        metadata: { error: error instanceof Error ? error.message : String(error) }
      })
    }
  })
}

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TOOL_OUTPUT_INLINE_LIMIT = 20000
const FILE_PREVIEW_BYTES_LIMIT = 320000
const MAX_RUN_DIFF_BYTES = 2 * 1024 * 1024
const FILE_MEDIA_PREVIEW_BYTES_LIMIT = 10 * 1024 * 1024
const FILE_HTML_PREVIEW_BYTES_LIMIT = 10 * 1024 * 1024
const FILE_HOVER_TEXT_BYTES_LIMIT = 32 * 1024
const FILE_HOVER_IMAGE_BYTES_LIMIT = 2 * 1024 * 1024
const FILE_HOVER_SNIFF_BYTES_LIMIT = 512
const LOCAL_PATH_STAT_LIMIT = 128
const DIRECTORY_ENTRY_LIMIT = 400
const KIMI_CODE_REPLACEMENT_MODEL_IDS = [
  'kimi-for-coding',
  'k3',
  'k3-256k',
  'kimi-for-coding-highspeed'
] as const

// Mirrors the runtime model metadata: a level is
// unsupported if the model's thinkingLevelMap explicitly maps it to null, and
// 'xhigh'/'max' additionally require an explicit (non-undefined) mapping —
// most models don't opt into those two tiers at all.
function getSupportedThinkingLevels(model: {
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
}): ThinkingLevel[] {
  if (!model.reasoning) return []
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

function isRetiredKimiCodeModel(providerId: string, modelId: string): boolean {
  return providerId === 'kimi-code' && /^kimi-k2(?:$|[.-])/.test(modelId)
}

function isSelectableRuntimeModel(model: { provider: string; id: string }): boolean {
  return !isRetiredKimiCodeModel(model.provider, model.id)
}

function selectableRuntimeModels(runtime: ModelRuntime): RuntimeModel[] {
  return runtime.getModels().filter(isSelectableRuntimeModel)
}

function resolveRuntimeModelSelection(
  runtime: ModelRuntime,
  selection: ModelSelection
): { model: RuntimeModel; selection: ModelSelection; migratedFrom?: ModelSelection } | null {
  const exact = runtime.getModel(selection.providerId, selection.modelId)
  if (exact && isSelectableRuntimeModel(exact)) {
    return { model: exact, selection }
  }

  if (!isRetiredKimiCodeModel(selection.providerId, selection.modelId)) {
    return null
  }

  for (const modelId of KIMI_CODE_REPLACEMENT_MODEL_IDS) {
    const replacement = runtime.getModel(selection.providerId, modelId)
    if (replacement && isSelectableRuntimeModel(replacement)) {
      return {
        model: replacement,
        selection: { providerId: replacement.provider, modelId: replacement.id },
        migratedFrom: selection
      }
    }
  }

  return null
}

function modelSelectionLabel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`
}

type AgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>
type AgentSessionInstance = AgentSessionResult['session']
type AgentSessionRecord = SessionLifecycleRecord<AgentSessionResult>
type CurrentSessionPayload = {
  path: string | null
  phiSessionId?: string
  cwd: string
  displayCwd: string
  projectId?: string
  projectLocation?: ProjectLocation
  sessionGeneration: number
  permissionMode: PermissionMode
  status: SessionStatus
  unreadKind: UnreadKind | null
  lastRunOutcome?: LastRunOutcome
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

type PromptTargetInput = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration?: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  planMode?: boolean
}

interface PromptRun {
  sessionKey: string
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  generation: number
  sessionGeneration: number
  cancelled: boolean
  recordedFailureMessage?: string
  stoppingPermanentProviderError?: boolean
  thinkingBlocks: Map<number, string>
  thinkingBlockStartedAtMs: Map<number, number>
  compactionReasons: Map<string, string>
  agentToolCallIds: Set<string>
  sdkToolCallIds: Set<string>
  browserSdkToolCallIds: Set<string>
  persistedToolCallIds: Set<string>
  pendingProviderToolCalls: Map<string, { toolName: string; args: unknown; createdAt?: string }>
  sessionPath?: string | null
  session?: AgentSessionInstance
  done?: Promise<{ path: string | null; phiSessionId?: string; sessionGeneration: number } | null>
}

type AnalysisNotebookCodeGenerationInput = {
  prompt: string
  language: string
  requestId?: string
  model?: {
    providerId: string
    modelId: string
  } | null
  afterCellId?: string | null
  references?: AnalysisNotebookContextReference[]
}

type AnalysisNotebookContextReference = {
  id: string
  kind: 'dataframe' | 'data_source' | 'variable' | 'cell_output'
  name: string
  detail?: string
  cellId?: string
  preview?: {
    source?: string
    code?: string
    output?: string
    value?: string
    shape?: string
    columns?: Array<{ name: string; type?: string }>
  }
}

type AnalysisNotebookGeneratedCell = {
  cellType: 'code' | 'markdown'
  source: string
  language?: string
}

type AnalysisNotebookCodeGenerationResult = {
  source: string
  language: string
  cells?: AnalysisNotebookGeneratedCell[]
}

type AnalysisNotebookCodeGenerationProgress = {
  requestId: string
  path: string
  relativePath: string
  source: string
  language: string
  cells: AnalysisNotebookGeneratedCell[]
}

const sessionLifecycles = new Map<string, SessionLifecycle<AgentSessionResult>>()
const sessionAbortControllers = new Map<string, AbortController>()
const cleanupBarriersByPath = new Map<string, Promise<void>>()
const unknownPathCleanupBarriers = new Set<Promise<void>>()

function getNoProjectTaskFolder(): string {
  return readAppSettings(AGENT_DIR).noProjectTaskFolder
}

type AnalysisWorkspaceContext = {
  workingDirectory: string
  name: string
  project: Project | null
  remoteSessionId?: string
}

function currentRemoteAnalysisProject(
  targetCwd: string
): { project: Project; sessionId: string } | null {
  const manifest = findPhiManifestForSession(currentSessionKey, currentSessionPath, currentCwd)
  const project = manifest?.projectId ? getProject(manifest.projectId) : undefined
  if (!manifest || !project || project.location.kind !== 'ssh') return null
  const accepted = new Set([
    manifest.cwd,
    project.workingDirectory,
    project.location.remoteRoot,
    project.location.canonicalRoot
  ])
  return accepted.has(targetCwd) ? { project, sessionId: manifest.sessionId } : null
}

function realDirectoryPath(
  path: string,
  options: { create?: boolean; fallbackToResolved?: boolean } = {}
): string | null {
  try {
    if (options.create) {
      mkdirSync(path, { recursive: true })
    }
    const realPath = realpathSync(path)
    return statSync(realPath).isDirectory() ? realPath : null
  } catch {
    return options.fallbackToResolved ? resolve(path) : null
  }
}

function resolveAnalysisWorkspaceByCwd(cwd?: string): AnalysisWorkspaceContext | null {
  const targetCwd = cwd ?? currentCwd
  const remote = currentRemoteAnalysisProject(targetCwd)
  if (remote && remote.project.location.kind === 'ssh') {
    return {
      workingDirectory: remote.project.location.canonicalRoot,
      name: remote.project.name,
      project: remote.project,
      remoteSessionId: remote.sessionId
    }
  }
  if (isRemoteProjectAnchorPath(targetCwd, AGENT_DIR)) return null
  const project = getProjectByCwd(targetCwd)
  if (project) {
    assertProjectPathAvailable(project.workingDirectory)
    return {
      workingDirectory: project.workingDirectory,
      name: project.name,
      project
    }
  }

  const noProjectTaskFolder = getNoProjectTaskFolder()
  const noProjectWorkspaceRealPath = realDirectoryPath(noProjectTaskFolder, {
    create: true,
    fallbackToResolved: true
  })
  const targetRealPath = realDirectoryPath(targetCwd, {
    create: resolve(targetCwd) === resolve(noProjectTaskFolder),
    fallbackToResolved: resolve(targetCwd) === resolve(noProjectTaskFolder)
  })
  if (!targetRealPath) return null

  const currentCwdRealPath = getProjectByCwd(currentCwd) ? null : realDirectoryPath(currentCwd)
  if (targetRealPath !== noProjectWorkspaceRealPath && targetRealPath !== currentCwdRealPath) {
    return null
  }

  return {
    workingDirectory: targetRealPath,
    name: basename(targetRealPath) || 'workspace',
    project: null
  }
}

function isRemoteAnalysisCwd(cwd: string): boolean {
  if (isRemoteProjectAnchorPath(cwd, AGENT_DIR)) return true
  if (currentRemoteAnalysisProject(cwd)) return true
  const localProject = getProjectByCwd(cwd)
  if (localProject && localProject.location?.kind !== 'ssh') return false
  return listProjects().some((project) => {
    if (project.location.kind !== 'ssh') return false
    return [project.workingDirectory, project.location.remoteRoot, project.location.canonicalRoot]
      .filter((root): root is string => typeof root === 'string' && root.length > 0)
      .some((root) => isPathInsideRoot(root, cwd))
  })
}

let freshSessionCounter = 0
// The session file currently active in the UI. undefined = a fresh, not-yet-persisted
// chat (nothing appended to it yet, so no file exists and it won't show in the sidebar
// until the first prompt). Distinct from invalidating the session object below: switching
// this is a user-visible "change conversation" action, while invalidation just rebuilds
// the in-memory AgentSession (e.g. after an auth/model/persona change) against whatever
// conversation was already active.
let currentSessionPath: string | undefined
// Working directory for the active conversation. A plain "对话" (conversation) uses the
// user-configurable no-project task folder; a "项目" (project) uses its own folder and
// carries a permission mode gating bash/edit/write tool calls (see tool-approval.ts).
let currentCwd: string = getNoProjectTaskFolder()
let currentPermissionMode: PermissionMode = 'auto'
let selectedModel: ModelSelection | null | undefined = readLastSelectedModel()
let modelSelectionRequest = 0
let lastRememberedModelSelectionRequest = 0
const sessionModelSelectionQueues = new Map<string, Promise<void>>()
// Default is deliberately 'high', not the SDK's own default of 'off': many models
// (e.g. DeepSeek V4 Pro) only enable reasoning output at 'high'/'max', and this app
// wants that reasoning visible in the UI out of the box rather than silently absent.
const selectedThinkingLevel: ThinkingLevel = 'high'
let currentSessionKey = createSessionKey(undefined, currentCwd, freshSessionCounter)
let sessionSwitchRequest = 0
const promptQueues = new Map<string, Promise<void>>()
const promptGenerations = new Map<string, number>()
const activePromptRuns = new Map<string, PromptRun>()
const runtimeRecoveryOperations = new Map<
  string,
  { controller: AbortController; done: Promise<void> }
>()
const runtimeRecoveryFailures = new Map<string, RuntimeRecoveryIssue>()
const projectMemoryPolicyUpdates = new Set<string>()
const manualCompactionIds = new Set<string>()
const manualCompactionOperations = new Map<
  string,
  { session?: AgentSessionInstance; cancelled: boolean; done: Promise<void> }
>()
const approvedRemoteBashCalls = new Map<
  string,
  { projectId: string; approvedCwd: string; approvalDigest: string; expiresAt: number }
>()
const approvedRemoteWriteCalls = new Map<
  string,
  { projectId: string; approvedCwd: string; approvalDigest: string; expiresAt: number }
>()
const approvedRemoteEditCalls = new Map<
  string,
  { projectId: string; approvedCwd: string; approvalDigest: string; expiresAt: number }
>()

function remoteBashApprovalKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`
}

function requireRemoteBashApproval(request: RemoteBashRequest): void {
  const manifest = findPhiSessionById(request.sessionId)
  if (!manifest || manifest.projectId !== request.projectId) {
    throw new Error('远程命令会话归属无效')
  }
  const key = remoteBashApprovalKey(request.sessionId, request.toolCallId)
  const approved = approvedRemoteBashCalls.get(key)
  approvedRemoteBashCalls.delete(key)
  if (manifest.permissionMode !== 'ask') return
  const project = getProject(request.projectId)
  const host =
    project?.location.kind === 'ssh'
      ? getRemoteHostProfile(project.location.hostProfileId)
      : undefined
  if (!project || project.location.kind !== 'ssh' || !host) {
    throw new Error('远程项目的 SSH 服务器档案不可用')
  }
  const expectedCwd = `ssh://${host.hostAlias}${project.location.canonicalRoot}`
  if (
    !approved ||
    approved.projectId !== request.projectId ||
    approved.approvedCwd !== expectedCwd ||
    approved.approvalDigest !== bashApprovalDigest(request as unknown as Record<string, unknown>) ||
    approved.expiresAt < Date.now()
  ) {
    throw new Error('远程命令尚未获得本次会话的批准')
  }
}

function requireRemoteWriteApproval(request: RemoteWriteRequest): void {
  const manifest = findPhiSessionById(request.sessionId)
  if (!manifest || manifest.projectId !== request.projectId) {
    throw new Error('远程写入会话归属无效')
  }
  const key = remoteBashApprovalKey(request.sessionId, request.toolCallId)
  const approved = approvedRemoteWriteCalls.get(key)
  approvedRemoteWriteCalls.delete(key)
  if (manifest.permissionMode !== 'ask') return
  const project = getProject(request.projectId)
  const host =
    project?.location.kind === 'ssh'
      ? getRemoteHostProfile(project.location.hostProfileId)
      : undefined
  if (!project || project.location.kind !== 'ssh' || !host) {
    throw new Error('远程项目的 SSH 服务器档案不可用')
  }
  const expectedCwd = `ssh://${host.hostAlias}${project.location.canonicalRoot}`
  if (
    !approved ||
    approved.projectId !== request.projectId ||
    approved.approvedCwd !== expectedCwd ||
    approved.approvalDigest !==
      writeApprovalDigest(request as unknown as Record<string, unknown>) ||
    approved.expiresAt < Date.now()
  ) {
    throw new Error('远程写入尚未获得本次会话的批准')
  }
}

function requireRemoteEditApproval(request: RemoteEditRequest): void {
  const manifest = findPhiSessionById(request.sessionId)
  if (!manifest || manifest.projectId !== request.projectId) {
    throw new Error('远程编辑会话归属无效')
  }
  const key = remoteBashApprovalKey(request.sessionId, request.toolCallId)
  const approved = approvedRemoteEditCalls.get(key)
  approvedRemoteEditCalls.delete(key)
  if (manifest.permissionMode !== 'ask') return
  const project = getProject(request.projectId)
  const host =
    project?.location.kind === 'ssh'
      ? getRemoteHostProfile(project.location.hostProfileId)
      : undefined
  if (!project || project.location.kind !== 'ssh' || !host) {
    throw new Error('远程项目的 SSH 服务器档案不可用')
  }
  const expectedCwd = `ssh://${host.hostAlias}${project.location.canonicalRoot}`
  if (
    !approved ||
    approved.projectId !== request.projectId ||
    approved.approvedCwd !== expectedCwd ||
    approved.approvalDigest !== editApprovalDigest(request as unknown as Record<string, unknown>) ||
    approved.expiresAt < Date.now()
  ) {
    throw new Error('远程编辑尚未获得本次会话的批准')
  }
}

const phiSessionIdsByKey = new Map<string, string>()
const loadedSkillNamesBySession = new Map<string, string[]>()
const sessionKeyAliases = new Map<string, string>()
const sessionModelSelections = new Map<string, ModelSelection | null>()
const sessionThinkingLevels = new Map<string, ThinkingLevel>()
const sessionPermissionModes = new Map<string, PermissionMode>()
let preventSleepBlockerId: number | null = null
const backgroundAgentApprovals = new BackgroundAgentApprovalTracker({
  readManifest: findPhiSessionById,
  appendEvent: appendSessionEvent,
  updateManifest: updateSessionManifest,
  onEvent: (sessionId, event) =>
    sendRunEventToWindow({ source: 'phi', ...event, phiSessionId: sessionId }),
  onChange: notifySessionChanged
})
// The RPC facade owns persistence; this observer reuses its records for sidebar attention.
const rpcChildApprovals = new BackgroundAgentApprovalTracker({
  readManifest: (sessionId) => {
    const manifest = findPhiSessionById(sessionId)
    const active = runnerRegistry.getActiveRun(sessionId)
    return manifest && active ? { ...manifest, status: 'running', unreadKind: null } : manifest
  },
  appendEvent: (sessionId, event) => {
    const persisted = readSessionEvents(sessionId).findLast(
      (stored) =>
        stored.type === event.type &&
        stored.approvalId === event.approvalId &&
        stored.agentRunId === event.agentRunId
    )
    if (!persisted) throw new Error('RPC child approval notification has no durable record')
    return persisted
  },
  updateManifest: (sessionId, patch) => {
    const attention = { ...patch }
    delete attention.lastRunOutcome
    const active = runnerRegistry.getActiveRun(sessionId)
    if (active) {
      // The live runner owns its status; a finished parent's child cannot change a successor.
      if (attention.unreadKind === 'approval' || active.status !== 'needs_approval')
        updateSessionManifest(sessionId, { unreadKind: attention.unreadKind })
      return
    }
    updateSessionManifest(sessionId, attention)
  },
  onEvent: (sessionId, event) =>
    sendRunEventToWindow({ source: 'phi', ...event, phiSessionId: sessionId }),
  onChange: notifySessionChanged
})
const runnerRegistry = new SessionRunnerRegistry({
  onSessionEvent: broadcastSessionTimelineEvent,
  onRunSettled: (sessionId) => {
    backgroundAgentApprovals.afterParentRunSettled(sessionId)
    rpcChildApprovals.afterParentRunSettled(sessionId)
  }
})

// Main-only internal migration gate; renderer session input cannot enable this route.
const remoteOmpRpcEnabled = process.env.PHI_REMOTE_OMP_RPC === '1'
installAppRemoteSessionRouting({
  enabled: remoteOmpRpcEnabled,
  foregroundAgentNames: process.env.PHI_REMOTE_OMP_AGENTS,
  agentDir: AGENT_DIR,
  runners: runnerRegistry,
  appPaths: () => ({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
  }),
  configuredRoot: (project) => projectRemoteRuntimeRoot(project).configured,
  loadAgents: async (identity) =>
    (
      await loadRemoteAgentCatalog({
        ...identity,
        agentDir: AGENT_DIR,
        bundledDir: getBundledAgentsDir()
      })
    ).agents,
  loadDesktopTools: loadAppRemoteDesktopTools,
  loadPromptContext: loadAppRemotePromptContext,
  loadAgentResources: loadAppRemoteAgentResources,
  resolveAgentEnvironment: resolveAppRemoteAgentEnvironment,
  onChildApprovalEvent: (event) => {
    if (!event.request.cwd) return
    if (event.type === 'approval_requested') {
      rpcChildApprovals.requested({
        sessionId: event.sessionId,
        agentRunId: event.runId,
        approvalId: event.approvalId,
        toolName: event.request.toolName,
        summary: event.request.summary ?? event.request.toolName,
        cwd: event.request.cwd
      })
    } else {
      rpcChildApprovals.resolved(
        event.approvalId,
        event.type === 'approval_approved'
          ? 'approved'
          : event.type === 'approval_denied'
            ? 'denied'
            : 'cancelled'
      )
    }
  },
  onMemoryError: (identity) =>
    writeAppLog({
      level: 'error',
      event: 'project_memory_ingestion_failed',
      sessionId: identity.sessionId,
      metadata: { projectId: identity.projectId, reason: 'ingestion_failed' }
    }),
  approval: {
    shouldGate: (request) => {
      const manifest = request.sessionId ? findPhiSessionById(request.sessionId) : null
      if (!manifest) throw new Error('RPC approval session is unavailable')
      return manifest.permissionMode === 'ask'
    },
    requestToolApproval: (request, signal) =>
      requestRuntimeToolApproval(request, signal, () => {
        const window = mainWindow
        return window && !window.isDestroyed() ? window : null
      }),
    onEvent: (event) => {
      const run = runnerRegistry.getActiveRun(event.sessionId)
      if (!run || run.runId !== event.runId) return
      if (event.type === 'approval_requested')
        runnerRegistry.markNeedsApproval(event.sessionId, event.approvalId, {
          toolName: event.request.toolName,
          summary: event.request.summary
        })
      else if (event.type === 'approval_approved')
        runnerRegistry.markApprovalApproved(event.sessionId, event.approvalId)
      else if (event.type === 'approval_denied')
        runnerRegistry.markApprovalDenied(event.sessionId, event.approvalId)
      else runnerRegistry.markApprovalCancelled(event.sessionId, event.approvalId)
    }
  }
})

function syncPreventSleepBlocker(): void {
  const shouldBlock = readAppSettings().preventSleepDuringRuns && runnerRegistry.activeCount > 0
  if (shouldBlock && preventSleepBlockerId === null) {
    preventSleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    return
  }
  if (!shouldBlock && preventSleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(preventSleepBlockerId)) {
      powerSaveBlocker.stop(preventSleepBlockerId)
    }
    preventSleepBlockerId = null
  }
}
const backgroundEnvironment = createBackgroundEnvironment({ agentDir: AGENT_DIR })
const environmentBuilds = createEnvironmentBuilds({
  root: getRuntimeRoot(),
  build: (root, descriptor, options) =>
    buildEnvironment(root, descriptor, { ...options, fetch: officialRegistryFetch }),
  onChange: (build) => {
    sendToAllWindows('environmentBuilds:changed', build)
  }
})
const managedEnvironmentActions = createManagedEnvironmentActions({
  root: getRuntimeRoot(),
  agentDir: AGENT_DIR,
  builds: environmentBuilds,
  collect: (root, options) => {
    const result = collectGarbage(root, options)
    if (!options?.dryRun) cleanupInactiveMcpVersions(AGENT_DIR, root)
    return result
  },
  catalog: (projectDir, includeDynamic) =>
    listManagedEnvironments({
      ...(projectDir ? { projectDir } : {}),
      builds: environmentBuilds.list(),
      includeDynamic
    })
})
// The notebook server joins builds started elsewhere (chat prompt or the environment panel).
const jupyterServerRegistry = new JupyterServerRegistry({
  managed: {
    builds: environmentBuilds,
    hostJupyterPath: () => getCustomToolPath('jupyter', AGENT_DIR)
  }
})
const notebookSessionRegistry = new AnalysisNotebookSessionRegistry({
  getConnection: (projectCwd) => jupyterServerRegistry.connection(projectCwd)
})
const notebookExecutor = new AnalysisNotebookExecutor()
const notebookAiGenerationJobs = new NotebookAiGenerationJobs()
const activeNotebookPathByProjectCwd = new Map<string, string>()
const notebookToolExecutor = new AnalysisNotebookToolExecutor({
  resolveWorkspaceByCwd: resolveAnalysisWorkspaceByCwd,
  ensureJupyterServerReady,
  notebookSessionRegistry,
  notebookExecutor,
  onDraftChanged: notifyAnalysisNotebookDraftChanged
})
const notebookFileWatcher = new AnalysisNotebookFileWatcher({
  onChange: notifyAnalysisNotebookFileChanged
})
const remoteNotebookBackends = new Map<string, RemoteAnalysisNotebookBackend>()
const remoteNotebookSessionIds = new Map<string, string>()
const notebookToolHostRouter = new NotebookToolHostRouter({
  local: (request, control) => notebookToolExecutor.execute(request, control),
  isRemoteCwd: isRemoteAnalysisCwd,
  resolveRemote: resolveRemoteNotebookToolBackend
})
getPhiEngine().host.register('notebookTool.execute', async (params, context) => {
  const request = params as Parameters<typeof notebookToolHostRouter.execute>[0]
  const identity = request.remoteProject
  const binding = identity
    ? resolveRemoteWorkspaceHostBinding({
        sessionId: identity.sessionId,
        projectId: identity.projectId
      })
    : undefined
  const rpcControl =
    identity && context
      ? remoteRuntimeDispatchControl(
          {
            runtimeSessionId: identity.runtimeSessionId,
            remoteSessionId: identity.sessionId,
            projectId: identity.projectId
          },
          context
        )
      : undefined
  const beforeDispatch = (): void => {
    rpcControl?.beforeDispatch()
    if (!identity) return
    const origin = runtimeSessionOrigins.get(identity.runtimeSessionId)
    if (
      context?.originSessionId !== identity.runtimeSessionId ||
      !origin ||
      getPhiSessionIdForKey(origin.sessionKey) !== identity.sessionId ||
      resolveRemoteWorkspaceHostBinding({
        sessionId: identity.sessionId,
        projectId: identity.projectId
      }).cacheKey !== binding?.cacheKey
    )
      throw new Error('远程 Notebook 后端不可用：运行或项目绑定已改变；没有回退到本机执行。')
  }
  beforeDispatch()
  return notebookToolHostRouter.execute(request, { signal: context?.signal, beforeDispatch })
})
const skillHost = createSkillHost({
  listSkillDirs: async (cwd) => {
    const skills = await listSkills(cwd)
    return skills.map((skill) => dirname(skill.filePath))
  },
  builds: environmentBuilds,
  confirmBuild: (request) => confirmEnvironmentBuild(request),
  presentArtifacts: (request) => presentScriptArtifacts(request)
})

function projectRemoteRuntimeRoot(project: Project): ReturnType<typeof resolveRemoteRuntimeRoot> {
  const hostOverride =
    project.location.kind === 'ssh'
      ? readHostRuntimeRoot(project.location.hostProfileId, AGENT_DIR)
      : undefined
  return resolveProjectRuntimeRoot(project, hostOverride)
}

const remoteJupyterStartJobs = new RemoteJupyterStartJobs()

function remoteNotebookTarget(project: Project, sessionId: string): RemoteRuntimeTarget {
  if (project.location.kind !== 'ssh') throw new Error('远程 Notebook 项目位置无效')
  const root = projectRemoteRuntimeRoot(project)
  const micromambaPath = readHostRemoteEnvironmentPaths(
    project.location.hostProfileId,
    AGENT_DIR
  ).micromamba
  return {
    runtimeSessionId: `notebook:${project.id}`,
    sessionId,
    projectId: project.id,
    configuredRoot: root.configured,
    ...(micromambaPath ? { micromambaPath } : {})
  }
}

function createRemoteNotebookBackend(
  project: Project,
  sessionId: string
): RemoteAnalysisNotebookBackend {
  const target = remoteNotebookTarget(project, sessionId)
  const binding = resolveRemoteWorkspaceHostBinding({ sessionId, projectId: project.id })
  const authorized = resolveAuthorizedRemoteConnectionConfig({ sessionId, projectId: project.id })
  return createRemoteAnalysisNotebookBackend({
    projectCwd: binding.canonicalRoot,
    projectName: project.name,
    serverLabel: authorized.hostAlias,
    runtimeSessionId: target.runtimeSessionId,
    micromambaVersion: remoteMicromambaManifestVersion(),
    projectHostConfig: binding.config,
    openWorkspace: (runtimeSessionId, signal) => {
      if (runtimeSessionId !== target.runtimeSessionId) {
        throw new Error('远程 Notebook runtime 身份无效；没有回退到本机执行。')
      }
      const activeSessionId = remoteNotebookSessionIds.get(project.id)
      if (!activeSessionId) {
        throw new Error('远程 Notebook 会话已释放；没有回退到本机执行。')
      }
      return openRemoteRuntimeWorkspace(remoteNotebookTarget(project, activeSessionId), signal)
    },
    connection: authorized.connection,
    projectId: project.id,
    startJobs: remoteJupyterStartJobs,
    // Read at each start, so a path saved in remote settings applies without reopening.
    configuredJupyterPath: () =>
      project.location.kind === 'ssh'
        ? readHostRemoteEnvironmentPaths(project.location.hostProfileId, AGENT_DIR).jupyter
        : undefined,
    confirmEnvironment: async () => true,
    resolveBaseEnvironment: (ref, pluginId) =>
      resolveRemoteBaseEnvironment(ref, pluginId, AGENT_DIR),
    notebookExecutor,
    onDraftChanged: notifyAnalysisNotebookDraftChanged
  })
}

function remoteNotebookBackend(project: Project, sessionId: string): RemoteAnalysisNotebookBackend {
  remoteNotebookSessionIds.set(project.id, sessionId)
  const existing = remoteNotebookBackends.get(project.id)
  if (existing) return existing
  const backend = createRemoteNotebookBackend(project, sessionId)
  remoteNotebookBackends.set(project.id, backend)
  return backend
}

async function resolveRemoteNotebookToolBackend(identity: {
  runtimeSessionId: string
  sessionId: string
  projectId: string
}): Promise<{
  projectCwd: string
  execute: RemoteAnalysisNotebookBackend['tools']['execute']
} | null> {
  const manifest = findPhiSessionById(identity.sessionId)
  const project = getProject(identity.projectId)
  const origin = runtimeSessionOrigins.get(identity.runtimeSessionId)
  if (
    !manifest ||
    !project ||
    !origin ||
    project.location.kind !== 'ssh' ||
    manifest.projectId !== project.id ||
    getPhiSessionIdForKey(origin.sessionKey) !== manifest.sessionId ||
    resolve(origin.cwd) !== resolve(manifest.cwd) ||
    resolve(manifest.cwd) !== resolve(remoteProjectAnchorPath(project.id, AGENT_DIR))
  ) {
    return null
  }
  const backend = remoteNotebookBackend(project, manifest.sessionId)
  return {
    projectCwd: backend.projectCwd,
    execute: (request, control) => backend.tools.execute(request, control)
  }
}

function remoteNotebookBackendFor(
  workspace: AnalysisWorkspaceContext
): RemoteAnalysisNotebookBackend | null {
  if (workspace.project?.location?.kind !== 'ssh') return null
  if (!workspace.remoteSessionId) {
    throw new Error('远程 Notebook 会话身份缺失；没有回退到本机执行。')
  }
  return remoteNotebookBackend(workspace.project, workspace.remoteSessionId)
}

function directRemoteRuntimeTarget(params: unknown): RemoteRuntimeTarget | undefined {
  if (!isRecord(params)) return undefined
  const runtimeSessionId = optionalStringField(params, 'runtimeSessionId')
  const sessionId = optionalStringField(params, 'remoteSessionId')
  const projectId = optionalStringField(params, 'projectId')
  if (!runtimeSessionId || !sessionId || !projectId) return undefined
  if (findPhiSessionById(sessionId)?.projectId !== projectId) return undefined
  const project = getProject(projectId)
  if (!project || project.location.kind !== 'ssh') return undefined
  const root = projectRemoteRuntimeRoot(project)
  const micromambaPath = readHostRemoteEnvironmentPaths(
    project.location.hostProfileId,
    AGENT_DIR
  ).micromamba
  return {
    runtimeSessionId,
    sessionId,
    projectId,
    configuredRoot: root.configured,
    ...(micromambaPath ? { micromambaPath } : {})
  }
}

const remoteRuntimeController = new RemoteRuntimeController({
  micromambaVersion: remoteMicromambaManifestVersion(),
  resolveTarget: directRemoteRuntimeTarget,
  confirmEnvironment: (request) => confirmEnvironmentRequest(request),
  resolveBaseEnvironment: (ref, pluginId) => resolveRemoteBaseEnvironment(ref, pluginId, AGENT_DIR),
  listSkills: async (_runtimeSessionId, target) => {
    const plugins = new Map(
      loadedPlugins({ agentDir: AGENT_DIR }).map((plugin) => [plugin.id, plugin])
    )
    const globalSkills = (await listGlobalSkills())
      .filter((skill) => skill.enabled)
      .map((skill) => {
        const plugin = skill.sourceId ? plugins.get(skill.sourceId) : undefined
        return {
          name: skill.name,
          filePath: skill.filePath,
          dir: dirname(skill.filePath),
          insidePlugin: skill.sourceCategory === 'plugin',
          ...(plugin ? { pluginId: plugin.id, toolPrefix: plugin.toolPrefix } : {})
        }
      })
    if (!target) return globalSkills
    const projectCatalog = await loadRemoteProjectSkillCatalog({
      sessionId: target.sessionId,
      projectId: target.projectId,
      cwd: remoteProjectAnchorPath(target.projectId, AGENT_DIR),
      agentDir: AGENT_DIR
    })
    const projectNames = new Set(projectCatalog.sources.map((skill) => skill.name))
    return [
      ...projectCatalog.sources,
      ...globalSkills.filter((skill) => !projectNames.has(skill.name))
    ]
  }
})

async function loadAppRemoteAgentResources(
  identity: Parameters<NonNullable<AppRemoteSessionRoutingOptions['loadAgentResources']>>[0],
  definitions: readonly import('./agent/agents/definition').PhiAgentDefinition[],
  signal: AbortSignal
): ReturnType<NonNullable<AppRemoteSessionRoutingOptions['loadAgentResources']>> {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const binding = resolveRemoteWorkspaceHostBinding(boundary).cacheKey
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (
      findPhiSessionById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      resolveRemoteWorkspaceHostBinding(boundary).cacheKey !== binding
    )
      throw new Error('专家资源的项目或主机绑定已改变')
  }
  assertCurrent()
  const context = { ...boundary, cwd: identity.resourceCwd, agentDir: AGENT_DIR }
  const [catalog, globals] = await Promise.all([
    loadRemoteProjectSkillCatalog(context),
    listGlobalSkills()
  ])
  assertCurrent()
  const wanted = [...new Set(definitions.flatMap((definition) => definition.skills))]
  if (wanted.length > 1024) throw new Error('专家技能数量超过当前限制')
  const skills: Array<{ name: string; description: string; markdown: string }> = []
  for (const name of wanted) {
    const projectMatches = catalog.summaries.filter(
      (skill) => skill.name === name && catalog.sources.some((source) => source.name === name)
    )
    const globalMatches = globals.filter((skill) => skill.enabled && skill.name === name)
    if (projectMatches.length > 1 || (!projectMatches.length && globalMatches.length !== 1))
      throw new Error(`专家技能不可用：${name}`)
    const selected = projectMatches[0] ?? globalMatches[0]
    const content = projectMatches.length
      ? await readRemoteProjectSkillContent(context, selected.filePath)
      : await readGlobalSkillContent(selected.filePath)
    assertCurrent()
    const markdown = typeof content === 'string' ? content : content.content
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > 64 * 1024)
      throw new Error(`专家技能正文不可用：${name}`)
    skills.push({ name, description: selected.description, markdown })
  }
  return { skills }
}

async function resolveAppRemoteAgentEnvironment(
  identity: Parameters<NonNullable<AppRemoteSessionRoutingOptions['resolveAgentEnvironment']>>[0],
  agent: Parameters<NonNullable<AppRemoteSessionRoutingOptions['resolveAgentEnvironment']>>[1],
  signal: AbortSignal
): Promise<
  Awaited<ReturnType<NonNullable<AppRemoteSessionRoutingOptions['resolveAgentEnvironment']>>>
> {
  if (!agent.environment) throw new Error('专家未声明环境')
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const binding = resolveRemoteWorkspaceHostBinding(boundary)
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (
      findPhiSessionById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      resolveRemoteWorkspaceHostBinding(boundary).cacheKey !== binding.cacheKey
    )
      throw new Error('专家环境的项目或主机绑定已改变')
  }
  assertCurrent()
  const target = directRemoteRuntimeTarget({
    runtimeSessionId: identity.runtimeSessionId,
    remoteSessionId: identity.sessionId,
    projectId: identity.projectId
  })
  if (!target) throw new Error('专家环境缺少已验证的远程项目')
  const workspace = await openRemoteRuntimeWorkspace(target, signal)
  try {
    assertCurrent()
    const environment = await remoteRuntimeController.environments.describeReadyInWorkspace(
      agent.environment,
      controlRemoteRuntimeWorkspace(workspace, assertCurrent),
      signal
    )
    assertCurrent()
    if (!environment) throw new Error(`专家环境尚未就绪：${agent.environment}`)
    const project = requireProject(identity.projectId)
    if (project.location.kind !== 'ssh') throw new Error('专家环境项目不再是 SSH 项目')
    return {
      ...environment,
      ...(agent.pluginId ? { pluginId: agent.pluginId } : {}),
      binding: {
        serverId: project.location.hostProfileId,
        serverIdentitySha256: facadeBindingHash(binding),
        projectId: project.id,
        projectRoot: binding.canonicalRoot
      }
    }
  } finally {
    await workspace.close?.()
  }
}

async function loadAppRemotePromptContext(
  identity: Parameters<NonNullable<AppRemoteSessionRoutingOptions['loadPromptContext']>>[0],
  signal: AbortSignal
): ReturnType<NonNullable<AppRemoteSessionRoutingOptions['loadPromptContext']>> {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const selected = resolveRemoteWorkspaceHostBinding(boundary)
  const project = requireProject(identity.projectId)
  if (project.location.kind !== 'ssh') throw new Error('远程主会话配置缺少 SSH 项目')
  const assertBinding = (): void => {
    signal.throwIfAborted()
    if (
      findPhiSessionById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      selected.canonicalRoot !== identity.cwd ||
      resolveRemoteWorkspaceHostBinding(boundary).cacheKey !== selected.cacheKey
    ) {
      throw new Error('远程主会话配置的项目或主机绑定已改变')
    }
  }
  assertBinding()
  const contextFiles = await loadRemoteProjectInstructions(project.location)
  assertBinding()
  const personaMarkdown = getPersonaMarkdown()
  const runtimeRoot = projectRemoteRuntimeRoot(project)
  const runtime = resolveRemoteRuntimePromptContext(
    {
      hostProfileId: project.location.hostProfileId,
      canonicalRoot: project.location.canonicalRoot,
      ...(runtimeRoot.source === 'project' ? { projectOverride: runtimeRoot.configured } : {})
    },
    AGENT_DIR
  )
  assertBinding()
  const recoverySummary = readRuntimeRecoverySummarySeed({
    sessionId: identity.sessionId,
    projectId: identity.projectId,
    events: readSessionEvents(identity.sessionId)
  })?.content
  assertBinding()
  return {
    personaMarkdown,
    ...(personaMarkdown ? { personaPath: join(AGENT_DIR, 'AGENTS.md') } : {}),
    contextFiles,
    runtime,
    ...(recoverySummary ? { recoverySummary } : {})
  }
}

async function loadAppRemoteDesktopTools(
  identity: Parameters<NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>>[0],
  signal: AbortSignal
): ReturnType<NonNullable<AppRemoteSessionRoutingOptions['loadDesktopTools']>> {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const selectedBinding = resolveRemoteWorkspaceHostBinding(boundary).cacheKey
  const memoryPolicy = normalizeProjectMemorySettings(getProject(identity.projectId)?.memory)
  const assertBinding = (): void => {
    signal.throwIfAborted()
    if (
      findPhiSessionById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      resolveRemoteWorkspaceHostBinding(boundary).cacheKey !== selectedBinding
    )
      throw new Error('远程资源项目绑定已改变；请显式恢复当前项目会话。')
  }
  const assertMemoryBinding = (): void => {
    assertBinding()
    if (
      JSON.stringify(normalizeProjectMemorySettings(getProject(identity.projectId)?.memory)) !==
      JSON.stringify(memoryPolicy)
    )
      throw new Error('项目记忆策略已改变')
  }
  assertMemoryBinding()
  const context = {
    sessionId: identity.sessionId,
    projectId: identity.projectId,
    cwd: identity.resourceCwd,
    agentDir: AGENT_DIR
  }
  const [globals, catalog, globalServers, mcpCatalog] = await Promise.all([
    listGlobalSkills(),
    loadRemoteProjectSkillCatalog(context),
    listGlobalMcpServers(),
    loadRemoteProjectMcpCatalog(context)
  ])
  assertMemoryBinding()
  const projectNames = new Set(catalog.sources.map((skill) => skill.name))
  const allowedSkills = [
    ...catalog.sources.map((skill) => skill.name),
    ...globals
      .filter((skill) => skill.enabled && !projectNames.has(skill.name))
      .map((skill) => skill.name)
  ]
  const scripts = await remoteRuntimeController.scriptTools({
    runtimeSessionId: identity.runtimeSessionId,
    remoteSessionId: identity.sessionId,
    projectId: identity.projectId
  })
  assertMemoryBinding()
  const { resourceCwd, ...toolIdentity } = identity
  const search = await createDesktopWebSearchAdapter({
    identity: toolIdentity,
    agentDir: AGENT_DIR,
    resourceCwd,
    signal,
    currentModel: () => {
      assertBinding()
      const model = findPhiSessionById(identity.sessionId)?.model
      return model ? { provider: model.providerId, id: model.modelId } : undefined
    }
  })
  let mcp: Awaited<ReturnType<typeof createDesktopMcpAdapter>> | undefined
  let memory: Awaited<ReturnType<typeof createDesktopProjectMemoryAdapter>> | undefined
  try {
    if (memoryPolicy.enabled) {
      memory = await createDesktopProjectMemoryAdapter({
        identity: toolIdentity,
        agentDir: AGENT_DIR,
        resourceCwd,
        settings: memoryPolicy,
        signal,
        beforeDispatch: assertMemoryBinding
      })
      assertMemoryBinding()
    }
    const serverNames = [
      ...new Set([
        ...globalServers.filter((server) => server.enabled !== false).map((server) => server.name),
        ...mcpCatalog.runtimeServers.map((server) => server.name)
      ])
    ]
    if (serverNames.length)
      mcp = await createDesktopMcpAdapter({
        identity: toolIdentity,
        agentDir: AGENT_DIR,
        resourceCwd,
        signal,
        serverNames,
        remoteProjectMcpServers: mcpCatalog.runtimeServers,
        approvalFor: () => 'write',
        beforeDispatch: assertBinding
      })
    assertMemoryBinding()
    return {
      tools: {
        assertBinding,
        allowedSkills,
        skillCatalog: [
          ...catalog.summaries
            .filter((skill) => allowedSkills.includes(skill.name))
            .map((skill) => ({ name: skill.name, description: skill.description })),
          ...globals
            .filter((skill) => skill.enabled && !projectNames.has(skill.name))
            .map((skill) => ({ name: skill.name, description: skill.description }))
        ],
        scriptTools: scripts.tools,
        scriptApprovalFor: (name, input, childRunId) => {
          const control = childRunId
            ? remoteRuntimeDispatchControl(
                {
                  runtimeSessionId: identity.runtimeSessionId,
                  remoteSessionId: identity.sessionId,
                  projectId: identity.projectId
                },
                { originSessionId: identity.runtimeSessionId, agentRunId: childRunId, signal }
              )
            : undefined
          return remoteRuntimeController.approvalFor(name, input, control)
        },
        remoteLibrary: true,
        desktopWebSearch: search,
        desktopMcp: mcp
      },
      memory,
      close: async () => {
        search.retire()
        mcp?.retire()
        memory?.retire()
        await Promise.allSettled([search.close(), mcp?.close(), memory?.close()])
      }
    }
  } catch (error) {
    search.retire(error)
    mcp?.retire(error)
    memory?.retire()
    await Promise.allSettled([search.close(), mcp?.close(), memory?.close()])
    throw error
  }
}

function remoteRuntimeDispatchControl(
  params: unknown,
  context: import('./agent/engine/types').PhiHostRequestContext
): RemoteRuntimeDispatchControl | undefined {
  if (
    !isRecord(params) ||
    (!Object.hasOwn(params, 'remoteSessionId') && !Object.hasOwn(params, 'projectId'))
  )
    return undefined
  const runtimeId = optionalStringField(params, 'runtimeSessionId')
  const sessionId = optionalStringField(params, 'remoteSessionId')
  const projectId = optionalStringField(params, 'projectId')
  if (
    !runtimeId ||
    !sessionId ||
    !projectId ||
    context.originSessionId !== runtimeId ||
    resolveOriginSession(runtimeId)?.phiSessionId !== sessionId
  )
    throw new Error('远程资源请求的来源会话无效；没有回退到本机执行。')
  const binding = resolveRemoteWorkspaceHostBinding({ sessionId, projectId })
  const run = runnerRegistry.getActiveRun(sessionId)
  const childId = ownsRemoteRuntimeSession(runtimeId) ? context.agentRunId : undefined
  const readResourceOwner = ():
    import('./agent/remote-runtime/skill-service').RemoteSkillResourceOwner | undefined => {
    if (!childId) return undefined
    const owner = getPhiEngine().agentRuns.resourceOwner?.(runtimeId, childId)
    if (!owner) throw new Error('专家资源调用缺少当前已验证的运行身份')
    return Object.freeze({
      toolOwner: owner.toolOwner,
      allowedSkills: Object.freeze([...owner.allowedSkills])
    })
  }
  const resourceOwner = readResourceOwner()
  const beforeDispatch = (): void => {
    context.signal?.throwIfAborted()
    if (!childId) run?.signal.throwIfAborted()
    if (childId && JSON.stringify(readResourceOwner()) !== JSON.stringify(resourceOwner))
      throw new Error('专家资源运行身份已改变')
    if (
      (!childId && context.signal && (!run || runnerRegistry.getActiveRun(sessionId) !== run)) ||
      resolveOriginSession(runtimeId)?.phiSessionId !== sessionId ||
      resolveRemoteWorkspaceHostBinding({ sessionId, projectId }).cacheKey !== binding.cacheKey
    )
      throw new Error('远程资源运行或项目绑定已改变；没有回退到本机执行。')
  }
  beforeDispatch()
  return { signal: context.signal, beforeDispatch, ...(resourceOwner ? { resourceOwner } : {}) }
}

function isRemoteRuntimeCancellation(
  params: unknown,
  context: import('./agent/engine/types').PhiHostRequestContext
): boolean {
  if (
    !isRecord(params) ||
    (!Object.hasOwn(params, 'remoteSessionId') && !Object.hasOwn(params, 'projectId'))
  )
    return false
  const runtimeId = optionalStringField(params, 'runtimeSessionId')
  if (
    !runtimeId ||
    context.originSessionId !== runtimeId ||
    resolveOriginSession(runtimeId)?.phiSessionId !== params.remoteSessionId
  )
    throw new Error('远程资源取消请求的来源会话无效')
  return true
}

const remoteLibraryService = new RemoteLibraryService(async (identity, signal, context) => {
  const control = remoteRuntimeDispatchControl(
    {
      runtimeSessionId: identity.runtimeSessionId,
      remoteSessionId: identity.sessionId,
      projectId: identity.projectId
    },
    { ...context, originSessionId: identity.runtimeSessionId, signal }
  )!
  const project = getProject(identity.projectId)!
  const binding = resolveRemoteWorkspaceHostBinding({
    sessionId: identity.sessionId,
    projectId: identity.projectId
  })
  const workspace = await openRemoteRuntimeWorkspace(
    {
      ...identity,
      configuredRoot: projectRemoteRuntimeRoot(project).configured
    },
    signal
  )
  let session: Awaited<ReturnType<typeof binding.config.connect>> | undefined
  try {
    control.beforeDispatch()
    session = await binding.config.connect()
    control.beforeDispatch()
    if (!session.openStdio) throw new Error('远程 Library 需要当前 SSH stdio 能力')
    return {
      workspace: {
        ...controlRemoteRuntimeWorkspace(workspace, control.beforeDispatch),
        close: async () => {
          await Promise.allSettled([workspace.close?.(), session!.close()])
        }
      },
      openLockStdio: async (command) => {
        control.beforeDispatch()
        const process = await session!.openStdio!(command)
        try {
          control.beforeDispatch()
          return process
        } catch (error) {
          await process.close().catch(() => undefined)
          throw error
        }
      }
    }
  } catch (error) {
    await Promise.allSettled([workspace.close?.(), session?.close()])
    throw error
  }
})
getPhiEngine().host.register('library.execute', (params, context) =>
  remoteLibraryService.execute(params, context)
)
getPhiEngine().host.register('library.cancel', (params, context) =>
  remoteLibraryService.cancel(params, context)
)

function phiPluginListItems(): PhiPluginListItem[] {
  const enablement = getEnablementSnapshot({ agentDir: AGENT_DIR })
  return listInstalledPlugins({ agentDir: AGENT_DIR }).map((plugin) =>
    buildPhiPluginListItem(plugin, {
      isSkillEnabled: (name) => isCoreSkill(name) || enablement.global[`skill:${name}`] !== false
    })
  )
}

function phiPluginProblemView(problem: PluginProblem): PhiPluginProblemView {
  const label = problem.level === 'error' ? '错误' : '警告'
  return {
    ...problem,
    displayMessage: `${label}（${problem.path}）：${localizePhiPluginProblemMessage(problem.message)}`
  }
}

function phiPluginMutation(result: PluginLifecycleResult): PhiPluginMutationResult {
  return {
    ok: result.ok,
    plugins: phiPluginListItems(),
    problems: [...result.errors, ...result.warnings].map(phiPluginProblemView)
  }
}

function failedPhiPluginMutation(path: string, message: string): PhiPluginMutationResult {
  return phiPluginMutation({
    ok: false,
    errors: [{ level: 'error', path, message }],
    warnings: []
  })
}

function phiPluginInstallPreview(path: string): PhiPluginInstallPreview {
  const validation = validatePlugin(path)
  const problems = [...validation.errors, ...validation.warnings].map(phiPluginProblemView)
  if (!validation.ok || !validation.plugin) return { ok: false, path, problems }

  const { manifest } = validation.plugin
  const existing = listInstalledPlugins({ agentDir: AGENT_DIR }).find(
    (plugin) => plugin.id === manifest.id
  )
  return {
    ok: true,
    path,
    action: !existing
      ? 'install'
      : semver.gt(manifest.version, existing.version)
        ? 'upgrade'
        : 'same-or-older',
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary,
    ...(existing ? { installedVersion: existing.version } : {}),
    problems
  }
}

async function installedPluginNamespace(projectDir?: string): Promise<PluginNamespace> {
  const resourceCwd = projectDir ?? currentCwd
  const pluginSkillRoots = loadedPlugins({
    agentDir: AGENT_DIR,
    ...(projectDir ? { projectDir } : {})
  }).flatMap((plugin) => plugin.components.skills)
  const skills = (await listSkills(resourceCwd)).filter(
    (skill) => !pluginSkillRoots.some((root) => isPathInsideRoot(root, skill.filePath))
  )
  const toolPrefixes = skills.flatMap((skill) => {
    try {
      const result = validateSkill(dirname(skill.filePath), { expectedName: skill.name })
      return result.skill?.phi?.toolPrefix ? [result.skill.phi.toolPrefix] : []
    } catch {
      return []
    }
  })
  const agents = discoverPhiAgents({
    cwd: resourceCwd,
    agentDir: AGENT_DIR,
    bundledDir: getBundledAgentsDir(),
    pluginAgentDirs: []
  }).agents
  return {
    agentNames: agents.map((agent) => agent.name),
    skillNames: skills.map((skill) => skill.name),
    toolPrefixes
  }
}
getPhiEngine().host.register('skills.scriptTools', (params) =>
  remoteRuntimeController.owns(params)
    ? remoteRuntimeController.scriptTools(params)
    : skillHost.scriptTools(params)
)
getPhiEngine().host.register('skills.run', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.runSkill(params, control)
    : skillHost.run(params)
})
getPhiEngine().host.register('skills.scriptTool', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.runScriptTool(params, control)
    : skillHost.scriptTool(params)
})
getPhiEngine().host.register('skills.cancel', (params, context) => {
  if (isRemoteRuntimeCancellation(params, context))
    return remoteRuntimeController.skills.cancel(params)
  return skillHost.cancel(params)
})
getPhiEngine().host.register('environments.bindSession', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.bindEnvironment(params, control)
    : bindAgentSession(params, {
        builds: environmentBuilds,
        confirmBuild: (request) => confirmEnvironmentBuild(request)
      })
})
getPhiEngine().host.register('environments.request', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.requestEnvironment(params, control)
    : requestProjectEnvironment(params, {
        root: getRuntimeRoot(),
        builds: environmentBuilds,
        confirm: (request) => confirmEnvironmentRequest(request)
      })
})
getPhiEngine().host.register('environments.cancel', (params, context) =>
  isRemoteRuntimeCancellation(params, context)
    ? remoteRuntimeController.environments.cancel(params)
    : undefined
)
const capabilityService = createCapabilityService({
  agentDir: AGENT_DIR,
  appVersion: app.getVersion(),
  loadRegistries: loadPackageRegistries,
  searchOfficial: (query, type, signal) =>
    searchOfficialCatalog(query, type, signal, { fetch: officialRegistryFetch }),
  confirm: (request, context) =>
    confirmAgentModuleInstallation(
      request.runtimeSessionId,
      capabilityApprovalSummary(request),
      context
    ),
  prepare: (registry, request, _options, signal) =>
    prepareContentPackageInstall(registry, request, {
      ...officialContentSourceOptions(),
      fetch: (input, init) =>
        officialRegistryFetch(input, {
          ...init,
          signal: signal
            ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
            : init?.signal
        })
    }),
  installerOptions: async () => ({
    ...officialContentSourceOptions(),
    runtimeRoot: getRuntimeRoot(),
    names: await installedPluginNamespace(),
    build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
  }),
  assertCurrent: (context) => capabilityHost.assertCurrent(context)
})
const externalSkillService = createExternalSkillService({
  agentDir: AGENT_DIR,
  appVersion: app.getVersion(),
  fetch: officialRegistryFetch,
  confirm: (request, context) =>
    confirmAgentModuleInstallation(request.runtimeSessionId, request.question, context),
  assertCurrent: (context) => capabilityHost.assertCurrent(context)
})
const capabilityHost: ReturnType<typeof createCapabilityHost> = createCapabilityHost({
  service: capabilityService,
  external: externalSkillService,
  onInstalled: (_result, context) => {
    const run = context.originSessionId
      ? findActivePromptRunByRuntimeSessionId(context.originSessionId)
      : undefined
    if (run) loadedSkillNamesBySession.delete(run.phiSessionId)
    sendToAllWindows('packages:resourcesChanged')
  },
  resolveRun: (runtimeSessionId) => {
    const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
    if (!run || run.cancelled) throw new Error('模块操作所属任务已结束')
    return {
      assertCurrent: () => {
        if (run.cancelled || findActivePromptRunByRuntimeSessionId(runtimeSessionId) !== run)
          throw new Error('模块操作所属任务已结束或改变')
      }
    }
  }
})
for (const [method, handler] of Object.entries(capabilityHost.handlers))
  getPhiEngine().host.register(method, handler)
getPhiEngine().host.register('agentInteraction.request', handleAgentInteractionRequest)
getPhiEngine().host.register(
  'settings.nextActionSuggestionsEnabled',
  () => readAppSettings().nextActionSuggestionsEnabled
)
const cursorH2Bridge = createCursorH2Bridge()
getPhiEngine().host.register('cursorBridge.ensure', async () => ({
  baseUrl: await cursorH2Bridge.ensure()
}))
getPhiEngine().host.register('planReview.request', handlePlanReviewRequest)
getPhiEngine().host.register('deliverables.present', handlePresentFilesRequest)
getPhiEngine().host.register('mcp.openAuthUrl', async (params) => {
  const request = params as { id?: unknown; url?: unknown } | null
  if (typeof request?.id !== 'string' || typeof request.url !== 'string') {
    throw new Error('授权地址无效')
  }
  const catalogConnector = listConnectorCatalog({
    agentDir: AGENT_DIR,
    appVersion: app.getVersion(),
    runtimeRoot: getRuntimeRoot(),
    registries: (await loadPackageRegistries('mcp')).registries
  }).find((entry) => entry.id === request.id)
  const authorizationOrigin = catalogConnector?.url
    ? mcpOAuthAuthorizationOrigin(request.id, catalogConnector.url)
    : undefined
  if (!authorizationOrigin) throw new Error('授权地址无效')
  const url = new URL(request.url)
  if (url.origin !== authorizationOrigin || url.username || url.password) {
    throw new Error('The authorization URL does not match this Connector')
  }
  await shell.openExternal(url.toString())
})
type PendingCustomMcpAuthorization = {
  attemptId: string
  serverUrl: string
  configDigest: string
  cancelled: boolean
  authorizationOrigin?: string
  authorizationPath?: string
}
const pendingCustomMcpAuthorizations = new Map<string, PendingCustomMcpAuthorization>()

function customMcpAuthUrl(value: unknown): URL {
  try {
    if (typeof value !== 'string') throw new Error('Invalid URL')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Invalid URL')
    return url
  } catch {
    throw new Error('Invalid Connector authorization URL')
  }
}

function customMcpConfigDigest(connector: ReturnType<typeof readCustomRemoteMcpConnector>): string {
  return createHash('sha256').update(JSON.stringify(connector)).digest('hex')
}

getPhiEngine().host.register('mcp.openCustomAuthUrl', async (params) => {
  const request = params as { name?: unknown; attemptId?: unknown; url?: unknown } | null
  if (typeof request?.name !== 'string' || typeof request.attemptId !== 'string') {
    throw new Error('Invalid Connector authorization request')
  }
  const pending = pendingCustomMcpAuthorizations.get(request.name)
  if (
    !pending ||
    pending.cancelled ||
    pending.attemptId !== request.attemptId ||
    !pending.authorizationOrigin
  ) {
    throw new Error('The Connector authorization request has expired')
  }
  const connector = readCustomRemoteMcpConnector(request.name, AGENT_DIR)
  if (
    connector.url !== pending.serverUrl ||
    customMcpConfigDigest(connector) !== pending.configDigest
  ) {
    throw new Error('Connector configuration changed. Authorize again.')
  }
  const url = customMcpAuthUrl(request.url)
  if (url.origin !== pending.authorizationOrigin || url.pathname !== pending.authorizationPath) {
    throw new Error('The authorization URL does not match this Connector')
  }
  await shell.openExternal(url.toString())
})
getPhiEngine().host.register('mcp.featuredApiKey', (params) => {
  const id = (params as { id?: unknown } | null)?.id
  if (typeof id !== 'string') throw new Error('Invalid Connector ID')
  apiKeyConnector(id)
  if (!isFeaturedMcpApiKeyInstalled(id)) return undefined
  return readFeaturedMcpApiKey(id)
})
const VERIFIED_API_KEY_CACHE_MS = 5 * 60_000
const verifiedMcpApiKeys = new Map<string, { digest: string; expiresAt: number }>()
function verificationExpiresAt(id: string): number {
  // SerpApi's account API accepts keys only in a query parameter. Check it at
  // most once per app process for an unchanged key to avoid repeated URL exposure.
  return id === 'serpapi' ? Number.POSITIVE_INFINITY : Date.now() + VERIFIED_API_KEY_CACHE_MS
}
function apiKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
async function featuredMcpApiKeyVerifiedStatus(id: string): Promise<boolean> {
  const key = readFeaturedMcpApiKey(id)
  if (!key) {
    verifiedMcpApiKeys.delete(id)
    return false
  }
  const digest = apiKeyDigest(key)
  const cached = verifiedMcpApiKeys.get(id)
  if (cached?.digest === digest && cached.expiresAt > Date.now()) return true
  try {
    await validateFeaturedMcpApiKey(id, key)
  } catch (cause) {
    verifiedMcpApiKeys.delete(id)
    if (cause instanceof McpApiKeyValidationError && cause.kind === 'invalid') return false
    throw cause
  }
  verifiedMcpApiKeys.set(id, { digest, expiresAt: verificationExpiresAt(id) })
  return true
}
async function syncFeaturedMcpApiKeySessions(id: string): Promise<void> {
  if (!API_KEY_CONNECTOR_IDS.some((connectorId) => connectorId === id)) return
  try {
    await getPhiEngine().mcp.syncFeaturedApiKeys({ id })
  } catch {
    // The worker may still hold the previous key. Stop it so a failed sync cannot
    // leave a revoked or rotated credential usable in an existing session.
    writeAppLog({ event: 'mcp_api_key_session_sync_failed', metadata: { connectorId: id } })
    await getPhiEngine().stop()
    throw new Error(
      'Local changes were saved, but the running chat could not be synchronized and was stopped. Reopen the chat and try again.'
    )
  }
}
const remoteConnectionTracker = new RemoteProjectConnectionTracker()
const remoteProjectUploads = new RemoteProjectUploadService({
  connectProject: async (projectId) => {
    const project = getProject(projectId)
    if (!project || project.location.kind !== 'ssh') {
      throw new Error('只能向已登记的 SSH 项目上传本机文件')
    }
    const profile = getRemoteHostProfile(project.location.hostProfileId, AGENT_DIR)
    if (!profile) throw new Error('远程项目的 SSH 服务器档案不可用')
    const session = await connectRemoteSshSession({
      ...remoteConnectionConfigForProfile(profile),
      readyTimeoutMs: 10_000,
      execTimeoutMs: 30_000
    })
    return {
      session,
      remoteProjectRoot: project.location.remoteRoot,
      canonicalRemoteProjectRoot: project.location.canonicalRoot,
      hostKey: remoteTransferHostKey(profile.hostAlias),
      workspaceId: createHash('sha256').update(project.location.canonicalRoot).digest('hex')
    }
  }
})
remoteProjectUploads.subscribe((job) => {
  sendToAllWindows('remoteProjectUploads:changed', job)
})
remoteJupyterStartJobs.subscribe((job) => {
  sendToAllWindows('remoteJupyterJobs:changed', job)
})
const wrapperResultReadControllers = new Map<string, AbortController>()
const wrapperResultDownloads = new Map<
  string,
  { controller: AbortController; phase: 'downloading' | 'verifying' | 'saving' }
>()
subscribeRemoteProjectConnection((projectId, state) => {
  sendToAllWindows('projects:remoteConnectionChanged', { projectId, state })
})
function remoteRequestProjectId(params: unknown): string {
  if (typeof params !== 'object' || params === null) return ''
  const projectId = (params as Record<string, unknown>).projectId
  return typeof projectId === 'string' ? projectId : ''
}

function remoteSkillContextFromRequest(params: unknown): RemoteProjectSkillContext {
  if (!isRecord(params)) throw new Error('远程项目 Skill 读取请求无效')
  const sessionId = optionalStringField(params, 'sessionId')
  const projectId = optionalStringField(params, 'projectId')
  if (!sessionId || !projectId) throw new Error('远程项目 Skill 读取请求无效')
  return { sessionId, projectId, cwd: '', agentDir: AGENT_DIR }
}
async function runWrapperResultRead<T>(
  request: unknown,
  read: (request: unknown, options: { signal: AbortSignal }) => Promise<T>
): Promise<T> {
  const requestId =
    typeof request === 'object' && request !== null
      ? (request as Record<string, unknown>).requestId
      : undefined
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
    throw new Error('Wrapper 结果读取请求 ID 无效')
  }
  if (wrapperResultReadControllers.has(requestId)) {
    throw new Error('Wrapper 结果读取请求 ID 正在使用')
  }
  const controller = new AbortController()
  wrapperResultReadControllers.set(requestId, controller)
  try {
    return await remoteConnectionTracker.observe(remoteRequestProjectId(request), async () => {
      try {
        const result = await read(request, { signal: controller.signal })
        controller.signal.throwIfAborted()
        return result
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Wrapper 结果读取已取消')
        throw error
      }
    })
  } finally {
    wrapperResultReadControllers.delete(requestId)
  }
}
function scheduleRemoteProjectCheck(sessionId: string, projectId: string): void {
  void remoteConnectionTracker.check(sessionId, projectId).catch((error) => {
    writeAppLog({
      level: 'warn',
      event: 'remote_project_connection_check_failed',
      sessionId,
      metadata: { projectId, reason: error instanceof Error ? error.message : '检查未完成' }
    })
  })
}
getPhiEngine().host.register('remoteWorkspace.resolvePath', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    resolveRemoteWorkspacePath(params)
  )
)
getPhiEngine().host.register('remoteWorkspace.resolveBashContext', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    resolveRemoteBashContext(params)
  )
)
const connectRemoteWorkspaceHost = async (request: {
  sessionId: string
  projectId: string
  execTimeoutMs: number
}): Promise<import('./agent/wrappers/remote-ssh-session').RemoteSshSession> =>
  (await import('./agent/workspace-host/remote-registry')).remoteWorkspaceHosts.connect(request)
const releaseRemoteWorkspaceHost = (sessionId: string): void => {
  void import('./agent/workspace-host/remote-registry').then(({ remoteWorkspaceHosts }) =>
    remoteWorkspaceHosts.releaseSession(sessionId)
  )
}
const releaseAllRemoteWorkspaceHosts = (): void => {
  void import('./agent/workspace-host/remote-registry').then(({ remoteWorkspaceHosts }) =>
    remoteWorkspaceHosts.releaseAll()
  )
}
const remoteReadBasis = new RemoteWorkspaceReadBasis()
getPhiEngine().host.register('remoteWorkspace.read', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    readRemoteWorkspacePath(params, {
      connectHost: connectRemoteWorkspaceHost,
      onFileRead: (authorized, content) =>
        remoteReadBasis.record(
          authorized.sessionId,
          authorized.projectId,
          authorized.hostAlias,
          authorized.path,
          content
        )
    })
  )
)
getPhiEngine().host.register('remoteSkills.readResource', (params) => {
  if (!isRecord(params) || typeof params.path !== 'string') {
    throw new Error('远程项目 Skill 读取请求无效')
  }
  const context = remoteSkillContextFromRequest(params)
  return remoteConnectionTracker.observe(context.projectId, () =>
    readRemoteProjectSkillResource(context, params.path as string)
  )
})
getPhiEngine().host.register('remoteWorkspace.glob', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteGlob(params, { connectHost: connectRemoteWorkspaceHost })
  )
)
getPhiEngine().host.register('remoteWorkspace.grep', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteGrep(params, { connectHost: connectRemoteWorkspaceHost })
  )
)
const remoteBashManager = new RemoteWorkspaceBashManager({
  beforeRun: requireRemoteBashApproval,
  connectHost: connectRemoteWorkspaceHost,
  releaseHostSession: releaseRemoteWorkspaceHost,
  releaseAllHosts: releaseAllRemoteWorkspaceHosts
})
const remoteMutationManager = new RemoteWorkspaceMutationManager({
  basis: remoteReadBasis,
  beforeWrite: requireRemoteWriteApproval,
  beforeEdit: requireRemoteEditApproval,
  connectHost: connectRemoteWorkspaceHost
})
const remoteProjectDownloadManager = new RemoteProjectDownloadManager({
  agentDir: AGENT_DIR
})
getPhiEngine().host.register('remoteWorkspace.write', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteMutationManager.write(params)
  )
)
getPhiEngine().host.register('remoteWorkspace.cancelWrite', (params) =>
  remoteMutationManager.cancel(params)
)
getPhiEngine().host.register('remoteWorkspace.edit', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteMutationManager.edit(params)
  )
)
getPhiEngine().host.register('remoteWorkspace.cancelEdit', (params) =>
  remoteMutationManager.cancel(params)
)
getPhiEngine().host.register('remoteWorkspace.bash', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteBashManager.run(params)
  )
)
getPhiEngine().host.register('remoteWorkspace.cancelBash', (params) =>
  remoteBashManager.cancel(params)
)
getPhiEngine().host.register('remoteWorkspace.download', (params, context) => {
  const request = isRecord(params) ? params : {}
  const control = remoteRuntimeDispatchControl(
    {
      runtimeSessionId: context.originSessionId,
      remoteSessionId: request.sessionId,
      projectId: request.projectId
    },
    context
  )
  return remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteProjectDownloadManager.run(params, control)
  )
})
getPhiEngine().host.register('remoteWorkspace.cancelDownload', (params, context) => {
  const request = isRecord(params) ? params : {}
  isRemoteRuntimeCancellation(
    {
      runtimeSessionId: context.originSessionId,
      remoteSessionId: request.sessionId,
      projectId: request.projectId
    },
    context
  )
  return remoteProjectDownloadManager.cancel(params)
})

// Background wrapper runs. The manager lives here, not in the agent worker: a run
// must outlive any chat session, and the worker is stopped whenever it idles.
const wrapperJobs = new WrapperJobManager({
  // Local runs use phi:nextflow@1; a missing environment is offered for building in the chat
  // that started the run.
  nextflowLaunch: {
    builds: environmentBuilds,
    confirmBuild: (request) => confirmEnvironmentBuild(request)
  },
  resolveProjectForRun: (originSessionId) => {
    const origin = resolveRecoverableJobOrigin(originSessionId)
    const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
    if (!manifest) return undefined
    return manifest.projectId ? getProject(manifest.projectId) : null
  },
  // A remote run goes to the HPC connection saved on the project the chat belongs to; a run
  // being resumed after a restart names its project and connection itself.
  resolveRemoteTarget: ({ originSessionId, projectId, connectionId }) => {
    const origin = resolveRecoverableJobOrigin(originSessionId)
    const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
    const project = projectId
      ? getProject(projectId)
      : manifest?.projectId
        ? getProject(manifest.projectId)
        : undefined
    return resolveProjectRemoteTarget(project, connectionId)
  },
  checkRemoteEnvironment: async ({ project, resolved, profile }) => {
    const remoteConnection = project.remoteConnections?.find(
      (connection) => connection.id === resolved.connectionId
    )
    const hostProfileId =
      project.location.kind === 'ssh'
        ? project.location.hostProfileId
        : remoteConnection?.hostProfileId
    if (!hostProfileId) throw new Error('找不到 Wrapper 运行连接的服务器档案')
    const hpc = resolved.target.hpc ?? { scheduler: 'local' as const }
    const controller = hpc.controller ?? 'login'
    const report = await remoteDoctor(
      hostProfileId,
      resolved.target.workspaceRoot,
      {
        scope: 'full',
        scheduler: hpc.scheduler,
        controller,
        runtime: profile,
        ...(remoteConnection?.runtimeRoot
          ? {
              runtimeRootOverride: {
                source: 'project' as const,
                configured: remoteConnection.runtimeRoot
              }
            }
          : {}),
        ...(hpc.nextflowBin ? { nextflowBin: hpc.nextflowBin } : {}),
        ...(hpc.containerRuntimeBin ? { containerRuntimeBin: hpc.containerRuntimeBin } : {})
      },
      { deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length) }
    )
    return {
      report,
      remotePath: resolved.target.workspaceRoot,
      scheduler: hpc.scheduler,
      controller,
      runtime: profile,
      deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length)
    }
  }
})
for (const [method, handler] of Object.entries(
  wrapperJobHostHandlers(wrapperJobs, {
    scopeFor: (context) => {
      const originSessionId = context?.originSessionId
      if (!originSessionId) {
        if (context?.signal) throw new Error('RPC Wrapper call has no trusted origin')
        return undefined
      }
      const origin = resolveOriginSession(originSessionId)
      const manifest = origin && findPhiSessionById(origin.phiSessionId)
      if (!origin || !manifest) throw new Error('Wrapper origin session is unavailable')
      const project = manifest.projectId ? getProject(manifest.projectId) : undefined
      if (project?.location.kind !== 'ssh') {
        if (context?.signal || manifest.projectLocation?.kind === 'ssh')
          throw new Error('RPC Wrapper project is unavailable')
        return undefined
      }
      if (ownsRemoteRuntimeSession(originSessionId) && !context?.signal)
        throw new Error('RPC Wrapper call has no owned cancellation scope')
      const binding = resolveRemoteWorkspaceHostBinding({
        sessionId: origin.phiSessionId,
        projectId: project.id
      })
      const target = resolveProjectRemoteTarget(project, undefined)
      if ('reason' in target) throw new Error(target.reason)
      const targetKey = JSON.stringify(target)
      return createWrapperJobHostScope({
        originSessionId,
        phiSessionId: origin.phiSessionId,
        projectId: project.id,
        hostProfileId: project.location.hostProfileId,
        host: target.target.connection.host,
        workspaceRoot: target.target.workspaceRoot,
        signal: context?.signal,
        readRun: (runId) => readWrapperRun(runId),
        resolveOrigin: resolveOriginSession,
        assertCurrent: () => {
          const currentProject = getProject(project.id)
          if (
            !currentProject ||
            resolveOriginSession(originSessionId)?.phiSessionId !== origin.phiSessionId ||
            resolveRemoteWorkspaceHostBinding({
              sessionId: origin.phiSessionId,
              projectId: project.id
            }).cacheKey !== binding.cacheKey ||
            JSON.stringify(resolveProjectRemoteTarget(currentProject, undefined)) !== targetKey
          )
            throw new Error('RPC Wrapper selected project/host binding changed')
        }
      })
    }
  })
)) {
  getPhiEngine().host.register(method, handler)
}
wrapperJobs.onChange((runId) => sendToAllWindows('wrappers:runsChanged', { runId }))

// The agent worker knows which runtime session started a run; the timeline that must hear
// about its end belongs to the Phi conversation that session serves. Registered when the
// session is created and kept for the app's lifetime (a few short entries).
const runtimeSessionOrigins = new Map<string, { sessionKey: string; cwd: string }>()

// Both background wrapper runs and background agent runs report their end through these:
// which Phi conversation a runtime session belongs to, the window, and the system notification.
function resolveOriginSession(
  originSessionId: string | undefined
): { phiSessionId: string; cwd: string } | undefined {
  if (!originSessionId) return undefined
  const origin = runtimeSessionOrigins.get(originSessionId)
  const phiSessionId = origin
    ? getPhiSessionIdForKey(origin.sessionKey)
    : findActivePromptRunByRuntimeSessionId(originSessionId)?.phiSessionId
  return phiSessionId ? { phiSessionId, cwd: origin?.cwd ?? currentCwd } : undefined
}

function currentRuntimeOriginScope(
  manifest: PhiSessionManifest
): import('./agent/session/runtime-reference').RemoteOmpScope | undefined {
  if (!manifest.runtimeRef || !manifest.projectId) return undefined
  const reference = parseRuntimeReference(manifest.runtimeRef, manifest.sessionId)
  const project = requireProject(manifest.projectId)
  if (project.location.kind !== 'ssh') return undefined
  const binding = resolveRemoteWorkspaceHostBinding({
    sessionId: manifest.sessionId,
    projectId: project.id
  })
  const scope = {
    hostProfileId: project.location.hostProfileId,
    bindingHash: facadeBindingHash(binding),
    projectId: project.id,
    projectRoot: binding.canonicalRoot,
    runtimeRoot: reference.runtimeRoot
  }
  assertRuntimeReferenceProject(manifest, scope)
  assertRuntimeScope(reference, scope)
  return scope
}

/** Cold records recover job attribution only; all tool/control/wakeup authority uses the live resolver. */
function resolveRecoverableJobOrigin(
  originSessionId: string | undefined
): { phiSessionId: string; cwd: string } | undefined {
  if (!originSessionId) return undefined
  return (
    resolveOriginSession(originSessionId) ??
    resolveRuntimeSessionOrigin(
      originSessionId,
      {
        readManifest: findPhiSessionById,
        resolveRemoteScope: currentRuntimeOriginScope,
        resolveConfiguredRuntimeRoot: (manifest) => {
          const project = manifest.projectId ? getProject(manifest.projectId) : undefined
          return project?.location.kind === 'ssh'
            ? projectRemoteRuntimeRoot(project).configured
            : undefined
        }
      },
      AGENT_DIR
    )
  )
}

const browserToolHostCoordinator = new BrowserToolHostCoordinator({
  resolveActiveRun: (originSessionId) => {
    const run = findActivePromptRunByRuntimeSessionId(originSessionId)
    return run ? { runId: run.runId, cancelled: run.cancelled } : undefined
  },
  executeAgent: (params, signal, control) =>
    browserIpcCoordinator.executeAgent(params, signal, control)
})

function cancelBrowserRun(run: PromptRun): void {
  browserToolHostCoordinator.cancelRun(run.runId, run.session?.runtimeSessionId)
}

async function cleanupBrowserRunTabs(run: PromptRun): Promise<void> {
  try {
    await browserWorkspaceRegistry?.disposeRun(run.phiSessionId, run.runId)
  } catch {
    writeAppLog({ level: 'error', event: 'browser_run_cleanup_failed' })
  }
}

function browserChildDispatchControl(
  params: unknown,
  context: import('./agent/engine/types').PhiHostRequestContext | undefined
): import('./agent/browser/browser-tool-host').BrowserToolDispatchControl | undefined {
  if (!context?.agentRunId) return undefined
  const runtimeId = isRecord(params) ? optionalStringField(params, 'originSessionId') : undefined
  if (!runtimeId || context.originSessionId !== runtimeId)
    throw new Error('专家浏览器请求缺少已验证的来源')
  const origin = resolveOriginSession(runtimeId)
  const manifest = origin && findPhiSessionById(origin.phiSessionId)
  if (!ownsRemoteRuntimeSession(runtimeId)) {
    if (manifest?.projectLocation?.kind === 'ssh') throw new Error('远程专家浏览器连接不可用')
    return undefined
  }
  if (!origin || !manifest?.projectId || !context.signal)
    throw new Error('专家浏览器请求缺少独立运行范围')
  const control = remoteRuntimeDispatchControl(
    {
      runtimeSessionId: runtimeId,
      remoteSessionId: origin.phiSessionId,
      projectId: manifest.projectId
    },
    context
  )!
  return {
    runId: context.agentRunId,
    signal: context.signal,
    allowTypeText: false,
    assertCurrent: control.beforeDispatch
  }
}
getPhiEngine().host.register('browser.execute', (params, context) =>
  browserToolHostCoordinator.execute(params, browserChildDispatchControl(params, context))
)
getPhiEngine().host.register('browser.cancel', (params, context) => {
  if (context?.agentRunId) {
    if (!isRecord(params) || context.originSessionId !== params.originSessionId)
      throw new Error('专家浏览器取消请求的来源不匹配')
    // Terminal cancellation uses only the captured child ID, never a successor's active run.
    return browserToolHostCoordinator.cancel(params, { runId: context.agentRunId })
  }
  return browserToolHostCoordinator.cancel(params)
})
async function listBackgroundAgentJobs(): Promise<BackgroundAgentJob[]> {
  const raw = await getPhiEngine().agentRuns.list({})
  if (!Array.isArray(raw)) throw new Error('后台 Agent 状态暂时不可用')
  const live = raw.flatMap((value): BackgroundAgentJob[] => {
    if (!isRecord(value)) return []
    const agentSessionId = optionalStringField(value, 'agentSessionId')
    const agentRunId = optionalStringField(value, 'agentRunId')
    const agentName = optionalStringField(value, 'agentName')
    const state = value.state
    const startedAt = value.startedAt
    if (
      !agentSessionId ||
      !agentRunId ||
      !agentName ||
      (state !== 'queued' &&
        state !== 'running' &&
        state !== 'done' &&
        state !== 'error' &&
        state !== 'cancelled') ||
      typeof startedAt !== 'number' ||
      !Number.isFinite(startedAt)
    )
      return []
    const origin = resolveRecoverableJobOrigin(agentSessionId)
    if (!origin) return []
    const manifest = findPhiSessionById(origin.phiSessionId)
    if (!manifest) return []
    return [
      {
        agentSessionId,
        agentRunId,
        sessionId: origin.phiSessionId,
        sessionPath: phiOnlySessionPath(origin.phiSessionId),
        sessionTitle: messageContentTitleText(manifest.title) || '新对话',
        agentName,
        task: (optionalStringField(value, 'task') ?? '').slice(0, 300),
        state,
        background: value.background === true,
        startedAt: new Date(startedAt).toISOString(),
        ...(typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
          ? { completedAt: new Date(value.completedAt).toISOString() }
          : {}),
        ...(optionalStringField(value, 'lastStep')
          ? { lastStep: optionalStringField(value, 'lastStep')?.slice(0, 160) }
          : {}),
        ...(typeof value.toolCalls === 'number' && Number.isFinite(value.toolCalls)
          ? { toolCalls: Math.max(0, Math.trunc(value.toolCalls)) }
          : {}),
        ...(optionalStringField(value, 'toolCallId')
          ? { toolCallId: optionalStringField(value, 'toolCallId') }
          : {})
      }
    ]
  })
  // Only a successful live listing establishes absence. Persisted records never grant control.
  const liveIds = new Set(live.map((run) => `${run.sessionId}:${run.agentRunId}`))
  const cold: BackgroundAgentJob[] = []
  for (const manifest of listPhiSessions()) {
    if (!manifest.runtimeRef) continue
    try {
      const scope = currentRuntimeOriginScope(manifest)
      if (!scope) continue
      const reference = parseRuntimeReference(manifest.runtimeRef, manifest.sessionId)
      for (const run of readColdChildRuns(
        { phiSessionId: manifest.sessionId, reference },
        AGENT_DIR
      )) {
        if (!run.background || liveIds.has(`${manifest.sessionId}:${run.id}`)) continue
        cold.push({
          agentSessionId: '',
          agentRunId: run.id,
          sessionId: manifest.sessionId,
          sessionPath: phiOnlySessionPath(manifest.sessionId),
          sessionTitle: messageContentTitleText(manifest.title) || '新对话',
          agentName: run.agent,
          task: '',
          state:
            run.status === 'completed'
              ? 'done'
              : run.status === 'failed'
                ? 'error'
                : run.status === 'aborted'
                  ? 'cancelled'
                  : 'interrupted',
          background: true,
          canControl: false,
          historyAvailable: false,
          startedAt: new Date(run.startedAt).toISOString(),
          ...(run.completedAt !== undefined
            ? { completedAt: new Date(run.completedAt).toISOString() }
            : {})
        })
      }
    } catch {
      writeAppLog({
        level: 'error',
        event: 'child_recovery_metadata_unavailable',
        sessionId: manifest.sessionId
      })
    }
  }
  return [...live, ...cold]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 50)
}

const SHELL_JOB_STATES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])

async function listBackgroundShellJobs(): Promise<BackgroundShellJob[]> {
  const raw = await getPhiEngine().shellJobs.list({})
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((value): BackgroundShellJob[] => {
      if (!isRecord(value)) return []
      const agentSessionId = optionalStringField(value, 'agentSessionId')
      const jobId = optionalStringField(value, 'jobId')
      const command = optionalStringField(value, 'command')
      const state = value.state
      const startedAt = value.startedAt
      if (
        !agentSessionId ||
        !jobId ||
        !command ||
        typeof state !== 'string' ||
        !SHELL_JOB_STATES.has(state) ||
        typeof startedAt !== 'number' ||
        !Number.isFinite(startedAt)
      )
        return []
      const origin = resolveOriginSession(agentSessionId)
      if (!origin) return []
      const manifest = findPhiSessionById(origin.phiSessionId)
      if (!manifest) return []
      const startedAtIso = new Date(startedAt).toISOString()
      const output = optionalStringField(value, 'output')?.slice(-160)
      return [
        {
          agentSessionId,
          jobId,
          sessionId: origin.phiSessionId,
          sessionPath: phiOnlySessionPath(origin.phiSessionId),
          sessionTitle: messageContentTitleText(manifest.title) || '新对话',
          command: command.slice(0, 300),
          state: state as BackgroundShellJob['state'],
          startedAt: startedAtIso,
          ...(state !== 'queued' && state !== 'running' ? { completedAt: startedAtIso } : {}),
          ...(output ? { output } : {})
        }
      ]
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 50)
}

async function stopBackgroundShellJob(agentSessionId: unknown, jobId: unknown): Promise<void> {
  if (typeof agentSessionId !== 'string' || !agentSessionId) throw new Error('缺少会话')
  if (typeof jobId !== 'string' || !jobId) throw new Error('缺少后台命令编号')
  const result = await getPhiEngine().shellJobs.cancel({
    sessionId: agentSessionId,
    jobId
  })
  if (!result?.ok) throw new Error('这个后台命令已经结束')
}

function sendRunEventToWindow(payload: Record<string, unknown>): void {
  sendToWindow(getActiveWindow(), 'agent:event', {
    ...payload,
    sessionPath: phiOnlySessionPath(String(payload.phiSessionId))
  })
}

function showRunNotification({ title, body }: { title: string; body: string }): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    const window = getActiveWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  notification.show()
}

wrapperJobs.onFinish((run, status) => {
  const liveOrigin = resolveOriginSession(run.originSessionId)
  if (status.state === 'lost' && run.remote?.projectId) {
    remoteConnectionTracker.noteRemoteRunLost(run.remote.projectId)
  }
  return deliverWrapperRunFinished(run, status, {
    resolveSession: resolveRecoverableJobOrigin,
    appendToSession: (phiSessionId, event) => appendSessionEvent(phiSessionId, { ...event }),
    sendToWindow: sendRunEventToWindow,
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    continueConversation: liveOrigin ? continueConversationAfterWrapperRun : async () => undefined,
    showOsNotification: showRunNotification,
    getUiLanguage: () => readAppSettings().uiLanguage
  })
})

// Background agent runs live in the agent worker, one registry per conversation; the worker
// tells us here when one ends, or when the main agent has already collected its report.
for (const [method, handler] of Object.entries(
  agentRunHostHandlers({
    resolveSession: resolveOriginSession,
    appendToSession: (phiSessionId, event) => appendSessionEvent(phiSessionId, { ...event }),
    sendToWindow: sendRunEventToWindow,
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    continueConversation: continueConversationAfterAgentRun,
    showOsNotification: showRunNotification,
    getUiLanguage: () => readAppSettings().uiLanguage,
    redact: redactSensitiveText,
    persistStepOutput: (phiSessionId, toolCallId, stepId, output) =>
      persistToolOutput(phiSessionId, {
        runId: 'agent-run',
        toolCallId: `${toolCallId}-${stepId}`,
        output,
        inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
      }),
    redactValue: redactStructuredValue,
    markReported: (phiSessionId, agentRunId) => markAgentRunReported(phiSessionId, agentRunId),
    clearReported: (phiSessionId, agentRunId) => clearAgentRunReported(phiSessionId, agentRunId)
  })
)) {
  getPhiEngine().host.register(method, handler)
}

const MAX_AGENT_STEER_LENGTH = 4000

/**
 * Keeps what the user told a running agent on its card, so it is still there after switching
 * conversations or restarting. Only called once the agent has accepted the message; recording it
 * is an extra that must never turn a delivered message into a failure.
 */
function recordAgentSteer(
  agentSessionId: unknown,
  agentRunId: unknown,
  toolCallId: unknown,
  text: string
): void {
  if (typeof toolCallId !== 'string' || !toolCallId) return
  try {
    const origin = resolveOriginSession(typeof agentSessionId === 'string' ? agentSessionId : '')
    if (!origin) return
    const stored = appendSessionEvent(origin.phiSessionId, {
      type: 'agent_execution_steered',
      toolCallId,
      ...(typeof agentRunId === 'string' ? { agentRunId } : {}),
      text: redactSensitiveText(text)
    })
    sendRunEventToWindow({
      source: 'phi',
      ...stored,
      phiSessionId: origin.phiSessionId,
      cwd: origin.cwd
    })
  } catch (error) {
    logUnexpectedError(error)
  }
}

async function requestAgentRunControl(
  method: 'agentRun.steer' | 'agentRun.stop',
  agentSessionId: unknown,
  agentRunId: unknown,
  message?: string
): Promise<void> {
  if (typeof agentSessionId !== 'string' || !agentSessionId) throw new Error('缺少 Agent 会话')
  if (typeof agentRunId !== 'string' || !agentRunId) throw new Error('缺少 Agent 运行编号')
  const origin = resolveRecoverableJobOrigin(agentSessionId)
  const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
  if (
    manifest?.projectLocation?.kind === 'ssh' ||
    manifest?.runtimeRef ||
    manifest?.runtimeRecoveryError
  ) {
    if (
      !ownsRemoteRuntimeSession(agentSessionId) ||
      resolveOriginSession(agentSessionId)?.phiSessionId !== manifest.sessionId ||
      !getPhiEngine().sessions.has(agentSessionId) ||
      !currentRuntimeOriginScope(manifest)
    )
      throw new Error('远程专家任务当前没有可控制的连接；旧任务不会在本机重新启动。')
  }
  const params = {
    sessionId: agentSessionId,
    runId: agentRunId,
    ...(message !== undefined ? { message } : {})
  }
  if (method === 'agentRun.steer') await getPhiEngine().agentRuns.steer(params)
  else await getPhiEngine().agentRuns.stop(params)
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function interactionOptionsField(
  value: unknown
): AgentUserInteractionQuestion['options'] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .filter(isRecord)
    .map((item) => {
      const label = optionalStringField(item, 'label')
      const description = optionalStringField(item, 'description')
      if (!label || !description) return null
      return {
        label,
        description,
        ...(optionalStringField(item, 'preview')
          ? { preview: optionalStringField(item, 'preview') }
          : {})
      }
    })
    .filter((item): item is AgentUserInteractionQuestion['options'][number] => item !== null)
  return options.length > 0 ? options : undefined
}

function interactionQuestionsField(value: unknown): AgentUserInteractionQuestion[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((item) => {
      const question = optionalStringField(item, 'question')
      const header = optionalStringField(item, 'header')
      const options = interactionOptionsField(item.options)
      if (!question || !header || !options) return null
      return {
        question,
        header,
        options,
        ...(item.multiSelect === true ? { multiSelect: true } : {})
      }
    })
    .filter((item): item is AgentUserInteractionQuestion => item !== null)
}

function findActivePromptRunByRuntimeSessionId(runtimeSessionId: string): PromptRun | null {
  return (
    [...activePromptRuns.values()].find(
      (run) => run.session?.runtimeSessionId === runtimeSessionId
    ) ?? null
  )
}

function presentableRun(
  runtimeSessionId: string | undefined,
  toolCallId: string | undefined
): {
  run: PromptRun
  toolCallId: string
  remote?: { sessionId: string; projectId: string }
} {
  if (!runtimeSessionId || !toolCallId || toolCallId.length > 200) {
    throw new Error('Invalid file delivery request')
  }
  const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
  if (!run || run.cancelled) throw new Error('No active conversation for file delivery')
  const manifest = findPhiSessionById(run.phiSessionId)
  const project = run.projectId ? getProject(run.projectId) : undefined
  const remoteAnchor = isRemoteProjectAnchorPath(run.cwd, AGENT_DIR)
  if (
    remoteAnchor ||
    manifest?.projectLocation?.kind === 'ssh' ||
    project?.location.kind === 'ssh'
  ) {
    if (
      !run.projectId ||
      manifest?.projectId !== run.projectId ||
      manifest.projectLocation?.kind !== 'ssh' ||
      project?.location.kind !== 'ssh' ||
      manifest.projectLocation.hostProfileId !== project.location.hostProfileId ||
      manifest.projectLocation.remoteRoot !== project.location.remoteRoot ||
      manifest.projectLocation.canonicalRoot !== project.location.canonicalRoot
    ) {
      throw new Error('Remote project identity is unavailable for file delivery')
    }
    return {
      run,
      toolCallId,
      remote: { sessionId: run.phiSessionId, projectId: run.projectId }
    }
  }
  return { run, toolCallId }
}

function recordPresentedFiles(run: PromptRun, toolCallId: string, files: PresentedFile[]): void {
  for (let index = 0; index < files.length; index += MAX_PRESENTED_FILES) {
    const batch = files.slice(index, index + MAX_PRESENTED_FILES)
    const stored = appendSessionEvent(run.phiSessionId, {
      type: 'files_presented',
      runId: run.runId,
      toolCallId,
      files: batch
    })
    broadcastSessionTimelineEvent(run.phiSessionId, stored)
  }
}

async function handlePresentFilesRequest(
  params: unknown,
  context?: import('./agent/engine/types').PhiHostRequestContext
): Promise<{ files: PresentedFile[] }> {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = optionalStringField(record, 'runtimeSessionId')
  const toolCallId = optionalStringField(record, 'toolCallId')
  const { run, toolCallId: callId, remote } = presentableRun(runtimeSessionId, toolCallId)
  const routed = runtimeSessionId && ownsRemoteRuntimeSession(runtimeSessionId)
  if (
    routed &&
    (context?.originSessionId !== runtimeSessionId ||
      context?.toolCallId !== callId ||
      !context.signal)
  )
    throw new Error('RPC deliverable origin/call binding differs')
  context?.signal?.throwIfAborted()
  const binding = remote ? resolveRemoteWorkspaceHostBinding(remote).cacheKey : undefined
  const files = remote
    ? await validateRemotePresentedFiles(remote, record.files, {
        connectHost: connectRemoteWorkspaceHost
      })
    : validatePresentedFiles(run.cwd, record.files)
  context?.signal?.throwIfAborted()
  if (
    presentableRun(runtimeSessionId, toolCallId).run !== run ||
    (remote && resolveRemoteWorkspaceHostBinding(remote).cacheKey !== binding)
  )
    throw new Error('Deliverable run/project binding changed during inspection')
  recordPresentedFiles(run, callId, files)
  return { files }
}

function presentScriptArtifacts(request: PresentArtifactsRequest): void {
  const { run, toolCallId } = presentableRun(request.runtimeSessionId, request.toolCallId)
  const files: PresentedFile[] = request.artifacts.map((artifact) => ({
    path: artifact.path,
    displayPath: artifact.relativePath,
    bytes: statSync(artifact.path).size,
    description: artifact.descriptor.title,
    artifact: {
      kind: artifact.descriptor.kind,
      title: artifact.descriptor.title,
      envId: request.envId
    }
  }))
  recordPresentedFiles(run, toolCallId, files)
}

async function confirmEnvironmentBuild(request: ConfirmBuildRequest): Promise<boolean> {
  try {
    const response = await handleAgentInteractionRequest({
      runtimeSessionId: request.runtimeSessionId,
      questions: [
        {
          header: '环境',
          question: environmentBuildQuestion(request),
          options: [
            { label: BUILD_NOW, description: '下载并安装这个环境' },
            { label: '暂不', description: '这次先不安装' }
          ]
        }
      ]
    })
    return confirmedEnvironmentBuild(response)
  } catch {
    return false
  }
}

async function confirmEnvironmentRequest(request: EnvironmentRequestConfirm): Promise<boolean> {
  try {
    const response = await handleAgentInteractionRequest({
      runtimeSessionId: request.runtimeSessionId,
      questions: [
        {
          header: '环境',
          question: request.question,
          options: [
            { label: ADD_PACKAGES, description: '求解并安装这些包' },
            { label: '取消', description: '不添加这些包' }
          ]
        }
      ]
    })
    return confirmedEnvironmentRequest(response)
  } catch {
    return false
  }
}

async function confirmAgentModuleInstallation(
  runtimeSessionId: string,
  summary: string,
  context: import('./agent/engine/types').PhiHostRequestContext
): Promise<boolean> {
  capabilityHost.assertCurrent(context)
  const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
  if (!run || !context.signal || !context.toolCallId) return false
  const project = run.projectId ? getProject(run.projectId) : getProjectByCwd(run.cwd)
  const request = {
    requestId: createRunId(),
    sessionId: run.phiSessionId,
    sessionPath: phiOnlySessionPath(run.phiSessionId),
    sessionGeneration: run.sessionGeneration,
    runId: run.runId,
    cwd: run.cwd,
    ...(project?.name ? { projectName: project.name } : {}),
    toolCallId: context.toolCallId,
    toolName: 'capability_install',
    summary
  }
  runnerRegistry.markNeedsApproval(run.phiSessionId, request.requestId, request)
  const decision = await requestRuntimeToolApproval(request, context.signal, getActiveWindow)
  if (decision === 'approved')
    runnerRegistry.markApprovalApproved(run.phiSessionId, request.requestId)
  else if (decision === 'denied')
    runnerRegistry.markApprovalDenied(run.phiSessionId, request.requestId)
  else {
    runnerRegistry.markApprovalCancelled(run.phiSessionId, request.requestId)
    sendToAllWindows('tool:approval-cancelled', request.requestId)
  }
  notifySessionChanged()
  capabilityHost.assertCurrent(context)
  return decision === 'approved'
}

async function handleAgentInteractionRequest(
  params: unknown,
  context?: import('./agent/engine/types').PhiHostRequestContext
): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = optionalStringField(record, 'runtimeSessionId')
  const questions = interactionQuestionsField(record.questions)
  if (!runtimeSessionId || questions.length === 0) {
    throw new Error('Invalid user interaction request')
  }

  const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
  if (
    !run ||
    run.cancelled ||
    (context?.originSessionId && context.originSessionId !== runtimeSessionId)
  ) {
    throw new Error('No active run for user interaction request')
  }

  const window = getActiveWindow()
  if (!canRequestAgentUserInteraction(window)) {
    throw new Error('没有可用窗口来请求用户输入')
  }

  const interactionId = createRunId()
  const project = run.projectId ? getProject(run.projectId) : getProjectByCwd(run.cwd)
  runnerRegistry.markNeedsInput(run.phiSessionId, interactionId, {
    kind: 'ask_user_question',
    message: questions[0].question
  })
  const response = await waitForAgentUserInteraction(
    {
      requestId: interactionId,
      questions,
      sessionId: run.phiSessionId,
      sessionPath: phiOnlySessionPath(run.phiSessionId),
      sessionGeneration: run.sessionGeneration,
      runId: run.runId,
      cwd: project?.location.kind === 'ssh' ? project.location.remoteRoot : run.cwd,
      ...(project?.name ? { projectName: project.name } : {})
    },
    window,
    [context?.signal]
  )
  if (
    context?.signal?.aborted ||
    run.cancelled ||
    findActivePromptRunByRuntimeSessionId(runtimeSessionId) !== run
  ) {
    runnerRegistry.markInputCancelled(run.phiSessionId, interactionId)
    notifySessionChanged()
    return { requestId: interactionId, answers: [], cancelled: true }
  }
  if (response.cancelled) {
    runnerRegistry.markInputCancelled(run.phiSessionId, interactionId)
  } else {
    runnerRegistry.markInputAnswered(run.phiSessionId, interactionId)
  }
  notifySessionChanged()
  return response
}

async function handlePlanReviewRequest(
  params: unknown
): Promise<{ decision: 'approve' | 'revise' | 'cancel'; note?: string }> {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = optionalStringField(record, 'runtimeSessionId')
  const title = optionalStringField(record, 'title')?.trim()
  const content = optionalStringField(record, 'planContent')
  const planFilePath = optionalStringField(record, 'planFilePath')
  if (
    !runtimeSessionId ||
    !title ||
    title.length > 120 ||
    !content?.trim() ||
    Buffer.byteLength(content, 'utf8') > 64 * 1024 ||
    !planFilePath ||
    !/^local:\/\/[A-Za-z0-9_-]+\.md$/.test(planFilePath)
  ) {
    throw new Error('Invalid plan review request')
  }
  const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
  if (!run || run.cancelled) throw new Error('No active conversation for plan review')
  const project = run.projectId ? getProject(run.projectId) : undefined
  const manifest = findPhiSessionById(run.phiSessionId)
  if (project?.location.kind === 'ssh' || manifest?.projectLocation?.kind === 'ssh') {
    throw new Error('远程项目暂不支持计划评审')
  }
  const window = getActiveWindow()
  if (!canRequestAgentUserInteraction(window)) throw new Error('没有可用窗口来评审计划')

  const reviewId = createRunId()
  const submitted = appendSessionEvent(run.phiSessionId, {
    type: 'plan_review_submitted',
    runId: run.runId,
    reviewId,
    title,
    content,
    planFilePath
  })
  broadcastSessionTimelineEvent(run.phiSessionId, submitted)
  runnerRegistry.markNeedsInput(run.phiSessionId, reviewId, {
    kind: 'plan_review',
    message: title
  })
  notifySessionChanged()
  const response = await waitForAgentUserInteraction(
    {
      requestId: reviewId,
      questions: [],
      planReview: { title, content, planFilePath },
      sessionId: run.phiSessionId,
      sessionPath: phiOnlySessionPath(run.phiSessionId),
      sessionGeneration: run.sessionGeneration,
      runId: run.runId,
      cwd: run.cwd,
      ...(project?.name ? { projectName: project.name } : {})
    },
    window
  )
  const answer = response.answers.find((item) => item.question === 'plan_review')?.answer
  const decision = response.cancelled
    ? 'cancel'
    : answer === 'approve' || answer === 'revise'
      ? answer
      : 'cancel'
  const note =
    typeof response.globalNote === 'string' ? response.globalNote.trim().slice(0, 2000) : ''
  if (decision === 'cancel') runnerRegistry.markInputCancelled(run.phiSessionId, reviewId)
  else runnerRegistry.markInputAnswered(run.phiSessionId, reviewId)
  const decided = appendSessionEvent(run.phiSessionId, {
    type: 'plan_review_decided',
    runId: run.runId,
    reviewId,
    decision,
    ...(note && decision === 'revise' ? { note } : {})
  })
  broadcastSessionTimelineEvent(run.phiSessionId, decided)
  notifySessionChanged()
  return { decision, ...(note && decision === 'revise' ? { note } : {}) }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function ensureJupyterServerReady(projectCwd: string): Promise<void> {
  let status = jupyterServerRegistry.status(projectCwd)
  if (status.state !== 'ready' || !status.hasEndpoint) {
    status = jupyterServerRegistry.start(projectCwd)
  }
  for (
    let attempt = 0;
    attempt < 20 && (status.state !== 'ready' || !status.hasEndpoint);
    attempt += 1
  ) {
    if (status.state === 'error' || status.state === 'exited' || status.state === 'stopped') {
      break
    }
    await delay(250)
    status = jupyterServerRegistry.status(projectCwd)
  }
  if (status.state !== 'ready' || !status.hasEndpoint) {
    throw new Error(status.message ?? 'Jupyter Server 尚未就绪')
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function emptyNotebookCompletionResult(
  cursorPosition: number,
  message?: string
): JupyterKernelCompletionResult {
  const position = Number.isFinite(cursorPosition) ? Math.max(0, cursorPosition) : 0
  return {
    matches: [],
    cursorStart: position,
    cursorEnd: position,
    metadata: {},
    status: 'error' as const,
    message
  }
}

function stoppedJupyterStatus(
  projectCwd: string | undefined,
  message?: string
): {
  projectCwd: string
  state: 'stopped'
  hasEndpoint: false
  message?: string
} {
  return {
    projectCwd: projectCwd ?? '',
    state: 'stopped' as const,
    hasEndpoint: false,
    ...(message ? { message } : {})
  }
}

function emptyAnalysisRuntimeStatus(
  projectCwd: string | undefined,
  message?: string
): {
  server: ReturnType<typeof stoppedJupyterStatus>
  notebooks: {
    activeSessionCount: number
    busySessionCount: number
    sessions: unknown[]
  }
} {
  return {
    server: stoppedJupyterStatus(projectCwd, message),
    notebooks: {
      activeSessionCount: 0,
      busySessionCount: 0,
      sessions: []
    }
  }
}

function analysisSessions(workspace: AnalysisWorkspaceContext): AnalysisNotebookSessionRegistry {
  return remoteNotebookBackendFor(workspace)?.sessions ?? notebookSessionRegistry
}

function analysisTools(workspace: AnalysisWorkspaceContext): AnalysisNotebookToolExecutor {
  return remoteNotebookBackendFor(workspace)?.tools ?? notebookToolExecutor
}

function analysisKernels(
  workspace: AnalysisWorkspaceContext
): ReturnType<typeof detectConfiguredAnalysisKernels> {
  return remoteNotebookBackendFor(workspace)?.kernels() ?? detectConfiguredAnalysisKernels()
}

async function analysisOpenFile(
  workspace: AnalysisWorkspaceContext,
  notebookPath: string,
  watch = false
): Promise<Awaited<ReturnType<RemoteAnalysisNotebookBackend['workspace']['open']>>> {
  const remote = remoteNotebookBackendFor(workspace)
  if (!remote) {
    return watch
      ? notebookFileWatcher.watch(workspace.workingDirectory, notebookPath)
      : openProjectNotebook(workspace.workingDirectory, notebookPath)
  }
  return remote.open(
    notebookPath,
    watch
      ? (event) =>
          notifyAnalysisNotebookFileChanged(remoteNotebookFileChange(remote.projectCwd, event))
      : undefined
  )
}

function syncAnalysisDraft(
  workspace: AnalysisWorkspaceContext,
  file: Awaited<ReturnType<typeof analysisOpenFile>>,
  document: NotebookDocument = file.document,
  savedRevision: string = file.savedRevision,
  refreshFileBasis = false
): ReturnType<AnalysisNotebookToolExecutor['syncDraft']> {
  return analysisTools(workspace).syncDraft({
    cwd: workspace.workingDirectory,
    path: file.path,
    file,
    document,
    savedRevision,
    refreshFileBasis,
    source: 'renderer'
  })
}

async function analysisSaveFile(
  workspace: AnalysisWorkspaceContext,
  input: SaveProjectNotebookInput
): Promise<Awaited<ReturnType<RemoteAnalysisNotebookBackend['save']>>> {
  const remote = remoteNotebookBackendFor(workspace)
  const file = remote
    ? await remote.save(input)
    : saveProjectNotebook(workspace.workingDirectory, input)
  if (!remote) notebookFileWatcher.noteLocalWrite(workspace.workingDirectory, file)
  return file
}

async function analysisCreateFile(
  workspace: AnalysisWorkspaceContext,
  relativePath?: string
): Promise<Awaited<ReturnType<RemoteAnalysisNotebookBackend['workspace']['create']>>> {
  const remote = remoteNotebookBackendFor(workspace)
  if (!remote) {
    const file = createProjectNotebook(workspace.workingDirectory, relativePath)
    notebookFileWatcher.watchFile(workspace.workingDirectory, file)
    return file
  }
  const created = await remote.workspace.create(relativePath)
  return remote.open(created.path, (event) =>
    notifyAnalysisNotebookFileChanged(remoteNotebookFileChange(remote.projectCwd, event))
  )
}

async function analysisCloseFile(
  workspace: AnalysisWorkspaceContext,
  notebookPath: string
): Promise<{ path: string }> {
  const remote = remoteNotebookBackendFor(workspace)
  if (remote) return remote.close(notebookPath)
  const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
  await notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
  notebookFileWatcher.unwatchFile(workspace.workingDirectory, file)
  return closeProjectNotebook(workspace.workingDirectory, notebookPath)
}

async function analysisDeleteFile(
  workspace: AnalysisWorkspaceContext,
  notebookPath: string
): Promise<{ path: string; relativePath: string }> {
  const remote = remoteNotebookBackendFor(workspace)
  if (remote) return remote.delete(notebookPath)
  const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
  await notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
  notebookFileWatcher.unwatchFile(workspace.workingDirectory, file)
  return deleteProjectNotebook(workspace.workingDirectory, notebookPath)
}

function notebookDocumentLanguage(document: NotebookDocument): string {
  const kernelspec = document.metadata.kernelspec
  if (kernelspec && typeof kernelspec === 'object' && !Array.isArray(kernelspec)) {
    const spec = kernelspec as JsonObject
    if (typeof spec.language === 'string') return spec.language
    if (typeof spec.name === 'string') return spec.name
    if (typeof spec.display_name === 'string') return spec.display_name
  }
  return ''
}

function isPythonNotebookDocument(document: NotebookDocument): boolean {
  return notebookDocumentLanguage(document).toLocaleLowerCase().includes('python')
}

function notebookAgentRuntimePrompt(projectCwd: string): string | null {
  const project = getProjectByCwd(projectCwd)
  if (!project) return null

  const status = jupyterServerRegistry.status(project.workingDirectory)
  const activeNotebookPath = activeNotebookPathByProjectCwd.get(project.workingDirectory)
  const registry = listProjectNotebooks(project.workingDirectory, {
    maxDepth: 4,
    maxEntries: 600,
    maxNotebooks: 12
  })
  const notebooks = registry.notebooks
    .map((notebook) => {
      const marker = notebook.path === activeNotebookPath ? ' (active)' : ''
      return `- ${notebook.relativePath}${marker}`
    })
    .join('\n')

  return [
    '<phi_notebook_runtime>',
    'This Phi project can operate .ipynb notebooks through the built-in notebook.* tools.',
    'When the user asks to read, edit, save, or run a notebook, use notebook.list/read/insert_cell/update_cell/delete_cell/run_cell/save instead of shell-editing the .ipynb JSON by default.',
    'Notebook execution must use the Phi app-managed Jupyter Server registered for this project. Do not assume, probe, or instruct the user to restart JupyterLab on localhost:8888.',
    `Project: ${project.name ?? project.workingDirectory}`,
    `Project cwd: ${project.workingDirectory}`,
    activeNotebookPath
      ? `Active notebook: ${relative(project.workingDirectory, activeNotebookPath).split(sep).join('/')}`
      : 'Active notebook: none selected',
    `Jupyter server: ${status.state}${status.hasEndpoint ? `, app-managed port ${status.port ?? 'unknown'}` : ', no endpoint yet; notebook.run_cell may start or attach it'}`,
    registry.notebooks.length > 0
      ? `Project notebooks:\n${notebooks}`
      : 'Project notebooks: none found',
    registry.truncated
      ? 'Project notebooks list is truncated; call notebook.list for the full tool view.'
      : '',
    'If notebook.run_cell returns an error, report that tool error directly and do not invent an external JupyterLab port workaround.',
    '</phi_notebook_runtime>'
  ]
    .filter(Boolean)
    .join('\n')
}

function broadcastSessionTimelineEvent(sessionId: string, event: StoredSessionEvent): void {
  const run = [...activePromptRuns.values()].find((item) => item.phiSessionId === sessionId)
  if (!run) return

  const targetWindow = getActiveWindow()
  sendToWindow(targetWindow, 'agent:event', {
    source: 'phi',
    ...event,
    phiSessionId: run.phiSessionId,
    sessionGeneration: run.sessionGeneration,
    sessionPath: run.sessionPath ?? run.session?.sessionFile ?? null,
    cwd: run.cwd
  })
}

function logUnexpectedError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  writeAppLog({
    level: 'error',
    event: 'error_summary',
    metadata: { message }
  })
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as { role?: string; content?: unknown }
  if (record.role !== 'assistant') return ''

  return extractMessageText(record.content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactStructuredValue(value: unknown, key = ''): unknown {
  if (key && isSecretMetadataKey(key)) return '[redacted]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactStructuredValue(entryValue, entryKey)
    ])
  )
}

function assistantMessagesFrom(value: unknown): unknown[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => assistantMessagesFrom(item))
  }
  if (!isRecord(value)) return []
  const messages = Array.isArray(value.messages) ? assistantMessagesFrom(value.messages) : []
  const message = isRecord(value.message) ? assistantMessagesFrom(value.message) : []
  const self = value.role === 'assistant' ? [value] : []
  return [...messages, ...message, ...self]
}

function lastAssistantMessageFrom(value: unknown): unknown {
  return assistantMessagesFrom(value).at(-1)
}

function assistantErrorText(message: unknown, options: { allowContent?: boolean } = {}): string {
  if (!isRecord(message)) return ''
  if (typeof message.errorMessage === 'string') return message.errorMessage
  if (typeof message.message === 'string') return message.message
  if (message.role !== 'assistant') return ''
  if (message.stopReason === 'error' || options.allowContent) return extractAssistantText(message)
  return ''
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (!content || typeof content !== 'object') return ''
    const record = content as Record<string, unknown>
    if (
      (record.type === 'text' || record.type === 'output_text' || record.type === 'input_text') &&
      typeof record.text === 'string'
    ) {
      return record.text
    }
    if (record.type === undefined && typeof record.text === 'string') return record.text
    if (record.type === undefined && typeof record.output_text === 'string') {
      return record.output_text
    }
    if (typeof record.content === 'string') return record.content
    return (
      extractMessageText(record.content) ||
      extractMessageText(record.delta) ||
      extractMessageText(record.data) ||
      extractMessageText(record.value) ||
      extractMessageText(record.result) ||
      extractMessageText(record.output) ||
      extractMessageText(record.outputs) ||
      extractMessageText(record.message)
    )
  }

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; text?: unknown; content?: unknown }
      if (
        (item.type === 'text' || item.type === 'output_text' || item.type === 'input_text') &&
        typeof item.text === 'string'
      ) {
        return item.text
      }
      if (typeof item.text === 'string' && item.type === undefined) return item.text
      return extractMessageText(item.content)
    })
    .join('')
}

function assistantTextFromEventSummary(summary: PhiAgentEventSummary, currentText: string): string {
  const message = isPhiEventType(summary, 'message_end') ? summary.message : undefined
  const assistantMessageEvent = isPhiMessageUpdateSummary(summary)
    ? summary.assistantMessageEvent
    : undefined

  if (
    summary.type === 'message_update' &&
    assistantMessageEvent?.type === 'text_delta' &&
    typeof assistantMessageEvent.delta === 'string'
  ) {
    return `${currentText}${assistantMessageEvent.delta}`
  }
  if (summary.type === 'message_update' && typeof assistantMessageEvent?.type === 'string') {
    const deltaText = extractMessageText(assistantMessageEvent.delta)
    if (deltaText && assistantMessageEvent.type.endsWith('_delta')) {
      return `${currentText}${deltaText}`
    }
  }

  if (summary.type === 'message_update' && assistantMessageEvent?.type === 'done') {
    const text = extractAssistantText(assistantMessageEvent.message).trim()
    return text || currentText
  }

  if (summary.type === 'message_update' && assistantMessageEvent?.partial) {
    const text = extractAssistantText(assistantMessageEvent.partial).trim()
    if (text) return text
  }
  if (summary.type === 'message_update' && assistantMessageEvent) {
    const text = extractMessageText(assistantMessageEvent).trim()
    if (text) return text
  }

  if (summary.type === 'message_end' && message?.role === 'assistant') {
    const text = extractAssistantText(message).trim()
    return text || currentText
  }

  const batchedText = extractAssistantText(lastAssistantMessageFrom(summary.messages)).trim()
  if (batchedText) return batchedText

  const resultText = extractAssistantText(lastAssistantMessageFrom(summary.result)).trim()
  if (resultText) return resultText

  return currentText
}

function assistantErrorMessageFromEventSummary(summary: PhiAgentEventSummary): string | null {
  const assistantMessageEvent = isPhiMessageUpdateSummary(summary)
    ? summary.assistantMessageEvent
    : undefined
  if (summary.type === 'message_update' && assistantMessageEvent?.type === 'error') {
    const error = assistantMessageEvent.error
    const message = assistantErrorText(error, { allowContent: true })
    return message ? redactSensitiveText(message) : '请求失败'
  }

  const message = isPhiEventType(summary, 'message_end') ? summary.message : undefined
  if (
    summary.type === 'message_end' &&
    message?.role === 'assistant' &&
    message.stopReason === 'error'
  ) {
    return typeof message.errorMessage === 'string'
      ? redactSensitiveText(message.errorMessage)
      : '请求失败'
  }

  const batchedMessage = lastAssistantMessageFrom(summary.messages)
  const batchedError = assistantErrorText(batchedMessage)
  if (batchedError) return redactSensitiveText(batchedError)

  const resultMessage = lastAssistantMessageFrom(summary.result)
  const resultError = assistantErrorText(resultMessage)
  if (resultError) return redactSensitiveText(resultError)

  return null
}

function isPermanentProviderRegionError(message: unknown): message is string {
  return (
    typeof message === 'string' && /(?:not supported|not available) in your region/i.test(message)
  )
}

function extractAssistantThinkingBlocks(message: unknown): string[] {
  if (!message || typeof message !== 'object') return []
  const record = message as { role?: string; content?: unknown }
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return []

  return record.content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; thinking?: unknown; text?: unknown }
      if (item.type !== 'thinking') return ''
      if (typeof item.thinking === 'string') return item.thinking
      return typeof item.text === 'string' ? item.text : ''
    })
    .filter((text) => text.length > 0)
}

function summaryTimestampMs(summary: Record<string, unknown>): number {
  if (typeof summary.createdAt === 'string') {
    const timestamp = Date.parse(summary.createdAt)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return Date.now()
}

/**
 * The SDK's session events carry no timestamp. Without one the chat cannot tell when a tool call or
 * a delegated agent started, so a card would time itself at 0 seconds however long it ran. The
 * conversation's store stamps its own copy when it writes, but the live event sent to the window is
 * the one before that, so it gets its time here. An event that already has one keeps it.
 */
function withEventTimestamp(summary: PhiAgentEvent): PhiAgentEvent {
  return Object.keys(createdAtFromSummary(summary)).length > 0
    ? summary
    : { ...summary, createdAt: new Date().toISOString() }
}

function createdAtFromSummary(
  summary: Record<string, unknown>
): { createdAt: string } | Record<string, never> {
  if (typeof summary.createdAt !== 'string') return {}
  return Number.isFinite(Date.parse(summary.createdAt)) ? { createdAt: summary.createdAt } : {}
}

function textFromToolContentParts(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

function extractToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textFromToolContentParts(value)
  if (value && typeof value === 'object') {
    const record = value as { content?: unknown; output?: unknown; text?: unknown }
    if (Array.isArray(record.content)) {
      const text = textFromToolContentParts(record.content)
      if (text) return text
    }
    if (typeof record.output === 'string') return record.output
    if (typeof record.text === 'string') return record.text
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return value == null ? '' : String(value)
}

function isAgentToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(toolName)
}

function detailsKind(value: unknown): string | undefined {
  const details = detailsFromToolResult(value)
  if (!isRecord(details)) return undefined
  return typeof details.kind === 'string' ? details.kind : undefined
}

function agentNameFromDetails(value: unknown): string | undefined {
  const details = detailsFromToolResult(value)
  if (!isRecord(details)) return undefined
  return typeof details.agent === 'string' && details.agent ? details.agent : undefined
}

function agentTaskFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const task = args.task
  return typeof task === 'string' && task.trim() ? task.trim() : undefined
}

function isAgentDelegationStart(summary: Record<string, unknown>): boolean {
  return (
    summary.type === 'tool_execution_start' &&
    typeof summary.toolCallId === 'string' &&
    isAgentToolName(summary.toolName) &&
    agentTaskFromArgs(summary.args) !== undefined
  )
}

function isAgentDelegationUpdate(run: PromptRun, summary: Record<string, unknown>): boolean {
  if (summary.type !== 'tool_execution_update' || typeof summary.toolCallId !== 'string') {
    return false
  }
  const kind = detailsKind(summary.partialResult)
  return (
    run.agentToolCallIds.has(summary.toolCallId) ||
    kind === 'agent_step' ||
    kind === 'agent_progress'
  )
}

function isAgentDelegationEnd(run: PromptRun, summary: Record<string, unknown>): boolean {
  if (summary.type !== 'tool_execution_end' || typeof summary.toolCallId !== 'string') {
    return false
  }
  return (
    detailsKind(summary.result) === 'agent_result' || run.agentToolCallIds.has(summary.toolCallId)
  )
}

/**
 * Which agent run, in which agent session, a delegation card is showing, so the card can steer
 * or stop it. The run id comes from the delegation tool; the session is the one that owns it.
 */
function agentRunRefFrom(
  run: PromptRun,
  toolResult: unknown
): { agentRunId?: string; agentSessionId?: string } {
  const details = detailsFromToolResult(toolResult)
  const agentRunId =
    isRecord(details) && typeof details.agentRunId === 'string' && details.agentRunId
      ? details.agentRunId
      : isRecord(details) && details.kind === 'agent_started' && typeof details.runId === 'string'
        ? details.runId
        : undefined
  const agentSessionId = run.session?.runtimeSessionId
  return {
    ...(agentRunId ? { agentRunId } : {}),
    ...(agentRunId && typeof agentSessionId === 'string' ? { agentSessionId } : {})
  }
}

function agentStepRecordFrom(value: unknown): Record<string, unknown> | null {
  const details = detailsFromToolResult(value)
  if (!isRecord(details) || details.kind !== 'agent_step' || !isRecord(details.step)) return null
  return details.step
}

function agentToolStepId(step: Record<string, unknown>, parentToolCallId: string): string {
  const value = step.id
  return typeof value === 'string' && value ? value : `${parentToolCallId}:step`
}

function persistAgentStepOutput(
  run: PromptRun,
  parentToolCallId: string,
  stepId: string,
  output: string
): ReturnType<typeof persistToolOutput> | null {
  if (!output) return null
  return persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId: `${parentToolCallId}-${stepId}`,
    output,
    inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
  })
}

function agentStepEventFromSummary(
  run: PromptRun,
  summary: Record<string, unknown>
): SessionEventInput | null {
  if (typeof summary.toolCallId !== 'string') return null
  const parentToolCallId = summary.toolCallId
  const step = agentStepRecordFrom(summary.partialResult)
  if (!step) return null
  const stepId = agentToolStepId(step, parentToolCallId)
  const output = typeof step.output === 'string' ? step.output : ''
  const persisted = persistAgentStepOutput(run, parentToolCallId, stepId, output)
  const status =
    step.status === 'done' || step.status === 'error' || step.status === 'running'
      ? step.status
      : 'running'
  const completedAt = typeof step.completedAt === 'string' ? step.completedAt : undefined
  const createdAt = typeof step.createdAt === 'string' ? step.createdAt : undefined
  const error =
    typeof step.error === 'string' && step.error
      ? redactSensitiveText(step.error)
      : status === 'error' && output
        ? redactSensitiveText(output)
        : undefined

  return {
    type: 'agent_execution_step',
    runId: run.runId,
    toolCallId: parentToolCallId,
    agentName:
      agentNameFromDetails(summary.partialResult) ??
      (isAgentToolName(summary.toolName) ? summary.toolName : undefined),
    ...agentRunRefFrom(run, summary.partialResult),
    step: {
      id: stepId,
      toolName: typeof step.toolName === 'string' && step.toolName ? step.toolName : 'tool',
      status,
      ...(step.args !== undefined ? { args: redactStructuredValue(step.args) } : {}),
      ...(persisted ? { output: persisted.outputPreview } : {}),
      ...(persisted?.outputPath ? { outputPath: persisted.outputPath } : {}),
      ...(persisted ? { outputBytes: persisted.outputBytes } : {}),
      ...(persisted?.truncated ? { outputTruncated: true } : {}),
      ...(persisted?.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {}),
      ...(error ? { error } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(completedAt ? { completedAt } : {})
    },
    ...createdAtFromSummary(summary)
  }
}

function agentResultDetails(value: unknown): Record<string, unknown> | null {
  const details = detailsFromToolResult(value)
  return isRecord(details) && details.kind === 'agent_result' ? details : null
}

function isNotebookToolName(toolName: unknown): boolean {
  return typeof toolName === 'string' && toolName.startsWith('notebook.')
}

function detailsFromToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  return (result as { details?: unknown }).details
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

function numberOrNullField(
  record: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = numberOrNullField(record, key)
  return typeof value === 'number' ? value : undefined
}

function notebookCellNumberFrom(
  record: Record<string, unknown>,
  cell: Record<string, unknown> | null
): number | undefined {
  const explicit =
    numberField(record, 'cellNumber') ??
    (cell ? (numberField(cell, 'cellNumber') ?? numberField(cell, 'number')) : undefined)
  if (explicit !== undefined && explicit >= 1) return Math.trunc(explicit)
  const legacyIndex = cell ? numberField(cell, 'index') : undefined
  return legacyIndex !== undefined && legacyIndex >= 0 ? Math.trunc(legacyIndex) + 1 : undefined
}

function notebookToolDetailsFromResult(result: unknown): Record<string, unknown> | undefined {
  const details = detailsFromToolResult(result)
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  const kind = stringField(record, 'kind')
  if (!kind || !kind.startsWith('notebook_')) return undefined

  const cell =
    record.cell && typeof record.cell === 'object' ? (record.cell as Record<string, unknown>) : null
  const execution =
    record.execution && typeof record.execution === 'object'
      ? (record.execution as Record<string, unknown>)
      : null
  const cellNumber = notebookCellNumberFrom(record, cell)

  return {
    kind,
    ...(stringField(record, 'path') ? { path: stringField(record, 'path') } : {}),
    ...(stringField(record, 'relativePath')
      ? { relativePath: stringField(record, 'relativePath') }
      : {}),
    ...((stringField(record, 'cellId') ?? (cell ? stringField(cell, 'id') : undefined))
      ? { cellId: stringField(record, 'cellId') ?? (cell ? stringField(cell, 'id') : undefined) }
      : {}),
    ...(cellNumber !== undefined ? { cellNumber } : {}),
    ...((stringField(record, 'cellType') ??
    (cell ? (stringField(cell, 'cellType') ?? stringField(cell, 'cell_type')) : undefined))
      ? {
          cellType:
            stringField(record, 'cellType') ??
            (cell ? (stringField(cell, 'cellType') ?? stringField(cell, 'cell_type')) : undefined)
        }
      : {}),
    ...(execution && stringField(execution, 'state')
      ? { executionState: stringField(execution, 'state') }
      : {}),
    ...(execution && numberOrNullField(execution, 'executionCount') !== undefined
      ? { executionCount: numberOrNullField(execution, 'executionCount') }
      : {}),
    ...(stringField(record, 'summary') ? { summary: stringField(record, 'summary') } : {})
  }
}

function persistCompletedThinkingBlocks(run: PromptRun, summary: Record<string, unknown>): void {
  const thinkingBlocks =
    run.thinkingBlocks.size > 0
      ? [...run.thinkingBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([contentIndex, content]) => ({ contentIndex, content }))
      : extractAssistantThinkingBlocks(summary.message).map((content, contentIndex) => ({
          contentIndex,
          content
        }))
  const thinkingEndedAtMs = summaryTimestampMs(summary)
  run.thinkingBlocks.clear()
  for (const { contentIndex, content } of thinkingBlocks) {
    if (!content) continue
    const startedAtMs = run.thinkingBlockStartedAtMs.get(contentIndex)
    appendSessionEvent(run.phiSessionId, {
      type: 'assistant_thinking_completed',
      runId: run.runId,
      content,
      ...createdAtFromSummary(summary),
      ...(startedAtMs !== undefined
        ? { durationMs: Math.max(0, thinkingEndedAtMs - startedAtMs) }
        : {})
    })
  }
  run.thinkingBlockStartedAtMs.clear()
}

function persistAssistantContentInOrder(run: PromptRun, summary: Record<string, unknown>): void {
  const message = summary.message as { content?: unknown }
  const contentParts = Array.isArray(message.content) ? message.content : []
  const orderedParts = contentParts.map((part, contentIndex) => ({
    part,
    contentIndex,
    orphan: false
  }))
  for (const [contentIndex, content] of run.thinkingBlocks) {
    if (isRecord(contentParts[contentIndex]) && contentParts[contentIndex].type === 'thinking') {
      continue
    }
    orderedParts.push({ part: { type: 'thinking', thinking: content }, contentIndex, orphan: true })
  }
  orderedParts.sort(
    (left, right) =>
      left.contentIndex - right.contentIndex || Number(right.orphan) - Number(left.orphan)
  )
  const endedAtMs = summaryTimestampMs(summary)
  let storedText = false
  for (const { part, contentIndex } of orderedParts) {
    if (!isRecord(part)) continue
    if (part.type === 'thinking') {
      const content = run.thinkingBlocks.get(contentIndex) ?? part.thinking
      if (typeof content !== 'string' || !content) continue
      const startedAtMs = run.thinkingBlockStartedAtMs.get(contentIndex)
      appendSessionEvent(run.phiSessionId, {
        type: 'assistant_thinking_completed',
        runId: run.runId,
        content,
        ...createdAtFromSummary(summary),
        ...(startedAtMs !== undefined ? { durationMs: Math.max(0, endedAtMs - startedAtMs) } : {})
      })
      continue
    }
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      storedText = true
      appendSessionEvent(run.phiSessionId, {
        type: 'assistant_message_finalized',
        runId: run.runId,
        content: part.text,
        ...createdAtFromSummary(summary)
      })
      continue
    }
    if (part.type !== 'toolCall' || typeof part.id !== 'string') continue
    const toolName = typeof part.name === 'string' ? part.name : 'tool'
    const persistedArgs = toolArgsForPersistence(toolName, part.arguments)
    run.pendingProviderToolCalls.set(part.id, {
      toolName,
      args: persistedArgs,
      ...createdAtFromSummary(summary)
    })
    if (run.persistedToolCallIds.has(part.id)) continue
    run.persistedToolCallIds.add(part.id)
    appendSessionEvent(run.phiSessionId, {
      type: 'tool_call_started',
      runId: run.runId,
      toolCallId: part.id,
      toolName,
      args: persistedArgs,
      ...createdAtFromSummary(summary)
    })
  }
  if (!storedText) {
    const content = extractAssistantText(summary.message)
    if (content) {
      appendSessionEvent(run.phiSessionId, {
        type: 'assistant_message_finalized',
        runId: run.runId,
        content,
        ...createdAtFromSummary(summary)
      })
    }
  }
  run.thinkingBlocks.clear()
  run.thinkingBlockStartedAtMs.clear()
}

function toolArgsForPersistence(toolName: unknown, args: unknown): unknown {
  if (toolName !== 'browser') return args
  if (!isRecord(args)) return {}
  const sanitized: Record<string, unknown> = {}
  if (
    args.action === 'open' ||
    args.action === 'snapshot' ||
    args.action === 'click' ||
    args.action === 'typeText' ||
    args.action === 'scroll' ||
    args.action === 'keypress'
  ) {
    sanitized.action = args.action
  }
  if (args.target === 'current' || args.target === 'dedicated') sanitized.target = args.target
  if (
    typeof args.tabId === 'string' &&
    args.tabId.length > 0 &&
    Buffer.byteLength(args.tabId, 'utf8') <= 256
  ) {
    sanitized.tabId = args.tabId
  }
  const expectedDocumentRevision = args.expectedDocumentRevision
  if (
    typeof expectedDocumentRevision === 'number' &&
    Number.isSafeInteger(expectedDocumentRevision) &&
    expectedDocumentRevision >= 0
  ) {
    sanitized.expectedDocumentRevision = expectedDocumentRevision
  }
  return sanitized
}

function browserToolResultForEvent(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return { content: [] }
  return {
    content: result.content.flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ? [{ type: 'text', text: part.text }]
        : []
    )
  }
}

function browserSafeAssistantMessage(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((part) =>
      isRecord(part) && part.type === 'toolCall' && part.name === 'browser'
        ? { ...part, arguments: toolArgsForPersistence('browser', part.arguments) }
        : part
    )
  }
}

function browserSafeToolResultMessage(message: unknown): unknown {
  if (!isRecord(message)) return { role: 'toolResult', content: [] }
  const result = browserToolResultForEvent(message)
  return {
    role: 'toolResult',
    ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(isRecord(result) && Array.isArray(result.content) ? { content: result.content } : {}),
    ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {})
  }
}

function persistSdkCompactionNotice(
  phiSessionId: string,
  runId: string | undefined,
  summary: Record<string, unknown>
): Record<string, unknown> | null {
  if (
    summary.type !== 'notice' ||
    summary.source !== 'compaction' ||
    typeof summary.message !== 'string'
  ) {
    return null
  }
  const stored = appendSessionEvent(phiSessionId, {
    type: 'context_maintenance_notice',
    ...(runId ? { runId } : {}),
    ...createdAtFromSummary(summary),
    noticeLevel: summary.level === 'error' ? 'error' : 'info',
    noticeText: summary.message.slice(0, 1000)
  })
  return { source: 'phi', ...stored }
}

function persistSdkShakeEvent(
  phiSessionId: string,
  runId: string | undefined,
  summary: Record<string, unknown>,
  reason?: string
): Record<string, unknown> | null {
  if (summary.type !== 'auto_compaction_end' || summary.action !== 'shake' || summary.skipped) {
    return null
  }
  const stored = appendSessionEvent(phiSessionId, {
    type: summary.aborted || summary.errorMessage ? 'context_maintenance_notice' : 'context_shaken',
    ...(runId ? { runId } : {}),
    action: 'shake',
    ...createdAtFromSummary(summary),
    ...(reason ? { reason } : {}),
    ...(summary.aborted || summary.errorMessage
      ? {
          noticeLevel: summary.aborted ? 'info' : 'warning',
          noticeText:
            typeof summary.errorMessage === 'string'
              ? summary.errorMessage.slice(0, 1000)
              : '自动精简已取消'
        }
      : {}),
    ...(typeof summary.tokensAfter === 'number' &&
    Number.isFinite(summary.tokensAfter) &&
    summary.tokensAfter >= 0
      ? { tokensAfter: summary.tokensAfter }
      : {})
  })
  return { source: 'phi', ...stored }
}

function isCursorStreamEndError(message: string | undefined): boolean {
  return (
    message === 'Cursor stream ended before turnEnded' ||
    message ===
      'stream closed before a terminal response event: Cursor stream ended before turnEnded'
  )
}

function persistSessionEvent(run: PromptRun, summary: PhiAgentEvent): Record<string, unknown> {
  const withRunId = (event: Record<string, unknown>): Record<string, unknown> =>
    typeof event.runId === 'string' ? event : { ...event, runId: run.runId }

  const notice = persistSdkCompactionNotice(run.phiSessionId, run.runId, summary)
  if (notice) return notice

  if (
    isPhiEventType(summary, 'auto_retry_end') &&
    summary.success &&
    !run.stoppingPermanentProviderError
  ) {
    delete run.recordedFailureMessage
  }

  if (summary.type === 'auto_compaction_start' && typeof summary.action === 'string') {
    if (typeof summary.reason === 'string') {
      run.compactionReasons.set(summary.action, summary.reason)
    }
    return withRunId(summary)
  }

  if (isPhiEventType(summary, 'auto_compaction_end')) {
    const reason = run.compactionReasons.get(summary.action)
    run.compactionReasons.delete(summary.action)
    if (summary.action === 'shake') {
      return (
        persistSdkShakeEvent(run.phiSessionId, run.runId, summary, reason) ?? withRunId(summary)
      )
    }
    if (summary.skipped) return withRunId(summary)
    if (summary.aborted || summary.errorMessage) {
      const stored = appendSessionEvent(run.phiSessionId, {
        type: 'context_compaction_failed',
        runId: run.runId,
        action: summary.action,
        ...createdAtFromSummary(summary),
        ...(reason ? { reason } : {}),
        errorMessage: typeof summary.errorMessage === 'string' ? summary.errorMessage : '已取消'
      })
      return { source: 'phi', ...stored }
    }
    const result = summary.result
    const stored = appendSessionEvent(run.phiSessionId, {
      type: 'context_compacted',
      runId: run.runId,
      action: summary.action,
      ...createdAtFromSummary(summary),
      ...(reason ? { reason } : {}),
      ...(typeof result?.shortSummary === 'string' ? { shortSummary: result.shortSummary } : {}),
      ...(typeof result?.summary === 'string' ? { summary: result.summary } : {}),
      ...(typeof result?.tokensBefore === 'number' ? { tokensBefore: result.tokensBefore } : {}),
      ...(typeof summary.tokensAfter === 'number' &&
      Number.isFinite(summary.tokensAfter) &&
      summary.tokensAfter >= 0
        ? { tokensAfter: summary.tokensAfter }
        : {})
    })
    return { source: 'phi', ...stored }
  }

  if (isPhiEventType(summary, 'message_start') && summary.message.role === 'assistant') {
    run.thinkingBlocks.clear()
    run.thinkingBlockStartedAtMs.clear()
    return withRunId(summary)
  }

  if (isPhiEventType(summary, 'message_update') && summary.message.role === 'assistant') {
    const assistantMessageEvent = summary.assistantMessageEvent
    if (
      assistantMessageEvent?.type === 'thinking_delta' &&
      typeof assistantMessageEvent.delta === 'string'
    ) {
      const contentIndex =
        typeof assistantMessageEvent.contentIndex === 'number'
          ? assistantMessageEvent.contentIndex
          : 0
      if (!run.thinkingBlockStartedAtMs.has(contentIndex)) {
        run.thinkingBlockStartedAtMs.set(contentIndex, summaryTimestampMs(summary))
      }
      run.thinkingBlocks.set(
        contentIndex,
        `${run.thinkingBlocks.get(contentIndex) ?? ''}${assistantMessageEvent.delta}`
      )
    }
    return withRunId(summary)
  }

  if (isPhiEventType(summary, 'message_end') && summary.message.role === 'assistant') {
    const assistantMessage = summary.message
    if (assistantMessage?.stopReason === 'error') {
      const errorMessage =
        typeof assistantMessage.errorMessage === 'string'
          ? redactSensitiveText(assistantMessage.errorMessage)
          : '请求失败'
      persistCompletedThinkingBlocks(run, summary)
      const cursorStreamFailure =
        assistantMessage.api === 'cursor-agent' && isCursorStreamEndError(errorMessage)
      if (
        !run.stoppingPermanentProviderError &&
        (!cursorStreamFailure ||
          !run.recordedFailureMessage ||
          isCursorStreamEndError(run.recordedFailureMessage))
      ) {
        run.recordedFailureMessage = errorMessage
      }
      return withRunId(summary)
    }

    persistAssistantContentInOrder(run, summary)
    if (
      !run.stoppingPermanentProviderError &&
      assistantMessage.api === 'cursor-agent' &&
      assistantMessage.stopReason === 'stop' &&
      isCursorStreamEndError(run.recordedFailureMessage)
    ) {
      delete run.recordedFailureMessage
    }
    return withRunId({ ...summary, message: browserSafeAssistantMessage(summary.message) })
  }

  if (isPhiEventType(summary, 'message_end') && summary.message.role === 'toolResult') {
    const result = summary.message
    const toolCallId = result.toolCallId
    if (typeof toolCallId !== 'string') return withRunId(summary)
    const pending = run.pendingProviderToolCalls.get(toolCallId)
    run.pendingProviderToolCalls.delete(toolCallId)
    const browserSdkToolResult = run.browserSdkToolCallIds.delete(toolCallId)
    if (!pending || run.sdkToolCallIds.has(toolCallId)) {
      return withRunId(
        browserSdkToolResult
          ? { ...summary, message: browserSafeToolResultMessage(summary.message) }
          : summary
      )
    }

    if (!run.persistedToolCallIds.has(toolCallId)) {
      run.persistedToolCallIds.add(toolCallId)
      appendSessionEvent(run.phiSessionId, {
        type: 'tool_call_started',
        runId: run.runId,
        toolCallId,
        toolName: pending.toolName,
        args: pending.args,
        ...(pending.createdAt ? { createdAt: pending.createdAt } : createdAtFromSummary(summary))
      })
    }
    const persisted = persistToolOutput(run.phiSessionId, {
      runId: run.runId,
      toolCallId,
      output: extractToolText(result.content),
      inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
    })
    const completed = appendSessionEvent(run.phiSessionId, {
      type: 'tool_call_completed',
      runId: run.runId,
      toolCallId,
      toolName: pending.toolName,
      isError: result.isError === true,
      ...createdAtFromSummary(summary),
      output: persisted.outputPreview,
      outputBytes: persisted.outputBytes,
      outputTruncated: persisted.truncated,
      ...(persisted.outputPath ? { outputPath: persisted.outputPath } : {}),
      ...(persisted.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
    })
    return { ...completed, type: 'provider_tool_call_completed', args: pending.args, source: 'phi' }
  }

  if (summary.type === 'tool_execution_start' && typeof summary.toolCallId === 'string') {
    run.sdkToolCallIds.add(summary.toolCallId)
    if (summary.toolName === 'browser') run.browserSdkToolCallIds.add(summary.toolCallId)
    if (isAgentDelegationStart(summary)) {
      run.agentToolCallIds.add(summary.toolCallId)
      const task = agentTaskFromArgs(summary.args) ?? ''
      const redactedArgs = redactStructuredValue(summary.args)
      const event = {
        type: 'agent_execution_started',
        runId: run.runId,
        toolCallId: summary.toolCallId,
        agentName: typeof summary.toolName === 'string' ? summary.toolName : 'Agent',
        task: redactSensitiveText(task),
        args: redactedArgs,
        ...createdAtFromSummary(summary)
      }
      appendSessionEvent(run.phiSessionId, event)
      return event
    }

    const persistedArgs = toolArgsForPersistence(summary.toolName, summary.args)
    if (!run.persistedToolCallIds.has(summary.toolCallId)) {
      run.persistedToolCallIds.add(summary.toolCallId)
      appendSessionEvent(run.phiSessionId, {
        type: 'tool_call_started',
        runId: run.runId,
        toolCallId: summary.toolCallId,
        toolName: summary.toolName,
        args: persistedArgs,
        ...createdAtFromSummary(summary)
      })
    }
    return withRunId(summary.toolName === 'browser' ? { ...summary, args: persistedArgs } : summary)
  }

  if (isAgentDelegationUpdate(run, summary)) {
    const event = agentStepEventFromSummary(run, summary)
    if (event) {
      appendSessionEvent(run.phiSessionId, event)
      return event
    }
    return withRunId(summary)
  }

  if (summary.type !== 'tool_execution_end' || typeof summary.toolCallId !== 'string') {
    return withRunId(summary)
  }

  run.sdkToolCallIds.add(summary.toolCallId)

  if (isAgentDelegationEnd(run, summary) && detailsKind(summary.result) === 'agent_started') {
    // The agent carries on after this tool call returns. Its card stays running; its steps
    // and its end reach the card later, from the agent worker (see agent/agents/run-host.ts).
    run.agentToolCallIds.delete(summary.toolCallId)
    const event = {
      type: 'agent_execution_background',
      runId: run.runId,
      toolCallId: summary.toolCallId,
      agentName:
        agentNameFromDetails(summary.result) ??
        (isAgentToolName(summary.toolName) ? summary.toolName : 'Agent'),
      ...agentRunRefFrom(run, summary.result),
      ...createdAtFromSummary(summary)
    }
    appendSessionEvent(run.phiSessionId, event)
    return event
  }

  if (isAgentDelegationEnd(run, summary)) {
    const output = extractToolText(summary.result)
    const persisted = persistToolOutput(run.phiSessionId, {
      runId: run.runId,
      toolCallId: summary.toolCallId,
      output,
      inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
    })
    const details = agentResultDetails(summary.result)
    const agentName =
      (typeof details?.agent === 'string' && details.agent) ||
      (isAgentToolName(summary.toolName) ? summary.toolName : 'Agent')
    const event = {
      type: 'agent_execution_completed',
      runId: run.runId,
      toolCallId: summary.toolCallId,
      agentName,
      isError: summary.isError,
      ...createdAtFromSummary(summary),
      finalReport: persisted.outputPreview,
      finalReportBytes: persisted.outputBytes,
      finalReportTruncated: persisted.truncated,
      ...(persisted.outputPath ? { finalReportPath: persisted.outputPath } : {}),
      ...(persisted.outputArtifact ? { finalReportArtifact: persisted.outputArtifact } : {}),
      ...(typeof details?.toolCalls === 'number' ? { toolCalls: details.toolCalls } : {}),
      ...(summary.isError && output ? { error: redactSensitiveText(output) } : {})
    }
    run.agentToolCallIds.delete(summary.toolCallId)
    appendSessionEvent(run.phiSessionId, event)
    if (!persisted.truncated) return event
    return {
      ...event,
      result: {
        output: persisted.outputPreview,
        outputPath: persisted.outputPath,
        outputBytes: persisted.outputBytes,
        truncated: true,
        outputArtifact: persisted.outputArtifact
      }
    }
  }

  const output = extractToolText(summary.result)
  const notebookDetails = isNotebookToolName(summary.toolName)
    ? notebookToolDetailsFromResult(summary.result)
    : undefined
  const sessionDetails =
    toolResultDetailsForSession(summary.toolName, summary.result) ?? notebookDetails
  const persisted = persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId: summary.toolCallId,
    output,
    inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
  })
  appendSessionEvent(run.phiSessionId, {
    type: 'tool_call_completed',
    runId: run.runId,
    toolCallId: summary.toolCallId,
    toolName: summary.toolName,
    isError: summary.isError,
    ...createdAtFromSummary(summary),
    output: persisted.outputPreview,
    outputBytes: persisted.outputBytes,
    outputTruncated: persisted.truncated,
    ...(sessionDetails ? { details: sessionDetails } : {}),
    ...(persisted.outputPath ? { outputPath: persisted.outputPath } : {}),
    ...(persisted.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
  })

  if (!persisted.truncated) {
    return withRunId(
      summary.toolName === 'browser'
        ? { ...summary, result: browserToolResultForEvent(summary.result) }
        : summary
    )
  }
  return withRunId({
    ...summary,
    result: {
      output: persisted.outputPreview,
      outputPath: persisted.outputPath,
      outputBytes: persisted.outputBytes,
      truncated: true,
      outputArtifact: persisted.outputArtifact
    }
  })
}

function readPhiTimelineMessages(
  runtimeSessionPath: string | null | undefined,
  cwd: string,
  phiSessionId?: string
): unknown[] {
  const manifestsById = new Map<string, PhiSessionManifest>()
  if (runtimeSessionPath) {
    for (const manifest of listPhiSessions()) {
      if (manifest.cwd === cwd && manifest.runtimeSessionPath === runtimeSessionPath) {
        manifestsById.set(manifest.sessionId, manifest)
      }
    }
  }
  if (phiSessionId) {
    const manifest = listPhiSessions().find((session) => session.sessionId === phiSessionId)
    if (manifest) {
      manifestsById.set(manifest.sessionId, manifest)
    }
  } else if (runtimeSessionPath && manifestsById.size === 0) {
    const manifest = findPhiSessionByRuntimePath(runtimeSessionPath, cwd)
    if (manifest) {
      manifestsById.set(manifest.sessionId, manifest)
    }
  }
  const manifests = [...manifestsById.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )
  if (manifests.length === 0) return []
  const events = manifests
    .flatMap((manifest) => readSessionEvents(manifest.sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const hasPhiText = events.some(
    (event) => event.type === 'user_message' || event.type === 'assistant_message_finalized'
  )
  return events.map((event) => ({
    ...event,
    ...(hasPhiText ? { preferPhiTimeline: true } : {}),
    source: 'phi'
  }))
}

function createSessionKey(
  path: string | undefined,
  cwd: string,
  freshId = freshSessionCounter
): string {
  return path ? `path:${path}` : `fresh:${cwd}:${freshId}`
}

function createPhiSessionKey(sessionId: string, cwd: string): string {
  return createSessionKey(phiOnlySessionPath(sessionId), cwd)
}

function resolveSessionKeyAlias(sessionKey: string): string {
  let current = sessionKey
  const seen = new Set<string>()
  while (true) {
    const next = sessionKeyAliases.get(current)
    if (!next || seen.has(current)) return current
    seen.add(current)
    current = next
  }
}

function aliasSessionKey(aliasKey: string, canonicalKey: string): void {
  const resolvedCanonicalKey = resolveSessionKeyAlias(canonicalKey)
  if (aliasKey === resolvedCanonicalKey) return

  sessionKeyAliases.set(aliasKey, resolvedCanonicalKey)
  const lifecycle = sessionLifecycles.get(resolvedCanonicalKey)
  if (lifecycle) {
    sessionLifecycles.set(aliasKey, lifecycle)
  }
}

function aliasMaterializedSessionPath(sessionKey: string, path: string, cwd: string): void {
  aliasSessionKey(createSessionKey(path, cwd), sessionKey)
}

function linkPhiManagedSessionKey(sessionKey: string, cwd: string, phiSessionId: string): string {
  const stablePath = phiOnlySessionPath(phiSessionId)
  const stableKey = createPhiSessionKey(phiSessionId, cwd)
  aliasSessionKey(stableKey, sessionKey)
  setPhiSessionIdForKey(sessionKey, phiSessionId)
  setPhiSessionIdForKey(stableKey, phiSessionId)
  if (sameCanonicalSessionKey(sessionKey, currentSessionKey)) {
    currentSessionPath = stablePath
    currentSessionKey = stableKey
  }
  return stablePath
}

function sameCanonicalSessionKey(left: string, right: string): boolean {
  return resolveSessionKeyAlias(left) === resolveSessionKeyAlias(right)
}

function getActivePromptRun(sessionKey: string): PromptRun | undefined {
  return activePromptRuns.get(resolveSessionKeyAlias(sessionKey))
}

function hasActivePromptRun(sessionKey: string): boolean {
  return activePromptRuns.has(resolveSessionKeyAlias(sessionKey))
}

function setActivePromptRun(sessionKey: string, run: PromptRun): void {
  activePromptRuns.set(resolveSessionKeyAlias(sessionKey), run)
}

function deleteActivePromptRun(sessionKey: string, run: PromptRun): void {
  cancelBrowserRun(run)
  void cleanupBrowserRunTabs(run)
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (activePromptRuns.get(canonicalKey) === run) {
    activePromptRuns.delete(canonicalKey)
  }
}

function getPhiSessionIdForKey(sessionKey: string): string | undefined {
  return phiSessionIdsByKey.get(resolveSessionKeyAlias(sessionKey))
}

function setPhiSessionIdForKey(sessionKey: string, sessionId: string): void {
  phiSessionIdsByKey.set(resolveSessionKeyAlias(sessionKey), sessionId)
}

function updatePhiRuntimeSessionPath(sessionId: string, path: string): void {
  const manifest = findPhiSessionById(sessionId)
  if (manifest?.runtimeSessionPath === path) return
  updateSessionManifest(sessionId, { runtimeSessionPath: path })
}

function linkMaterializedRuntimeSessionPath(
  sessionKey: string,
  cwd: string,
  sessionFile: string | undefined,
  phiSessionId?: string
): void {
  const path = runtimeSessionPath(sessionFile)
  if (!path) return

  const materializedKey = createSessionKey(path, cwd)
  aliasMaterializedSessionPath(sessionKey, path, cwd)
  if (phiSessionId) {
    setPhiSessionIdForKey(sessionKey, phiSessionId)
    setPhiSessionIdForKey(materializedKey, phiSessionId)
    updatePhiRuntimeSessionPath(phiSessionId, path)
  }
  if (phiSessionId) {
    linkPhiManagedSessionKey(sessionKey, cwd, phiSessionId)
    return
  }
  if (sameCanonicalSessionKey(sessionKey, currentSessionKey)) {
    currentSessionKey = materializedKey
  }
}

function linkPromptRunRuntimeSessionPath(
  sessionKey: string,
  cwd: string,
  promptRun: PromptRun,
  session: AgentSessionInstance
): void {
  const path = runtimeSessionPath(session.sessionFile)
  if (!path) return
  promptRun.sessionPath = phiOnlySessionPath(promptRun.phiSessionId)
  linkMaterializedRuntimeSessionPath(sessionKey, cwd, path, promptRun.phiSessionId)
}

function getCurrentLifecycle(): SessionLifecycle<AgentSessionResult> {
  return getLifecycleForKey(currentSessionKey)
}

function getLifecycleForKey(sessionKey: string): SessionLifecycle<AgentSessionResult> {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  let lifecycle = sessionLifecycles.get(canonicalKey)
  if (!lifecycle) {
    lifecycle = new SessionLifecycle<AgentSessionResult>()
    sessionLifecycles.set(canonicalKey, lifecycle)
  }
  if (canonicalKey !== sessionKey) {
    sessionLifecycles.set(sessionKey, lifecycle)
  }
  return lifecycle
}

function getPromptQueue(sessionKey: string): Promise<void> {
  return promptQueues.get(resolveSessionKeyAlias(sessionKey)) ?? Promise.resolve()
}

function setPromptQueue(sessionKey: string, queue: Promise<void>): void {
  promptQueues.set(resolveSessionKeyAlias(sessionKey), queue)
}

function getPromptGeneration(sessionKey: string): number {
  return promptGenerations.get(resolveSessionKeyAlias(sessionKey)) ?? 0
}

function advancePromptGeneration(sessionKey: string): number {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  const next = getPromptGeneration(canonicalKey) + 1
  promptGenerations.set(canonicalKey, next)
  return next
}

function getSessionControllerKey(snapshot: SessionSnapshot, generation: number): string {
  return `${snapshot.path ?? `fresh:${snapshot.cwd}`}:${generation}`
}

function findPhiManifestForSession(
  sessionKey: string,
  path: string | undefined,
  cwd: string
): PhiSessionManifest | null {
  const phiSessionId =
    getActivePromptRun(sessionKey)?.phiSessionId ?? getPhiSessionIdForKey(sessionKey)
  if (phiSessionId) {
    return listPhiSessions().find((manifest) => manifest.sessionId === phiSessionId) ?? null
  }
  if (!path) return null
  const phiOnlySessionId = phiSessionIdFromPath(path)
  return phiOnlySessionId
    ? findPhiSessionById(phiOnlySessionId)
    : findPhiSessionByRuntimePath(path, cwd)
}

function runtimeSessionPath(path: string | undefined): string | undefined {
  return isPhiOnlySessionPath(path) ? undefined : path
}

function runtimeSessionPathForSnapshot(
  sessionKey: string,
  snapshot: SessionSnapshot
): string | undefined {
  return (
    findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)?.runtimeSessionPath ??
    runtimeSessionPath(snapshot.path)
  )
}

function uiSessionPathForKey(sessionKey: string, fallbackPath: string | undefined): string | null {
  const phiSessionId = getPhiSessionIdForKey(sessionKey)
  return phiSessionId ? phiOnlySessionPath(phiSessionId) : (fallbackPath ?? null)
}

function parsePromptTarget(input: unknown): PromptTargetInput | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const path = record.path === null ? null : typeof record.path === 'string' ? record.path : null
  const phiSessionId = typeof record.phiSessionId === 'string' ? record.phiSessionId : undefined
  const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : currentCwd
  return {
    path,
    ...(phiSessionId ? { phiSessionId } : {}),
    cwd,
    ...(typeof record.sessionGeneration === 'number'
      ? { sessionGeneration: record.sessionGeneration }
      : {}),
    ...(record.suppressUserMessageEvent === true ? { suppressUserMessageEvent: true } : {}),
    ...(typeof record.retryUserMessageId === 'string'
      ? { retryUserMessageId: record.retryUserMessageId }
      : {}),
    ...(record.planMode === true ? { planMode: true } : {})
  }
}

// Waking a conversation when a background run it started has ended: a wrapper run, or a
// specialist agent run. The policy and the message are in job-continue.ts and run-continue.ts;
// this is the plumbing, shared by both so they count against one cap and can be reported in one
// message. State is per Phi conversation.
const automaticContinuations = new Map<string, number>()
const pendingContinuations = new Map<string, ContinuationEvent[]>()
// Agent runs whose report the main agent was already handed (agent_wait / agent_status), so no
// wake-up repeats it. Wrapper has the same in `wrapperJobs.hasBeenReported`.
const reportedAgentRuns = new Map<string, Set<string>>()

function markAgentRunReported(phiSessionId: string, agentRunId: string): void {
  reportedAgentRuns.set(
    phiSessionId,
    (reportedAgentRuns.get(phiSessionId) ?? new Set()).add(agentRunId)
  )
}

function clearAgentRunReported(phiSessionId: string, agentRunId: string): void {
  reportedAgentRuns.get(phiSessionId)?.delete(agentRunId)
}

function hasAgentRunBeenReported(phiSessionId: string, agentRunId: string): boolean {
  return reportedAgentRuns.get(phiSessionId)?.has(agentRunId) === true
}

function startAutomaticContinuation(
  phiSessionId: string,
  events: readonly ContinuationEvent[]
): void {
  const manifest = findPhiSessionById(phiSessionId)
  if (!manifest) return
  const sessionKey = createPhiSessionKey(manifest.sessionId, manifest.cwd)
  linkPhiManagedSessionKey(sessionKey, manifest.cwd, manifest.sessionId)
  sessionPermissionModes.set(resolveSessionKeyAlias(sessionKey), manifest.permissionMode)
  automaticContinuations.set(phiSessionId, (automaticContinuations.get(phiSessionId) ?? 0) + 1)

  void submitPromptRun({
    sessionKey,
    snapshot: {
      path: undefined,
      cwd: manifest.cwd,
      permissionMode: manifest.permissionMode
    },
    text: continuationPrompt(events),
    promptTarget: null,
    automatic: true
  }).catch((error: unknown) => {
    logUnexpectedError(error)
    writeAppLog({
      level: 'error',
      event: 'wrapper_run_continue_failed',
      metadata: {
        phiSessionId,
        error: error instanceof Error ? error.message : String(error)
      }
    })
  })
}

function continueConversationAfterWrapperRun(
  phiSessionId: string,
  event: WrapperRunFinishedEvent,
  run: WrapperRun
): void {
  const decision = shouldContinueConversation({
    run,
    state: event.state,
    automaticCount: automaticContinuations.get(phiSessionId) ?? 0
  })
  if (!decision.continue) {
    if (decision.reason === 'limit') {
      writeAppLog({
        event: 'wrapper_run_continue_limit',
        metadata: { phiSessionId, wrapperRunId: event.wrapperRunId }
      })
    }
    return
  }
  wakeConversation(phiSessionId, event)
}

function continueConversationAfterAgentRun(
  phiSessionId: string,
  event: AgentRunFinishedEvent
): void {
  const decision = shouldContinueAfterAgentRun({
    state: event.state,
    automaticCount: automaticContinuations.get(phiSessionId) ?? 0
  })
  if (!decision.continue) {
    if (decision.reason === 'limit') {
      writeAppLog({
        event: 'agent_run_continue_limit',
        metadata: { phiSessionId, agentRunId: event.agentRunId }
      })
    }
    return
  }
  wakeConversation(phiSessionId, event)
}

/** Wakes the conversation when its run or manual compaction has settled. */
function wakeConversation(phiSessionId: string, event: ContinuationEvent): void {
  const manifest = findPhiSessionById(phiSessionId)
  if (!manifest) return
  if (
    hasActivePromptRun(createPhiSessionKey(manifest.sessionId, manifest.cwd)) ||
    manualCompactionIds.has(phiSessionId)
  ) {
    // Keep the report for the next turn after the active run or compaction finishes.
    pendingContinuations.set(phiSessionId, [
      ...(pendingContinuations.get(phiSessionId) ?? []),
      event
    ])
    return
  }
  startAutomaticContinuation(phiSessionId, [event])
}

/** A prompt run just ended: deliver what came in meanwhile, unless the user stopped that run. */
function flushPendingContinuations(phiSessionId: string, runWasCancelled: boolean): void {
  const queued = pendingContinuations.get(phiSessionId)
  if (!queued) return
  pendingContinuations.delete(phiSessionId)
  // A run whose outcome the agent was already handed during that turn (it waited for it) needs no announcement.
  const events = queued.filter((event) =>
    event.type === 'agent_run_finished'
      ? !hasAgentRunBeenReported(phiSessionId, event.agentRunId)
      : !wrapperJobs.hasBeenReported(event.wrapperRunId)
  )
  if (runWasCancelled || events.length === 0) return
  try {
    startAutomaticContinuation(phiSessionId, events)
  } catch (error) {
    logUnexpectedError(error)
  }
}

interface SubmitPromptInput {
  sessionKey: string
  snapshot: SessionSnapshot & { permissionMode: PermissionMode }
  text: string
  images?: PromptImageInput[]
  promptTarget: PromptTargetInput | null
  /** A prompt Phi sends on its own (e.g. a background run ended), not the user's words. */
  automatic?: boolean
  planMode?: boolean
}

/**
 * Runs one prompt in the conversation `sessionKey`. It does not depend on which
 * conversation is on screen, so it also serves prompts for a conversation in the
 * background. The `agent:prompt` handler and automatic continuation both use it.
 */
async function submitPromptRun(input: SubmitPromptInput): Promise<{
  path: string | null
  phiSessionId?: string
  sessionGeneration: number
} | null> {
  const normalizedText = input.text
  const promptTarget = input.promptTarget
  const runSessionKey = resolveSessionKeyAlias(input.sessionKey)
  const runLifecycle = getLifecycleForKey(runSessionKey)
  const runSessionGeneration = runLifecycle.currentGeneration
  const runSnapshot = input.snapshot
  const automaticModelSelection = resolveSessionModelSelection(runSessionKey, runSnapshot) === null
  const project = projectForSession(runSessionKey, runSnapshot)
  if (
    input.planMode &&
    (project?.location.kind === 'ssh' || isRemoteProjectAnchorPath(runSnapshot.cwd))
  ) {
    throw new Error('远程项目暂不支持计划评审')
  }
  const phiSessionId = ensurePhiSessionId(
    runSessionKey,
    runSnapshot,
    normalizedText || (input.images?.length ? '图片' : undefined)
  )
  if (runtimeRecoveryOperations.has(phiSessionId))
    throw new Error('会话正在恢复，请等待恢复操作结束')
  if (manualCompactionIds.has(phiSessionId)) {
    throw new Error('上下文压缩正在进行，请稍后发送消息')
  }
  const stableSessionPath = phiOnlySessionPath(phiSessionId)
  const runId = createRunId()
  if (hasActivePromptRun(runSessionKey)) {
    throw new Error('会话正在运行')
  }
  const runGeneration = advancePromptGeneration(runSessionKey)
  // A real user message starts the automatic wake-up count over only after preflight succeeds.
  if (!input.automatic) automaticContinuations.delete(phiSessionId)
  const storedImages = input.images?.length ? persistPromptImages(phiSessionId, input.images) : []
  const otherActiveProjectRuns = project
    ? countOtherActiveProjectRuns(project.id, runSessionKey)
    : 0
  const promptRun: PromptRun = {
    sessionKey: runSessionKey,
    phiSessionId,
    runId,
    cwd: runSnapshot.cwd,
    ...(project ? { projectId: project.id } : {}),
    generation: runGeneration,
    sessionGeneration: runSessionGeneration,
    cancelled: false,
    thinkingBlocks: new Map(),
    thinkingBlockStartedAtMs: new Map(),
    compactionReasons: new Map(),
    agentToolCallIds: new Set(),
    sdkToolCallIds: new Set(),
    browserSdkToolCallIds: new Set(),
    persistedToolCallIds: new Set(),
    pendingProviderToolCalls: new Map(),
    sessionPath: stableSessionPath
  }
  setActivePromptRun(runSessionKey, promptRun)
  try {
    if (input.automatic) {
      // Phi's own message to the agent, not the user's words: nothing to show as a user bubble.
    } else if (promptTarget?.suppressUserMessageEvent === true) {
      appendSessionEvent(phiSessionId, {
        type: 'user_message_retry',
        runId,
        content: normalizedText,
        ...(storedImages.length ? { images: storedImages } : {}),
        ...(promptTarget.retryUserMessageId
          ? { userMessageId: promptTarget.retryUserMessageId }
          : {})
      })
    } else {
      appendSessionEvent(phiSessionId, {
        type: 'user_message',
        runId,
        content: normalizedText,
        ...(storedImages.length ? { images: storedImages } : {})
      })
    }
  } catch (error) {
    deleteActivePromptRun(runSessionKey, promptRun)
    throw error
  }
  if (otherActiveProjectRuns > 0 && !input.automatic) {
    notifyProjectParallelRun(
      runSessionGeneration,
      stableSessionPath,
      runSnapshot.cwd,
      otherActiveProjectRuns
    )
  }

  // Serialize prompts per session: duplicate/overlapping IPC invokes must
  // never run session.prompt() concurrently within the same conversation.
  const run = getPromptQueue(runSessionKey).then(async () => {
    let promptResult: {
      path: string | null
      phiSessionId?: string
      sessionGeneration: number
    } | null = null
    if (
      promptRun.cancelled ||
      promptRun.generation !== getPromptGeneration(runSessionKey) ||
      !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
    ) {
      return null
    }

    const changeBaseline =
      project?.location?.kind === 'ssh' ? null : await beginWorkspaceChangeCapture(runSnapshot.cwd)

    let loadedSkills = loadedSkillNamesBySession.get(phiSessionId)
    if (!loadedSkills) {
      try {
        loadedSkills = (
          isRemoteResourceScope(runSnapshot.cwd)
            ? await listRemoteProjectSkills(runSnapshot.cwd)
            : await listSkills(runSnapshot.cwd)
        )
          .filter((skill) => skill.enabled)
          .map((skill) => skill.name)
          .sort()
      } catch (error) {
        loadedSkills = []
        writeAppLog({
          event: 'session_loaded_skills_unavailable',
          level: 'warn',
          sessionId: phiSessionId,
          metadata: { error: error instanceof Error ? error.message : String(error) }
        })
      }
      loadedSkillNamesBySession.set(phiSessionId, loadedSkills)
    }

    const registryRun = runnerRegistry.startRun({
      sessionId: phiSessionId,
      runId,
      loadedSkills,
      getRecordedFailure: () => promptRun.recordedFailureMessage,
      execute: async ({ signal }) => {
        if (signal.aborted || promptRun.cancelled) return

        let session: AgentSessionInstance
        try {
          const result = await getAgentSession(runSessionKey, runSnapshot)
          session = result.session
        } catch (error) {
          if (
            isStaleSessionError(error) ||
            promptRun.cancelled ||
            signal.aborted ||
            !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
          ) {
            return
          }
          throw error
        }
        promptRun.session = session
        const automatic =
          automaticModelSelection && !ownsRemoteRuntimeSession(session.runtimeSessionId)
        const automaticCandidates = async (): Promise<RuntimeModel[]> => {
          const [runtime, providers] = await Promise.all([
            getAuthManager().getRuntime(),
            getAuthManager().getProviderStatuses()
          ])
          const configured = new Set(
            providers
              .filter((provider) => provider.configured)
              .map((provider) => provider.providerId)
          )
          return selectableRuntimeModels(runtime).filter(
            (model) =>
              configured.has(model.provider) &&
              (!input.images?.length || model.supportsImages === true)
          )
        }

        await applyNextRunConfiguration(session, runSessionKey, runSnapshot)
        if (input.planMode) {
          await getPhiEngine().sessions.enterPlanMode({
            sessionId: session.runtimeSessionId
          })
        }
        if (automatic && input.images?.length && session.model?.supportsImages !== true) {
          const compatible = (await automaticCandidates())[0]
          if (signal.aborted || promptRun.cancelled) return
          if (compatible) await session.setModel(compatible)
        }
        if (input.images?.length && session.model?.supportsImages !== true) {
          throw new Error('当前模型不支持图片，请切换到支持图片的模型后重试')
        }

        if (
          signal.aborted ||
          promptRun.cancelled ||
          promptRun.generation !== getPromptGeneration(runSessionKey) ||
          !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
        ) {
          await abortSession(session)
          return
        }

        try {
          await promptWithAutomaticModelFallback({
            session,
            text: normalizedText,
            automatic,
            isCurrent: () =>
              !signal.aborted &&
              !promptRun.cancelled &&
              promptRun.generation === getPromptGeneration(runSessionKey) &&
              runLifecycle.isCurrentGeneration(promptRun.sessionGeneration),
            recordedFailure: () => promptRun.recordedFailureMessage,
            clearFailure: () => {
              delete promptRun.recordedFailureMessage
              delete promptRun.stoppingPermanentProviderError
            },
            candidates: automaticCandidates,
            onSwitch: (from, to, error) => {
              const stored = appendSessionEvent(phiSessionId, {
                type: 'model_fallback',
                runId,
                fromProviderId: from.provider,
                fromModelId: from.id,
                toProviderId: to.provider,
                toModelId: to.id,
                toModelName: to.name,
                errorMessage: redactSensitiveText(error)
              })
              broadcastSessionTimelineEvent(phiSessionId, stored)
            },
            options: {
              hostRunId: promptRun.runId,
              ...(input.images?.length
                ? {
                    images: input.images.map((image) => ({
                      type: 'image' as const,
                      data: image.data,
                      mimeType: image.mimeType
                    }))
                  }
                : {}),
              preflightResult: (success) => {
                if (
                  success &&
                  (signal.aborted ||
                    promptRun.cancelled ||
                    promptRun.generation !== getPromptGeneration(runSessionKey) ||
                    !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration))
                ) {
                  void abortSessionWithoutCancellingApprovals(session).catch((error) => {
                    logUnexpectedError(error)
                    console.error('Failed to abort stale prompt:', error)
                  })
                  throw new StaleSessionError()
                }
              }
            }
          })
        } catch (error) {
          linkPromptRunRuntimeSessionPath(runSessionKey, runSnapshot.cwd, promptRun, session)
          if (
            signal.aborted ||
            promptRun.cancelled ||
            promptRun.generation !== getPromptGeneration(runSessionKey) ||
            !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
          ) {
            return
          }
          throw error
        }
        linkPromptRunRuntimeSessionPath(runSessionKey, runSnapshot.cwd, promptRun, session)

        if (
          signal.aborted ||
          promptRun.cancelled ||
          promptRun.generation !== getPromptGeneration(runSessionKey) ||
          !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
        ) {
          return
        }

        // A brand-new chat's first prompt is when it actually becomes a file on disk —
        // hand the stable Phi path back so the renderer can refresh and highlight it.
        if (sameCanonicalSessionKey(runSessionKey, currentSessionKey)) {
          currentSessionPath = stableSessionPath
        }
        promptRun.sessionPath = stableSessionPath
        promptResult = {
          path: stableSessionPath,
          phiSessionId,
          sessionGeneration: promptRun.sessionGeneration
        }
      }
    })
    syncPreventSleepBlocker()
    void registryRun.done.then(syncPreventSleepBlocker, syncPreventSleepBlocker)
    try {
      await registryRun.done
    } finally {
      let savedDiffBytes = 0
      const changes = await finishWorkspaceChangeCapture(changeBaseline, {
        onTextDiff: async (_name, patch) => {
          const bytes = Buffer.byteLength(patch, 'utf8')
          if (savedDiffBytes + bytes > MAX_RUN_DIFF_BYTES) return null
          const ref = persistWorkspaceDiff(phiSessionId, patch)
          if (ref) savedDiffBytes += ref.bytes
          return ref
        }
      })
      if (changes && (changes.files.length > 0 || changes.truncated)) {
        try {
          const stored = appendSessionEvent(phiSessionId, {
            type: 'workspace_changes',
            runId,
            ...changes
          })
          broadcastSessionTimelineEvent(phiSessionId, stored)
        } catch (error) {
          logUnexpectedError(error)
        }
      }
    }
    return promptRun.cancelled ? null : promptResult
  })
  promptRun.done = run
  setPromptQueue(
    runSessionKey,
    run.then(
      (result) => {
        deleteActivePromptRun(runSessionKey, promptRun)
        notifySessionChanged()
        flushPendingContinuations(phiSessionId, promptRun.cancelled)
        if (result && !promptRun.cancelled && !promptRun.recordedFailureMessage) {
          scheduleAutomaticSessionTitle(phiSessionId)
        }
      },
      () => {
        deleteActivePromptRun(runSessionKey, promptRun)
        notifySessionChanged()
        flushPendingContinuations(phiSessionId, promptRun.cancelled)
      }
    )
  )
  return run
}

async function alignCurrentSessionToPromptTarget(input: unknown): Promise<void> {
  const target = parsePromptTarget(input)
  if (!target) return

  if (target.phiSessionId) {
    const manifest = findPhiSessionById(target.phiSessionId)
    if (!manifest) throw new Error('会话不存在或已被删除')
    const stablePath = phiOnlySessionPath(manifest.sessionId)
    const targetKey = createPhiSessionKey(manifest.sessionId, manifest.cwd)
    linkPhiManagedSessionKey(targetKey, manifest.cwd, manifest.sessionId)
    sessionPermissionModes.set(resolveSessionKeyAlias(targetKey), manifest.permissionMode)
    const generationMatches =
      typeof target.sessionGeneration !== 'number' ||
      target.sessionGeneration === getLifecycleForKey(targetKey).currentGeneration
    if (currentSessionPath === stablePath && currentCwd === manifest.cwd && generationMatches) {
      return
    }
    await disposeAndSwitchSession(stablePath, manifest.cwd, manifest.permissionMode, {
      notify: false
    })
    return
  }

  if (target.path === null) {
    const generationMatches =
      typeof target.sessionGeneration !== 'number' ||
      target.sessionGeneration === getCurrentLifecycle().currentGeneration
    if (currentSessionPath === undefined && currentCwd === target.cwd && generationMatches) return
    throw new Error('当前会话已切换，请重新发送')
  }

  const phiOnlySessionId = phiSessionIdFromPath(target.path)
  if (phiOnlySessionId) {
    const manifest = findPhiSessionById(phiOnlySessionId)
    if (!manifest) throw new Error('会话不存在或已被删除')
    const targetKey = createSessionKey(target.path, manifest.cwd)
    setPhiSessionIdForKey(targetKey, phiOnlySessionId)
    sessionPermissionModes.set(resolveSessionKeyAlias(targetKey), manifest.permissionMode)
    if (currentSessionPath !== target.path || currentCwd !== manifest.cwd) {
      await disposeAndSwitchSession(target.path, manifest.cwd, manifest.permissionMode, {
        notify: false
      })
    }
    return
  }

  if (currentSessionPath === target.path) {
    return
  }

  const cwd = (await openRuntimeSessionManager(target.path)).getCwd()
  const targetKey = createSessionKey(target.path, cwd)
  const permissionMode = resolveSessionPermissionMode(targetKey, { path: target.path, cwd })
  if (currentSessionPath !== target.path || currentCwd !== cwd) {
    await disposeAndSwitchSession(target.path, cwd, permissionMode, { notify: false })
  }
}

function getSessionStatusPayload(
  sessionKey: string,
  path: string | undefined,
  cwd: string
): Pick<
  CurrentSessionPayload,
  | 'status'
  | 'unreadKind'
  | 'lastRunOutcome'
  | 'currentRunId'
  | 'currentRunStartedAt'
  | 'lastActivityAt'
> {
  const promptRun = getActivePromptRun(sessionKey)
  const activeRun = promptRun ? runnerRegistry.getActiveRun(promptRun.phiSessionId) : null
  if (activeRun) {
    return {
      status: activeRun.status,
      unreadKind:
        activeRun.status === 'needs_approval'
          ? 'approval'
          : activeRun.status === 'needs_input'
            ? 'input'
            : null,
      currentRunId: activeRun.runId,
      currentRunStartedAt: activeRun.startedAt
    }
  }

  const manifest = findPhiManifestForSession(sessionKey, path, cwd)
  if (manifest) {
    return {
      status: manifest.status,
      unreadKind: manifest.unreadKind,
      lastRunOutcome: manifest.lastRunOutcome,
      currentRunId: manifest.currentRunId,
      currentRunStartedAt: manifest.currentRunStartedAt,
      lastActivityAt: manifest.lastActivityAt
    }
  }

  return { status: 'idle', unreadKind: null }
}

function projectForSession(
  sessionKey: string,
  snapshot: Pick<SessionSnapshot, 'path' | 'cwd'>
): Project | undefined {
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  return manifest?.projectId ? getProject(manifest.projectId) : getProjectByCwd(snapshot.cwd)
}

function resolveSessionModelSelection(
  sessionKey: string,
  snapshot: SessionSnapshot
): ModelSelection | null {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (sessionModelSelections.has(canonicalKey)) {
    return sessionModelSelections.get(canonicalKey) ?? null
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (manifest?.model !== undefined) return manifest.model
  return projectForSession(sessionKey, snapshot)?.defaultModel ?? selectedModel ?? null
}

function resolveSessionThinkingLevel(sessionKey: string, snapshot: SessionSnapshot): ThinkingLevel {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (sessionThinkingLevels.has(canonicalKey)) {
    return sessionThinkingLevels.get(canonicalKey) ?? selectedThinkingLevel
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  return (
    manifest?.thinkingLevel ??
    projectForSession(sessionKey, snapshot)?.defaultThinkingLevel ??
    selectedThinkingLevel
  )
}

function resolveSessionPermissionMode(
  sessionKey: string,
  snapshot: Pick<SessionSnapshot, 'path' | 'cwd'>
): PermissionMode {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (manifest) {
    sessionPermissionModes.set(canonicalKey, manifest.permissionMode)
    return manifest.permissionMode
  }
  if (sessionPermissionModes.has(canonicalKey)) {
    return sessionPermissionModes.get(canonicalKey) ?? 'auto'
  }
  return projectForSession(sessionKey, snapshot)?.permissionMode ?? 'auto'
}

function ensurePhiSessionId(
  sessionKey: string,
  snapshot: SessionSnapshot & { permissionMode: PermissionMode },
  title?: string
): string {
  const existing = getPhiSessionIdForKey(sessionKey)
  if (existing) {
    linkPhiManagedSessionKey(sessionKey, snapshot.cwd, existing)
    return existing
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (manifest) {
    linkPhiManagedSessionKey(sessionKey, manifest.cwd, manifest.sessionId)
    return manifest.sessionId
  }

  const project = getProjectByCwd(snapshot.cwd)
  const model = resolveSessionModelSelection(sessionKey, snapshot)
  const sessionTitle = messageContentTitleText(title)
  const session = createPhiSession({
    kind: project ? 'project' : 'ordinary',
    projectId: project?.id ?? null,
    cwd: snapshot.cwd,
    cwdRealPath: project?.workingDirectoryRealPath ?? snapshot.cwd,
    ...(sessionTitle ? { title: sessionTitle } : {}),
    ...(runtimeSessionPath(snapshot.path) ? { runtimeSessionPath: snapshot.path } : {}),
    permissionMode: snapshot.permissionMode,
    model,
    thinkingLevel: resolveSessionThinkingLevel(sessionKey, snapshot)
  })
  linkPhiManagedSessionKey(sessionKey, snapshot.cwd, session.sessionId)
  return session.sessionId
}

function createPhiManagedSession(
  cwd: string,
  permissionMode: PermissionMode,
  title?: string
): { path: string; sessionId: string; permissionMode: PermissionMode } {
  const project = getProjectByCwd(cwd)
  const model = selectedModel !== undefined ? selectedModel : (project?.defaultModel ?? null)
  const sessionTitle = messageContentTitleText(title)
  const session = createPhiSession({
    kind: project ? 'project' : 'ordinary',
    projectId: project?.id ?? null,
    cwd,
    cwdRealPath: project?.workingDirectoryRealPath ?? cwd,
    ...(sessionTitle ? { title: sessionTitle } : {}),
    permissionMode,
    model,
    thinkingLevel: project?.defaultThinkingLevel ?? selectedThinkingLevel
  })
  const path = phiOnlySessionPath(session.sessionId)
  const key = createPhiSessionKey(session.sessionId, cwd)
  linkPhiManagedSessionKey(key, cwd, session.sessionId)
  sessionPermissionModes.set(resolveSessionKeyAlias(key), permissionMode)
  return { path, sessionId: session.sessionId, permissionMode }
}

function createRemoteManagedSession(projectId: string): {
  path: string
  sessionId: string
  cwd: string
  permissionMode: PermissionMode
} {
  const project = getProject(projectId)
  if (!project || project.location.kind !== 'ssh') throw new Error('远程项目不存在')
  const cwd = ensureRemoteProjectAnchor(project.id)
  const model =
    selectedModel !== undefined && !(remoteOmpRpcEnabled && selectedModel === null)
      ? selectedModel
      : (project.defaultModel ?? null)
  const session = createPhiSession({
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd,
    cwdRealPath: cwd,
    permissionMode: project.permissionMode,
    model,
    ...(project.defaultThinkingLevel ? { thinkingLevel: project.defaultThinkingLevel } : {})
  })
  const path = phiOnlySessionPath(session.sessionId)
  const key = createPhiSessionKey(session.sessionId, cwd)
  linkPhiManagedSessionKey(key, cwd, session.sessionId)
  sessionPermissionModes.set(resolveSessionKeyAlias(key), project.permissionMode)
  return { path, sessionId: session.sessionId, cwd, permissionMode: project.permissionMode }
}

let sessionTitleGenerator: SessionTitleGenerator | null = null
const automaticTitleJobs = new Map<string, Promise<void>>()
const titleRenameQueues = new Map<string, Promise<void>>()
const manualTitleRequests = new Set<string>()

function sessionTitleContext(path: string): {
  manifest: PhiSessionManifest
  firstUserMessage: string
  userMessage: string
  assistantMessage?: string
} {
  const id = phiSessionIdFromPath(path)
  const manifest = id ? findPhiSessionById(id) : findPhiSessionByRuntimePath(path)
  if (!manifest) throw new Error('请先打开该对话，再生成标题')
  const events = readSessionEvents(manifest.sessionId)
  const userMessages = events
    .filter((event) => event.type === 'user_message' && typeof event.content === 'string')
    .map((event) => messageContentTitleText(event.content as string))
    .filter(Boolean)
  const firstUserMessage = userMessages[0]
  const userMessage = userMessages.find(hasSessionTitleTopic) ?? firstUserMessage
  if (!userMessage) throw new Error('对话还没有可用于生成标题的内容')
  const reply = events.find(
    (event) => event.type === 'assistant_message_finalized' && typeof event.content === 'string'
  )
  return {
    manifest,
    firstUserMessage,
    userMessage,
    ...(reply ? { assistantMessage: reply.content as string } : {})
  }
}

function hasSessionTitleTopic(message: string): boolean {
  return !/^(?:hi|hello|hey|你好|您好|哈喽|嗨|谢谢|thanks|thank you|继续|continue|好的|ok|okay|好)[！!。，,.\s]*$/i.test(
    message.trim()
  )
}

function getSessionTitleGenerator(): SessionTitleGenerator {
  if (mainWindowCleanupStarted) throw new Error('标题生成服务已关闭')
  sessionTitleGenerator ??= new SessionTitleGenerator({
    request: async ({ sessionPath, prompt, signal }) => {
      const { manifest } = sessionTitleContext(sessionPath)
      const key = createPhiSessionKey(manifest.sessionId, manifest.cwd)
      const selection = resolveSessionModelSelection(key, {
        path: sessionPath,
        cwd: manifest.cwd,
        permissionMode: manifest.permissionMode
      })
      const runtime = await getAuthManager().getRuntime()
      signal.throwIfAborted()
      let model = selection ? resolveRuntimeModelSelection(runtime, selection)?.model : undefined
      if (!selection) {
        const lifecycle = getLifecycleForKey(key)
        const record = lifecycle.currentRecord
        if (record) {
          const ready = await record.promise
          if (lifecycle.isCurrent(record)) model = ready.session.model
        }
        signal.throwIfAborted()
      }
      if (selection && !model) throw new Error('请先为对话配置可用模型')
      const cwd = getNoProjectTaskFolder()
      let streamedText = ''
      let replyFailed = false
      const { session } = await createAgentSession(
        {
          cwd,
          modelRuntime: runtime,
          ...(model ? { model } : {}),
          thinkingLevel: 'minimal',
          noTools: 'all',
          sessionManager: createInMemoryRuntimeSessionManager(cwd)
        },
        (summary) => {
          if (assistantErrorMessageFromEventSummary(summary)) replyFailed = true
          const event = isPhiMessageUpdateSummary(summary)
            ? summary.assistantMessageEvent
            : undefined
          if (event?.type === 'text_delta' && typeof event.delta === 'string') {
            streamedText += event.delta
          }
          const message = isPhiEventType(summary, 'message_end')
            ? summary.message
            : (event?.partial ?? event?.message)
          if ((message as { role?: string } | undefined)?.role === 'assistant') {
            const body = extractAssistantText(message).trim()
            if (body) streamedText = body
          }
        },
        { signal, assertCurrent: () => signal.throwIfAborted() }
      )
      const abort = (): void => {
        void session.abort().catch(logUnexpectedError)
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        await session.prompt(prompt, {
          expandPromptTemplates: false,
          userInitiated: true,
          skipCompactionCheck: true
        })
        signal.throwIfAborted()
        const assistant = session.messages.findLast(
          (message) => (message as { role?: string }).role === 'assistant'
        )
        const final = assistant as { stopReason?: string; errorMessage?: unknown } | undefined
        if (
          final?.stopReason === 'error' ||
          final?.stopReason === 'aborted' ||
          final?.errorMessage ||
          (replyFailed && final?.stopReason !== 'stop')
        )
          return ''
        return extractAssistantText(assistant).trim() || streamedText.trim()
      } finally {
        signal.removeEventListener('abort', abort)
        await session.dispose()
      }
    }
  })
  return sessionTitleGenerator
}

function enqueueSessionTitleWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  const previous = titleRenameQueues.get(path) ?? Promise.resolve()
  const result = previous.then(write)
  const settled = result.then(
    () => {},
    () => {}
  )
  titleRenameQueues.set(path, settled)
  void settled.then(() => {
    if (titleRenameQueues.get(path) === settled) titleRenameQueues.delete(path)
  })
  return result
}

async function renameConversation(
  path: string,
  name: string,
  source: 'auto' | 'user'
): Promise<void> {
  const id = phiSessionIdFromPath(path)
  if (id) {
    const manifest = findPhiSessionById(id)
    if (!manifest) throw new Error('会话不存在')
    const rpc = Boolean(
      manifest.runtimeRef || (remoteOmpRpcEnabled && manifest.projectLocation?.kind === 'ssh')
    )
    if (rpc) {
      const key = createSessionKey(path, manifest.cwd)
      const captured = captureSessionControlTarget(key, manifest.sessionId, false, true, false)
      const ready = await captured.resolved()
      captured.assertCurrent()
      if (ready) {
        if (!ownsRemoteRuntimeSession(ready.session.runtimeSessionId))
          throw new Error('RPC rename requires an exact live attachment')
        const confirmed = await ready.session.sessionManager.setSessionName(name, source, captured)
        captured.assertCurrent()
        if (!confirmed) throw new Error('远程会话名称尚未确认')
      } else {
        if (manifest.runtimeRef) throw new Error('远程会话名称需要显式恢复后修改')
        await renameSession(path, name)
      }
    } else {
      await renameSession(path, name)
    }
    updateSessionManifest(id, { titleSource: source })
    notifySessionChanged()
    return
  }
  const current = await getCurrentResolvedSession()
  if (currentSessionPath === path && current) {
    await current.session.sessionManager.setSessionName(name, source)
  } else {
    await renameSession(path, name)
  }
}

function scheduleAutomaticSessionTitle(sessionId: string): void {
  if (mainWindowCleanupStarted || automaticTitleJobs.has(sessionId)) return
  const path = phiOnlySessionPath(sessionId)
  const job = (async () => {
    const context = sessionTitleContext(path)
    const { manifest, userMessage, firstUserMessage } = context
    if (
      manifest.titleSource ||
      !hasSessionTitleTopic(userMessage) ||
      manifest.runtimeRecoveryError ||
      (manifest.title && messageContentTitleText(manifest.title) !== firstUserMessage)
    )
      return
    const target = captureSessionControlTarget(
      createPhiSessionKey(sessionId, manifest.cwd),
      sessionId,
      false,
      true,
      false
    )
    const title = await getSessionTitleGenerator().generate({ sessionPath: path, ...context })
    if (!title || mainWindowCleanupStarted) return
    await enqueueSessionTitleWrite(path, async () => {
      if (mainWindowCleanupStarted) return
      target.assertCurrent()
      const latest = findPhiSessionById(sessionId)
      if (
        !latest ||
        latest.titleSource ||
        latest.title !== manifest.title ||
        latest.runtimeRecoveryError ||
        manualTitleRequests.has(path) ||
        runnerRegistry.getActiveRun(sessionId) ||
        runtimeRecoveryOperations.has(sessionId)
      )
        return
      await renameConversation(path, title, 'auto')
    })
  })()
    .catch(() => {
      writeAppLog({ level: 'warn', event: 'session_auto_title_unavailable', sessionId })
    })
    .finally(() => {
      if (automaticTitleJobs.get(sessionId) === job) automaticTitleJobs.delete(sessionId)
    })
  automaticTitleJobs.set(sessionId, job)
}

// Turns a free-text description of the desired assistant into a persona markdown file
// by asking the agent itself to write it, in a throwaway session (noTools + in-memory
// history) so it doesn't touch the user's real chat or leave tool-call side effects.
async function generatePersonaMarkdown(
  description: string,
  control?: { assertCurrent(): void }
): Promise<string> {
  control?.assertCurrent()
  const runtime = await getAuthManager().getRuntime()
  control?.assertCurrent()
  const model = selectedModel
    ? runtime.getModel(selectedModel.providerId, selectedModel.modelId)
    : undefined
  let eventAssistantText = ''
  const cwd = getNoProjectTaskFolder()
  const { session } = await createAgentSession(
    {
      modelRuntime: runtime,
      cwd,
      noTools: 'all',
      sessionManager: createInMemoryRuntimeSessionManager(cwd),
      ...(model ? { model } : {})
    },
    (summary) => {
      eventAssistantText = assistantTextFromEventSummary(summary, eventAssistantText)
    }
  )

  try {
    control?.assertCurrent()
    await session.prompt(
      [
        '请根据下面用户对助手的描述，生成一份 Markdown 格式的智能体人设配置。',
        '内容应涵盖：性格特征、说话风格/语气、回答偏好（如结构、详略程度等）。',
        '只输出 Markdown 正文本身，不要包含任何解释、前后缀说明或代码块包裹符号。',
        '',
        '用户描述：',
        description
      ].join('\n')
    )

    control?.assertCurrent()
    const lastAssistantMessage = [...session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    const generated = extractAssistantText(lastAssistantMessage).trim() || eventAssistantText.trim()
    return generated || fallbackMarkdownFromDescription(description)
  } finally {
    await session.dispose()
  }
}

const NOTEBOOK_AI_VARIABLE_REFERENCE_PATTERN =
  /@(?:(?:dataframe|variable):\/\/)?((?:[A-Za-z_]|\.(?!\d))[A-Za-z0-9._]*)/g

function notebookLanguageSupportsKernelIntrospection(language: string): boolean {
  const value = language.toLocaleLowerCase()
  return value.startsWith('python') || value === 'r' || value === 'ir' || value === 'rscript'
}

function notebookAiVariableNamesFromInput(
  prompt: string,
  references: AnalysisNotebookContextReference[] | undefined
): string[] {
  const names = new Set<string>()
  for (const reference of references ?? []) {
    if (reference.kind === 'dataframe' || reference.kind === 'variable') {
      names.add(reference.name)
    }
  }
  for (const match of prompt.matchAll(NOTEBOOK_AI_VARIABLE_REFERENCE_PATTERN)) {
    names.add(match[1])
  }
  return [...names]
}

function kernelShapeLabel(shape: string | undefined): string | undefined {
  if (!shape) return undefined
  const match = shape.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/)
  return match ? `${match[1]} rows x ${match[2]} columns` : shape
}

function mergeKernelIntrospectionReference(
  references: AnalysisNotebookContextReference[],
  summary: NotebookVariableIntrospection
): AnalysisNotebookContextReference[] {
  if (!summary.exists || !summary.name) return references
  const index = references.findIndex(
    (reference) =>
      reference.name === summary.name &&
      (reference.kind === 'dataframe' || reference.kind === 'variable')
  )
  const existing = index >= 0 ? references[index] : null
  const kind: AnalysisNotebookContextReference['kind'] =
    existing?.kind ?? (summary.columns?.length || summary.shape ? 'dataframe' : 'variable')
  const next: AnalysisNotebookContextReference = {
    id: existing?.id ?? `${kind}:${summary.name}`,
    kind,
    name: summary.name,
    detail: summary.datatype ?? existing?.detail ?? 'live kernel',
    cellId: existing?.cellId,
    preview: {
      ...existing?.preview,
      source: existing?.preview?.source ?? 'live kernel',
      shape: kernelShapeLabel(summary.shape) ?? existing?.preview?.shape,
      columns: summary.columns ?? existing?.preview?.columns,
      value: summary.preview ?? existing?.preview?.value
    }
  }
  if (index < 0) return [...references, next]
  return references.map((reference, currentIndex) => (currentIndex === index ? next : reference))
}

async function notebookAiReferencesWithKernelIntrospection(input: {
  projectCwd: string
  notebookPath: string
  prompt: string
  language: string
  references?: AnalysisNotebookContextReference[]
  sessions?: AnalysisNotebookSessionRegistry
}): Promise<AnalysisNotebookContextReference[] | undefined> {
  const references = [...(input.references ?? [])]
  if (!notebookLanguageSupportsKernelIntrospection(input.language)) return references
  const variableNames = notebookAiVariableNamesFromInput(input.prompt, references)
  if (variableNames.length === 0) return references
  const target = (input.sessions ?? notebookSessionRegistry).executionTarget(
    input.projectCwd,
    input.notebookPath
  )
  if (!target) return references

  try {
    const summaries = await notebookExecutor.introspectVariables({
      connection: target.connection,
      sessionId: target.sessionId,
      kernelId: target.kernelId,
      variableNames,
      language: input.language
    })
    return summaries.reduce(mergeKernelIntrospectionReference, references)
  } catch {
    return references
  }
}

async function repairNotebookGenerationCompletion(input: {
  sessionOptions: NonNullable<Parameters<typeof createAgentSession>[0]>
  language: string
  notebookPath: string
  insertionIndex: number
  references?: AnalysisNotebookContextReference[]
  userPrompt: string
  nearbyContext: string
  otherCellContext: string
  invalidOutput: string
  onEvent?: (summary: PhiAgentEventSummary) => void
  onProgress?: (completion: NotebookCompletionSelection) => void
}): Promise<NotebookCompletionSelection | null> {
  const completion = new NotebookCompletionCollector()
  let errorMessage = ''
  const { session } = await createAgentSession(input.sessionOptions, (summary) => {
    input.onEvent?.(summary)
    completion.observe(summary)
    errorMessage = assistantErrorMessageFromEventSummary(summary) ?? errorMessage
    const snapshot = completion.select(input.language, parseGeneratedNotebookCompletionSnapshot)
    if (snapshot?.cells.length) input.onProgress?.(snapshot)
  })

  try {
    await session.prompt(
      buildNotebookCodeGenerationRepairPrompt({
        language: input.language,
        notebookPath: input.notebookPath,
        insertionIndex: input.insertionIndex,
        references: input.references,
        userPrompt: input.userPrompt,
        nearbyContext: input.nearbyContext,
        otherCellContext: input.otherCellContext,
        invalidOutput: input.invalidOutput
      }),
      {
        expandPromptTemplates: false,
        synthetic: true,
        skipCompactionCheck: true
      }
    )
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return completion.select(
      input.language,
      parseFinalGeneratedNotebookCompletion,
      session.messages
    )
  } finally {
    await session.dispose()
  }
}

async function generateAnalysisNotebookCode(
  cwd: string,
  notebookPath: string,
  document: NotebookDocument,
  input: AnalysisNotebookCodeGenerationInput,
  onProgress?: (progress: AnalysisNotebookCodeGenerationProgress) => void
): Promise<AnalysisNotebookCodeGenerationResult> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error('请输入要生成的代码需求')
  }

  const workspace = resolveAnalysisWorkspaceByCwd(cwd)
  if (!workspace) {
    throw new Error('请选择一个已添加的项目或当前 workspace')
  }
  const modelSelection = input.model ?? workspace.project?.defaultModel ?? selectedModel
  const job = notebookAiGenerationJobs.begin({
    requestId: input.requestId,
    projectCwd: workspace.workingDirectory,
    notebookPath,
    notebookName: basename(notebookPath),
    model: modelSelection ? modelSelectionLabel(modelSelection) : '默认模型',
    prompt
  })
  try {
    const remote = remoteNotebookBackendFor(workspace)
    const file = await analysisOpenFile(workspace, notebookPath)
    job.update('preparing', { notebookPath: file.path, notebookName: basename(file.path) })
    const runtime = await getAuthManager().getRuntime()
    const resolvedModel = modelSelection
      ? resolveRuntimeModelSelection(runtime, modelSelection)
      : null
    if (modelSelection && !resolvedModel) {
      throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
    }
    const { insertionIndex, nearbyContext, otherCellContext } = notebookCellPromptContext(
      document,
      input.afterCellId
    )
    const language = input.language || 'python'
    const references = await notebookAiReferencesWithKernelIntrospection({
      projectCwd: workspace.workingDirectory,
      notebookPath: file.path,
      prompt,
      language,
      references: input.references,
      sessions: analysisSessions(workspace)
    })
    const sessionCwd = remote ? AGENT_DIR : workspace.workingDirectory
    const sessionOptions = {
      modelRuntime: runtime,
      cwd: sessionCwd,
      noTools: 'all' as const,
      thinkingLevel: workspace.project?.defaultThinkingLevel ?? selectedThinkingLevel,
      sessionManager: createInMemoryRuntimeSessionManager(sessionCwd),
      ...(resolvedModel ? { model: resolvedModel.model } : {})
    }
    const completion = new NotebookCompletionCollector()
    let eventErrorMessage = ''
    let lastProgressSource = ''
    const emitProgress = (): void => {
      const selectedCompletion = completion.select(
        language,
        parseGeneratedNotebookCompletionSnapshot
      )
      if (!selectedCompletion || selectedCompletion.cells.length === 0) return
      const source = generatedNotebookCellsSource(selectedCompletion.cells)
      if (source === lastProgressSource) return
      lastProgressSource = source
      job.update('generating', {
        sourcePreview: source,
        previewCells: selectedCompletion.cells,
        cellCount: selectedCompletion.cells.length
      })
      if (!input.requestId || !onProgress) return
      onProgress({
        requestId: input.requestId,
        path: file.path,
        relativePath: file.relativePath,
        source,
        language,
        cells: selectedCompletion.cells
      })
    }
    const { session } = await createAgentSession(sessionOptions, (summary) => {
      job.observe(summary)
      completion.observe(summary)
      eventErrorMessage = assistantErrorMessageFromEventSummary(summary) ?? eventErrorMessage
      if (completion.text) job.update('generating')
      emitProgress()
    })

    let result: Required<AnalysisNotebookCodeGenerationResult>
    try {
      job.update(
        'waiting',
        session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}
      )
      await session.prompt(
        buildNotebookCodeGenerationPrompt({
          language,
          notebookPath: file.relativePath,
          insertionIndex,
          references,
          userPrompt: prompt,
          nearbyContext,
          otherCellContext
        }),
        {
          expandPromptTemplates: false,
          userInitiated: true,
          skipCompactionCheck: true
        }
      )
      if (eventErrorMessage) {
        throw new Error(eventErrorMessage)
      }

      const lastAssistantMessage = [...session.messages].reverse().find((message) => {
        const record = message as { role?: string }
        return record.role === 'assistant'
      })
      const selectedCompletion = completion.select(
        language,
        parseFinalGeneratedNotebookCompletion,
        session.messages
      )
      let assistantText = selectedCompletion?.text || completion.text
      assistantText ||= extractAssistantText(lastAssistantMessage).trim()
      let cells = selectedCompletion?.cells ?? []
      let completionText = assistantText
      if (cells.length === 0) {
        job.update('repairing')
        const repairedCompletion = await repairNotebookGenerationCompletion({
          sessionOptions,
          language,
          notebookPath: file.relativePath,
          insertionIndex,
          references,
          userPrompt: prompt,
          nearbyContext,
          otherCellContext,
          invalidOutput: assistantText,
          onEvent: (summary) => job.observe(summary),
          onProgress: (completion) => {
            job.update('repairing', {
              sourcePreview: generatedNotebookCellsSource(completion.cells),
              previewCells: completion.cells,
              cellCount: completion.cells.length
            })
          }
        })
        if (repairedCompletion) {
          cells = repairedCompletion.cells
          completionText = repairedCompletion.text
        }
      }
      if (cells.length === 0) {
        const emptyResultDiagnostic =
          completionText ||
          '未收到模型返回文本或 data-notebook-cells-completion 结构化结果。请检查当前模型/供应商配置，或稍后重试。'
        throw new Error(notebookGenerationEmptyResultMessage(emptyResultDiagnostic))
      }
      const source = generatedNotebookCellsSource(cells)
      if (input.requestId && onProgress && source !== lastProgressSource) {
        onProgress({
          requestId: input.requestId,
          path: file.path,
          relativePath: file.relativePath,
          source,
          language,
          cells
        })
      }
      result = { source, language, cells }
    } finally {
      await session.dispose()
    }
    job.complete({
      sourcePreview: result.source,
      previewCells: result.cells,
      cellCount: result.cells.length
    })
    return result
  } catch (error) {
    job.fail(error)
    throw error
  }
}

function isUsableWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

function isDisposedFrameSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Render frame was disposed before WebFrameMain could be accessed') ||
    message.includes('Object has been destroyed')
  )
}

function isExpectedShutdownCleanupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('OMP worker exited (130)')
}

function sendToWindow(window: BrowserWindow | null, channel: string, ...args: unknown[]): boolean {
  if (!isUsableWindow(window)) return false
  try {
    window.webContents.send(channel, ...args)
    return true
  } catch (error) {
    if (isDisposedFrameSendError(error)) return false
    throw error
  }
}

function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, channel, ...args)
  }
}

function getActiveWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (isUsableWindow(focusedWindow)) return focusedWindow
  return BrowserWindow.getAllWindows().find((window) => isUsableWindow(window)) ?? null
}

function notifyToolApprovalsCancelled(): void {
  sendToAllWindows('tool:approval-cancelled')
}

function notifyAgentUserInteractionsCancelled(): void {
  sendToAllWindows('agent:interaction-cancelled')
}

function notifyAnalysisNotebookDraftChanged(change: {
  source: string
  projectCwd: string
  path: string
  relativePath: string
  document: NotebookDocument
  savedRevision: string
  contentHash?: string
  changeKind?: string
  changedCellId?: string
  focusCellId?: string
}): void {
  sendToAllWindows('analysis:notebookDraftChanged', change)
}

function notifyAnalysisNotebookFileChanged(change: unknown): void {
  sendToAllWindows('analysis:notebookFileChanged', change)
}

type LocalPathScope = {
  cwd: string
  cwdRealPath?: string
}

function currentLocalPathScope(): LocalPathScope {
  const project = getProjectByCwd(currentCwd)
  return {
    cwd: currentCwd,
    ...(project?.workingDirectoryRealPath ? { cwdRealPath: project.workingDirectoryRealPath } : {})
  }
}

function isRemoteResourceScope(cwd?: string): boolean {
  return (
    isRemoteProjectAnchorPath(currentCwd, AGENT_DIR) ||
    (typeof cwd === 'string' && isRemoteProjectAnchorPath(cwd, AGENT_DIR))
  )
}

function remoteAgentProjectContext(cwd?: string): RemoteAgentProjectContext {
  const target = cwd ?? currentCwd
  const remote = currentRemoteAnalysisProject(target) ?? currentRemoteAnalysisProject(currentCwd)
  if (!remote) throw new Error('远程项目 agent 请求缺少有效的当前项目会话')
  return {
    sessionId: remote.sessionId,
    projectId: remote.project.id,
    cwd: target,
    agentDir: AGENT_DIR,
    bundledDir: getBundledAgentsDir()
  }
}

function remoteSkillProjectContext(cwd?: string): RemoteProjectSkillContext {
  const target = cwd ?? currentCwd
  const remote = currentRemoteAnalysisProject(target) ?? currentRemoteAnalysisProject(currentCwd)
  if (!remote) throw new Error('远程项目 Skill 请求缺少有效的当前项目会话')
  return {
    sessionId: remote.sessionId,
    projectId: remote.project.id,
    cwd: target,
    agentDir: AGENT_DIR
  }
}

function remoteMcpProjectContext(cwd?: string): RemoteProjectMcpContext {
  return remoteSkillProjectContext(cwd)
}

async function listRemoteProjectSkills(
  cwd?: string
): Promise<Awaited<ReturnType<typeof listSkills>>> {
  const [globalSkills, projectCatalog] = await Promise.all([
    listGlobalSkills(),
    loadRemoteProjectSkillCatalog(remoteSkillProjectContext(cwd))
  ])
  const trustedNames = new Set(projectCatalog.sources.map((skill) => skill.name))
  return [
    ...globalSkills.filter((skill) => !trustedNames.has(skill.name)),
    ...projectCatalog.summaries
  ]
}

function remoteRuntimeSkillDefinitions(catalog: RemoteProjectSkillCatalog): RuntimeSkill[] {
  return catalog.sources.flatMap((source) => {
    const entry = catalog.summaries.find(
      (candidate) =>
        candidate.relativePath === source.filePath && candidate.trustState === 'trusted'
    )
    const discovered = catalog.entries.find(
      (candidate) => candidate.relativePath === source.filePath
    )
    if (!entry?.relativePath || !entry.contentHash) return []
    return [
      {
        name: entry.name,
        description: entry.description,
        filePath: entry.filePath,
        ...(discovered?.disableModelInvocation ? { disableModelInvocation: true } : {}),
        sourceInfo: {
          source: 'server-project',
          scope: 'project',
          origin: 'server-project',
          path: entry.relativePath,
          baseDir: entry.filePath.slice(0, -'/SKILL.md'.length)
        },
        remoteProject: {
          relativePath: entry.relativePath,
          contentHash: entry.contentHash
        }
      }
    ]
  })
}

function checkedRemoteAgentTrustMutation(value: unknown): {
  cwd: string
  relativePath: string
  contentHash: string
} {
  if (!isRecord(value)) throw new Error('远程项目 agent 信任请求无效')
  if (
    Object.keys(value).some(
      (key) => key !== 'cwd' && key !== 'relativePath' && key !== 'contentHash'
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash)
  ) {
    throw new Error('远程项目 agent 信任请求无效')
  }
  return value as { cwd: string; relativePath: string; contentHash: string }
}

function checkedRemoteSkillTrustMutation(value: unknown): {
  cwd: string
  relativePath: string
  contentHash: string
} {
  if (!isRecord(value)) throw new Error('远程项目 Skill 信任请求无效')
  if (
    Object.keys(value).some(
      (key) => key !== 'cwd' && key !== 'relativePath' && key !== 'contentHash'
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !/^\.(?:phi|omp|pi)\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/u.test(value.relativePath) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash)
  ) {
    throw new Error('远程项目 Skill 信任请求无效')
  }
  return value as { cwd: string; relativePath: string; contentHash: string }
}

function checkedRemoteMcpTrustMutation(value: unknown): {
  cwd: string
  relativePath: string
  contentHash: string
  confirmedItemIds: string[]
} {
  if (!isRecord(value)) throw new Error('远程项目 MCP 信任请求无效')
  if (
    Object.keys(value).some(
      (key) =>
        key !== 'cwd' &&
        key !== 'relativePath' &&
        key !== 'contentHash' &&
        key !== 'confirmedItemIds'
    ) ||
    typeof value.cwd !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !/^(?:\.phi\/mcp\.json|\.mcp\.json|\.omp\/mcp\.json|\.pi\/mcp\.json)$/u.test(
      value.relativePath
    ) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
    !Array.isArray(value.confirmedItemIds) ||
    value.confirmedItemIds.length > 1024 ||
    !value.confirmedItemIds.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 512
    )
  ) {
    throw new Error('远程项目 MCP 信任请求无效')
  }
  return value as {
    cwd: string
    relativePath: string
    contentHash: string
    confirmedItemIds: string[]
  }
}

async function listRemotePromptAgents(cwd?: string): Promise<PromptAgentSummary[]> {
  return (await loadRemoteAgentCatalog(remoteAgentProjectContext(cwd))).entries
}

function isEnablementItemKey(value: unknown): value is EnablementItemKey {
  return (
    typeof value === 'string' &&
    (/^skill:[a-z0-9][a-z0-9-]{0,63}$/.test(value) ||
      /^(?:plugin|wrapper|mcp):[a-z][a-z0-9-]{1,63}$/.test(value))
  )
}

function enablementScopeOptions(value: unknown): { projectDir?: string } {
  if (!isRecord(value) || (value.type !== 'global' && value.type !== 'project')) {
    throw new Error('启用范围无效')
  }
  if (value.type === 'global') {
    if (Object.keys(value).some((key) => key !== 'type')) throw new Error('全局启用范围无效')
    return {}
  }
  if (
    Object.keys(value).some((key) => key !== 'type' && key !== 'projectCwd') ||
    typeof value.projectCwd !== 'string' ||
    value.projectCwd.trim().length === 0 ||
    isRemoteResourceScope(value.projectCwd)
  ) {
    throw new Error('项目启用范围无效')
  }
  return { projectDir: value.projectCwd }
}

function isCoreAuthoringSkillResourcePath(target: string): boolean {
  try {
    return isPathInsideRoot(realpathSync(getCoreAuthoringSkillDir()), target)
  } catch {
    return false
  }
}

function isLocalFilePathAllowed(
  target: string,
  scope: LocalPathScope = currentLocalPathScope(),
  projectRoots: readonly string[] = []
): boolean {
  if (isRemoteProjectAnchorPath(target, AGENT_DIR)) return false
  if (isCoreAuthoringSkillResourcePath(target)) return true
  if (isPluginSkillPreviewPath(target)) return true
  return isLocalFilePathAllowedByRoots(
    target,
    localFileAllowRoots({
      agentDir: resolve(AGENT_DIR),
      sessionCwd: scope.cwd,
      sessionCwdRealPath: scope.cwdRealPath,
      projectRoots
    })
  )
}

function scopeForRoot(
  root: string,
  target: string
): { rootPath: string; rootLabel: string; displayPath: string } | null {
  const rootPath = resolve(root)
  if (!isPathInsideRoot(rootPath, target)) return null
  const relativePath = relative(rootPath, target)
  return {
    rootPath,
    rootLabel: basename(rootPath) || rootPath,
    displayPath: relativePath || basename(target)
  }
}

function getLocalPathScope(
  target: string,
  projectRoots: readonly string[] = []
): {
  rootPath: string
  rootLabel: string
  displayPath: string
} | null {
  if (isRemoteProjectAnchorPath(target, AGENT_DIR)) return null
  const cwdScope = scopeForRoot(currentCwd, target)
  if (cwdScope) return cwdScope

  const projectScope = projectRoots
    .map((root) => scopeForRoot(root, target))
    .filter((scope): scope is NonNullable<typeof scope> => scope !== null)
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]
  if (projectScope) return projectScope

  const agentDir = resolve(AGENT_DIR)
  const relativeAgentPath = relative(agentDir, target)
  if (!relativeAgentPath.startsWith('..') && !isAbsolute(relativeAgentPath)) {
    return {
      rootPath: agentDir,
      rootLabel: 'Phi',
      displayPath: join('Phi', relativeAgentPath || basename(target))
    }
  }

  return null
}

function assertLocalFilePathAllowed(
  filePath: string,
  actionLabel: string,
  options: { resolveSymlinks?: boolean; projectRoots?: readonly string[] } = {}
): string {
  if (!isAbsolute(filePath)) {
    throw new Error(`只能${actionLabel}绝对路径`)
  }
  const projectRoots = options.projectRoots ?? listLocalProjectAllowRoots()
  const scope = currentLocalPathScope()
  const target = resolve(filePath)
  if (!isLocalFilePathAllowed(target, scope, projectRoots)) {
    throw new Error(`只能${actionLabel} Phi 保存的文件或当前项目内的文件`)
  }
  const inspectedTarget = options.resolveSymlinks ? realpathSync(target) : target
  if (
    !isLocalFilePathAllowed(inspectedTarget, scope, projectRoots) ||
    (existsSync(inspectedTarget) &&
      isRemoteProjectAnchorPath(realpathSync(inspectedTarget), AGENT_DIR))
  ) {
    throw new Error(`只能${actionLabel} Phi 保存的文件或当前项目内的文件`)
  }
  return inspectedTarget
}

function assertFileHoverPreviewPathAllowed(filePath: string): string {
  if (!readAppSettings().allowExternalFileRead) {
    try {
      return assertLocalFilePathAllowed(filePath, '预览', { resolveSymlinks: true })
    } catch (error) {
      if (
        isAbsolute(filePath) &&
        error instanceof Error &&
        error.message.includes('Phi 保存的文件或当前项目内的文件')
      ) {
        throw new Error(
          '此文件位于当前项目之外。请前往“设置 → 通用”，开启“允许读取项目外文件”后重试。'
        )
      }
      throw error
    }
  }

  if (!isAbsolute(filePath)) {
    throw new Error('只能预览绝对路径')
  }
  const target = resolve(filePath)
  if (isRemoteProjectAnchorPath(target, AGENT_DIR)) {
    throw new Error('远程项目文件不支持本地悬停预览')
  }
  const inspectedTarget = realpathSync(target)
  if (isRemoteProjectAnchorPath(inspectedTarget, AGENT_DIR)) {
    throw new Error('远程项目文件不支持本地悬停预览')
  }
  return inspectedTarget
}

function assertRevealPathAllowed(filePath: string): string {
  return assertLocalFilePathAllowed(filePath, '显示')
}

type LocalPathStatPayload = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

function localPathStatScope(cwd: unknown, allowExternalFileRead: boolean): LocalPathScope | null {
  const rawCwd = typeof cwd === 'string' && cwd.trim() ? cwd : currentCwd
  if (isRemoteProjectAnchorPath(rawCwd, AGENT_DIR)) return null
  const requestedCwd = resolve(rawCwd)
  if (requestedCwd === resolve(currentCwd)) return currentLocalPathScope()

  const project = getProjectByCwd(rawCwd)
  if (!project) {
    return allowExternalFileRead ? { cwd: requestedCwd } : null
  }

  try {
    assertProjectPathAvailable(project.workingDirectory)
  } catch {
    return null
  }

  return {
    cwd: project.workingDirectory,
    cwdRealPath: project.workingDirectoryRealPath
  }
}

function missingLocalPathStats(paths: string[]): LocalPathStatPayload[] {
  return paths.map((path) => ({ path, kind: 'missing' as const }))
}

function statLocalPath(
  filePath: string,
  scope: LocalPathScope,
  allowExternalFileRead: boolean
): LocalPathStatPayload {
  const missing = { path: filePath, kind: 'missing' as const }
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return missing

  const target = resolve(filePath)
  if (isRemoteProjectAnchorPath(target, AGENT_DIR)) return missing
  if (!allowExternalFileRead && !isLocalFilePathAllowed(target, scope)) return missing

  try {
    const realTarget = realpathSync(target)
    if (isRemoteProjectAnchorPath(realTarget, AGENT_DIR)) return missing
    if (!allowExternalFileRead && !isLocalFilePathAllowed(realTarget, scope)) return missing

    const stats = statSync(realTarget)
    if (stats.isDirectory()) return { path: target, kind: 'directory' }
    if (stats.isFile()) return { path: target, kind: 'file' }
  } catch {
    return missing
  }

  return missing
}

function statLocalPaths(cwd: unknown, paths: unknown): LocalPathStatPayload[] {
  if (!Array.isArray(paths)) return []

  const uniquePaths = [...new Set(paths.filter((path): path is string => typeof path === 'string'))]
  const limitedPaths = uniquePaths.slice(0, LOCAL_PATH_STAT_LIMIT)
  const allowExternalFileRead = readAppSettings().allowExternalFileRead
  const scope = localPathStatScope(cwd, allowExternalFileRead)
  if (!scope) return missingLocalPathStats(limitedPaths)

  return limitedPaths.map((path) => statLocalPath(path, scope, allowExternalFileRead))
}

function readFilePreviewBytes(target: string, bytesToRead: number): Buffer {
  if (bytesToRead <= 0) return Buffer.alloc(0)

  const fd = openSync(target, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

type FilePreviewBasePayload = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

type FilePreviewPayload = FilePreviewBasePayload &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
      }
    | {
        kind: 'html'
        mimeType: 'text/html'
        content: string
      }
    | {
        kind: 'image'
        mimeType: PreviewImageMimeType
        dataUrl: string
      }
    | {
        kind: 'pdf'
        mimeType: 'application/pdf'
        dataUrl: string
      }
  )

type FileHoverPreviewPayload = FilePreviewBasePayload &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
      }
    | {
        kind: 'spreadsheet'
        mimeType: 'text/csv' | 'text/tab-separated-values'
        format: 'csv' | 'tsv'
        content: string
      }
    | {
        kind: 'image'
        mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        dataUrl: string
      }
    | {
        kind: 'metadata'
        mimeType: string
        reason: 'binary' | 'large_file' | 'pdf' | 'unsupported_media'
      }
  )

function filePreviewBasePayload(
  target: string,
  stats: { size: number },
  previewBytes: number,
  truncated: boolean
): FilePreviewBasePayload {
  const scope = getLocalPathScope(target, listLocalProjectAllowRoots())
  return {
    path: target,
    name: basename(target),
    displayPath: scope?.displayPath ?? basename(target),
    rootPath: scope?.rootPath ?? dirname(target),
    rootLabel: scope?.rootLabel ?? basename(dirname(target)),
    bytes: stats.size,
    previewBytes,
    truncated
  }
}

function spreadsheetHoverPreviewType(
  path: string
):
  | { format: 'csv'; mimeType: 'text/csv' }
  | { format: 'tsv'; mimeType: 'text/tab-separated-values' }
  | null {
  const name = basename(path).toLowerCase()
  if (name.endsWith('.csv')) return { format: 'csv', mimeType: 'text/csv' }
  if (name.endsWith('.tsv') || name.endsWith('.tab')) {
    return { format: 'tsv', mimeType: 'text/tab-separated-values' }
  }
  return null
}

function createFilePreview(filePath: string): FilePreviewPayload {
  const target = assertLocalFilePathAllowed(filePath, '预览', { resolveSymlinks: true })
  const stats = statSync(target)
  if (!stats.isFile()) {
    throw new Error('只能预览文件内容')
  }

  const truncated = stats.size > FILE_PREVIEW_BYTES_LIMIT
  const previewBytes = readFilePreviewBytes(target, Math.min(stats.size, FILE_PREVIEW_BYTES_LIMIT))
  const base = filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated)
  const mediaType = mediaPreviewType(previewBytes)
  if (mediaType) {
    if (stats.size > FILE_MEDIA_PREVIEW_BYTES_LIMIT) {
      throw new Error('文件过大，暂不支持直接预览')
    }
    const mediaBytes =
      previewBytes.byteLength === stats.size
        ? previewBytes
        : readFilePreviewBytes(target, stats.size)
    if (mediaType.kind === 'image') {
      return {
        ...base,
        kind: 'image',
        mimeType: mediaType.mimeType,
        dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
        previewBytes: mediaBytes.byteLength,
        truncated: false
      }
    }

    return {
      ...base,
      kind: 'pdf',
      mimeType: 'application/pdf',
      dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
      previewBytes: mediaBytes.byteLength,
      truncated: false
    }
  }

  if (previewBytes.includes(0)) {
    throw new Error('暂不支持预览二进制文件')
  }

  if (/\.html?$/i.test(target) && stats.size <= FILE_HTML_PREVIEW_BYTES_LIMIT) {
    const htmlBytes =
      previewBytes.byteLength === stats.size
        ? previewBytes
        : readFilePreviewBytes(target, stats.size)
    return {
      ...base,
      kind: 'html',
      mimeType: 'text/html',
      content: htmlBytes.toString('utf8'),
      previewBytes: htmlBytes.byteLength,
      truncated: false
    }
  }

  return {
    ...base,
    kind: 'text',
    mimeType: 'text/plain',
    content: previewBytes.toString('utf8'),
    truncated
  }
}

function createFileHoverPreview(filePath: string): FileHoverPreviewPayload {
  const target = assertFileHoverPreviewPathAllowed(filePath)
  const stats = statSync(target)
  if (!stats.isFile()) {
    throw new Error('只能预览文件内容')
  }

  const sniffBytes = readFilePreviewBytes(
    target,
    Math.min(stats.size, FILE_HOVER_SNIFF_BYTES_LIMIT)
  )
  const base = filePreviewBasePayload(
    target,
    stats,
    sniffBytes.byteLength,
    stats.size > sniffBytes.byteLength
  )
  const mediaType = hoverMediaPreviewType(sniffBytes)

  if (mediaType?.kind === 'image') {
    if (stats.size > FILE_HOVER_IMAGE_BYTES_LIMIT) {
      return {
        ...base,
        kind: 'metadata',
        mimeType: mediaType.mimeType,
        reason: 'large_file',
        truncated: true
      }
    }

    const mediaBytes =
      sniffBytes.byteLength === stats.size ? sniffBytes : readFilePreviewBytes(target, stats.size)
    return {
      ...base,
      kind: 'image',
      mimeType: mediaType.mimeType,
      dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
      previewBytes: mediaBytes.byteLength,
      truncated: false
    }
  }

  if (mediaType?.kind === 'pdf') {
    return {
      ...base,
      kind: 'metadata',
      mimeType: 'application/pdf',
      reason: 'pdf',
      truncated: stats.size > sniffBytes.byteLength
    }
  }

  if (sniffBytes.includes(0)) {
    return {
      ...base,
      kind: 'metadata',
      mimeType: 'application/octet-stream',
      reason: 'binary',
      truncated: stats.size > sniffBytes.byteLength
    }
  }

  const previewBytes =
    sniffBytes.byteLength >= Math.min(stats.size, FILE_HOVER_TEXT_BYTES_LIMIT)
      ? sniffBytes
      : readFilePreviewBytes(target, Math.min(stats.size, FILE_HOVER_TEXT_BYTES_LIMIT))
  const truncated = stats.size > previewBytes.byteLength
  const spreadsheetType = spreadsheetHoverPreviewType(target)
  if (spreadsheetType) {
    return {
      ...filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated),
      kind: 'spreadsheet',
      mimeType: spreadsheetType.mimeType,
      format: spreadsheetType.format,
      content: previewBytes.toString('utf8')
    }
  }

  return {
    ...filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated),
    kind: 'text',
    mimeType: 'text/plain',
    content: previewBytes.toString('utf8')
  }
}

function openLocalFilePath(filePath: string): Promise<void> {
  const target = assertLocalFilePathAllowed(filePath, '打开', { resolveSymlinks: true })
  return shell.openPath(target).then((errorMessage) => {
    if (errorMessage) {
      throw new Error(errorMessage)
    }
  })
}

function readMacLaunchServicesHandlers(): Promise<MacLaunchServicesHandler[]> {
  if (macLaunchServicesHandlers) return macLaunchServicesHandlers

  macLaunchServicesHandlers = new Promise((resolveHandlers) => {
    execFile(
      '/usr/bin/plutil',
      [
        '-convert',
        'json',
        '-o',
        '-',
        join(
          homedir(),
          'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
        )
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 1200 },
      (error, stdout) => {
        if (error) {
          resolveHandlers([])
          return
        }
        try {
          const data = JSON.parse(stdout) as { LSHandlers?: unknown }
          resolveHandlers(
            Array.isArray(data.LSHandlers) ? (data.LSHandlers as MacLaunchServicesHandler[]) : []
          )
        } catch {
          resolveHandlers([])
        }
      }
    )
  })

  return macLaunchServicesHandlers
}

function macDefaultApplicationBundleIdForExtension(
  handlers: MacLaunchServicesHandler[],
  extension: string
): string | null {
  const extensionHandler = handlers.find(
    (handler) =>
      handler.LSHandlerContentTagClass === macFilenameExtensionTagClass &&
      handler.LSHandlerContentTag?.toLowerCase() === extension
  )
  const extensionBundleId =
    extensionHandler?.LSHandlerRoleAll ??
    extensionHandler?.LSHandlerRoleViewer ??
    extensionHandler?.LSHandlerRoleEditor
  if (extensionBundleId) return extensionBundleId.toLowerCase()

  const contentTypes = macContentTypesByExtension[extension] ?? []
  const contentTypeHandler = handlers.find(
    (handler) =>
      typeof handler.LSHandlerContentType === 'string' &&
      contentTypes.includes(handler.LSHandlerContentType.toLowerCase())
  )
  const contentTypeBundleId =
    contentTypeHandler?.LSHandlerRoleAll ??
    contentTypeHandler?.LSHandlerRoleViewer ??
    contentTypeHandler?.LSHandlerRoleEditor
  if (contentTypeBundleId) return contentTypeBundleId.toLowerCase()

  return macFallbackApplicationBundleIdByExtension[extension] ?? null
}

function macApplicationPathsForBundleId(bundleId: string): string[] {
  return macApplicationPathsByBundleId[bundleId.toLowerCase()] ?? []
}

function quoteMacSpotlightQueryValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

function readMacApplicationPathsForBundleId(bundleId: string): Promise<string[]> {
  const normalizedBundleId = bundleId.toLowerCase()
  const cached = macApplicationPathQueries.get(normalizedBundleId)
  if (cached) return cached

  const query = new Promise<string[]>((resolvePaths) => {
    execFile(
      '/usr/bin/mdfind',
      [`kMDItemCFBundleIdentifier == "${quoteMacSpotlightQueryValue(bundleId)}"`],
      { encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 1200 },
      (error, stdout) => {
        if (error) {
          resolvePaths([])
          return
        }
        resolvePaths(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        )
      }
    )
  })
  macApplicationPathQueries.set(normalizedBundleId, query)
  return query
}

async function getMacApplicationIconDataUrl(bundleId: string): Promise<string | null> {
  const applicationPaths = [
    ...(await readMacApplicationPathsForBundleId(bundleId)),
    ...macApplicationPathsForBundleId(bundleId)
  ]
  const visitedPaths = new Set<string>()

  for (const applicationPath of applicationPaths) {
    if (visitedPaths.has(applicationPath)) continue
    visitedPaths.add(applicationPath)
    try {
      const icon = await getNativeIconDataUrl(applicationPath)
      if (icon) return icon
    } catch {
      continue
    }
  }

  return null
}

async function getMacDefaultApplicationIconDataUrl(filePath: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null

  const extension = extname(filePath).slice(1).toLowerCase()
  if (!extension) return null

  const bundleId = macDefaultApplicationBundleIdForExtension(
    await readMacLaunchServicesHandlers(),
    extension
  )
  return bundleId ? getMacApplicationIconDataUrl(bundleId) : null
}

async function getNativeIconDataUrl(path: string): Promise<string | null> {
  const icon = await app.getFileIcon(path, { size: 'normal' })
  return icon.isEmpty() ? null : icon.toDataURL()
}

async function getLocalFileIconDataUrl(filePath: string): Promise<string | null> {
  const target = assertLocalFilePathAllowed(filePath, '读取图标', { resolveSymlinks: true })
  try {
    const defaultApplicationIcon = await getMacDefaultApplicationIconDataUrl(target)
    if (defaultApplicationIcon) return defaultApplicationIcon
    return getNativeIconDataUrl(target)
  } catch {
    return null
  }
}

function createDirectoryListing(dirPath: string): {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: Array<{
    path: string
    name: string
    displayPath: string
    kind: 'directory' | 'file'
  }>
  truncated: boolean
} {
  const projectRoots = listLocalProjectAllowRoots()
  const pathScope = currentLocalPathScope()
  const target = assertLocalFilePathAllowed(dirPath, '列出', {
    resolveSymlinks: true,
    projectRoots
  })
  const stats = statSync(target)
  if (!stats.isDirectory()) {
    throw new Error('只能列出文件夹内容')
  }

  const entries = readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(target, entry.name)
    let realEntryPath = entryPath
    try {
      realEntryPath = realpathSync(entryPath)
      if (!isLocalFilePathAllowed(realEntryPath, pathScope, projectRoots)) return []
      const entryStats = statSync(realEntryPath)
      if (!entryStats.isDirectory() && !entryStats.isFile()) return []
      const scope = getLocalPathScope(entryPath, projectRoots)
      return [
        {
          path: entryPath,
          name: entry.name,
          displayPath: scope?.displayPath ?? entry.name,
          kind: entryStats.isDirectory() ? ('directory' as const) : ('file' as const)
        }
      ]
    } catch {
      return []
    }
  })
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  const scope = getLocalPathScope(target, projectRoots)
  return {
    path: target,
    name: basename(target) || target,
    displayPath: scope?.displayPath ?? basename(target),
    rootPath: scope?.rootPath ?? target,
    rootLabel: scope?.rootLabel ?? basename(target),
    entries: entries.slice(0, DIRECTORY_ENTRY_LIMIT),
    truncated: entries.length > DIRECTORY_ENTRY_LIMIT
  }
}

function cancelPendingToolApprovals(scope?: { sessionId: string; runId: string }): void {
  const cancelled = cancelToolApprovals(scope) ?? []
  if (!scope) {
    notifyToolApprovalsCancelled()
    return
  }
  for (const request of cancelled) {
    sendToAllWindows('tool:approval-cancelled', request.requestId)
  }
}

function cancelPendingAgentUserInteractions(): void {
  cancelAgentUserInteractions()
  notifyAgentUserInteractionsCancelled()
}

function cancelPendingRunWaits(scope?: { sessionId: string; runId: string }): void {
  cancelPendingToolApprovals(scope)
  cancelPendingAgentUserInteractions()
}

async function abortSession(session: AgentSessionInstance): Promise<void> {
  cancelPendingRunWaits()
  await session.abort()
}

async function abortSessionWithoutCancellingApprovals(
  session: AgentSessionInstance
): Promise<void> {
  await session.abort({ preserveApprovals: true })
}

async function abortAndDisposeSession(
  session: AgentSessionInstance,
  options: { cancelApprovals: boolean }
): Promise<void> {
  if (options.cancelApprovals) {
    await abortSession(session)
  } else {
    await abortSessionWithoutCancellingApprovals(session)
  }
  await session.dispose()
}

async function cleanupSessionRecord(
  record: AgentSessionRecord | null,
  options: { cancelApprovals: boolean } = { cancelApprovals: false }
): Promise<void> {
  if (!record) return

  const controller = sessionAbortControllers.get(
    getSessionControllerKey(record.snapshot, record.generation)
  )
  controller?.abort()

  const barrier: { promise: Promise<void> | null } = { promise: null }
  barrier.promise = (async (): Promise<void> => {
    let resolvedPath = record.snapshot.path
    try {
      const { session } = await record.promise
      resolvedPath = session.sessionFile ?? resolvedPath
      if (
        resolvedPath &&
        barrier.promise &&
        cleanupBarriersByPath.get(resolvedPath) !== barrier.promise
      ) {
        cleanupBarriersByPath.set(resolvedPath, barrier.promise)
      }
      await abortAndDisposeSession(session, options)
    } catch (error) {
      if (
        !isStaleSessionError(error) &&
        !(mainWindowCleanupStarted && isExpectedShutdownCleanupError(error))
      ) {
        logUnexpectedError(error)
        console.error('Failed to clean up agent session:', error)
      }
    } finally {
      sessionAbortControllers.delete(getSessionControllerKey(record.snapshot, record.generation))
      if (barrier.promise) {
        unknownPathCleanupBarriers.delete(barrier.promise)
      }
      if (resolvedPath && cleanupBarriersByPath.get(resolvedPath) === barrier.promise) {
        cleanupBarriersByPath.delete(resolvedPath)
      }
    }
  })()

  if (record.snapshot.path) {
    cleanupBarriersByPath.set(record.snapshot.path, barrier.promise)
  } else if (barrier.promise) {
    unknownPathCleanupBarriers.add(barrier.promise)
  }

  await barrier.promise
}

async function waitForSessionCleanup(snapshot: SessionSnapshot): Promise<void> {
  if (snapshot.path) {
    await Promise.all([...unknownPathCleanupBarriers])
    await cleanupBarriersByPath.get(snapshot.path)
    return
  }

  await Promise.all([...unknownPathCleanupBarriers])
}

async function getCurrentResolvedSession(): Promise<AgentSessionResult | null> {
  const lifecycle = getCurrentLifecycle()
  const record = lifecycle.currentRecord
  if (!record) return null

  try {
    const result = await record.promise
    return lifecycle.isCurrent(record) ? result : null
  } catch (error) {
    if (!isStaleSessionError(error)) {
      throw error
    }
    return null
  }
}

async function getCurrentResolvedSessionIfReady(): Promise<AgentSessionResult | null> {
  const lifecycle = getCurrentLifecycle()
  const record = lifecycle.currentRecord
  if (!record) return null

  const pending = Symbol('pending')
  try {
    const result = await Promise.race([record.promise, Promise.resolve(pending)])
    if (result === pending) return null
    return lifecycle.isCurrent(record) ? result : null
  } catch (error) {
    if (!isStaleSessionError(error)) {
      throw error
    }
    return null
  }
}

async function getCurrentContextUsage(): Promise<CurrentContextUsage> {
  const current = getCurrentSessionPayload()
  const identity = {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration
  }
  const sessionKey = currentSessionKey
  const snapshot: SessionSnapshot = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (
    !runtimeSessionPathForSnapshot(sessionKey, snapshot) &&
    !(manifest?.projectLocation?.kind === 'ssh' && manifest.runtimeRef)
  ) {
    return { ...identity, usage: null }
  }

  const result =
    manifest?.projectLocation?.kind === 'ssh'
      ? await getCurrentResolvedSessionIfReady()
      : await getAgentSession(sessionKey, snapshot)
  if (!result) return { ...identity, usage: null }
  const usage = await result.session.getContextUsage()
  const latest = getCurrentSessionPayload()
  if (
    latest.path !== identity.sessionPath ||
    (latest.phiSessionId ?? null) !== identity.phiSessionId ||
    latest.sessionGeneration !== identity.sessionGeneration
  ) {
    return { ...identity, usage: null }
  }
  return { ...identity, usage }
}

function currentAutoCompactionManifest(target: unknown): {
  current: ReturnType<typeof getCurrentSessionPayload>
  manifest: PhiSessionManifest
  sessionKey: string
} {
  const current = getCurrentSessionPayload()
  const requested = target as Partial<ManualCompactionTarget> | null
  if (
    !requested ||
    requested.sessionPath !== current.path ||
    (requested.phiSessionId ?? null) !== (current.phiSessionId ?? null) ||
    requested.sessionGeneration !== current.sessionGeneration
  ) {
    throw new Error('会话已切换，请重新打开自动压缩设置')
  }
  const sessionKey = currentSessionKey
  const manifest = findPhiManifestForSession(sessionKey, current.path ?? undefined, current.cwd)
  if (!manifest) throw new Error('当前会话尚未建立设置记录')
  return { current, manifest, sessionKey }
}

function autoCompactionSettingsPatch(value: unknown): AutoCompactionSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('自动压缩设置无效')
  }
  const patch = value as Record<string, unknown>
  if (Object.keys(patch).some((key) => key !== 'enabled' && key !== 'thresholdPercent')) {
    throw new Error('自动压缩设置包含未知字段')
  }
  const result: AutoCompactionSettingsPatch = {}
  if ('enabled' in patch) {
    if (patch.enabled !== null && typeof patch.enabled !== 'boolean') {
      throw new Error('自动压缩开关无效')
    }
    result.enabled = patch.enabled
  }
  if ('thresholdPercent' in patch) {
    if (
      patch.thresholdPercent !== null &&
      patch.thresholdPercent !== 70 &&
      patch.thresholdPercent !== 80 &&
      patch.thresholdPercent !== 90
    ) {
      throw new Error('自动压缩阈值无效')
    }
    result.thresholdPercent = patch.thresholdPercent
  }
  return result
}

// Bind a control before its first await. RPC may advance its own checkpoint/runtime
// generation; the owner, lifecycle record, journal, project and host stay bound.
// Manual dispatch releases only the view fence so accepted work survives navigation.
function captureSessionControlTarget(
  sessionKey: string,
  phiSessionId: string,
  manual = false,
  requireIdle = true,
  viewBound = true
): {
  current: CurrentSessionPayload
  rpc: boolean
  assertCurrent(): void
  acceptManual(): void
  resolved(snapshot?: SessionSnapshot): Promise<AgentSessionResult | null>
} {
  const key = resolveSessionKeyAlias(sessionKey)
  const current = getCurrentSessionPayload()
  const lifecycle = getLifecycleForKey(key)
  const generation = lifecycle.currentGeneration
  const promptGeneration = getPromptGeneration(key)
  let record = lifecycle.currentRecord
  let initializing = false
  let acceptedManual = false
  const manifest = findPhiSessionById(phiSessionId)
  const binding = (value: typeof manifest): string => {
    const project = value?.projectId ? getProject(value.projectId) : undefined
    const location = value?.projectLocation
    const profile =
      location?.kind === 'ssh' ? getRemoteHostProfile(location.hostProfileId) : undefined
    return JSON.stringify([
      value?.projectId,
      value?.cwd,
      value?.cwdRealPath,
      location,
      project?.location,
      profile ? remoteConnectionConfigForProfile(profile) : null
    ])
  }
  const journal = (value: typeof manifest): string =>
    JSON.stringify([value?.runtimeRef?.ompSessionId, value?.runtimeRef?.journalBasename])
  const initialBinding = binding(manifest)
  let expectedJournal = journal(manifest)
  const rpc = Boolean(
    manifest?.runtimeRef || (remoteOmpRpcEnabled && manifest?.projectLocation?.kind === 'ssh')
  )
  const assertCurrent = (): void => {
    const latest = findPhiSessionById(phiSessionId)
    const requireSelected = viewBound && !acceptedManual
    const now = requireSelected ? getCurrentSessionPayload() : undefined
    if (
      (requireSelected &&
        (!now ||
          !sameCanonicalSessionKey(key, currentSessionKey) ||
          now.path !== current.path ||
          now.cwd !== current.cwd ||
          now.phiSessionId !== phiSessionId ||
          getCurrentLifecycle() !== lifecycle)) ||
      getPhiSessionIdForKey(key) !== phiSessionId ||
      getLifecycleForKey(key) !== lifecycle ||
      !lifecycle.isCurrentGeneration(generation) ||
      lifecycle.currentRecord !== record ||
      getPromptGeneration(key) !== promptGeneration ||
      binding(latest) !== initialBinding ||
      (!initializing && journal(latest) !== expectedJournal)
    )
      throw new StaleSessionError()
    if (
      requireIdle &&
      (hasActivePromptRun(key) ||
        runnerRegistry.getActiveRun(phiSessionId) ||
        (!manual && manualCompactionIds.has(phiSessionId)))
    )
      throw new Error('请等待当前会话运行结束后再修改压缩设置')
  }
  assertCurrent()
  return {
    current,
    rpc,
    assertCurrent,
    acceptManual: (): void => {
      assertCurrent()
      if (!manual) throw new Error('只有手动压缩操作可以进入后台执行')
      acceptedManual = true
    },
    resolved: async (snapshot?: SessionSnapshot): Promise<AgentSessionResult | null> => {
      assertCurrent()
      let pending = record?.promise
      if (!record && snapshot) {
        // getOrCreate installs this exact record synchronously without advancing
        // the Phi view generation. Only this call may adopt the initial attachment.
        initializing = !manifest?.runtimeRef
        pending = getAgentSession(key, snapshot, { assertCurrent })
        record = lifecycle.currentRecord
      }
      const result = pending ? await pending : null
      assertCurrent()
      if (requireIdle && rpc && result?.session.hasActiveAgentRuns?.())
        throw new Error('请等待专家任务运行结束后再修改会话')
      if (initializing) {
        expectedJournal = journal(findPhiSessionById(phiSessionId))
        initializing = false
      }
      assertCurrent()
      return result
    }
  }
}

async function getCurrentAutoCompactionSettings(
  target: unknown
): Promise<CurrentAutoCompactionSettings> {
  const { current, manifest, sessionKey } = currentAutoCompactionManifest(target)
  const captured = captureSessionControlTarget(sessionKey, manifest.sessionId, false, false)
  const ready = await captured.resolved()
  const receipt =
    captured.rpc && ready ? await ready.session.getAutoCompactionSettings?.(captured) : undefined
  captured.assertCurrent()
  const defaults =
    receipt?.defaults ??
    (captured.rpc
      ? (await readRpcCompactionPolicy(AGENT_DIR, manifest.autoCompaction ?? {})).defaults
      : await readAutoCompactionDefaults(current.cwd, AGENT_DIR))
  captured.assertCurrent()
  const overrides = findPhiSessionById(manifest.sessionId)?.autoCompaction ?? {}
  return {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration,
    enabled: receipt?.enabled ?? overrides.enabled ?? defaults.enabled,
    thresholdPercent:
      receipt?.thresholdPercent ?? overrides.thresholdPercent ?? defaults.thresholdPercent,
    defaults,
    overrides
  }
}

async function setCurrentAutoCompactionSettings(
  target: unknown,
  value: unknown
): Promise<CurrentAutoCompactionSettings> {
  const { current, manifest, sessionKey } = currentAutoCompactionManifest(target)
  const captured = captureSessionControlTarget(sessionKey, manifest.sessionId)
  const patch = autoCompactionSettingsPatch(value)
  const overrides: AutoCompactionOverrides = { ...(manifest.autoCompaction ?? {}) }
  if (patch.enabled === null) delete overrides.enabled
  else if (patch.enabled !== undefined) overrides.enabled = patch.enabled
  if (patch.thresholdPercent === null) delete overrides.thresholdPercent
  else if (patch.thresholdPercent !== undefined) overrides.thresholdPercent = patch.thresholdPercent
  const ready = await captured.resolved()
  // Resolve local/cold settings before any save. A live RPC receipt includes its
  // installation's baseline, so no new read can turn a committed success into failure.
  const defaults = captured.rpc
    ? ready
      ? undefined
      : (await readRpcCompactionPolicy(AGENT_DIR, overrides)).defaults
    : await readAutoCompactionDefaults(current.cwd, AGENT_DIR)
  captured.assertCurrent()
  const receipt = ready
    ? await ready.session.setAutoCompactionSettings(overrides, captured)
    : undefined
  captured.assertCurrent()
  const confirmedDefaults = receipt?.defaults ?? defaults
  if (!confirmedDefaults) throw new Error('远程自动压缩设置缺少已确认的默认策略')
  updateSessionManifest(manifest.sessionId, {
    autoCompaction: Object.keys(overrides).length > 0 ? overrides : undefined
  })
  notifySessionChanged()
  return {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration,
    enabled: receipt?.enabled ?? overrides.enabled ?? confirmedDefaults.enabled,
    thresholdPercent:
      receipt?.thresholdPercent ?? overrides.thresholdPercent ?? confirmedDefaults.thresholdPercent,
    defaults: confirmedDefaults,
    overrides
  }
}

async function compactCurrentSession(target: unknown): Promise<ManualCompactionOutcome> {
  const current = getCurrentSessionPayload()
  const requested = target as Partial<ManualCompactionTarget> | null
  if (
    !requested ||
    requested.sessionPath !== current.path ||
    (requested.phiSessionId ?? null) !== (current.phiSessionId ?? null) ||
    requested.sessionGeneration !== current.sessionGeneration
  ) {
    throw new Error('会话已切换，请重新打开压缩操作')
  }
  const sessionKey = currentSessionKey
  const snapshot: SessionSnapshot & { permissionMode: PermissionMode } = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  }
  if (hasActivePromptRun(sessionKey)) throw new Error('请等待当前会话运行结束后再压缩')
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (
    !runtimeSessionPathForSnapshot(sessionKey, snapshot) &&
    !(manifest?.projectLocation?.kind === 'ssh' && manifest.runtimeRef)
  ) {
    throw new Error('当前会话暂无可压缩的历史')
  }

  const phiSessionId = ensurePhiSessionId(sessionKey, snapshot)
  if (manualCompactionIds.has(phiSessionId)) throw new Error('上下文压缩正在进行')
  const captured = captureSessionControlTarget(sessionKey, phiSessionId, true)
  let finish!: () => void
  const operation: { session?: AgentSessionInstance; cancelled: boolean; done: Promise<void> } = {
    cancelled: false,
    done: new Promise<void>((resolve) => {
      finish = resolve
    })
  }
  const control = {
    assertCurrent: (): void => {
      if (operation.cancelled) throw new Error('上下文压缩已取消')
      captured.assertCurrent()
    }
  }
  manualCompactionIds.add(phiSessionId)
  manualCompactionOperations.set(phiSessionId, operation)
  const sessionPath = phiOnlySessionPath(phiSessionId)
  const sessionGeneration = getLifecycleForKey(sessionKey).currentGeneration
  const broadcast = (event: StoredSessionEvent): void => {
    sendToAllWindows('agent:event', {
      source: 'phi',
      ...event,
      phiSessionId,
      sessionPath,
      sessionGeneration,
      cwd: snapshot.cwd
    })
    notifySessionChanged()
  }

  try {
    const resolved = await captured.resolved(snapshot)
    control.assertCurrent()
    if (!resolved) throw new Error('当前会话暂无可压缩的历史')
    const { session } = resolved
    operation.session = session
    let result: Awaited<ReturnType<typeof session.compact>>
    try {
      captured.acceptManual()
      result = await session.compact(control)
      control.assertCurrent()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      try {
        broadcast(
          appendSessionEvent(phiSessionId, {
            type: 'context_compaction_failed',
            action: 'manual',
            reason: 'user',
            errorMessage: errorMessage.slice(0, 500)
          })
        )
      } catch (persistError) {
        logUnexpectedError(persistError)
      }
      throw error
    }

    broadcast(
      appendSessionEvent(phiSessionId, {
        type: 'context_compacted',
        action: 'manual',
        reason: 'user',
        summary: result.summary,
        ...(result.shortSummary ? { shortSummary: result.shortSummary } : {}),
        tokensBefore: result.tokensBefore,
        ...(result.tokensAfter === undefined ? {} : { tokensAfter: result.tokensAfter })
      })
    )
    return {
      sessionPath,
      phiSessionId,
      tokensBefore: result.tokensBefore,
      ...(result.tokensAfter === undefined ? {} : { tokensAfter: result.tokensAfter }),
      ...(result.shortSummary ? { shortSummary: result.shortSummary } : {})
    }
  } finally {
    manualCompactionOperations.delete(phiSessionId)
    manualCompactionIds.delete(phiSessionId)
    finish()
    flushPendingContinuations(phiSessionId, false)
  }
}

interface MainRuntimeRecoveryScope extends RuntimeRecoveryScope {
  readonly manifest: PhiSessionManifest
  readonly key: string
  readonly snapshot: SessionSnapshot & { permissionMode: PermissionMode }
  attach(replacement?: RuntimeRecoveryModelSelection): Promise<RuntimeRecoveryState>
}

async function captureRuntimeRecoveryScope(
  target: RuntimeRecoveryTarget
): Promise<MainRuntimeRecoveryScope> {
  const current = getCurrentSessionPayload()
  if (
    current.phiSessionId !== target.sessionId ||
    current.path !== target.sessionPath ||
    current.projectId !== target.projectId ||
    current.sessionGeneration !== target.sessionGeneration
  )
    throw new StaleSessionError()
  const manifest = findPhiSessionById(target.sessionId)
  if (
    !manifest ||
    manifest.projectId !== target.projectId ||
    manifest.projectLocation?.kind !== 'ssh'
  )
    throw new Error('恢复目标不是已绑定的远程会话')
  const key = resolveSessionKeyAlias(currentSessionKey)
  const snapshot = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  }
  const lifecycle = getLifecycleForKey(key)
  let generation = lifecycle.currentGeneration
  let record = lifecycle.currentRecord
  let promptGeneration = getPromptGeneration(key)
  let selected = true
  const readBinding = (): ReturnType<typeof resolveRemoteWorkspaceHostBinding> | undefined => {
    try {
      return resolveRemoteWorkspaceHostBinding({
        sessionId: target.sessionId,
        projectId: target.projectId
      })
    } catch {
      return undefined
    }
  }
  const selectedBinding = readBinding()
  const binding = selectedBinding?.cacheKey
  const journal = JSON.stringify([
    manifest.runtimeRef?.ompSessionId,
    manifest.runtimeRef?.journalBasename
  ])
  const currentProject = getProject(target.projectId)
  const readProject = (): string => {
    const project = getProject(target.projectId)
    const profile =
      project?.location.kind === 'ssh'
        ? getRemoteHostProfile(project.location.hostProfileId)
        : undefined
    return JSON.stringify([
      project?.location,
      project?.workingDirectory,
      profile ? remoteConnectionConfigForProfile(profile) : null,
      project?.location.kind === 'ssh' ? projectRemoteRuntimeRoot(project).configured : null
    ])
  }
  const projectBinding = readProject()
  const assertCurrent = (): void => {
    const latest = findPhiSessionById(target.sessionId)
    if (
      (selected &&
        (!sameCanonicalSessionKey(key, currentSessionKey) || currentCwd !== snapshot.cwd)) ||
      getLifecycleForKey(key) !== lifecycle ||
      !lifecycle.isCurrentGeneration(generation) ||
      lifecycle.currentRecord !== record ||
      getPromptGeneration(key) !== promptGeneration ||
      latest?.projectId !== target.projectId ||
      latest?.cwd !== snapshot.cwd ||
      JSON.stringify([latest?.runtimeRef?.ompSessionId, latest?.runtimeRef?.journalBasename]) !==
        journal ||
      readBinding()?.cacheKey !== binding ||
      readProject() !== projectBinding
    )
      throw new StaleSessionError()
  }
  assertCurrent()
  const pending = Symbol('pending')
  const resolved = record
    ? await Promise.race([record.promise, Promise.resolve(pending)]).catch(() => null)
    : null
  assertCurrent()
  const ready = resolved === pending ? null : resolved
  const busy = (): boolean =>
    Boolean(
      hasActivePromptRun(key) ||
      runnerRegistry.getActiveRun(target.sessionId) ||
      manualCompactionIds.has(target.sessionId) ||
      ready?.session.hasActiveAgentRuns?.() ||
      (record && resolved === pending)
    )
  const assertIdle = (): void => {
    if (busy()) throw new Error('请等待原会话和专家任务结束后再恢复')
  }
  let live = false
  if (ready && ownsRemoteRuntimeSession(ready.session.runtimeSessionId)) {
    try {
      live = getPhiEngine().sessions.has(ready.session.runtimeSessionId)
    } catch {
      live = false
    }
  }
  let issue: RuntimeRecoveryIssue =
    runtimeRecoveryFailures.get(target.sessionId) ??
    (manifest.runtimeRecoveryError
      ? describeRemoteRecoveryFailure(
          new RuntimeReferenceError(manifest.runtimeRecoveryError.code, '')
        ).issue
      : 'disconnected')
  let validReference = false
  if (manifest.runtimeRef) {
    try {
      const reference = parseRuntimeReference(manifest.runtimeRef, manifest.sessionId)
      if (!selectedBinding || currentProject?.location.kind !== 'ssh')
        throw new Error('项目或主机身份不匹配')
      assertRuntimeReferenceProject(manifest, {
        ...reference,
        hostProfileId: currentProject.location.hostProfileId,
        bindingHash: facadeBindingHash(selectedBinding),
        projectId: currentProject.id,
        projectRoot: selectedBinding.canonicalRoot
      })
      assertRuntimeScope(reference, {
        ...reference,
        hostProfileId: currentProject.location.hostProfileId,
        bindingHash: facadeBindingHash(selectedBinding),
        projectId: currentProject.id,
        projectRoot: selectedBinding.canonicalRoot
      })
      validReference = true
    } catch (error) {
      issue = selectedBinding ? describeRemoteRecoveryFailure(error).issue : 'binding-changed'
    }
  }
  if (!remoteOmpRpcEnabled) issue = 'not-enabled'
  if (
    remoteOmpRpcEnabled &&
    manifest.model &&
    !busy() &&
    !runtimeRecoveryOperations.has(target.sessionId)
  ) {
    const runtime = await getAuthManager().getRuntime()
    assertCurrent()
    const saved = resolveRuntimeModelSelection(runtime, manifest.model)
    if (!saved || saved.migratedFrom) issue = 'model-unavailable'
  }
  const state: RuntimeRecoveryState = {
    target,
    phase: live
      ? 'connected'
      : busy() || runtimeRecoveryOperations.has(target.sessionId)
        ? 'busy'
        : manifest.runtimeRef || manifest.runtimeRecoveryError
          ? 'recovery-required'
          : 'not-started',
    issue,
    message: runtimeRecoveryMessage(issue),
    canResume: !live && !busy() && remoteOmpRpcEnabled && validReference,
    canContinueFromSummary:
      remoteOmpRpcEnabled &&
      Boolean(manifest.runtimeRef || manifest.runtimeRecoveryError) &&
      currentProject?.location.kind === 'ssh',
    ...(manifest.model ? { savedModel: manifest.model } : {})
  }
  const scope: MainRuntimeRecoveryScope = {
    state,
    manifest,
    key,
    snapshot,
    assertCurrent,
    assertIdle,
    attach: async (replacement) => {
      assertCurrent()
      assertIdle()
      if (state.issue === 'model-unavailable' && !replacement)
        throw new RemoteRecoveryError('MODEL_UNAVAILABLE', '请先选择可用的替代模型')
      const controller = new AbortController()
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      runtimeRecoveryOperations.set(target.sessionId, { controller, done })
      try {
        const previous = lifecycle.advance()
        generation = lifecycle.currentGeneration
        record = lifecycle.currentRecord
        advancePromptGeneration(key)
        promptGeneration = getPromptGeneration(key)
        selected = false
        notifySessionChanged()
        await cleanupSessionRecord(previous)
        assertCurrent()
        controller.signal.throwIfAborted()
        const creating = getAgentSession(
          key,
          snapshot,
          {
            signal: controller.signal,
            assertCurrent: () => {
              controller.signal.throwIfAborted()
              assertCurrent()
            }
          },
          { ...(replacement ? { replacementModel: replacement } : {}) }
        )
        record = lifecycle.currentRecord
        const result = await creating
        assertCurrent()
        controller.signal.throwIfAborted()
        if (
          !ownsRemoteRuntimeSession(result.session.runtimeSessionId) ||
          !getPhiEngine().sessions.has(result.session.runtimeSessionId)
        )
          throw new Error('原远程会话尚未确认连接')
        const confirmed = findPhiSessionById(target.sessionId)
        if (confirmed?.model)
          sessionModelSelections.set(resolveSessionKeyAlias(key), confirmed.model)
        if (confirmed?.thinkingLevel === undefined)
          sessionThinkingLevels.delete(resolveSessionKeyAlias(key))
        else sessionThinkingLevels.set(resolveSessionKeyAlias(key), confirmed.thinkingLevel)
        runtimeRecoveryFailures.delete(target.sessionId)
        notifySessionChanged()
        return {
          ...state,
          target: { ...target, sessionGeneration: generation },
          phase: 'connected',
          issue: undefined,
          message: '原会话已恢复，未重发消息或任务。',
          canResume: false
        }
      } catch (error) {
        runtimeRecoveryFailures.set(target.sessionId, describeRemoteRecoveryFailure(error).issue)
        notifySessionChanged()
        throw error
      } finally {
        runtimeRecoveryOperations.delete(target.sessionId)
        finish()
      }
    }
  }
  return scope
}

const runtimeRecoveryController = createRuntimeRecoveryController<MainRuntimeRecoveryScope>({
  capture: captureRuntimeRecoveryScope,
  resolveModel: async (selection, scope) => {
    const runtime = await getAuthManager().getRuntime()
    scope.assertCurrent()
    const resolved = resolveRuntimeModelSelection(runtime, selection)
    if (!resolved || resolved.migratedFrom)
      throw new RemoteRecoveryError('MODEL_UNAVAILABLE', '所选替代模型目前不可用')
    return resolved.selection
  },
  resume: (scope, replacement) => scope.attach(replacement),
  summarize: (scope) =>
    buildRuntimeRecoverySummary({
      sourceSessionId: scope.manifest.sessionId,
      projectId: scope.manifest.projectId ?? null,
      events: readSessionEvents(scope.manifest.sessionId)
    }),
  continueFromSummary: async (scope, summary: RuntimeRecoverySummary) => {
    scope.assertCurrent()
    scope.assertIdle()
    const created = createRemoteManagedSession(scope.manifest.projectId!)
    appendSessionEvent(created.sessionId, {
      type: 'runtime_recovery_summary',
      content: summary.content,
      provenance: summary.provenance,
      contentSha256: createHash('sha256').update(summary.content).digest('hex')
    })
    const switched = await disposeAndSwitchSession(
      created.path,
      created.cwd,
      created.permissionMode
    )
    return {
      path: created.path,
      phiSessionId: created.sessionId,
      projectId: scope.manifest.projectId!,
      sessionGeneration: switched.sessionGeneration,
      sourceSessionId: scope.manifest.sessionId,
      connected: false
    }
  }
})

function getCurrentSessionPayload(): CurrentSessionPayload {
  currentPermissionMode = resolveSessionPermissionMode(currentSessionKey, {
    path: currentSessionPath,
    cwd: currentCwd
  })
  const manifest = findPhiManifestForSession(currentSessionKey, currentSessionPath, currentCwd)
  const phiSessionId = manifest?.sessionId ?? getPhiSessionIdForKey(currentSessionKey)
  const path = phiSessionId ? phiOnlySessionPath(phiSessionId) : (currentSessionPath ?? null)
  const project = manifest?.projectId ? getProject(manifest.projectId) : getProjectByCwd(currentCwd)
  const projectLocation = manifest?.projectLocation ?? project?.location
  return {
    path,
    ...(phiSessionId ? { phiSessionId } : {}),
    cwd: currentCwd,
    displayCwd: projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : currentCwd,
    ...(manifest?.projectId || project?.id
      ? { projectId: manifest?.projectId ?? project?.id }
      : {}),
    ...(projectLocation ? { projectLocation } : {}),
    sessionGeneration: getCurrentLifecycle().currentGeneration,
    permissionMode: currentPermissionMode,
    ...getSessionStatusPayload(currentSessionKey, currentSessionPath, currentCwd)
  }
}

async function getCurrentSessionPayloadWithMessages(): Promise<
  ReturnType<typeof getCurrentSessionPayload> & {
    messages: unknown[]
  }
> {
  const payload = getCurrentSessionPayload()
  const phiSessionId = payload.phiSessionId ?? getPhiSessionIdForKey(currentSessionKey)
  if (!payload.path && !phiSessionId) {
    return { ...payload, messages: [] }
  }

  const current = payload.path
    ? phiSessionId
      ? await getCurrentResolvedSessionIfReady()
      : await getCurrentResolvedSession()
    : null
  return {
    ...payload,
    messages: [
      ...(current?.session.messages ?? []),
      ...readPhiTimelineMessages(
        current?.session.sessionFile ?? payload.path,
        payload.cwd,
        phiSessionId
      )
    ]
  }
}

function notifySessionChanged(): void {
  const payload = getCurrentSessionPayload()
  void browserWorkspaceRegistry?.setActiveSession(payload.phiSessionId ?? null).catch(() => {
    writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
  })
  sendToAllWindows('sessions:changed', payload)
}

function notifyProjectParallelRun(
  sessionGeneration: number,
  sessionPath: string | undefined,
  cwd: string,
  activeCount: number
): void {
  const window = getActiveWindow()
  sendToWindow(window, 'agent:event', {
    type: 'project_parallel_warning',
    sessionGeneration,
    sessionPath: sessionPath ?? null,
    cwd,
    activeCount
  })
}

function countOtherActiveProjectRuns(projectId: string, sessionKey: string): number {
  return [...activePromptRuns.values()].filter(
    (run) => run.projectId === projectId && run.sessionKey !== sessionKey
  ).length
}

function requireProject(id: string): Project {
  const project = getProject(id)
  if (!project) throw new Error('项目不存在')
  return project
}

/** The session manager cwd memory is keyed by: the project directory or the remote anchor. */
function projectMemoryTarget(project: Project): { agentDir: string; cwd: string } {
  return {
    agentDir: AGENT_DIR,
    cwd:
      project.location.kind === 'ssh'
        ? ensureRemoteProjectAnchor(project.id)
        : project.workingDirectory
  }
}

async function projectMemorySnapshot(id: string): Promise<ProjectMemorySnapshot> {
  const project = requireProject(id)
  const files = await getPhiEngine().memory.read(projectMemoryTarget(project))
  return {
    projectId: id,
    settings: normalizeProjectMemorySettings(project.memory),
    summary: files.summary,
    summaryUpdatedAt: files.summaryUpdatedAt,
    lessons: files.lessons
  }
}

async function invalidateAgentSession(): Promise<void> {
  const phiSessionId = getPhiSessionIdForKey(currentSessionKey)
  if (phiSessionId) loadedSkillNamesBySession.delete(phiSessionId)
  const lifecycle = getCurrentLifecycle()
  const previous = lifecycle.advance()
  advancePromptGeneration(currentSessionKey)
  const activePromptRun = getActivePromptRun(currentSessionKey)
  if (activePromptRun) {
    activePromptRun.cancelled = true
    cancelBrowserRun(activePromptRun)
    void cleanupBrowserRunTabs(activePromptRun)
  }
  cancelPendingRunWaits(
    activePromptRun
      ? { sessionId: activePromptRun.phiSessionId, runId: activePromptRun.runId }
      : undefined
  )
  notifySessionChanged()
  void cleanupSessionRecord(previous)
}

async function stopActivePrompt(): Promise<void> {
  // Invalidate queued work even before its queue callback sets activePromptRun.
  advancePromptGeneration(currentSessionKey)
  const run = getActivePromptRun(currentSessionKey)
  if (!run) {
    const phiSessionId = getPhiSessionIdForKey(currentSessionKey)
    const recovery = phiSessionId ? runtimeRecoveryOperations.get(phiSessionId) : undefined
    if (recovery) {
      recovery.controller.abort(new Error('会话恢复已取消'))
      await recovery.done
      return
    }
    const operation = phiSessionId ? manualCompactionOperations.get(phiSessionId) : undefined
    if (operation) {
      operation.cancelled = true
      try {
        if (operation.session) await operation.session.abort()
      } finally {
        await operation.done
      }
    }
    return
  }

  await stopPromptRun(currentSessionKey, run, false)
}

async function stopPromptRun(
  sessionKey: string,
  run: PromptRun,
  invalidateGeneration = true
): Promise<void> {
  if (invalidateGeneration) advancePromptGeneration(sessionKey)
  run.cancelled = true
  cancelBrowserRun(run)
  const browserCleanup = cleanupBrowserRunTabs(run)
  remoteBashManager.cancelSession(run.phiSessionId)
  remoteMutationManager.cancelSession(run.phiSessionId)
  runnerRegistry.stopRun(run.phiSessionId)
  cancelPendingRunWaits({ sessionId: run.phiSessionId, runId: run.runId })
  if (run.session) {
    await Promise.all([browserCleanup, abortSessionWithoutCancellingApprovals(run.session)])
  } else {
    await browserCleanup
  }
}

function stopAllPromptRuns(): {
  browserCleanup: Promise<void>
  runtimeAbort: Promise<void>
} {
  remoteBashManager.cancelAll()
  remoteMutationManager.cancelAll()
  const recoveries = [...runtimeRecoveryOperations.values()]
  for (const recovery of recoveries) recovery.controller.abort()
  const runs = [...activePromptRuns.values()]
  for (const [sessionKey, run] of activePromptRuns) {
    advancePromptGeneration(sessionKey)
    run.cancelled = true
    cancelBrowserRun(run)
  }
  const browserCleanup = Promise.all(runs.map((run) => cleanupBrowserRunTabs(run)))
  runnerRegistry.stopAll()
  cancelPendingRunWaits()
  const runtimeAbort = Promise.all([
    ...recoveries.map((recovery) => recovery.done),
    ...runs.map(async (run) => {
      if (!run.session) return
      await abortSessionWithoutCancellingApprovals(run.session)
    })
  ]).then(() => undefined)
  return { browserCleanup: browserCleanup.then(() => undefined), runtimeAbort }
}

function safeCleanupStep(event: string, run: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(run()).catch(() => {
      writeAppLog({ level: 'error', event })
    })
  } catch {
    writeAppLog({ level: 'error', event })
    return Promise.resolve()
  }
}

async function disposeRemoteNotebookBackends(): Promise<void> {
  const backends = [...remoteNotebookBackends.values()]
  remoteNotebookBackends.clear()
  remoteNotebookSessionIds.clear()
  await Promise.all(backends.map((backend) => backend.dispose()))
}

async function disposeRemoteNotebookBackend(projectId: string): Promise<void> {
  const backend = remoteNotebookBackends.get(projectId)
  if (!backend) return
  await backend.dispose()
  remoteNotebookBackends.delete(projectId)
  remoteNotebookSessionIds.delete(projectId)
}

function cleanupMainWindowRuntime(): Promise<void> {
  if (mainWindowCleanupPromise) return mainWindowCleanupPromise
  mainWindowCleanupStarted = true
  sessionTitleGenerator?.dispose()
  mainWindowCleanupPromise = Promise.resolve().then(async () => {
    let promptShutdown = {
      browserCleanup: Promise.resolve(),
      runtimeAbort: Promise.resolve()
    }
    try {
      promptShutdown = stopAllPromptRuns()
    } catch {
      writeAppLog({ level: 'error', event: 'prompt_shutdown_failed' })
    }
    void promptShutdown.runtimeAbort.catch(() => {
      writeAppLog({ level: 'error', event: 'agent_runtime_abort_failed' })
    })
    await Promise.allSettled([
      promptShutdown.browserCleanup,
      safeCleanupStep('terminal_cleanup_failed', () => disposeTerminalManager()),
      safeCleanupStep('notebook_watcher_cleanup_failed', () => notebookFileWatcher.dispose()),
      safeCleanupStep('jupyter_cleanup_failed', () => jupyterServerRegistry.disposeAll()),
      safeCleanupStep('remote_jupyter_cleanup_failed', disposeRemoteNotebookBackends),
      safeCleanupStep('remote_upload_cleanup_failed', () => remoteProjectUploads.dispose()),
      safeCleanupStep('agent_session_cleanup_failed', () => invalidateAgentSession()),
      safeCleanupStep('cursor_bridge_cleanup_failed', () => cursorH2Bridge.close())
    ])
    await Promise.allSettled([cleanupBrowserWorkspaceRegistry()])
  })
  return mainWindowCleanupPromise
}

// A user-visible conversation switch points future getAgentSession() calls at a
// different file/cwd/permission mode. It deliberately does not abort the old
// session: switching conversations is navigation, not stop.
async function disposeAndSwitchSession(
  path: string | undefined,
  cwd: string = getNoProjectTaskFolder(),
  permissionMode: PermissionMode = 'auto',
  options: { notify?: boolean } = {}
): Promise<{
  path: string | null
  cwd: string
  displayCwd: string
  projectId?: string
  projectLocation?: ProjectLocation
  sessionGeneration: number
  permissionMode: PermissionMode
}> {
  if (!path) {
    freshSessionCounter += 1
  }
  currentSessionPath = path
  currentCwd = cwd
  currentSessionKey = createSessionKey(path, cwd)
  currentPermissionMode = resolveSessionPermissionMode(currentSessionKey, { path, cwd })
  if (!path) {
    sessionPermissionModes.set(resolveSessionKeyAlias(currentSessionKey), permissionMode)
    currentPermissionMode = permissionMode
  }
  const target = getCurrentSessionPayload()
  try {
    await browserWorkspaceRegistry?.setActiveSession(target.phiSessionId ?? null)
  } catch {
    writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
  }
  if (options.notify !== false) {
    notifySessionChanged()
  }
  return target
}

async function getAgentSession(
  sessionKey: string = currentSessionKey,
  snapshot: SessionSnapshot = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  },
  control?: import('./agent/engine/types').RuntimeSelectionControl,
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
): Promise<AgentSessionResult> {
  const lifecycle = getLifecycleForKey(sessionKey)
  const record = lifecycle.getOrCreate(
    snapshot,
    async (creationSnapshot, generation) => {
      control?.assertCurrent()
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      const sessionManifest = findPhiManifestForSession(
        sessionKey,
        creationSnapshot.path,
        creationSnapshot.cwd
      )
      const project = sessionManifest?.projectId
        ? getProject(sessionManifest.projectId)
        : getProjectByCwd(creationSnapshot.cwd)
      const remoteProject =
        sessionManifest?.projectLocation?.kind === 'ssh' &&
        typeof sessionManifest.projectId === 'string'
          ? { projectId: sessionManifest.projectId, location: sessionManifest.projectLocation }
          : null
      if (
        !remoteProject &&
        (project?.location?.kind === 'ssh' ||
          isRemoteProjectAnchorPath(creationSnapshot.cwd, AGENT_DIR))
      ) {
        throw new Error('远程项目旧会话缺少服务器位置绑定，已拒绝在本机执行工具；请新建远程会话')
      }
      if (
        remoteProject &&
        (!project ||
          project.location.kind !== 'ssh' ||
          resolve(creationSnapshot.cwd) !== resolve(remoteProjectAnchorPath(project.id)) ||
          remoteProject.projectId !== project.id ||
          project.location.hostProfileId !== remoteProject.location.hostProfileId ||
          project.location.canonicalRoot !== remoteProject.location.canonicalRoot)
      ) {
        throw new Error('远程项目会话归属无效，请重新选择项目')
      }
      const initialPromptGeneration = getPromptGeneration(sessionKey)
      const initialRun = getActivePromptRun(sessionKey)
      const ownerBinding = (): string => {
        const latest = findPhiManifestForSession(
          sessionKey,
          creationSnapshot.path,
          creationSnapshot.cwd
        )
        const latestProject = latest?.projectId
          ? getProject(latest.projectId)
          : getProjectByCwd(creationSnapshot.cwd)
        return JSON.stringify([
          latest?.sessionId,
          latest?.projectId,
          latest?.cwd,
          latest?.cwdRealPath,
          latest?.projectLocation,
          latestProject?.location,
          normalizeProjectMemorySettings(latestProject?.memory)
        ])
      }
      const initialOwnerBinding = ownerBinding()
      const initialJournal = JSON.stringify([
        sessionManifest?.runtimeRef?.ompSessionId,
        sessionManifest?.runtimeRef?.journalBasename
      ])
      const remoteBinding = remoteProject
        ? resolveRemoteWorkspaceHostBinding({
            sessionId: sessionManifest!.sessionId,
            projectId: remoteProject.projectId
          }).cacheKey
        : undefined
      const assertCreationCurrent = (allowInitialAdoption = false): void => {
        control?.assertCurrent()
        const latest = findPhiManifestForSession(
          sessionKey,
          creationSnapshot.path,
          creationSnapshot.cwd
        )
        if (
          !lifecycle.isCurrentGeneration(generation) ||
          getPromptGeneration(sessionKey) !== initialPromptGeneration ||
          (initialRun && (initialRun.cancelled || getActivePromptRun(sessionKey) !== initialRun)) ||
          ownerBinding() !== initialOwnerBinding ||
          ((!allowInitialAdoption || sessionManifest?.runtimeRef) &&
            JSON.stringify([
              latest?.runtimeRef?.ompSessionId,
              latest?.runtimeRef?.journalBasename
            ]) !== initialJournal) ||
          (remoteProject &&
            resolveRemoteWorkspaceHostBinding({
              sessionId: sessionManifest!.sessionId,
              projectId: remoteProject.projectId
            }).cacheKey !== remoteBinding)
        ) {
          throw new StaleSessionError()
        }
      }
      assertCreationCurrent()
      await waitForSessionCleanup(creationSnapshot)
      assertCreationCurrent()
      const useRpc = remoteOmpRpcEnabled && remoteProject !== null
      if (sessionManifest?.runtimeRef && !useRpc) {
        throw new Error('此会话属于远程 RPC 运行时，请启用对应运行路径后显式恢复')
      }
      const remoteContextFiles = remoteProject
        ? await loadRemoteProjectInstructions(remoteProject.location)
        : null
      assertCreationCurrent()
      const runtime = await getAuthManager().getRuntime()
      assertCreationCurrent()
      const modelSelection =
        remoteRecovery?.replacementModel ??
        resolveSessionModelSelection(sessionKey, creationSnapshot)
      if (useRpc && !modelSelection) {
        throw new Error('远程 RPC 对话暂不支持自动模型，请选择具体模型')
      }
      const resolvedModel = modelSelection
        ? resolveRuntimeModelSelection(runtime, modelSelection)
        : null
      const model = resolvedModel?.model
      if (
        (remoteRecovery || (useRpc && sessionManifest?.runtimeRef)) &&
        modelSelection &&
        (!resolvedModel || resolvedModel.migratedFrom)
      )
        throw new RemoteRecoveryError('MODEL_UNAVAILABLE', '原模型目前不可用，必须显式选择替代模型')
      if (modelSelection && !resolvedModel) {
        throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
      }
      if (resolvedModel?.migratedFrom) {
        sessionModelSelections.set(resolveSessionKeyAlias(sessionKey), resolvedModel.selection)
        const run = getActivePromptRun(sessionKey)
        const phiSessionId = run?.phiSessionId ?? getPhiSessionIdForKey(sessionKey)
        if (phiSessionId) {
          const stored = appendSessionEvent(phiSessionId, {
            type: 'model_selection_migrated',
            ...(run ? { runId: run.runId } : {}),
            fromProviderId: resolvedModel.migratedFrom.providerId,
            fromModelId: resolvedModel.migratedFrom.modelId,
            toProviderId: resolvedModel.selection.providerId,
            toModelId: resolvedModel.selection.modelId,
            toModelName: resolvedModel.model.name
          })
          updateSessionManifest(phiSessionId, { model: resolvedModel.selection })
          const targetWindow = getActiveWindow()
          const sessionPath = uiSessionPathForKey(sessionKey, creationSnapshot.path)
          sendToWindow(targetWindow, 'agent:event', {
            ...stored,
            phiSessionId,
            sessionGeneration: generation,
            sessionPath,
            cwd: creationSnapshot.cwd
          })
        }
      }
      const desiredThinking = resolveSessionThinkingLevel(sessionKey, creationSnapshot)
      const thinkingLevel =
        useRpc && model ? selectionThinking(model, desiredThinking).phi : desiredThinking
      const sessionAbortController = new AbortController()
      sessionAbortControllers.set(
        getSessionControllerKey(creationSnapshot, generation),
        sessionAbortController
      )

      let resourceLoader: RuntimeResourceLoader | undefined
      const notebookPrompt = remoteProject ? null : notebookAgentRuntimePrompt(creationSnapshot.cwd)
      // Phi scans its own agent definitions (plus legacy layouts for compatibility).
      // The same scan feeds the leader prompt here and the delegation tools the
      // worker builds, so the two can never disagree.
      const agentScan = useRpc
        ? { agents: [], diagnostics: [] }
        : remoteProject
          ? await loadRemoteAgentCatalog({
              sessionId: sessionManifest?.sessionId ?? '',
              projectId: remoteProject.projectId,
              cwd: creationSnapshot.cwd,
              agentDir: AGENT_DIR,
              bundledDir: getBundledAgentsDir()
            })
          : discoverPhiAgents({
              cwd: creationSnapshot.cwd,
              agentDir: AGENT_DIR,
              bundledDir: getBundledAgentsDir()
            })
      assertCreationCurrent()
      const remoteSkillCatalog = remoteProject
        ? await loadRemoteProjectSkillCatalog({
            sessionId: sessionManifest?.sessionId ?? '',
            projectId: remoteProject.projectId,
            cwd: creationSnapshot.cwd,
            agentDir: AGENT_DIR
          })
        : undefined
      assertCreationCurrent()
      const remoteMcpCatalog: RemoteProjectMcpCatalog | undefined = remoteProject
        ? await loadRemoteProjectMcpCatalog({
            sessionId: sessionManifest?.sessionId ?? '',
            projectId: remoteProject.projectId,
            cwd: creationSnapshot.cwd,
            agentDir: AGENT_DIR
          })
        : undefined
      assertCreationCurrent()
      const personaMarkdown = getPersonaMarkdown()
      for (const diagnostic of agentScan.diagnostics) {
        writeAppLog({
          event:
            diagnostic.level === 'warning'
              ? 'agent_definition_warning'
              : 'agent_definition_invalid',
          metadata: { filePath: diagnostic.filePath, message: diagnostic.message }
        })
      }
      const agentLeaderPrompt = buildAgentLeaderPrompt(agentScan.agents)
      const appendSystemPrompt = [
        ...(notebookPrompt ? [notebookPrompt] : []),
        ...(agentLeaderPrompt ? [agentLeaderPrompt] : [])
      ]
      const shouldLoadCoreSkill = !remoteProject && existsSync(getCoreAuthoringSkillDir())
      const extensionFactories = !useRpc
        ? [
            createApprovalExtension({
              signal: sessionAbortController.signal,
              classifyTool: (toolName, input) =>
                remoteProject
                  ? remoteRuntimeController.approvalFor(toolName, input)
                  : skillHost.approvalFor(toolName, input),
              shouldGate: () =>
                resolveSessionPermissionMode(sessionKey, creationSnapshot) === 'ask',
              getContext: (event) => {
                const run = getActivePromptRun(sessionKey)
                const phiSessionId = run?.phiSessionId ?? sessionManifest?.sessionId
                if (!phiSessionId) return null
                const remoteHost =
                  project?.location.kind === 'ssh'
                    ? getRemoteHostProfile(project.location.hostProfileId)
                    : undefined
                if (project?.location.kind === 'ssh' && !remoteHost) {
                  throw new Error('远程项目的 SSH 服务器档案不可用')
                }
                return {
                  sessionId: phiSessionId,
                  sessionPath: phiOnlySessionPath(phiSessionId),
                  sessionGeneration: run?.sessionGeneration ?? generation,
                  runId: event?.agentRunId ?? run?.runId ?? 'background-agent',
                  cwd:
                    project?.location.kind === 'ssh' && remoteHost
                      ? `ssh://${remoteHost.hostAlias}${project.location.canonicalRoot}`
                      : creationSnapshot.cwd,
                  ...(project?.location.kind === 'ssh' && remoteHost
                    ? {
                        scopeNote: remoteBashApprovalScope(
                          remoteHost.hostAlias,
                          project.location.canonicalRoot
                        ),
                        writeScopeNote: `SSH ${remoteHost.hostAlias} · 项目 ${project.location.canonicalRoot}；新建文件或修改已读取且未变化的文件。`
                      }
                    : {}),
                  ...(project?.name ? { projectName: project.name } : {})
                }
              },
              onApprovalRequested: (request) => {
                if (!request.sessionId) return
                if (request.agentRunId && request.cwd) {
                  backgroundAgentApprovals.requested({
                    sessionId: request.sessionId,
                    agentRunId: request.agentRunId,
                    approvalId: request.requestId,
                    toolName: request.toolName,
                    summary: request.summary,
                    cwd: request.cwd
                  })
                } else {
                  runnerRegistry.markNeedsApproval(request.sessionId, request.requestId, {
                    toolName: request.toolName,
                    summary: request.summary
                  })
                }
              },
              onApprovalResolved: (request, approved) => {
                if (!request.sessionId) return
                if (approved) {
                  if (
                    remoteProject &&
                    request.toolName === 'bash' &&
                    request.toolCallId &&
                    request.approvalDigest &&
                    request.cwd
                  ) {
                    approvedRemoteBashCalls.set(
                      remoteBashApprovalKey(request.sessionId, request.toolCallId),
                      {
                        projectId: remoteProject.projectId,
                        approvedCwd: request.cwd,
                        approvalDigest: request.approvalDigest,
                        expiresAt: Date.now() + 120_000
                      }
                    )
                  }
                  if (
                    remoteProject &&
                    request.toolName === 'write' &&
                    request.toolCallId &&
                    request.approvalDigest &&
                    request.cwd
                  ) {
                    approvedRemoteWriteCalls.set(
                      remoteBashApprovalKey(request.sessionId, request.toolCallId),
                      {
                        projectId: remoteProject.projectId,
                        approvedCwd: request.cwd,
                        approvalDigest: request.approvalDigest,
                        expiresAt: Date.now() + 120_000
                      }
                    )
                  }
                  if (
                    remoteProject &&
                    request.toolName === 'edit' &&
                    request.toolCallId &&
                    request.approvalDigest &&
                    request.cwd
                  ) {
                    approvedRemoteEditCalls.set(
                      remoteBashApprovalKey(request.sessionId, request.toolCallId),
                      {
                        projectId: remoteProject.projectId,
                        approvedCwd: request.cwd,
                        approvalDigest: request.approvalDigest,
                        expiresAt: Date.now() + 120_000
                      }
                    )
                  }
                  if (request.agentRunId) {
                    backgroundAgentApprovals.resolved(request.requestId, 'approved')
                  } else {
                    runnerRegistry.markApprovalApproved(request.sessionId, request.requestId)
                  }
                } else {
                  if (remoteProject && request.toolCallId) {
                    approvedRemoteBashCalls.delete(
                      remoteBashApprovalKey(request.sessionId, request.toolCallId)
                    )
                    approvedRemoteWriteCalls.delete(
                      remoteBashApprovalKey(request.sessionId, request.toolCallId)
                    )
                    approvedRemoteEditCalls.delete(
                      remoteBashApprovalKey(request.sessionId, request.toolCallId)
                    )
                  }
                  if (request.agentRunId) {
                    backgroundAgentApprovals.resolved(request.requestId, 'denied')
                  } else {
                    runnerRegistry.markApprovalDenied(request.sessionId, request.requestId)
                  }
                }
              },
              onApprovalCancelled: (request) => {
                if (!request.sessionId) return
                if (request.agentRunId) {
                  backgroundAgentApprovals.resolved(request.requestId, 'cancelled')
                } else {
                  runnerRegistry.markApprovalCancelled(request.sessionId, request.requestId)
                }
              }
            })
          ]
        : []
      if (
        !useRpc &&
        (remoteProject ||
          shouldLoadCoreSkill ||
          appendSystemPrompt.length > 0 ||
          extensionFactories.length > 0)
      ) {
        resourceLoader = createRuntimeResourceLoader({
          cwd: remoteProject ? AGENT_DIR : creationSnapshot.cwd,
          agentDir: AGENT_DIR,
          ...(remoteProject
            ? {
                noExtensions: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                remoteProjectSkills: remoteSkillCatalog
                  ? remoteRuntimeSkillDefinitions(remoteSkillCatalog)
                  : []
              }
            : {}),
          ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
          ...(extensionFactories.length > 0 ? { extensionFactories } : {})
        })
        await resourceLoader.reload()
      }
      assertCreationCurrent()

      if (useRpc && sessionManifest && !sessionManifest.runtimeRef && model) {
        const latest = findPhiSessionById(sessionManifest.sessionId)
        if (
          !latest ||
          latest?.runtimeRef ||
          JSON.stringify(latest?.model) !== JSON.stringify(sessionManifest.model) ||
          latest?.thinkingLevel !== sessionManifest.thinkingLevel
        )
          throw new StaleSessionError()
        if (latest.thinkingLevel !== thinkingLevel)
          updateSessionManifest(sessionManifest.sessionId, { thinkingLevel })
      }
      const result = await createAgentSession(
        {
          ...(remoteRecovery ? { remoteRecovery } : {}),
          modelRuntime: runtime,
          thinkingLevel,
          ...(sessionManifest?.autoCompaction
            ? { autoCompaction: sessionManifest.autoCompaction }
            : {}),
          cwd: creationSnapshot.cwd,
          sessionManager: useRpc
            ? createAppRemoteSessionManager(
                creationSnapshot.cwd,
                sessionManifest!.sessionId,
                Boolean(sessionManifest?.runtimeRef)
              )
            : createSessionManager(
                creationSnapshot.cwd,
                runtimeSessionPathForSnapshot(sessionKey, creationSnapshot)
              ),
          ...(resourceLoader ? { resourceLoader } : {}),
          ...(agentScan.agents.length > 0 ? { phiAgents: agentScan.agents } : {}),
          ...(!useRpc && remoteMcpCatalog?.runtimeServers.length
            ? { remoteProjectMcpServers: remoteMcpCatalog.runtimeServers }
            : {}),
          projectBound: Boolean(project),
          ...(project?.memory?.enabled ? { memory: project.memory } : {}),
          ...(remoteProject
            ? {
                ...(project ? { remoteRuntimeRoot: projectRemoteRuntimeRoot(project) } : {}),
                remoteProject: {
                  ...remoteProject,
                  phiSessionId: sessionManifest?.sessionId ?? '',
                  contextFiles: remoteContextFiles ?? []
                }
              }
            : {}),
          personaMarkdown,
          ...(model ? { model } : {})
        },
        undefined,
        control
      )
      try {
        assertCreationCurrent(true)
        const phiSessionId = sessionManifest?.sessionId ?? getPhiSessionIdForKey(sessionKey)
        const confirmed = phiSessionId ? findPhiSessionById(phiSessionId) : null
        if (
          confirmed &&
          (confirmed.projectLocation?.kind !== 'ssh' ||
            ownsRemoteRuntimeSession(result.session.runtimeSessionId))
        ) {
          const remoteScope =
            confirmed.projectLocation?.kind === 'ssh'
              ? currentRuntimeOriginScope(confirmed)
              : undefined
          if (confirmed.projectLocation?.kind === 'ssh' && !remoteScope)
            throw new Error('远程运行来源尚未验证')
          registerRuntimeSessionOrigin(
            {
              runtimeSessionId: result.session.runtimeSessionId,
              phiSessionId: confirmed.sessionId,
              projectId: confirmed.projectId ?? null,
              cwd: confirmed.cwd,
              ...(remoteScope
                ? {
                    remoteScope,
                    configuredRuntimeRoot: projectRemoteRuntimeRoot(
                      requireProject(confirmed.projectId!)
                    ).configured
                  }
                : {})
            },
            AGENT_DIR
          )
        }
      } catch (error) {
        try {
          await abortSessionWithoutCancellingApprovals(result.session)
        } catch (cleanupError) {
          logUnexpectedError(cleanupError)
        }
        try {
          await result.session.dispose()
        } catch (cleanupError) {
          logUnexpectedError(cleanupError)
        }
        throw error
      }
      if (typeof result.session.runtimeSessionId === 'string') {
        runtimeSessionOrigins.set(result.session.runtimeSessionId, {
          sessionKey,
          cwd: creationSnapshot.cwd
        })
      }
      const run = getActivePromptRun(sessionKey)
      if (run) {
        linkPromptRunRuntimeSessionPath(sessionKey, creationSnapshot.cwd, run, result.session)
      } else {
        linkMaterializedRuntimeSessionPath(
          sessionKey,
          creationSnapshot.cwd,
          result.session.sessionFile
        )
      }
      if (
        lifecycle.isCurrentGeneration(generation) &&
        sameCanonicalSessionKey(sessionKey, currentSessionKey)
      ) {
        const nextSessionPath = uiSessionPathForKey(sessionKey, creationSnapshot.path)
        if (currentSessionPath !== nextSessionPath) {
          currentSessionPath = nextSessionPath ?? undefined
          notifySessionChanged()
        }
      }

      result.session.subscribe((rawSummary) => {
        if (!lifecycle.isCurrentGeneration(generation)) return
        const summary = withEventTimestamp(rawSummary)
        const run = getActivePromptRun(sessionKey)
        if (
          run &&
          summary.type === 'auto_retry_start' &&
          isPermanentProviderRegionError(summary.errorMessage) &&
          !run.stoppingPermanentProviderError
        ) {
          run.stoppingPermanentProviderError = true
          run.recordedFailureMessage = redactSensitiveText(summary.errorMessage)
          void abortSessionWithoutCancellingApprovals(result.session).catch((error) => {
            logUnexpectedError(error)
          })
        }
        const phiSessionId = run?.phiSessionId ?? getPhiSessionIdForKey(sessionKey)
        const persistedSummary = run
          ? persistSessionEvent(run, summary)
          : phiSessionId
            ? (persistSdkCompactionNotice(phiSessionId, undefined, summary) ??
              persistSdkShakeEvent(phiSessionId, undefined, summary) ??
              summary)
            : summary
        const targetWindow = getActiveWindow()
        sendToWindow(targetWindow, 'agent:event', {
          ...persistedSummary,
          ...(phiSessionId ? { phiSessionId } : {}),
          sessionGeneration: generation,
          sessionPath: phiSessionId
            ? phiOnlySessionPath(phiSessionId)
            : (result.session.sessionFile ?? creationSnapshot.path ?? null),
          cwd: creationSnapshot.cwd
        })
      })

      return result
    },
    async ({ session }) => {
      await abortAndDisposeSession(session, { cancelApprovals: false })
    }
  )

  return record.promise
}

async function applyNextRunConfiguration(
  session: AgentSessionInstance,
  sessionKey: string,
  snapshot: SessionSnapshot
): Promise<void> {
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (session.runtimeSessionId && ownsRemoteRuntimeSession(session.runtimeSessionId)) {
    // The selected RPC generation already owns this saved policy. Unsupported changes are explicit.
    const selection = resolveSessionModelSelection(sessionKey, snapshot)
    if (
      !selection ||
      selection.providerId !== session.model?.provider ||
      selection.modelId !== session.model?.id ||
      selectionThinking(session.model!, resolveSessionThinkingLevel(sessionKey, snapshot)).phi !==
        session.thinkingLevel
    )
      throw new Error('RPC model/thinking changes require a supported remote control path')
    return
  }
  await session.setAutoCompactionSettings(manifest?.autoCompaction ?? {})
  const runtime = await getAuthManager().getRuntime()
  const modelSelection = resolveSessionModelSelection(sessionKey, snapshot)
  if (modelSelection) {
    const resolvedModel = resolveRuntimeModelSelection(runtime, modelSelection)
    if (!resolvedModel) {
      throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
    }
    await session.setModel(resolvedModel.model)
  }
  await session.setThinkingLevel(resolveSessionThinkingLevel(sessionKey, snapshot))
}

function captureCurrentSelectionTarget(): {
  key: string
  phiSessionId: string | undefined
  rpc: boolean
  assertCurrent(): void
  resolved(): Promise<AgentSessionResult | null>
} {
  const key = resolveSessionKeyAlias(currentSessionKey)
  const cwd = currentCwd
  const phiSessionId = getPhiSessionIdForKey(key)
  const manifest = phiSessionId ? findPhiSessionById(phiSessionId) : null
  const lifecycle = getCurrentLifecycle()
  const generation = lifecycle.currentGeneration
  const record = lifecycle.currentRecord
  const rpc = Boolean(
    manifest?.runtimeRef || (remoteOmpRpcEnabled && manifest?.projectLocation?.kind === 'ssh')
  )
  const identity = (value: typeof manifest): string =>
    JSON.stringify([
      value?.projectId,
      value?.cwd,
      value?.cwdRealPath,
      value?.projectLocation,
      value?.runtimeRef?.ompSessionId,
      value?.runtimeRef?.journalBasename
    ])
  const initialIdentity = identity(manifest)
  const assertCurrent = (): void => {
    const latest = phiSessionId ? findPhiSessionById(phiSessionId) : null
    if (
      !sameCanonicalSessionKey(key, currentSessionKey) ||
      currentCwd !== cwd ||
      getPhiSessionIdForKey(currentSessionKey) !== phiSessionId ||
      getCurrentLifecycle() !== lifecycle ||
      !lifecycle.isCurrentGeneration(generation) ||
      lifecycle.currentRecord !== record ||
      identity(latest) !== initialIdentity
    )
      throw new StaleSessionError()
    if (
      rpc &&
      (hasActivePromptRun(key) || (phiSessionId && runnerRegistry.getActiveRun(phiSessionId)))
    )
      throw new Error('Remote selection requires an idle Phi session')
  }
  assertCurrent()
  return {
    key,
    phiSessionId,
    rpc,
    assertCurrent,
    resolved: async () => {
      const result = record ? await record.promise : null
      assertCurrent()
      if (rpc && result?.session.hasActiveAgentRuns?.())
        throw new Error('请等待专家任务运行结束后再修改会话')
      return result
    }
  }
}

function captureCurrentRpcConfigurationTarget(): ReturnType<
  typeof captureSessionControlTarget
> | null {
  const key = resolveSessionKeyAlias(currentSessionKey)
  const phiSessionId = getPhiSessionIdForKey(key)
  const manifest = phiSessionId ? findPhiSessionById(phiSessionId) : null
  if (
    !phiSessionId ||
    !(manifest?.runtimeRef || (remoteOmpRpcEnabled && manifest?.projectLocation?.kind === 'ssh'))
  )
    return null
  return captureSessionControlTarget(key, phiSessionId)
}

function createWindow(): void {
  mainWindowCleanupStarted = false
  mainWindowCleanupPromise = null

  // Create the browser window.
  const window = new BrowserWindow({
    title: APP_NAME,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    transparent: false,
    // macOS titleBarStyle paints a system sidebar material behind the left pane.
    // Use a frameless window and opt the traffic lights back in so the renderer
    // owns every background pixel.
    ...(process.platform === 'darwin' ? { frame: false } : {}),
    backgroundMaterial: 'none',
    // Hidden until the renderer supplies its selected theme and first content frame.
    backgroundColor: '#FFFFFF',
    icon: appIcon,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  mainWindow = window

  const startup = createMainWindowStartup(
    window,
    (reason) => {
      finishStartupSplash(window)
      writeAppLog({ level: 'error', event: 'window_startup_failed', metadata: { reason } })
      const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
      void dialog
        .showMessageBox({
          type: 'error',
          title: APP_NAME,
          message: dialogCopy.startupFailed,
          detail: dialogCopy.startupRecovery,
          buttons: [dialogCopy.reload, dialogCopy.close],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
        .then(({ response }) => {
          if (window.isDestroyed()) return
          if (response === 0) {
            if (startup.retry()) window.webContents.reload()
          } else {
            window.close()
          }
        })
        .catch(() => {
          if (!window.isDestroyed()) window.close()
        })
    },
    15_000,
    () => finishStartupSplash(window)
  )
  mainWindowStartups.set(window, startup)
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) startup.fail('main-frame-load-failed')
  })
  window.webContents.on('render-process-gone', () => startup.fail('renderer-process-gone'))
  window.webContents.setBackgroundThrottling(false)
  if (process.platform === 'darwin') {
    window.setVibrancy(null)
    window.setWindowButtonVisibility(false)
    window.webContents.on('did-finish-load', () => {
      sendMainWindowFullscreenState(window, window.isFullScreen())
    })
    // In fullscreen the renderer hides its drawn traffic lights; hand the job back to macOS so the
    // native buttons slide in with the menu bar when the pointer reaches the top edge.
    window.on('enter-full-screen', () => {
      if (!window.isDestroyed()) window.setWindowButtonVisibility(true)
      sendMainWindowFullscreenState(window, true)
    })
    window.on('leave-full-screen', () => {
      if (!window.isDestroyed()) window.setWindowButtonVisibility(false)
      sendMainWindowFullscreenState(window, false)
    })
  }

  window.once('ready-to-show', startup.painted)

  window.on('close', () => {
    void cleanupMainWindowRuntime()
  })

  window.on('closed', () => {
    startup.dispose()
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler((details) => {
    return routeBrowserAppShellWindowOpen({
      details,
      coordinator: browserIpcCoordinator,
      policyContext: browserPolicyContext(),
      openExternal: (url) => shell.openExternal(url)
    })
  })

  window.webContents.on('will-frame-navigate', (event) => {
    if (
      shouldBlockHtmlReportNavigation({
        isMainFrame: event.isMainFrame,
        frameName: event.frame?.name,
        url: event.url
      })
    ) {
      event.preventDefault()
    }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window
      .loadURL(process.env['ELECTRON_RENDERER_URL'])
      .catch(() => startup.fail('load-failed'))
  } else {
    void window
      .loadFile(join(import.meta.dirname, '../renderer/index.html'))
      .catch(() => startup.fail('load-failed'))
  }
}

registerNotebookOutputScheme()

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  try {
    configureSystemUiLanguage(app.getPreferredSystemLanguages())
  } catch {
    configureSystemUiLanguage([])
  }
  installNotebookOutputProtocol()
  applyDockIcon()
  menuBarController = createMacMenuBar({
    getUiLanguage: () => readAppSettings().uiLanguage,
    openWindow: showMainWindowFromMenuBar,
    queueAction: queueMenuBarAction,
    hideWindow: hideMainWindowFromMenuBar,
    canHideWindow: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    quit: () => app.quit()
  })
  startupSplashWindow = await createStartupSplashWindow(
    (options) => new BrowserWindow(options),
    appIcon.isEmpty() ? '' : appIcon.toDataURL(),
    Date.now,
    readAppSettings().uiLanguage
  )

  const removedLogs = cleanupOldLogs()
  try {
    cleanupStalePackageStaging({ agentDir: AGENT_DIR })
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'package_staging_cleanup_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  writeAppLog({ event: 'app_started', metadata: { removedOldLogs: removedLogs } })
  migrateEnablementFromHistory(['create-wrapper'], { agentDir: AGENT_DIR })
  try {
    const refreshed = refreshPersistedManagedStdioServers({
      agentDir: AGENT_DIR,
      runtimeRoot: getRuntimeRoot()
    })
    if (refreshed.failures.length > 0) {
      writeAppLog({
        level: 'warn',
        event: 'mcp_managed_stdio_refresh_failed',
        metadata: {
          failures: refreshed.failures.map(({ name, ref, error }) => ({
            name,
            ref,
            error: error.message
          }))
        }
      })
    }
  } catch (error) {
    writeAppLog({
      level: 'warn',
      event: 'mcp_managed_stdio_refresh_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  try {
    const registry = readPluginRegistry(AGENT_DIR)
    const global = getEnablementSnapshot({ agentDir: AGENT_DIR }).global
    const plugins = { ...registry.plugins }
    const migratedPlugins: string[] = []
    let hadLegacyEnablement = false
    for (const [id, entry] of Object.entries(plugins)) {
      if (typeof entry.enabled !== 'boolean') continue
      hadLegacyEnablement = true
      const key = `plugin:${id}` as const
      if (!Object.hasOwn(global, key)) {
        setEnabled(key, entry.enabled, { agentDir: AGENT_DIR })
        migratedPlugins.push(id)
      }
      const lifecycleEntry = { ...entry }
      delete lifecycleEntry.enabled
      plugins[id] = lifecycleEntry
    }
    if (hadLegacyEnablement) {
      writePluginRegistry({ version: 1, plugins }, AGENT_DIR)
    }
    if (migratedPlugins.length > 0) {
      writeAppLog({
        event: 'enablement_plugin_registry_migrated',
        metadata: { plugins: migratedPlugins }
      })
    }
  } catch (error) {
    writeAppLog({
      event: 'enablement_plugin_registry_migration_failed',
      level: 'warn',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  // Domain packages are installed only after a catalog choice. Core runtime assets remain bundled.
  mkdirSync(currentCwd, { recursive: true })
  recoverInterruptedPhiSessions()
  // Wrapper packages are installed from the catalogue only after a user choice.
  // Keep legacy user-authored wrappers available without seeding every bundled package.
  try {
    const migratedCustom = migrateLegacyCustomWrappers(AGENT_DIR)
    if (migratedCustom.length > 0) {
      writeAppLog({ event: 'wrapper_custom_migrated', metadata: { ids: migratedCustom } })
    }
    resetWrapperCompositionCatalogCache()
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'wrapper_custom_migration_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  // Fire-and-forget: resumes remote Slurm and detached runs left mid-flight by
  // the previous app session (see executor-slurm-reconcile.ts's doc comment).
  // Must never block startup — a network hiccup here shouldn't delay the window.
  void reconcileRemoteWrapperRuns().catch((error: unknown) => {
    writeAppLog({
      level: 'error',
      event: 'wrapper_remote_run_reconcile_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  })
  // Agent-started (wrapper_run) local runs cannot outlive the worker that owned
  // them: anything still non-terminal from the previous session is `lost`.
  try {
    const lost = markInterruptedCompositionRuns()
    if (lost > 0) {
      writeAppLog({ event: 'wrapper_composition_runs_marked_lost', metadata: { count: lost } })
    }
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'wrapper_composition_run_reconcile_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  // Remote runs are the exception: they kept running on the cluster while Phi was closed, so
  // watch them again (any that cannot be reached are recorded `lost`).
  void wrapperJobs
    .adoptRemoteRuns()
    .then((adopted) => {
      if (adopted > 0) {
        writeAppLog({ event: 'wrapper_remote_runs_adopted', metadata: { count: adopted } })
      }
    })
    .catch((error) => {
      writeAppLog({
        level: 'error',
        event: 'wrapper_remote_run_adopt_failed',
        metadata: { error: error instanceof Error ? error.message : String(error) }
      })
    })
  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_ID)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  registerBrowserRendererIpc(ipcMain, browserIpcCoordinator)
  registerTerminalRendererIpc(ipcMain, terminalIpcCoordinator)
  registerSshBootstrapIpc(
    ipcMain,
    () => mainWindow?.webContents ?? null,
    createDefaultSshBootstrapCoordinator()
  )
  registerRemoteMicromambaIpc(ipcMain)
  registerRemoteRipgrepIpc(ipcMain)
  ipcMain.handle('window:close', () => {
    getActiveWindow()?.close()
  })
  ipcMain.handle('window:minimize', () => {
    getActiveWindow()?.minimize()
  })
  ipcMain.handle('window:toggle-fullscreen', () => {
    const window = getActiveWindow()
    if (!window) return
    window.setFullScreen(!window.isFullScreen())
  })
  ipcMain.handle('window:get-fullscreen', (event) => {
    return requireMainWindowRenderer(event).isFullScreen()
  })
  ipcMain.handle('window:renderer-ready', (event, background: unknown) => {
    const window = requireMainWindowRenderer(event)
    mainWindowStartups.get(window)?.rendererReady(background)
  })
  ipcMain.handle('menu-bar:consume-action', (event): MenuBarAction | null => {
    requireMainWindowRenderer(event)
    const action = pendingMenuBarAction
    pendingMenuBarAction = null
    return action
  })
  ipcMain.handle('files:reveal', async (_, filePath: string) => {
    shell.showItemInFolder(assertRevealPathAllowed(filePath))
  })
  ipcMain.handle('files:openPath', async (_, filePath: string) => {
    await openLocalFilePath(filePath)
  })
  ipcMain.handle('files:getIcon', async (_, filePath: string) => {
    return getLocalFileIconDataUrl(filePath)
  })
  ipcMain.handle('resources:readIcon', (_, key: unknown) => readResourceIcon(key))
  ipcMain.handle('web-link:preview', (event, url: unknown) => {
    requireMainWindowRenderer(event)
    return webLinkPreviews.get(url)
  })
  ipcMain.handle('files:pickInput', async () => {
    if (isRemoteProjectAnchorPath(currentCwd, AGENT_DIR)) {
      throw new Error('远程项目文件选择暂不可用；不会打开本机会话目录')
    }
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectInput,
      buttonLabel: dialogCopy.select,
      defaultPath: currentCwd || undefined,
      properties: ['openFile', 'openDirectory', 'multiSelections']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('files:pickLocalUpload', async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectUpload,
      buttonLabel: dialogCopy.select,
      properties: ['openFile', 'openDirectory', 'multiSelections']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('remoteProjectUploads:prepare', async (_, projectId: unknown, value: unknown) => {
    if (typeof projectId !== 'string' || !projectId || !isRecord(value)) {
      throw new Error('远程项目上传请求无效')
    }
    const sourcePaths = value.sourcePaths
    const destinationDirectory = value.destinationDirectory
    if (
      Object.keys(value).some((key) => key !== 'sourcePaths' && key !== 'destinationDirectory') ||
      !Array.isArray(sourcePaths) ||
      sourcePaths.some((path) => typeof path !== 'string') ||
      (destinationDirectory !== undefined && typeof destinationDirectory !== 'string')
    ) {
      throw new Error('远程项目上传只能包含本机来源和项目内落点')
    }
    return remoteProjectUploads.prepare(projectId, {
      sourcePaths,
      ...(typeof destinationDirectory === 'string' ? { destinationDirectory } : {})
    })
  })
  ipcMain.handle(
    'remoteProjectUploads:start',
    async (_, projectId: unknown, jobId: unknown, value: unknown) => {
      if (typeof projectId !== 'string' || !projectId || typeof jobId !== 'string' || !jobId) {
        throw new Error('远程项目上传任务无效')
      }
      if (
        value !== undefined &&
        (!isRecord(value) ||
          Object.keys(value).some((key) => key !== 'confirmed') ||
          (value.confirmed !== undefined && typeof value.confirmed !== 'boolean'))
      ) {
        throw new Error('远程项目上传确认无效')
      }
      return remoteProjectUploads.start(projectId, jobId, {
        confirmed: isRecord(value) && value.confirmed === true
      })
    }
  )
  ipcMain.handle('remoteProjectUploads:list', () => remoteProjectUploads.list())
  ipcMain.handle('remoteJupyterJobs:list', () => remoteJupyterStartJobs.list())
  ipcMain.handle('remoteProjectUploads:cancel', async (_, jobId: unknown) => {
    if (typeof jobId !== 'string' || !jobId) throw new Error('远程项目上传任务无效')
    await remoteProjectUploads.cancel(jobId)
  })
  ipcMain.handle('remoteProjectUploads:retry', async (_, jobId: unknown) => {
    if (typeof jobId !== 'string' || !jobId) throw new Error('远程项目上传任务无效')
    return remoteProjectUploads.retry(jobId)
  })
  ipcMain.handle(
    'wrappers:completeInputUpload',
    async (_, jobId: unknown, planId: unknown, inputId: unknown, expectedRevision: unknown) => {
      if (
        typeof jobId !== 'string' ||
        typeof planId !== 'string' ||
        typeof inputId !== 'string' ||
        !Number.isSafeInteger(expectedRevision)
      ) {
        throw new Error('Wrapper 上传输入绑定无效')
      }
      const plan = readWrapperPlan(planId)
      const projectId = plan?.targetSelection?.projectId
      if (!projectId || plan.targetSelection?.projectLocation.kind !== 'ssh') {
        throw new Error('Wrapper 上传输入计划不属于 SSH 项目')
      }
      const job = await remoteProjectUploads.wait(projectId, jobId)
      if (
        job.status !== 'completed' ||
        job.sourcePaths.length !== 1 ||
        !job.files[0]?.destinationPath
      ) {
        throw new Error('上传未完成，Wrapper 计划不会启动')
      }
      const parts = job.files[0].relativePath.split('/')
      let remotePath = job.files[0].destinationPath
      for (let index = 1; index < parts.length; index += 1) remotePath = posix.dirname(remotePath)
      return recordWrapperUploadedInput({
        planId,
        inputId,
        expectedRevision: expectedRevision as number,
        localPath: job.sourcePaths[0]!,
        remotePath
      })
    }
  )
  registerWorkspaceFileIpc({
    ipcMain,
    dialog,
    shell,
    getUiLanguage: () => readAppSettings().uiLanguage,
    requireRenderer: requireMainWindowRenderer,
    requireLocalWorkspaceRoot: (rootPath) => {
      if (
        isRemoteResourceScope() ||
        resolve(rootPath) !== resolve(currentCwd) ||
        isRemoteProjectAnchorPath(rootPath, AGENT_DIR)
      ) {
        throw new Error('只能修改当前本地工作区中的文件')
      }
    },
    observeRemote: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
    downloads: wrapperResultDownloads
  })
  ipcMain.handle('files:preview', async (_, filePath: string) => {
    return createFilePreview(filePath)
  })
  ipcMain.handle('remoteWorkspace:statPaths', async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), async () =>
      (await import('./agent/workspace-host/remote-registry')).remoteWorkspaceHosts.statPaths(
        request
      )
    )
  )
  ipcMain.handle('remoteWorkspace:preview', async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      previewRemoteWorkspaceFile(request, { connectHost: connectRemoteWorkspaceHost })
    )
  )
  ipcMain.handle('remoteWorkspace:listDirectory', async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      listRemoteWorkspaceDirectory(request)
    )
  )
  ipcMain.handle('wrapperResults:listDirectory', async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      listWrapperResultDirectory(request)
    )
  )
  ipcMain.handle('wrapperResults:preview', async (_, request: unknown) =>
    runWrapperResultRead(request, previewWrapperResult)
  )
  ipcMain.handle('wrapperResults:readRange', async (_, request: unknown) =>
    runWrapperResultRead(request, readWrapperResultRange)
  )
  ipcMain.handle('wrapperResults:cancelRead', async (_, requestId: unknown) => {
    if (typeof requestId !== 'string') throw new Error('Wrapper 结果读取请求 ID 无效')
    const controller = wrapperResultReadControllers.get(requestId)
    controller?.abort()
    return controller !== undefined
  })
  ipcMain.handle('wrapperResults:download', async (event, request: unknown) => {
    requireMainWindowRenderer(event)
    const checked = validateWrapperResultDownloadRequest(request)
    const { requestId } = checked
    if (wrapperResultDownloads.has(requestId)) throw new Error('Wrapper 下载请求 ID 正在使用')
    const name = basename(checked.path!)
    const window = BrowserWindow.fromWebContents?.(event.sender) ?? getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.SaveDialogOptions = {
      title: dialogCopy.saveResult,
      buttonLabel: dialogCopy.save,
      defaultPath: name && name !== '.' && name !== '..' ? name : 'remote-result'
    }
    const chosen = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' as const }
    if (wrapperResultDownloads.has(requestId)) throw new Error('Wrapper 下载请求 ID 正在使用')

    const controller = new AbortController()
    const active: {
      controller: AbortController
      phase: 'downloading' | 'verifying' | 'saving'
    } = { controller, phase: 'downloading' }
    wrapperResultDownloads.set(requestId, active)
    try {
      return await remoteConnectionTracker.observe(remoteRequestProjectId(request), async () => {
        try {
          return await downloadWrapperResultToPath(checked, chosen.filePath!, {
            signal: controller.signal,
            onProgress: (progress) => {
              active.phase = progress.phase
              try {
                if (event.sender.isDestroyed?.()) controller.abort()
                else event.sender.send?.('wrapperResults:downloadProgress', progress)
              } catch {
                controller.abort()
              }
            }
          })
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Wrapper 下载已取消')
          throw error
        }
      })
    } finally {
      wrapperResultDownloads.delete(requestId)
    }
  })
  ipcMain.handle('wrapperResults:cancelDownload', async (event, requestId: unknown) => {
    requireMainWindowRenderer(event)
    if (typeof requestId !== 'string') throw new Error('Wrapper 下载请求 ID 无效')
    const active = wrapperResultDownloads.get(requestId)
    if (!active || active.phase === 'saving') return false
    active.controller.abort()
    return true
  })
  ipcMain.handle('files:hoverPreview', async (_, filePath: string) => {
    return createFileHoverPreview(filePath)
  })
  ipcMain.handle('files:statLocalPaths', async (_, cwd: unknown, paths: unknown) => {
    return statLocalPaths(cwd, paths)
  })
  ipcMain.handle('files:listDirectory', async (_, dirPath: string) => {
    return createDirectoryListing(dirPath)
  })
  ipcMain.handle(
    'molecules:renderSvg',
    async (_, value: unknown, width: unknown, height: unknown) => {
      return renderMoleculeSvg(value, width, height)
    }
  )
  ipcMain.handle('agent:prompt', async (_, text: string, targetInput?: unknown) => {
    const normalizedText = typeof text === 'string' ? text.trim() : ''
    const images = validatePromptImages(
      targetInput && typeof targetInput === 'object'
        ? (targetInput as Record<string, unknown>).images
        : undefined
    )
    if (!normalizedText && images.length === 0) return null
    const promptTarget = parsePromptTarget(targetInput)
    if (targetInput !== undefined) {
      await alignCurrentSessionToPromptTarget(targetInput)
    }

    return submitPromptRun({
      sessionKey: resolveSessionKeyAlias(currentSessionKey),
      snapshot: {
        path: runtimeSessionPath(currentSessionPath),
        cwd: currentCwd,
        permissionMode: currentPermissionMode
      },
      text: normalizedText,
      images,
      promptTarget,
      planMode: promptTarget?.planMode === true
    })
  })

  ipcMain.handle('agent:readPromptImage', async (_, ref: unknown) => readPromptImage(ref))
  ipcMain.handle('workspaceChanges:readDiff', async (_, ref: unknown) => readWorkspaceDiff(ref))

  ipcMain.handle('agent:stop', async () => {
    await stopActivePrompt()
  })

  // A delegation card steers or stops the run it shows. The card knows which agent session
  // owns the run; the worker answers if the run is still there.
  ipcMain.handle(
    'agent:steerRun',
    async (
      _,
      agentSessionId: unknown,
      agentRunId: unknown,
      message: unknown,
      toolCallId?: unknown
    ) => {
      const text = typeof message === 'string' ? message.trim() : ''
      if (!text) throw new Error('消息不能为空')
      if (text.length > MAX_AGENT_STEER_LENGTH) throw new Error('消息过长')
      await requestAgentRunControl('agentRun.steer', agentSessionId, agentRunId, text)
      recordAgentSteer(agentSessionId, agentRunId, toolCallId, text)
    }
  )
  ipcMain.handle('agent:stopRun', async (_, agentSessionId: unknown, agentRunId: unknown) => {
    await requestAgentRunControl('agentRun.stop', agentSessionId, agentRunId)
  })

  ipcMain.handle('auth:status', async () => getAuthManager().getProviderStatuses())
  ipcMain.handle('auth:loginApiKey', async (_, providerId: string, key: string) => {
    const normalizedKey = key.trim()
    const status = await getAuthManager().loginApiKey(providerId, normalizedKey)
    await invalidateAgentSession()
    return status
  })
  ipcMain.handle('auth:loginOAuth', async (_, providerId: string) => {
    const status = await getAuthManager().loginOAuth(providerId)
    await invalidateAgentSession()
    return status
  })
  ipcMain.handle('auth:logout', async (_, providerId: string) => {
    await getAuthManager().logout(providerId)
    await invalidateAgentSession()
  })
  ipcMain.handle('auth:interaction-response', async (_, requestId: string, value: string) => {
    await getAuthManager().resolveInteraction(requestId, value)
  })

  ipcMain.handle('app:checkForUpdates', async () => checkForAppUpdate(app.getVersion()))
  ipcMain.handle('app:openReleasesPage', async (_, url: unknown) => {
    // Only Phi's own release pages; anything else falls back to the latest release.
    const target =
      typeof url === 'string' &&
      url.startsWith(`https://github.com/${RELEASES_REPOSITORY}/releases/`)
        ? url
        : RELEASES_PAGE_URL
    await shell.openExternal(target)
  })
  ipcMain.handle('settings:get', async () => readAppSettings())
  ipcMain.handle('settings:update', async (_, patch: unknown) => {
    const settings = updateAppSettings(patch)
    syncPreventSleepBlocker()
    return settings
  })
  ipcMain.handle('settings:webSearch:get', async () =>
    getPhiEngine().settings.webSearch.get({ agentDir: AGENT_DIR })
  )
  ipcMain.handle('settings:webSearch:update', async (_, patch: unknown) =>
    getPhiEngine().settings.webSearch.update({ agentDir: AGENT_DIR, patch })
  )
  ipcMain.handle('settings:webSearch:searxngEngines', async () =>
    getPhiEngine().settings.webSearch.searxngEngines({ agentDir: AGENT_DIR })
  )
  ipcMain.handle('settings:webSearch:apiKey:set', async (_, providerId: unknown, key: unknown) =>
    getPhiEngine().settings.webSearch.setApiKey({
      agentDir: AGENT_DIR,
      providerId,
      key
    })
  )
  ipcMain.handle('settings:webSearch:apiKey:clear', async (_, providerId: unknown) =>
    getPhiEngine().settings.webSearch.clearApiKey({ agentDir: AGENT_DIR, providerId })
  )

  ipcMain.handle('environment:get', () => backgroundEnvironment.get())
  ipcMain.handle('environment:redetect', () => backgroundEnvironment.redetect())
  ipcMain.handle('environment:dismissSummary', () => backgroundEnvironment.dismissSummary())
  ipcMain.handle('environment:setToolPath', async (_, toolId: unknown, path: unknown) => {
    if (typeof toolId !== 'string' || !toolId.trim()) {
      throw new Error('工具 id 无效')
    }
    if (path !== null && typeof path !== 'string') {
      throw new Error('工具路径必须是字符串或 null')
    }
    return backgroundEnvironment.setToolPath(
      toolId as Parameters<typeof backgroundEnvironment.setToolPath>[0],
      path
    )
  })
  ipcMain.handle('environment:pickBinary', async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectExecutable,
      buttonLabel: dialogCopy.select,
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(
    'managedEnvironments:list',
    async (_, projectCwd: unknown, includeDynamic: unknown) => {
      try {
        return await managedEnvironmentActions.list(projectCwd, includeDynamic)
      } catch (error) {
        throw new Error(
          `读取托管环境失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )
  ipcMain.handle(
    'managedEnvironments:build',
    async (_, ref: unknown, projectCwd: unknown, pluginId: unknown) => {
      try {
        return managedEnvironmentActions.build(ref, projectCwd, pluginId)
      } catch (error) {
        throw new Error(
          `启动环境构建失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )
  ipcMain.handle('managedEnvironments:rebuild', async (_, envId: unknown) => {
    try {
      await managedEnvironmentActions.rebuild(envId)
    } catch (error) {
      throw new Error(`重新构建环境失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ipcMain.handle('managedEnvironments:remove', async (_, envId: unknown) => {
    try {
      return await managedEnvironmentActions.remove(envId)
    } catch (error) {
      throw new Error(`删除环境失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ipcMain.handle('managedEnvironments:clean', async () => {
    try {
      return await managedEnvironmentActions.clean()
    } catch (error) {
      throw new Error(`清理环境失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ipcMain.handle('models:list', async () => {
    const runtime = await getAuthManager().getRuntime()
    return selectableRuntimeModels(runtime).map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      supportsImages: model.supportsImages ?? false,
      thinkingLevels: getSupportedThinkingLevels(model)
    }))
  })
  ipcMain.handle('models:select', async (_, providerId: string | null, modelId: string | null) => {
    const target = captureCurrentSelectionTarget()
    const request = ++modelSelectionRequest
    const key = target.phiSessionId ?? resolveSessionKeyAlias(target.key)
    const rememberSelection = (model: ModelSelection | null): void => {
      if (request < lastRememberedModelSelectionRequest) return
      writeLastSelectedModel(model)
      selectedModel = model
      lastRememberedModelSelectionRequest = request
    }
    const selection = (sessionModelSelectionQueues.get(key) ?? Promise.resolve()).then(async () => {
      target.assertCurrent()
      if (providerId === null && modelId === null) {
        if (target.rpc) throw new Error('远程 RPC 对话暂不支持自动模型，请选择具体模型')
        sessionModelSelections.set(resolveSessionKeyAlias(target.key), null)
        if (target.phiSessionId) updateSessionManifest(target.phiSessionId, { model: null })
        rememberSelection(null)
        return
      }
      if (typeof providerId !== 'string' || typeof modelId !== 'string') {
        throw new Error('模型选择无效')
      }
      const runtime = await getAuthManager().getRuntime()
      target.assertCurrent()
      const resolved = resolveRuntimeModelSelection(runtime, { providerId, modelId })
      if (!resolved || resolved.migratedFrom) throw new Error(`未知模型: ${providerId}/${modelId}`)
      const model = resolved.model
      if (target.rpc) {
        const current = await target.resolved()
        target.assertCurrent()
        const snapshot = {
          path: currentSessionPath,
          cwd: currentCwd,
          permissionMode: currentPermissionMode
        }
        const preferred = selectionThinking(
          model,
          resolveSessionThinkingLevel(target.key, snapshot)
        ).phi
        if (current) {
          if (!ownsRemoteRuntimeSession(current.session.runtimeSessionId))
            throw new Error('Remote selection requires an exact live attachment')
          await current.session.setModel(model, {
            assertCurrent: target.assertCurrent,
            preferredThinkingLevel: preferred
          })
          target.assertCurrent()
        } else {
          if (target.phiSessionId && findPhiSessionById(target.phiSessionId)?.runtimeRef)
            throw new Error('Remote selection requires an exact live attachment')
          if (target.phiSessionId)
            updateSessionManifest(target.phiSessionId, {
              model: { providerId, modelId },
              thinkingLevel: preferred
            })
        }
        const key = resolveSessionKeyAlias(target.key)
        sessionModelSelections.set(key, { providerId, modelId })
        const confirmed = target.phiSessionId
          ? findPhiSessionById(target.phiSessionId)?.thinkingLevel
          : preferred
        if (confirmed === undefined) sessionThinkingLevels.delete(key)
        else sessionThinkingLevels.set(key, confirmed)
        rememberSelection({ providerId, modelId })
        return
      }
      const nextModel = { providerId, modelId }
      if (!hasActivePromptRun(target.key)) {
        const current = await target.resolved()
        if (current) await current.session.setModel(model)
        target.assertCurrent()
      }
      sessionModelSelections.set(resolveSessionKeyAlias(target.key), nextModel)
      if (target.phiSessionId) updateSessionManifest(target.phiSessionId, { model: nextModel })
      rememberSelection(nextModel)
    })
    const settled = selection.then(
      () => undefined,
      () => undefined
    )
    sessionModelSelectionQueues.set(key, settled)
    void settled.then(() => {
      if (sessionModelSelectionQueues.get(key) === settled) sessionModelSelectionQueues.delete(key)
    })
    return selection
  })
  ipcMain.handle('models:selected', async () => {
    const snapshot: SessionSnapshot = {
      path: currentSessionPath,
      cwd: currentCwd,
      permissionMode: currentPermissionMode
    }
    const resolved = resolveSessionModelSelection(currentSessionKey, snapshot)
    if (resolved) {
      const runtime = await getAuthManager().getRuntime()
      return resolveRuntimeModelSelection(runtime, resolved)?.selection ?? resolved
    }

    return null
  })

  ipcMain.handle('thinking:select', async (_, level: ThinkingLevel) => {
    const target = captureCurrentSelectionTarget()
    if (target.rpc) {
      const current = await target.resolved()
      target.assertCurrent()
      if (current) {
        if (!ownsRemoteRuntimeSession(current.session.runtimeSessionId))
          throw new Error('Remote selection requires an exact live attachment')
        await current.session.setThinkingLevel(level, target)
        target.assertCurrent()
      } else {
        if (target.phiSessionId && findPhiSessionById(target.phiSessionId)?.runtimeRef)
          throw new Error('Remote selection requires an exact live attachment')
        const runtime = await getAuthManager().getRuntime()
        target.assertCurrent()
        const manifest = target.phiSessionId ? findPhiSessionById(target.phiSessionId) : null
        const selected =
          manifest?.model && resolveRuntimeModelSelection(runtime, manifest.model)?.model
        if (!selected) throw new Error('Remote thinking selection requires a trusted model')
        const normalized = selectionThinking(selected, level, true).phi
        if (target.phiSessionId)
          updateSessionManifest(target.phiSessionId, { thinkingLevel: normalized })
      }
      const key = resolveSessionKeyAlias(target.key)
      const confirmed = target.phiSessionId
        ? findPhiSessionById(target.phiSessionId)?.thinkingLevel
        : level
      if (confirmed === undefined) sessionThinkingLevels.delete(key)
      else sessionThinkingLevels.set(key, confirmed)
      return
    }
    sessionThinkingLevels.set(resolveSessionKeyAlias(target.key), level)
    if (target.phiSessionId) updateSessionManifest(target.phiSessionId, { thinkingLevel: level })
    if (hasActivePromptRun(target.key)) return
    const current = await target.resolved()
    if (current) await current.session.setThinkingLevel(level)
  })
  ipcMain.handle('thinking:selected', async () => {
    const resolved = sessionThinkingLevels.get(resolveSessionKeyAlias(currentSessionKey))
    if (resolved) return resolved

    const current = await getCurrentResolvedSession()
    if (current) {
      const { session } = current
      return session.thinkingLevel
    }
    return resolveSessionThinkingLevel(currentSessionKey, {
      path: currentSessionPath,
      cwd: currentCwd,
      permissionMode: currentPermissionMode
    })
  })

  ipcMain.handle('sessions:list', async () => listSessions(getNoProjectTaskFolder()))
  ipcMain.handle('sessions:homeActivity', async () => getHomeActivity())
  ipcMain.handle('sessions:current', async () => getCurrentSessionPayloadWithMessages())
  ipcMain.handle('sessions:contextUsage', async () => getCurrentContextUsage())
  ipcMain.handle('sessions:runtimeRecovery', async (_, target: unknown) =>
    runtimeRecoveryController.getState(target)
  )
  ipcMain.handle('sessions:resumeRuntime', async (_, target: unknown, replacement?: unknown) =>
    runtimeRecoveryController.resume(target, replacement)
  )
  ipcMain.handle('sessions:continueRuntimeSummary', async (_, target: unknown, sha256: unknown) =>
    runtimeRecoveryController.continueFromSummary(target, sha256)
  )
  ipcMain.handle('sessions:autoCompactionSettings', async (_, target: unknown) =>
    getCurrentAutoCompactionSettings(target)
  )
  ipcMain.handle(
    'sessions:autoCompactionSettings:set',
    async (_, target: unknown, patch: unknown) => setCurrentAutoCompactionSettings(target, patch)
  )
  ipcMain.handle('sessions:compact', async (_, target: unknown) => compactCurrentSession(target))
  ipcMain.handle(
    'sessions:updatePermissionMode',
    async (event, value: unknown, target: unknown) => {
      requireMainWindowRenderer(event)
      const permissionMode = validateSessionPermissionModeUpdate(
        value,
        target,
        getCurrentSessionPayload()
      )
      currentPermissionMode = permissionMode
      sessionPermissionModes.set(resolveSessionKeyAlias(currentSessionKey), permissionMode)
      const phiSessionId =
        getPhiSessionIdForKey(currentSessionKey) ??
        (currentSessionPath
          ? findPhiManifestForSession(currentSessionKey, currentSessionPath, currentCwd)?.sessionId
          : undefined)
      if (phiSessionId) {
        updateSessionManifest(phiSessionId, { permissionMode })
      }
      notifySessionChanged()
      return getCurrentSessionPayload()
    }
  )
  ipcMain.handle('sessions:create', async () => {
    const cwd = getNoProjectTaskFolder()
    const session = createPhiManagedSession(cwd, 'auto')
    return disposeAndSwitchSession(session.path, cwd, session.permissionMode)
  })
  ipcMain.handle('sessions:fork', async (_, sourceId: unknown, eventId: unknown) => {
    if (typeof sourceId !== 'string' || typeof eventId !== 'string') {
      throw new Error('无效的会话分叉请求')
    }
    const source = findPhiSessionById(sourceId)
    if (!source) throw new Error('来源会话不存在')
    if (
      source.status === 'running' ||
      source.status === 'needs_approval' ||
      source.status === 'needs_input' ||
      runnerRegistry.getActiveRun(sourceId)
    ) {
      throw new Error('请等待来源会话运行结束后再分叉')
    }
    if (!source.runtimeSessionPath) throw new Error('来源会话尚无可分叉的历史')
    const events = readSessionEvents(sourceId)
    const userMessages = events.filter((event) => event.type === 'user_message')
    const selectedIndex = userMessages.findIndex((event) => event.eventId === eventId)
    if (selectedIndex < 0) throw new Error('分叉消息不存在')
    const result = await getPhiEngine().history.fork({
      path: source.runtimeSessionPath,
      cwd: source.cwd,
      userMessages: userMessages
        .slice(0, selectedIndex + 2)
        .map((event) => (typeof event.content === 'string' ? event.content : '')),
      selectedIndex
    })
    try {
      const fork = forkPhiSession(sourceId, eventId, result.path)
      notifySessionChanged()
      return { path: phiOnlySessionPath(fork.sessionId), phiSessionId: fork.sessionId }
    } catch (error) {
      deleteSession(result.path)
      throw error
    }
  })
  ipcMain.handle('sessions:switch', async (_, path: string) => {
    const request = ++sessionSwitchRequest
    const phiOnlySessionId = phiSessionIdFromPath(path)
    if (phiOnlySessionId) {
      const manifest = findPhiSessionById(phiOnlySessionId)
      if (!manifest) return null
      const targetKey = createSessionKey(path, manifest.cwd)
      setPhiSessionIdForKey(targetKey, phiOnlySessionId)
      sessionPermissionModes.set(resolveSessionKeyAlias(targetKey), manifest.permissionMode)
      const shouldBecomeCurrent = request === sessionSwitchRequest
      const target = shouldBecomeCurrent
        ? await disposeAndSwitchSession(path, manifest.cwd, manifest.permissionMode, {
            notify: false
          })
        : {
            path,
            cwd: manifest.cwd,
            sessionGeneration: getLifecycleForKey(targetKey).currentGeneration,
            permissionMode: manifest.permissionMode
          }
      if (shouldBecomeCurrent) {
        acknowledgeSession(path, manifest.cwd)
      }
      const project = manifest.projectId ? getProject(manifest.projectId) : undefined
      const projectLocation = manifest.projectLocation ?? project?.location
      if (shouldBecomeCurrent && projectLocation?.kind === 'ssh' && manifest.projectId) {
        scheduleRemoteProjectCheck(manifest.sessionId, manifest.projectId)
      }
      return {
        path,
        phiSessionId: manifest.sessionId,
        cwd: target.cwd,
        displayCwd: projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : target.cwd,
        ...(manifest.projectId ? { projectId: manifest.projectId } : {}),
        ...(projectLocation ? { projectLocation } : {}),
        sessionGeneration: target.sessionGeneration,
        permissionMode: manifest.permissionMode,
        ...getSessionStatusPayload(targetKey, path, target.cwd),
        messages: readPhiTimelineMessages(null, target.cwd, phiOnlySessionId)
      }
    }

    // The session file already knows its own cwd (a project session was created with
    // that project's folder as cwd) — read it so switching to it also restores the
    // right permission mode, regardless of which sidebar section it was opened from.
    const cwd = (await openRuntimeSessionManager(path)).getCwd()
    const targetKey = createSessionKey(path, cwd)
    const permissionMode = resolveSessionPermissionMode(targetKey, { path, cwd })
    const shouldBecomeCurrent = request === sessionSwitchRequest
    const target = shouldBecomeCurrent
      ? await disposeAndSwitchSession(path, cwd, permissionMode, { notify: false })
      : {
          path,
          cwd,
          sessionGeneration: getLifecycleForKey(createSessionKey(path, cwd)).currentGeneration,
          permissionMode
        }
    const targetLifecycle = getLifecycleForKey(targetKey)
    const targetSnapshot: SessionSnapshot = { path, cwd, permissionMode }
    let session: AgentSessionInstance
    try {
      const result = await getAgentSession(targetKey, targetSnapshot)
      session = result.session
    } catch (error) {
      if (
        isStaleSessionError(error) ||
        !targetLifecycle.isCurrentGeneration(target.sessionGeneration)
      ) {
        return null
      }
      throw error
    }
    if (!targetLifecycle.isCurrentGeneration(target.sessionGeneration)) {
      return null
    }
    if (shouldBecomeCurrent && target.path) {
      acknowledgeSession(target.path, target.cwd)
    }
    const sessionPath = session.sessionFile ?? path
    const phiSessionId = getPhiSessionIdForKey(targetKey)
    const linkedManifest = phiSessionId
      ? findPhiSessionById(phiSessionId)
      : findPhiSessionByRuntimePath(sessionPath, target.cwd)
    const project = linkedManifest?.projectId ? getProject(linkedManifest.projectId) : undefined
    const projectLocation = linkedManifest?.projectLocation ?? project?.location
    return {
      path: phiSessionId ? phiOnlySessionPath(phiSessionId) : sessionPath,
      ...(phiSessionId ? { phiSessionId } : {}),
      cwd: target.cwd,
      displayCwd: projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : target.cwd,
      ...(linkedManifest?.projectId ? { projectId: linkedManifest.projectId } : {}),
      ...(projectLocation ? { projectLocation } : {}),
      sessionGeneration: target.sessionGeneration,
      permissionMode,
      ...getSessionStatusPayload(targetKey, sessionPath, target.cwd),
      messages: [
        ...session.messages,
        ...readPhiTimelineMessages(sessionPath, target.cwd, getPhiSessionIdForKey(targetKey))
      ]
    }
  })
  ipcMain.handle('sessions:acknowledge', async (_, path: string) => {
    const phiOnlySessionId = phiSessionIdFromPath(path)
    const cwd = phiOnlySessionId
      ? (findPhiSessionById(phiOnlySessionId)?.cwd ?? currentCwd)
      : (await openRuntimeSessionManager(path)).getCwd()
    return acknowledgeSession(path, cwd)
  })
  ipcMain.handle('sessions:delete', async (_, path: string) => {
    sessionTitleGenerator?.cancel(path)
    const deletionCwd = currentCwd
    const phiSessionId = phiSessionIdFromPath(path)
    const manifest = phiSessionId
      ? findPhiSessionById(phiSessionId)
      : findPhiSessionByRuntimePath(path, deletionCwd)
    const activeEntry = [...activePromptRuns.entries()].find(
      ([, run]) => run.phiSessionId === manifest?.sessionId
    )
    if (activeEntry) await stopPromptRun(activeEntry[0], activeEntry[1])
    if (currentSessionPath === path) {
      await disposeAndSwitchSession(undefined)
    }
    // Let an aborted run finish persisting before unlinking its history; otherwise
    // the final SDK write can recreate a conversation the user just deleted.
    await waitForSessionCleanup({
      path: manifest?.runtimeSessionPath ?? runtimeSessionPath(path),
      cwd: manifest?.cwd ?? currentCwd,
      permissionMode: currentPermissionMode
    })
    if (manifest?.sessionId && browserWorkspaceRegistry) {
      try {
        await browserWorkspaceRegistry.disposeSession(manifest.sessionId)
      } catch {
        writeAppLog({ level: 'error', event: 'browser_session_cleanup_failed' })
      }
    }
    if (
      manifest?.projectId &&
      remoteNotebookSessionIds.get(manifest.projectId) === manifest.sessionId
    ) {
      await disposeRemoteNotebookBackend(manifest.projectId)
    }
    // Session-private drafts and their registries are deleted here; Save As copies are project
    // files and intentionally remain outside this tree. Draft garbage collection is out of scope.
    deleteSession(path)
    if (manifest) loadedSkillNamesBySession.delete(manifest.sessionId)
  })
  ipcMain.handle('sessions:generateTitle', async (event, path: unknown) => {
    requireMainWindowRenderer(event)
    if (typeof path !== 'string' || !path || path.length > 8192) {
      throw new Error('对话路径无效')
    }
    const context = sessionTitleContext(path)
    if (runnerRegistry.getActiveRun(context.manifest.sessionId)) {
      throw new Error('请等待对话运行结束后再生成标题')
    }
    const title = await getSessionTitleGenerator().generate({ sessionPath: path, ...context })
    if (!title) throw new Error('暂时无法生成标题，请稍后重试，并检查当前模型是否可用')
    return title
  })
  ipcMain.handle('sessions:rename', async (_, path: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    manualTitleRequests.add(path)
    sessionTitleGenerator?.cancel(path)
    try {
      await enqueueSessionTitleWrite(path, () => renameConversation(path, trimmedName, 'user'))
    } finally {
      manualTitleRequests.delete(path)
    }
  })
  ipcMain.handle('sessions:export', async (_, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('会话编号无效')
    const manifest = findPhiSessionById(sessionId)
    if (!manifest) throw new Error('会话不存在')
    if (runnerRegistry.getActiveRun(sessionId)) throw new Error('请等待会话运行结束后再导出')
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.exportChat,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory', 'createDirectory']
    }
    const choice = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (choice.canceled || !choice.filePaths[0]) return null
    const result = await exportPhiSession(sessionId, choice.filePaths[0])
    writeAppLog({
      event: 'session_exported',
      sessionId,
      metadata: { fileCount: result.fileCount, bytes: result.bytes }
    })
    return result
  })

  ipcMain.handle('projects:list', async () => listProjects())
  ipcMain.handle('projects:pickDirectory', async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectProject,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(
    'projects:create',
    async (_, name: string, workingDirectory: string, permissionMode: PermissionMode) =>
      createProject({ name, workingDirectory, permissionMode })
  )
  ipcMain.handle('projects:createRemote', async (_, input: RemoteProjectCreateInput) =>
    createCheckedRemoteProject(input)
  )
  ipcMain.handle('projects:delete', async (_, id: string) => {
    // A broken terminal host must not make the project undeletable; its shells are already gone.
    await terminalManager?.closeWorkspace(`project:${id}`).catch(() => {
      writeAppLog({ level: 'error', event: 'terminal_project_close_failed' })
    })
    await disposeRemoteNotebookBackend(id)
    const project = getProject(id)
    await retireDesktopProjectMemoryAdapters(id)
    if (project?.memory) {
      // Memory lives under Phi's own directory, so it would outlive the project otherwise.
      await getPhiEngine()
        .memory.clear(projectMemoryTarget(project))
        .catch(() => writeAppLog({ level: 'error', event: 'project_memory_clear_failed' }))
    }
    deleteProject(id)
  })
  ipcMain.handle('projects:updatePermissionMode', async (event, id: string, value: unknown) => {
    requireMainWindowRenderer(event)
    const permissionMode = validatePermissionMode(value)
    const project = updateProjectPermissionMode(id, permissionMode)
    for (const manifest of listPhiSessions()) {
      if (manifest.projectId === id) {
        updateSessionManifest(manifest.sessionId, { permissionMode })
      }
    }
    const selected = findPhiManifestForSession(currentSessionKey, currentSessionPath, currentCwd)
    if (selected?.projectId === id || project.workingDirectory === currentCwd) {
      currentPermissionMode = permissionMode
      sessionPermissionModes.set(resolveSessionKeyAlias(currentSessionKey), permissionMode)
      notifySessionChanged()
    }
    return project
  })
  ipcMain.handle(
    'projects:updateDefaults',
    async (
      _,
      id: string,
      defaults: {
        defaultModel?: ModelSelection | null
        defaultThinkingLevel?: ThinkingLevel | null
      }
    ) => {
      if (defaults.defaultModel) {
        const runtime = await getAuthManager().getRuntime()
        const resolved = resolveRuntimeModelSelection(runtime, defaults.defaultModel)
        if (!resolved || resolved.migratedFrom) {
          throw new Error(
            `模型不可用: ${defaults.defaultModel.providerId}/${defaults.defaultModel.modelId}`
          )
        }
      }
      return updateProjectDefaults(id, defaults)
    }
  )
  // Memory settings reach the worker at session creation, so they apply to new conversations.
  ipcMain.handle('projects:updateMemory', async (_, id: string, settings: unknown) => {
    if (projectMemoryPolicyUpdates.has(id)) throw new Error('项目记忆设置正在更新，请稍后重试')
    const project = requireProject(id)
    const previous = normalizeProjectMemorySettings(project.memory)
    const next = normalizeProjectMemorySettings(settings)
    const currentBinding = (): string => {
      const current = requireProject(id)
      const profile =
        current.location.kind === 'ssh'
          ? getRemoteHostProfile(current.location.hostProfileId)
          : undefined
      return JSON.stringify([
        current.location,
        current.workingDirectory,
        current.workingDirectoryRealPath,
        normalizeProjectMemorySettings(current.memory),
        profile ? remoteConnectionConfigForProfile(profile) : null,
        current.location.kind === 'ssh' ? projectRemoteRuntimeRoot(current) : null
      ])
    }
    const binding = currentBinding()
    projectMemoryPolicyUpdates.add(id)
    try {
      if (previous.enabled !== next.enabled || previous.learn !== next.learn) {
        await retireDesktopProjectMemoryAdapters(id)
        if (currentBinding() !== binding) throw new StaleSessionError()
      }
      return updateProjectMemory(id, next)
    } finally {
      projectMemoryPolicyUpdates.delete(id)
    }
  })
  ipcMain.handle('memory:snapshot', async (_, id: string) => projectMemorySnapshot(id))
  ipcMain.handle('memory:deleteLesson', async (_, id: string, index: unknown, text: unknown) => {
    const project = requireProject(id)
    await retireDesktopProjectMemoryAdapters(id)
    await getPhiEngine().memory.deleteLesson({
      ...projectMemoryTarget(project),
      index,
      text
    })
    return projectMemorySnapshot(id)
  })
  ipcMain.handle('memory:clear', async (_, id: string) => {
    const project = requireProject(id)
    await retireDesktopProjectMemoryAdapters(id)
    await getPhiEngine().memory.clear(projectMemoryTarget(project))
    return projectMemorySnapshot(id)
  })
  ipcMain.handle('projects:listRemoteHosts', async () => listRemoteHostsWithRuntimeRoots())
  ipcMain.handle('projects:listRemoteDirectories', async (_, input: unknown) =>
    listRemoteProjectDirectories(input)
  )
  ipcMain.handle('projects:listOpenSshHosts', async () => listOpenSshHosts())
  ipcMain.handle('projects:saveOpenSshHost', async (_, input: OpenSshHostInput) => {
    if (!input || typeof input !== 'object') throw new Error('SSH 服务器配置无效')
    if (input.originalAlias) {
      const id = sshConfigHostId(input.originalAlias)
      const inUse = listProjects().some(
        (project) =>
          (project.location.kind === 'ssh' && project.location.hostProfileId === id) ||
          project.remoteConnections?.some((connection) => connection.hostProfileId === id)
      )
      if (inUse) {
        const current = (await listOpenSshHosts()).find(
          (host) => host.alias === input.originalAlias
        )
        if (
          !current ||
          current.hostname !== input.hostname ||
          (current.user ?? '') !== (input.user ?? '') ||
          current.port !== input.port
        ) {
          throw new Error('该服务器已绑定项目；更改地址、用户或端口前请先解除项目绑定')
        }
      }
    }
    const alias = await saveOpenSshHost(input)
    const profile = getRemoteHostProfile(sshConfigHostId(alias))
    if (!profile) throw new Error('SSH 配置已保存，但重新读取服务器失败；请刷新列表')
    return remoteHostProfileWithRuntimeRoot(profile)
  })
  ipcMain.handle(
    'projects:saveRemoteHost',
    async (
      _,
      input: {
        id?: string
        label: string
        hostAlias: string
        user?: string
        port?: number
        identityFile?: string
      }
    ) => {
      const saved = input.id ? getRemoteHostProfile(input.id) : undefined
      const inUse =
        input.id &&
        listProjects().some(
          (project) =>
            (project.location.kind === 'ssh' && project.location.hostProfileId === input.id) ||
            project.remoteConnections?.some((connection) => connection.hostProfileId === input.id)
        )
      if (
        saved &&
        inUse &&
        (saved.hostAlias !== input.hostAlias.trim() ||
          (saved.user ?? '') !== (input.user?.trim() ?? '') ||
          saved.port !== input.port)
      ) {
        throw new Error('该服务器已绑定项目；请先解除项目绑定，再修改地址或认证设置')
      }
      return remoteHostProfileWithRuntimeRoot(saveRemoteHostProfile(input))
    }
  )
  ipcMain.handle('projects:deleteRemoteHost', async (_, id: string) => {
    if (
      listProjects().some(
        (project) =>
          (project.location.kind === 'ssh' && project.location.hostProfileId === id) ||
          project.remoteConnections?.some((connection) => connection.hostProfileId === id)
      )
    ) {
      throw new Error('该服务器仍被项目使用，请先移除项目中的远程连接')
    }
    clearRemoteMicromambaMirrorSetting(id)
    clearRemoteEnvironmentSetting(id)
    clearRemoteRuntimeRootSetting(id)
    deleteRemoteHostProfile(id)
  })
  ipcMain.handle('remote:saveEnvironment', async (_, hostProfileId: unknown, value: unknown) => {
    if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
      throw new Error('SSH 服务器档案 ID 无效')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('远程环境配置无效')
    }
    const input = value as Record<string, unknown>
    if (
      input.runtimeRoot !== undefined &&
      input.runtimeRoot !== null &&
      typeof input.runtimeRoot !== 'string'
    ) {
      throw new Error('默认运行环境路径无效')
    }
    const toolPaths: Partial<Record<RemoteEnvironmentToolId, string>> = {}
    if (input.toolPaths !== undefined) {
      if (
        !input.toolPaths ||
        typeof input.toolPaths !== 'object' ||
        Array.isArray(input.toolPaths)
      ) {
        throw new Error('远程工具路径无效')
      }
      for (const id of ['nextflow', 'jupyter', 'micromamba', 'docker'] as const) {
        const path = (input.toolPaths as Record<string, unknown>)[id]
        if (path !== undefined && typeof path !== 'string') {
          throw new Error(`${id} 路径无效`)
        }
        if (typeof path === 'string') toolPaths[id] = path
      }
    }
    return saveRemoteEnvironmentSetting(hostProfileId, {
      ...(typeof input.runtimeRoot === 'string' ? { runtimeRoot: input.runtimeRoot } : {}),
      toolPaths
    } satisfies RemoteEnvironmentSettingInput)
  })
  ipcMain.handle(
    'remote:saveRuntimeRoot',
    async (_, hostProfileId: unknown, runtimeRoot: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (runtimeRoot !== undefined && runtimeRoot !== null && typeof runtimeRoot !== 'string') {
        throw new Error('远程运行时根目录无效')
      }
      return saveRemoteRuntimeRootSetting(hostProfileId, runtimeRoot)
    }
  )
  ipcMain.handle(
    'remote:saveMicromambaMirror',
    async (_, hostProfileId: unknown, downloadMirrorPrefix: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (
        downloadMirrorPrefix !== undefined &&
        downloadMirrorPrefix !== null &&
        typeof downloadMirrorPrefix !== 'string'
      ) {
        throw new Error('下载镜像前缀无效')
      }
      return saveRemoteMicromambaMirrorSetting(hostProfileId, downloadMirrorPrefix)
    }
  )
  ipcMain.handle(
    'remote:doctor',
    async (_, hostProfileId: unknown, remotePath: unknown, options: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (remotePath !== undefined && typeof remotePath !== 'string') {
        throw new Error('远程目录路径无效')
      }
      return remoteDoctor(hostProfileId, remotePath, options as RemoteDoctorOptions, {
        userInitiated: true
      })
    }
  )
  ipcMain.handle('remote:installNextflow', async (_, hostProfileId: unknown) => {
    if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
      throw new Error('SSH 服务器档案 ID 无效')
    }
    return installRemoteNextflow(hostProfileId)
  })
  ipcMain.handle(
    'projects:updateRemoteConnection',
    async (_, id: string, connectionId: string, patch: ProjectRemoteConnection | null) =>
      updateProjectRemoteConnectionRuntimeAware(id, connectionId, patch)
  )
  ipcMain.handle(
    'projects:updateRemoteDefaults',
    async (
      _,
      id: string,
      defaults: {
        defaultRemoteConnectionId?: string | null
        remoteWorkspaceRoot?: string | null
      }
    ) => updateProjectRemoteDefaults(id, defaults)
  )
  ipcMain.handle('projects:sessions', async (_, workingDirectory: string) =>
    listSessions(workingDirectory)
  )
  ipcMain.handle('projects:sessionsById', async (_, projectId: string) => {
    const project = getProject(projectId)
    if (!project) throw new Error('项目不存在')
    const cwd =
      project.location.kind === 'ssh'
        ? ensureRemoteProjectAnchor(project.id)
        : project.workingDirectory
    return listSessions(cwd)
  })
  ipcMain.handle('projects:newRemoteSession', async (_, projectId: string) => {
    const session = createRemoteManagedSession(projectId)
    const current = await disposeAndSwitchSession(session.path, session.cwd, session.permissionMode)
    scheduleRemoteProjectCheck(session.sessionId, projectId)
    return current
  })
  ipcMain.handle('projects:retryRemoteConnection', async (_, request: unknown) => {
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      Object.keys(request).length !== 2 ||
      typeof (request as Record<string, unknown>).sessionId !== 'string' ||
      typeof (request as Record<string, unknown>).projectId !== 'string'
    ) {
      throw new Error('远程重连请求必须包含会话和项目 ID')
    }
    const { sessionId, projectId } = request as { sessionId: string; projectId: string }
    return remoteConnectionTracker.check(sessionId, projectId, { userInitiated: true })
  })
  ipcMain.handle(
    'projects:newSession',
    async (_, workingDirectory: string, permissionMode: PermissionMode) => {
      assertProjectPathAvailable(workingDirectory)
      const session = createPhiManagedSession(workingDirectory, permissionMode)
      return disposeAndSwitchSession(session.path, workingDirectory, session.permissionMode)
    }
  )
  ipcMain.handle('analysis:listNotebooks', async (_, cwd?: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      return emptyNotebookRegistry('选择一个项目或当前 workspace 后显示 notebooks')
    }
    const remote = remoteNotebookBackendFor(workspace)
    const registry = remote
      ? await remote.workspace.list()
      : listProjectNotebooks(workspace.workingDirectory)
    return {
      projectCwd: workspace.workingDirectory,
      projectName: workspace.name,
      ...registry
    }
  })
  ipcMain.handle('analysis:initializeProject', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    return (
      remoteNotebookBackendFor(workspace)?.initializeProject() ??
      initializeProjectAnalysis(workspace.workingDirectory)
    )
  })
  ipcMain.handle('analysis:refreshNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    // Revalidation reads disk without replacing the tool draft or active path.
    return analysisOpenFile(workspace, notebookPath, true)
  })
  ipcMain.handle('analysis:openNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = await analysisOpenFile(workspace, notebookPath, true)
    activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
    syncAnalysisDraft(workspace, file, file.document, file.savedRevision, true)
    return file
  })
  ipcMain.handle(
    'analysis:saveNotebook',
    async (_, cwd: string, input: SaveProjectNotebookInput) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await analysisSaveFile(workspace, input)
      activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
      syncAnalysisDraft(workspace, file, file.document, file.savedRevision, true)
      return file
    }
  )
  ipcMain.handle(
    'analysis:syncNotebookDraft',
    async (
      _,
      cwd: string,
      notebookPath: string,
      document: NotebookDocument,
      savedRevision?: string
    ) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await analysisOpenFile(workspace, notebookPath)
      activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
      return syncAnalysisDraft(workspace, file, document, savedRevision ?? file.savedRevision)
    }
  )
  ipcMain.handle('analysis:createNotebook', async (_, cwd: string, relativePath?: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = await analysisCreateFile(workspace, relativePath)
    activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
    return file
  })
  ipcMain.handle('analysis:closeNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const closed = await analysisCloseFile(workspace, notebookPath)
    if (activeNotebookPathByProjectCwd.get(workspace.workingDirectory) === closed.path) {
      activeNotebookPathByProjectCwd.delete(workspace.workingDirectory)
    }
    return closed
  })
  ipcMain.handle('analysis:deleteNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const deleted = await analysisDeleteFile(workspace, notebookPath)
    if (activeNotebookPathByProjectCwd.get(workspace.workingDirectory) === deleted.path) {
      activeNotebookPathByProjectCwd.delete(workspace.workingDirectory)
    }
    return deleted
  })
  ipcMain.handle('analysis:listKernels', async (_, cwd?: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (workspace) return analysisKernels(workspace)
    const targetCwd = cwd ?? currentCwd
    if (isRemoteAnalysisCwd(targetCwd)) {
      throw new Error('远程 Notebook 会话或后端不可用；没有探测或回退到本机 Jupyter kernel。')
    }
    return detectConfiguredAnalysisKernels()
  })
  ipcMain.handle('analysis:jupyterStatus', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      return stoppedJupyterStatus(cwd, '请选择一个已添加的项目或当前 workspace')
    }
    return (
      remoteNotebookBackendFor(workspace)?.controller.status() ??
      jupyterServerRegistry.status(workspace.workingDirectory)
    )
  })
  ipcMain.handle('analysis:jupyterRuntimeStatus', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      return emptyAnalysisRuntimeStatus(cwd, '请选择一个已添加的项目或当前 workspace')
    }
    const remote = remoteNotebookBackendFor(workspace)
    const sessions = analysisSessions(workspace)
    return {
      server:
        remote?.controller.status() ?? jupyterServerRegistry.status(workspace.workingDirectory),
      notebooks: sessions.projectSummary(workspace.workingDirectory)
    }
  })
  ipcMain.handle('analysis:startJupyter', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    return (
      remoteNotebookBackendFor(workspace)?.controller.start() ??
      jupyterServerRegistry.start(workspace.workingDirectory)
    )
  })
  ipcMain.handle(
    'analysis:stopJupyter',
    async (_, cwd: string, options?: { abandonUnconfirmed?: boolean }) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const remote = remoteNotebookBackendFor(workspace)
      const sessions = analysisSessions(workspace)
      await sessions.closeProject(workspace.workingDirectory)
      if (remote) {
        const status = await remote.controller.stop({
          abandonUnconfirmed: options?.abandonUnconfirmed === true
        })
        await sessions.closeProject(workspace.workingDirectory)
        return status
      }
      notebookFileWatcher.unwatchProject(workspace.workingDirectory)
      return jupyterServerRegistry.stop(workspace.workingDirectory)
    }
  )
  ipcMain.handle(
    'analysis:notebookSessionStatus',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await analysisOpenFile(workspace, notebookPath)
      return analysisSessions(workspace).status({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: analysisKernels(workspace)
      })
    }
  )
  ipcMain.handle(
    'analysis:ensureNotebookSession',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await analysisOpenFile(workspace, notebookPath)
      return analysisSessions(workspace).ensureSession({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: analysisKernels(workspace)
      })
    }
  )
  ipcMain.handle('analysis:closeNotebookSession', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = await analysisOpenFile(workspace, notebookPath)
    return analysisSessions(workspace).closeSession(workspace.workingDirectory, file.path)
  })
  ipcMain.handle(
    'analysis:interruptNotebookExecution',
    async (_, cwd: string, notebookPath: string) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await analysisOpenFile(workspace, notebookPath)
      return analysisSessions(workspace).interruptSession(workspace.workingDirectory, file.path)
    }
  )
  ipcMain.handle(
    'analysis:completeNotebookCell',
    async (
      _,
      cwd: string,
      input: {
        path: string
        document: NotebookDocument
        cellId: string
        source: string
        cursorPosition: number
      }
    ) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const remote = remoteNotebookBackendFor(workspace)
      const file = await analysisOpenFile(workspace, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      const cursorPosition = Number.isFinite(input.cursorPosition)
        ? Math.max(0, Math.min(input.cursorPosition, input.source.length))
        : 0
      if (!cell || cell.cellType !== 'code') {
        return emptyNotebookCompletionResult(cursorPosition, 'Notebook cell is not a code cell')
      }

      const staticCompletion =
        !remote && isPythonNotebookDocument(input.document)
          ? completeNotebookPythonStaticCompletion({
              projectCwd: workspace.workingDirectory,
              source: input.source,
              cursorPosition
            })
          : null
      const target = analysisSessions(workspace).executionTarget(
        workspace.workingDirectory,
        file.path
      )
      if (!target) {
        return (
          staticCompletion ??
          emptyNotebookCompletionResult(cursorPosition, 'Notebook kernel is not connected')
        )
      }

      try {
        const kernelCompletion = await notebookExecutor.completeCode({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          code: input.source,
          cursorPosition
        })
        return mergeNotebookCompletionResults(kernelCompletion, staticCompletion)
      } catch (error) {
        return (
          staticCompletion ?? emptyNotebookCompletionResult(cursorPosition, errorMessage(error))
        )
      }
    }
  )
  ipcMain.handle(
    'analysis:formatNotebookCell',
    async (
      _,
      cwd: string,
      input: {
        path: string
        document: NotebookDocument
        cellId: string
        source: string
        language?: string
        lineLength?: number
      }
    ) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      await analysisOpenFile(workspace, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      if (!cell || cell.cellType !== 'code') {
        return {
          source: input.source,
          changed: false,
          formatter: 'none' as const,
          message: 'Notebook cell is not a code cell'
        }
      }

      if (remoteNotebookBackendFor(workspace)) {
        throw new Error(
          '远程 Notebook 暂不支持桌面端本机 formatter；请在登录节点环境中格式化。没有回退到本机执行。'
        )
      }

      return formatNotebookCellSource({
        projectCwd: workspace.workingDirectory,
        source: input.source,
        language: input.language,
        lineLength: input.lineLength
      })
    }
  )
  ipcMain.handle('analysis:listNotebookAiGenerationJobs', () => notebookAiGenerationJobs.list())
  ipcMain.handle(
    'analysis:generateNotebookCode',
    async (
      event,
      cwd: string,
      notebookPath: string,
      document: NotebookDocument,
      input: AnalysisNotebookCodeGenerationInput
    ) =>
      generateAnalysisNotebookCode(cwd, notebookPath, document, input, (progress) => {
        event.sender.send('analysis:notebookCodeGenerationProgress', progress)
      })
  )
  ipcMain.handle(
    'analysis:executeNotebookCell',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument, cellId: string) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const remote = remoteNotebookBackendFor(workspace)
      const file = await analysisOpenFile(workspace, notebookPath)
      const kernels = analysisKernels(workspace)
      const sessions = analysisSessions(workspace)
      let sessionStatus = await sessions.ensureSession({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels
      })
      let target = sessions.executionTarget(workspace.workingDirectory, file.path)
      if (!target) {
        if (remote) remote.controller.requireReady()
        else await ensureJupyterServerReady(workspace.workingDirectory)
        sessionStatus = await sessions.ensureSession({
          projectCwd: workspace.workingDirectory,
          notebookPath: file.path,
          document,
          kernels
        })
        target = sessions.executionTarget(workspace.workingDirectory, file.path)
      }
      if (!target) {
        throw new Error(sessionStatus.message ?? '请先连接 notebook kernel')
      }

      const cell = document.cells.find((item) => item.id === cellId)
      if (!cell) {
        throw new Error(`Notebook cell not found: ${cellId}`)
      }

      sessions.updateSessionState(
        workspace.workingDirectory,
        file.path,
        'busy',
        'Notebook kernel 正在执行'
      )
      try {
        const execution = await notebookExecutor.executeCell({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          cell
        })
        const nextDocument = updateNotebookCell(document, cellId, {
          executionCount: execution.executionCount,
          outputs: execution.outputs,
          metadata: notebookCellMetadataWithExecutionDuration(cell.metadata, execution)
        })
        syncAnalysisDraft(workspace, file, nextDocument)
        const nextSessionStatus =
          sessions.updateSessionState(
            workspace.workingDirectory,
            file.path,
            'idle',
            execution.state === 'error' ? 'Cell 执行出错，kernel 仍可继续使用' : 'Cell 执行完成'
          ) ?? sessionStatus
        return {
          ...execution,
          document: nextDocument,
          sessionStatus: nextSessionStatus
        }
      } catch (error) {
        sessions.updateSessionState(
          workspace.workingDirectory,
          file.path,
          'error',
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
    }
  )

  ipcMain.handle('tool:approval-response', async (event, requestId: unknown, approved: unknown) => {
    if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > 256 ||
      typeof approved !== 'boolean'
    ) {
      return false
    }
    return resolveToolApproval(requestId, approved, event.sender)
  })

  ipcMain.handle(
    'agent:interaction-response',
    async (_, requestId: string, response, cancelled?: boolean) => {
      resolveAgentUserInteraction(requestId, response, cancelled === true)
    }
  )

  ipcMain.handle('phiPlugins:list', async () => phiPluginListItems())
  ipcMain.handle('phiPlugins:pickDirectory', async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectPlugin,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('phiPlugins:previewDirectory', async (_, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return {
        ok: false,
        path: '',
        problems: [
          phiPluginProblemView({
            level: 'error',
            path: 'path',
            message: 'Select a valid Plugin directory'
          })
        ]
      } satisfies PhiPluginInstallPreview
    }
    try {
      return phiPluginInstallPreview(path)
    } catch (error) {
      logUnexpectedError(error)
      return {
        ok: false,
        path,
        problems: [
          phiPluginProblemView({
            level: 'error',
            path: 'preview',
            message: `Plugin validation failed: ${error instanceof Error ? error.message : String(error)}`
          })
        ]
      } satisfies PhiPluginInstallPreview
    }
  })
  ipcMain.handle('phiPlugins:installFromDirectory', async (_, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return failedPhiPluginMutation('path', 'Select a valid Plugin directory')
    }
    try {
      const validation = validatePlugin(path)
      if (!validation.ok || !validation.plugin) {
        return phiPluginMutation({
          ok: false,
          errors: validation.errors,
          warnings: validation.warnings
        })
      }
      const existing = listInstalledPlugins({ agentDir: AGENT_DIR }).find(
        (plugin) => plugin.id === validation.plugin?.manifest.id
      )
      const names = await installedPluginNamespace()
      let result: PluginLifecycleResult
      if (!existing) {
        result = installPhiPlugin(path, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot(),
          names,
          source: 'local'
        })
      } else if (semver.gt(validation.plugin.manifest.version, existing.version)) {
        result = await upgradePlugin(path, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot(),
          names,
          source: 'local',
          build: (descriptor, options) => environmentBuilds.start(descriptor, options)
        })
      } else {
        return failedPhiPluginMutation(
          'version',
          `${existing.id} ${existing.version} is already installed. Select a newer version to upgrade.`
        )
      }
      if (result.ok) await invalidateAgentSession()
      return phiPluginMutation(result)
    } catch (error) {
      logUnexpectedError(error)
      return failedPhiPluginMutation(
        'install',
        `Plugin installation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('phiPlugins:setEnabled', async (_, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || typeof enabled !== 'boolean') {
      return failedPhiPluginMutation('request', 'Invalid Plugin ID or enabled state')
    }
    try {
      const result = setPluginEnabled(id, enabled, {
        agentDir: AGENT_DIR,
        names: await installedPluginNamespace()
      })
      return phiPluginMutation(result)
    } catch (error) {
      logUnexpectedError(error)
      return failedPhiPluginMutation(
        'enabled',
        `Could not update Plugin state: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('phiPlugins:uninstall', async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      return failedPhiPluginMutation('id', 'Invalid Plugin ID')
    }
    try {
      const result = uninstallPhiPlugin(id, {
        agentDir: AGENT_DIR,
        runtimeRoot: getRuntimeRoot()
      })
      if (result.ok) await invalidateAgentSession()
      return phiPluginMutation(result)
    } catch (error) {
      logUnexpectedError(error)
      return failedPhiPluginMutation(
        'uninstall',
        `Could not uninstall Plugin: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('packages:pickRegistryDirectory', async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectSkill,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('packages:pickArchive', async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.importPackage,
      buttonLabel: dialogCopy.import,
      properties: ['openFile'],
      filters: [{ name: dialogCopy.packageFilter, extensions: ['tar.gz'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('packages:listRegistries', async () => {
    const result = await listKnownRegistries(knownContentSourceOptions())
    if (result.error) {
      writeAppLog({
        level: 'warn',
        event: 'package_registries_invalid',
        metadata: { error: result.error }
      })
    }
    return result.registries
  })
  ipcMain.handle('packages:contentCatalog', async (_, forceRefresh?: unknown) => {
    if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean')
      throw new Error('Invalid catalog refresh request')
    const registry = await syncPreferredOfficialRegistry({
      ...officialContentSourceOptions(),
      forceRefresh: forceRefresh === true
    })
    return packageRegistryIconView(registry)
  })
  ipcMain.handle('packages:removeRegistry', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid source ID')
    removeKnownRegistry(id, { agentDir: AGENT_DIR })
    return (await listKnownRegistries(knownContentSourceOptions())).registries
  })
  ipcMain.handle('sources:previewGithub', async (_, url: unknown) => {
    if (typeof url !== 'string' || url.length < 1 || url.length > 2048) {
      throw new Error('Invalid GitHub repository URL')
    }
    return previewGithubSource(url, { agentDir: AGENT_DIR, fetch: officialRegistryFetch })
  })
  ipcMain.handle('sources:addGithub', async (_, input: unknown) => {
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => key !== 'url' && key !== 'sha') ||
      typeof input.url !== 'string' ||
      input.url.length < 1 ||
      input.url.length > 2048 ||
      typeof input.sha !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(input.sha)
    ) {
      throw new Error('Invalid GitHub source import request')
    }
    const source = await addGithubSource(
      { url: input.url, sha: input.sha },
      { agentDir: AGENT_DIR, fetch: officialRegistryFetch }
    )
    await refreshGithubSourceDependants()
    writeAppLog({ event: 'github_source_added', metadata: { repo: source.repo, sha: source.sha } })
    return source
  })
  ipcMain.handle('sources:checkGithubUpdate', async (_, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) {
      throw new Error('Invalid GitHub source ID')
    }
    return checkGithubSourceUpdate(id, { agentDir: AGENT_DIR, fetch: officialRegistryFetch })
  })
  ipcMain.handle('sources:applyGithubUpdate', async (_, input: unknown) => {
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => key !== 'id' && key !== 'sha') ||
      typeof input.id !== 'string' ||
      !/^[a-f0-9]{16}$/.test(input.id) ||
      typeof input.sha !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(input.sha)
    ) {
      throw new Error('Invalid GitHub source refresh request')
    }
    const source = await applyGithubSourceUpdate(input.id, input.sha, {
      agentDir: AGENT_DIR,
      fetch: officialRegistryFetch
    })
    await refreshGithubSourceDependants()
    writeAppLog({
      event: 'github_source_updated',
      metadata: { repo: source.repo, sha: source.sha }
    })
    return source
  })
  ipcMain.handle('sources:removeGithub', async (_, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) {
      throw new Error('Invalid GitHub source ID')
    }
    const source = listGithubSources({ agentDir: AGENT_DIR }).sources.find(
      (entry) => entry.id === id
    )
    const removed = await removeGithubSource(id, { agentDir: AGENT_DIR })
    if (removed) {
      await refreshGithubSourceDependants()
      if (source) {
        writeAppLog({
          event: 'github_source_removed',
          metadata: { repo: source.repo, sha: source.sha }
        })
      }
    }
    return removed
  })
  ipcMain.handle('sources:listGithub', async () => {
    const state = listGithubSources({ agentDir: AGENT_DIR })
    if (state.error) {
      writeAppLog({ level: 'warn', event: 'github_sources_invalid' })
    }
    return state.sources
  })
  ipcMain.handle('packages:registry', async (_, dir: unknown) => {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new Error('Invalid registry directory')
    }
    try {
      const registry = await readContentRegistry(dir, officialContentSourceOptions())
      return packageRegistryIconView(registry)
    } catch (error) {
      throw new Error(
        `Could not read package registry: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle(
    'packages:plan',
    async (_, dir: unknown, type: unknown, id: unknown, version?: unknown) => {
      if (
        typeof dir !== 'string' ||
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0 ||
        (version !== undefined && typeof version !== 'string')
      ) {
        throw new Error('Invalid package installation plan request')
      }
      try {
        const registry = await readContentRegistry(dir, officialContentSourceOptions())
        return planRegistryInstall(
          registry,
          { type, id, ...(version ? { version } : {}) },
          { agentDir: AGENT_DIR, appVersion: app.getVersion() }
        )
      } catch (error) {
        throw new Error(
          `Could not create package installation plan: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )
  ipcMain.handle('packages:skillDetail', async (_, dir: unknown, id: unknown) => {
    if (typeof dir !== 'string' || typeof id !== 'string' || id.length === 0) {
      throw new Error('Invalid Skill package detail request')
    }
    try {
      const registry = await readContentRegistry(dir, officialContentSourceOptions())
      return await readSkillPackageDetail(registry, id, officialContentSourceOptions())
    } catch (error) {
      throw new Error(
        `Could not read Skill package details: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('packages:wrapperDetail', async (_, dir: unknown, id: unknown) => {
    if (typeof dir !== 'string' || typeof id !== 'string' || id.length === 0) {
      throw new Error('Invalid Wrapper package detail request')
    }
    try {
      const registry = await readContentRegistry(dir, officialContentSourceOptions())
      return await readWrapperPackageDetail(registry, id, officialContentSourceOptions())
    } catch (error) {
      throw new Error(
        `Could not read Wrapper package details: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle(
    'packages:install',
    serializedPackageMutation(
      async (_, dir: unknown, type: unknown, id: unknown, version?: unknown) => {
        if (
          typeof dir !== 'string' ||
          (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
          typeof id !== 'string' ||
          id.length === 0 ||
          (version !== undefined && typeof version !== 'string')
        ) {
          throw new Error('Invalid package installation request')
        }
        try {
          const registry = await readContentRegistry(dir, officialContentSourceOptions())
          const installedBefore = new Set(
            listRegistryPackages({ agentDir: AGENT_DIR }).map((item) => `${item.type}:${item.id}`)
          )
          await prepareContentPackageInstall(
            registry,
            { type, id, ...(version ? { version } : {}) },
            officialContentSourceOptions()
          )
          const plan = planRegistryInstall(
            registry,
            { type, id, ...(version ? { version } : {}) },
            { agentDir: AGENT_DIR, appVersion: app.getVersion() }
          )
          const result = await installRegistryPackages(plan, {
            agentDir: AGENT_DIR,
            runtimeRoot: getRuntimeRoot(),
            names: await installedPluginNamespace(),
            build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
          })
          for (const installed of result) {
            if (
              installed.type === 'skill' &&
              !installedBefore.has(`${installed.type}:${installed.id}`)
            ) {
              setEnabled(`skill:${installed.id}`, true, { agentDir: AGENT_DIR })
            }
            if (
              installed.type === 'mcp' &&
              !installedBefore.has(`${installed.type}:${installed.id}`)
            ) {
              setEnabled(`mcp:${installed.id}`, true, { agentDir: AGENT_DIR })
              setMcpPackageEnabled(installed.id, true, AGENT_DIR)
            }
          }
          if (result.some((installed) => installed.type === 'wrapper')) {
            resetWrapperCompositionCatalogCache()
          }
          await invalidateAgentSession()
          return result
        } catch (error) {
          throw new Error(
            `Package installation failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  )
  ipcMain.handle(
    'packages:removeWrapper',
    serializedPackageMutation(async (_, id: unknown) => {
      if (typeof id !== 'string' || id.length === 0)
        throw new Error('Invalid Wrapper package request')
      try {
        const result = removeWrapperPackage(id, { agentDir: AGENT_DIR })
        resetWrapperCompositionCatalogCache()
        await invalidateAgentSession()
        return result
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
    })
  )
  ipcMain.handle(
    'packages:uninstall',
    serializedPackageMutation(async (_, type: unknown, id: unknown) => {
      if (
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0
      ) {
        throw new Error('Invalid package uninstall request')
      }
      try {
        const result = uninstallRegistryPackage(type, id, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot()
        })
        if (type === 'wrapper') resetWrapperCompositionCatalogCache()
        if (type === 'mcp') setEnabled(`mcp:${id}`, null, { agentDir: AGENT_DIR })
        await invalidateAgentSession()
        return result
      } catch (error) {
        throw new Error(
          `Could not uninstall package: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )
  ipcMain.handle('packages:listInstalled', async () => {
    try {
      return listRegistryPackages({ agentDir: AGENT_DIR })
    } catch (error) {
      throw new Error(
        `Could not read installed packages: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('packages:previewImport', async (_, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0)
      throw new Error('Invalid offline package path')
    try {
      return previewOfflinePackageImport(path, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        registries: (await loadPackageRegistries()).registries
      })
    } catch (error) {
      throw new Error(
        `Could not read offline package: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle(
    'packages:import',
    serializedPackageMutation(async (_, path: unknown) => {
      if (typeof path !== 'string' || path.length === 0)
        throw new Error('Invalid offline package path')
      const installedBefore = new Set(
        listRegistryPackages({ agentDir: AGENT_DIR }).map((item) => `${item.type}:${item.id}`)
      )
      try {
        const result = await importOfflinePackage(path, {
          agentDir: AGENT_DIR,
          appVersion: app.getVersion(),
          runtimeRoot: getRuntimeRoot(),
          registries: (await loadPackageRegistries()).registries,
          preparePackage: async (registry, entry) => {
            await prepareContentPackageInstall(
              registry,
              { type: entry.type, id: entry.id, version: entry.version },
              officialContentSourceOptions()
            )
          },
          names: await installedPluginNamespace(),
          build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
        })
        for (const installed of result) {
          if (
            !installedBefore.has(`${installed.type}:${installed.id}`) &&
            installed.type === 'skill'
          ) {
            setEnabled(`skill:${installed.id}`, true, { agentDir: AGENT_DIR })
          }
          if (
            !installedBefore.has(`${installed.type}:${installed.id}`) &&
            installed.type === 'mcp'
          ) {
            setEnabled(`mcp:${installed.id}`, true, { agentDir: AGENT_DIR })
            setMcpPackageEnabled(installed.id, true, AGENT_DIR)
          }
        }
        if (result.some((installed) => installed.type === 'wrapper')) {
          resetWrapperCompositionCatalogCache()
        }
        await invalidateAgentSession()
        return result
      } catch (error) {
        throw new Error(
          `Could not import package: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )
  ipcMain.handle('packages:listUpdates', async () =>
    packageUpdateViews(await refreshCachedPackageUpdates())
  )
  ipcMain.handle(
    'packages:applyUpdate',
    serializedPackageMutation(async (_, type: unknown, id: unknown) => {
      if (
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0
      ) {
        throw new Error('Invalid package update request')
      }
      const loaded = await loadPackageRegistries()
      const updates = listPackageUpdates(loaded.registries, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion()
      })
      const update = updates.find((candidate) => candidate.type === type && candidate.id === id)
      if (!update) throw new Error(`No update available: ${type}:${id}`)
      const result = await applyPackageUpdate(update, loaded.registries, {
        preparePackage: async (registry, request) => {
          await prepareContentPackageInstall(registry, request, officialContentSourceOptions())
        },
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        runtimeRoot: getRuntimeRoot(),
        names: await installedPluginNamespace(),
        build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
      })
      if (type === 'wrapper') resetWrapperCompositionCatalogCache()
      cachedPackageUpdates = listPackageUpdates(loaded.registries, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion()
      })
      await invalidateAgentSession()
      return result
    })
  )
  ipcMain.handle(
    'packages:applyAllUpdates',
    serializedPackageMutation(async () => {
      const loaded = await loadPackageRegistries()
      const updates = listPackageUpdates(loaded.registries, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion()
      })
      const result = await applyPackageUpdates(updates, loaded.registries, {
        preparePackage: async (registry, request) => {
          await prepareContentPackageInstall(registry, request, officialContentSourceOptions())
        },
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        runtimeRoot: getRuntimeRoot(),
        names: await installedPluginNamespace(),
        build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
      })
      if (updates.some((update) => update.type === 'wrapper')) {
        resetWrapperCompositionCatalogCache()
      }
      cachedPackageUpdates = listPackageUpdates(loaded.registries, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion()
      })
      await invalidateAgentSession()
      return result
    })
  )
  ipcMain.handle('enablement:get', async (_, projectCwd?: unknown) => {
    if (projectCwd !== undefined && typeof projectCwd !== 'string') {
      throw new Error('项目目录无效')
    }
    if (typeof projectCwd === 'string' && isRemoteResourceScope(projectCwd)) {
      throw new Error('Skills are not available for this remote project')
    }
    return getEnablementSnapshot({
      agentDir: AGENT_DIR,
      ...(typeof projectCwd === 'string' && projectCwd.length > 0 ? { projectDir: projectCwd } : {})
    })
  })
  ipcMain.handle('enablement:set', async (_, item: unknown, value: unknown, scope: unknown) => {
    if (!isEnablementItemKey(item)) throw new Error('Invalid enablement item ID')
    if (typeof value !== 'boolean' && value !== null) throw new Error('Invalid enablement value')
    const options = enablementScopeOptions(scope as EnablementScope)
    if (item.startsWith('plugin:')) {
      const pluginId = item.slice('plugin:'.length)
      const inherited = options.projectDir
        ? getEnablementSnapshot({ agentDir: AGENT_DIR, ...options }).global[item]
        : undefined
      const desired = value ?? inherited ?? true
      const result = setPluginEnabled(pluginId, desired, {
        agentDir: AGENT_DIR,
        ...options,
        names: await installedPluginNamespace(options.projectDir)
      })
      if (!result.ok) {
        throw new Error(
          result.errors.map((problem) => problem.message).join('; ') ||
            'Invalid Plugin enabled state'
        )
      }
      if (value === null) setEnabled(item, null, { agentDir: AGENT_DIR, ...options })
    } else if (item.startsWith('mcp:')) {
      const packageId = item.slice('mcp:'.length)
      const inherited = options.projectDir
        ? getEnablementSnapshot({ agentDir: AGENT_DIR, ...options }).global[item]
        : undefined
      const desired = value ?? inherited ?? true
      setEnabled(item, value, { agentDir: AGENT_DIR, ...options })
      setMcpPackageEnabled(packageId, desired, AGENT_DIR)
    } else {
      setEnabled(item, value, { agentDir: AGENT_DIR, ...options })
    }
    if (item.startsWith('wrapper:')) resetWrapperCompositionCatalogCache()
    return getEnablementSnapshot({ agentDir: AGENT_DIR, ...options })
  })
  ipcMain.handle('skills:list', async (_, cwd?: string) =>
    isRemoteResourceScope(cwd) ? listRemoteProjectSkills(cwd) : listSkills(cwd ?? currentCwd)
  )
  ipcMain.handle('skills:read', async (_, filePath: string, cwd?: string) => {
    if (isRemoteResourceScope(cwd)) {
      const context = remoteSkillProjectContext(cwd)
      const catalog = await loadRemoteProjectSkillCatalog(context)
      if (catalog.summaries.some((skill) => skill.filePath === filePath)) {
        return readRemoteProjectSkillContent(context, filePath)
      }
      return readGlobalSkillContent(filePath)
    }
    return readSkillContent(filePath, cwd ?? currentCwd)
  })
  ipcMain.handle(
    'skills:setDisabled',
    async (_, filePath: string, disabled: boolean, cwd?: string) => {
      if (isRemoteResourceScope(cwd)) {
        throw new Error('Skills are not available for this remote project')
      }
      return setSkillDisabled(filePath, Boolean(disabled), cwd ?? currentCwd)
    }
  )
  ipcMain.handle('skills:delete', async (_, filePath: string, cwd?: string) => {
    if (isRemoteResourceScope(cwd)) {
      throw new Error('Skills are not available for this remote project')
    }
    return deleteSkill(filePath, cwd ?? currentCwd)
  })
  ipcMain.handle('skills:trustRemoteProject', async (_, input: unknown) => {
    const request = checkedRemoteSkillTrustMutation(input)
    const context = remoteSkillProjectContext(request.cwd)
    await trustRemoteProjectSkill(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return listRemoteProjectSkills(request.cwd)
  })
  ipcMain.handle('skills:revokeRemoteProjectTrust', async (_, input: unknown) => {
    const request = checkedRemoteSkillTrustMutation(input)
    const context = remoteSkillProjectContext(request.cwd)
    await revokeRemoteProjectSkillTrust(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return listRemoteProjectSkills(request.cwd)
  })
  ipcMain.handle('agents:list', async (_, cwd?: string) =>
    isRemoteResourceScope(cwd) ? listRemotePromptAgents(cwd) : listPromptAgents(cwd ?? currentCwd)
  )
  ipcMain.handle('agents:trustRemoteProject', async (_, input: unknown) => {
    const request = checkedRemoteAgentTrustMutation(input)
    const context = remoteAgentProjectContext(request.cwd)
    await trustRemoteAgent(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return (await loadRemoteAgentCatalog(context)).entries
  })
  ipcMain.handle('agents:revokeRemoteProjectTrust', async (_, input: unknown) => {
    const request = checkedRemoteAgentTrustMutation(input)
    const context = remoteAgentProjectContext(request.cwd)
    await revokeRemoteAgent(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return (await loadRemoteAgentCatalog(context)).entries
  })
  const connectorSetups = new ConnectorSetupTracker(
    (progress) => sendToAllWindows('mcp:connectorSetupChanged', progress),
    undefined,
    { path: join(AGENT_DIR, 'state', 'connector-setup.json') }
  )
  const connectorCatalog = async (
    forceRefresh = false
  ): Promise<ReturnType<typeof listConnectorCatalog>> =>
    listConnectorCatalog({
      agentDir: AGENT_DIR,
      appVersion: app.getVersion(),
      runtimeRoot: getRuntimeRoot(),
      registries: (await loadPackageRegistries('mcp', forceRefresh)).registries
    }).map((connector) => ({ ...connector, setup: connectorSetups.get(connector.id) }))
  const localConnectorJobs = createLocalConnectorJobs({
    tracker: connectorSetups,
    agentDir: AGENT_DIR,
    runtimeRoot: getRuntimeRoot(),
    probe: (request) => getPhiEngine().mcp.configuredStdioTools(request),
    cancelProbe: (requestKey) => getPhiEngine().mcp.cancelConfiguredStdioTools({ requestKey }),
    applyEnabled: (name) => getPhiEngine().mcp.applyConnectorEnabled({ name }),
    onEvent: (event, metadata) =>
      writeAppLog({ event: `mcp_local_connector_add_${event}`, metadata })
  })

  async function prepareStdioEnvironment(
    id: string,
    report: ConnectorSetupReporter
  ): Promise<{ envId: string }> {
    report('environment')
    const action = connectorEnvironmentBuildAction(id, { agentDir: AGENT_DIR })
    const handle = await environmentBuilds.start(action.descriptor, action.options)
    const refreshed = refreshPersistedManagedStdioServers({
      agentDir: AGENT_DIR,
      runtimeRoot: getRuntimeRoot()
    })
    const failure = refreshed.failures.find((entry) => entry.name === id)
    if (failure) throw failure.error
    return { envId: handle.envId }
  }

  async function probeStdioTools(id: string, report: ConnectorSetupReporter): Promise<string[]> {
    const entry = readMcpServerEntry(id, AGENT_DIR)
    if (!entry || entry.phiPackage !== id) throw new Error('Install this local Connector first')
    report('starting')
    const toolNames = await getPhiEngine().mcp.configuredStdioTools({
      name: id,
      entry,
      environment: { agentDir: AGENT_DIR, root: getRuntimeRoot() }
    })
    return toolNames
  }
  const listedMcpServers = async (
    cwd?: string
  ): Promise<Awaited<ReturnType<typeof listMcpServers>>> => {
    if (!isRemoteResourceScope(cwd)) return listMcpServers(cwd ?? currentCwd)
    const [globalServers, projectCatalog] = await Promise.all([
      listGlobalMcpServers(),
      loadRemoteProjectMcpCatalog(remoteMcpProjectContext(cwd))
    ])
    return [...globalServers, ...projectCatalog.summaries]
  }
  ipcMain.handle('mcp:listServers', async (_, cwd?: string) => {
    const servers = await listedMcpServers(cwd)
    return withConnectorMetadata(servers, await connectorCatalog())
  })
  ipcMain.handle('mcp:trustRemoteProject', async (_, input: unknown) => {
    const request = checkedRemoteMcpTrustMutation(input)
    await trustRemoteProjectMcp(remoteMcpProjectContext(request.cwd), {
      relativePath: request.relativePath,
      contentHash: request.contentHash,
      confirmedItemIds: request.confirmedItemIds
    })
    await invalidateAgentSession()
    return withConnectorMetadata(await listedMcpServers(request.cwd), await connectorCatalog())
  })
  ipcMain.handle('mcp:revokeRemoteProjectTrust', async (_, input: unknown) => {
    const request = checkedRemoteMcpTrustMutation(input)
    await revokeRemoteProjectMcpTrust(remoteMcpProjectContext(request.cwd), {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return withConnectorMetadata(await listedMcpServers(request.cwd), await connectorCatalog())
  })
  ipcMain.handle('mcp:listConnectorCatalog', async () => connectorCatalog(true))
  ipcMain.handle(
    'mcp:installConnector',
    async (_, id: unknown, version?: unknown, registryDir?: unknown) => {
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        (version !== undefined && typeof version !== 'string') ||
        (registryDir !== undefined && typeof registryDir !== 'string')
      ) {
        throw new Error('Invalid Connector installation request')
      }
      const connector = (await connectorCatalog()).find(
        (entry) =>
          entry.id === id &&
          (version === undefined || entry.version === version) &&
          (registryDir === undefined || entry.registryDir === registryDir)
      )
      if (!connector?.registryDir) throw new Error(`Connector ${id} was not found in the catalog`)
      if (connector.unavailableReason) throw new Error(connector.unavailableReason)
      const sourceRegistryDir = connector.registryDir
      return connectorSetups.run(
        connector.id,
        async (report) => {
          const wasConfigured = readMcpServerEntry(connector.id, AGENT_DIR) !== undefined
          let toolNames: string[] | undefined
          const sourceOptions = officialContentSourceOptions()
          const result = await installCatalogConnector(
            sourceRegistryDir,
            connector.id,
            connector.version,
            {
              ...sourceOptions,
              runtimeRoot: getRuntimeRoot(),
              onPhase: report,
              buildMcpEnvironment: (descriptor) => {
                report('environment')
                return sourceOptions.buildMcpEnvironment(descriptor)
              },
              verifyMcpStdio: async (request) => {
                report('starting')
                toolNames = await sourceOptions.verifyMcpStdio(request)
                return toolNames
              }
            }
          )
          if (!wasConfigured) {
            setEnabled(`mcp:${connector.id}`, true, { agentDir: AGENT_DIR })
            setMcpPackageEnabled(connector.id, true, AGENT_DIR)
          }
          try {
            if (connector.transport === 'stdio' && toolNames === undefined) {
              await prepareStdioEnvironment(connector.id, report)
              toolNames = await probeStdioTools(connector.id, report)
            }
          } finally {
            await invalidateAgentSession()
          }
          if (toolNames) report('ready', { toolNames })
          return result
        },
        connector.transport === 'stdio' ? 'ready' : 'installed'
      )
    }
  )
  ipcMain.handle('mcp:uninstallConnector', async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid Connector ID')
    return connectorSetups.run(
      id,
      async () => {
        const result = uninstallCatalogConnector(id, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot()
        })
        setEnabled(`mcp:${id}`, null, { agentDir: AGENT_DIR })
        await invalidateAgentSession()
        return result
      },
      'removed'
    )
  })
  ipcMain.handle('mcp:buildConnectorEnvironment', async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid Connector ID')
    return connectorSetups.run(id, async (report) => {
      let environment: { envId: string }
      let toolNames: string[]
      try {
        environment = await prepareStdioEnvironment(id, report)
        toolNames = await probeStdioTools(id, report)
      } finally {
        await invalidateAgentSession()
      }
      report('ready', { toolNames })
      return environment
    })
  })
  ipcMain.handle(
    'mcp:addRemoteConnector',
    async (_, name: string, url: string, options?: RemoteMcpConnectorOptions) => {
      addRemoteMcpConnector(name, url, undefined, options)
      await syncFeaturedMcpApiKeySessions(name)
    }
  )
  ipcMain.handle('mcp:addLocalConnector', async (_, raw: unknown) => {
    const catalogIds = (await connectorCatalog()).map((connector) => connector.id)
    const request = validateLocalConnectorRequest(raw, { catalogIds })
    // The MCP client only loads under the omp worker's Bun runtime, so probe through the bridge
    // exactly like the package installer does; the Electron main process cannot import it.
    const result = await addLocalMcpConnector(request, {
      agentDir: AGENT_DIR,
      catalogIds,
      probe: (probeRequest) => getPhiEngine().mcp.configuredStdioTools(probeRequest)
    })
    await getPhiEngine().mcp.applyConnectorEnabled({ name: request.name })
    return result
  })
  ipcMain.handle('mcp:startLocalConnectorAdd', async (_, raw: unknown) => {
    const catalogIds = (await connectorCatalog()).map((connector) => connector.id)
    const request = validateLocalConnectorRequest(raw, { catalogIds })
    return localConnectorJobs.startLocalConnectorAdd(request)
  })
  ipcMain.handle('mcp:cancelLocalConnectorAdd', async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    await localConnectorJobs.cancelLocalConnectorAdd(validateName(name))
  })
  ipcMain.handle('mcp:retryLocalConnectorAdd', async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    return localConnectorJobs.retryLocalConnectorAdd(validateName(name))
  })
  ipcMain.handle('mcp:listLocalConnectorJobs', async () =>
    localConnectorJobs.listLocalConnectorJobs()
  )
  ipcMain.handle('mcp:removeLocalConnector', async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    const validatedName = validateName(name)
    await removeLocalMcpConnector(validatedName)
    await getPhiEngine().mcp.applyConnectorEnabled({ name: validatedName })
  })
  ipcMain.handle('mcp:listLocalRuntimes', async () => listLocalMcpRuntimes())
  ipcMain.handle('mcp:removeRemoteConnector', async (_, name: string, url: string) => {
    removeRemoteMcpConnector(name, url)
    if (API_KEY_CONNECTOR_IDS.some((id) => id === name && apiKeyConnector(id).url === url)) {
      clearFeaturedMcpApiKey(name)
      verifiedMcpApiKeys.delete(name)
    }
    await syncFeaturedMcpApiKeySessions(name)
  })
  ipcMain.handle(
    'mcp:setConnectorEnabled',
    async (_, name: string, enabled: boolean, sourcePath?: string) => {
      if (typeof sourcePath === 'string' && sourcePath.startsWith('ssh://')) {
        throw new Error('Server project MCP enablement is managed by the server configuration file')
      }
      setMcpConnectorEnabled(
        name,
        Boolean(enabled),
        typeof sourcePath === 'string' ? sourcePath : undefined
      )
      try {
        await getPhiEngine().mcp.applyConnectorEnabled({ name })
      } catch (error) {
        if (!API_KEY_CONNECTOR_IDS.some((id) => id === name)) throw error
        writeAppLog({ event: 'mcp_api_key_session_sync_failed', metadata: { connectorId: name } })
        await getPhiEngine().stop()
        throw new Error(
          'Local changes were saved, but the running chat could not be synchronized and was stopped. Reopen the chat and try again.'
        )
      }
    }
  )
  ipcMain.handle('mcp:featuredApiKeyStatus', async (_, id: string) =>
    featuredMcpApiKeyVerifiedStatus(id)
  )
  ipcMain.handle('mcp:setFeaturedApiKey', async (_, id: string, key: string) => {
    apiKeyConnector(id)
    await validateFeaturedMcpApiKey(id, key)
    disableFeaturedApiKeyAutoDiscovery()
    setFeaturedMcpApiKey(id, key)
    verifiedMcpApiKeys.set(id, {
      digest: apiKeyDigest(key.trim()),
      expiresAt: verificationExpiresAt(id)
    })
    if (isFeaturedMcpApiKeyInstalled(id)) await syncFeaturedMcpApiKeySessions(id)
  })
  ipcMain.handle('mcp:clearFeaturedApiKey', async (_, id: string) => {
    clearFeaturedMcpApiKey(id)
    verifiedMcpApiKeys.delete(id)
    await syncFeaturedMcpApiKeySessions(id)
  })
  ipcMain.handle('mcp:featuredTools', async (_, id: string) => {
    if (typeof id !== 'string') throw new Error('Invalid Connector ID')
    const connector = (await connectorCatalog()).find((entry) => entry.id === id)
    if (!connector) throw new Error('This Connector was not found in the catalog')
    if (connector.transport === 'stdio') {
      return connectorSetups.run(id, async (report) => {
        const toolNames = await probeStdioTools(id, report)
        report('ready', { toolNames })
        return toolNames
      })
    }
    if (!connector.url) throw new Error('Invalid Connector service URL')
    return getPhiEngine().mcp.featuredTools({
      id,
      url: connector.url,
      auth: connector.auth
    })
  })
  ipcMain.handle('mcp:featuredAuthStatus', async (_, id: string) => {
    const connector = (await connectorCatalog()).find((entry) => entry.id === id)
    if (!connector?.url || !mcpOAuthAuthorizationOrigin(id, connector.url)) {
      throw new Error('This Connector does not support sign-in status checks')
    }
    return getPhiEngine().mcp.featuredAuthStatus({ id, url: connector.url })
  })
  ipcMain.handle('mcp:authorizeFeatured', async (_, id: string) => {
    const connector = (await connectorCatalog()).find((entry) => entry.id === id)
    if (!connector?.url || !mcpOAuthAuthorizationOrigin(id, connector.url)) {
      throw new Error('This Connector does not support OAuth authorization')
    }
    await getPhiEngine().mcp.authorizeFeatured({ id, url: connector.url })
  })
  ipcMain.handle('mcp:cancelFeaturedAuth', async (_, id: string) => {
    if (typeof id !== 'string' || !id) return
    await getPhiEngine().mcp.cancelFeaturedAuth({ id })
  })

  ipcMain.handle('mcp:authorizeRemoteConnector', async (_, name: string) => {
    const connector = readCustomRemoteMcpConnector(name, AGENT_DIR)
    if (pendingCustomMcpAuthorizations.has(connector.name))
      throw new Error('Authorization is already in progress for this Connector')
    const pending: PendingCustomMcpAuthorization = {
      attemptId: randomUUID(),
      serverUrl: connector.url,
      configDigest: customMcpConfigDigest(connector),
      cancelled: false
    }
    // Register before discovery: cancel during preflight must prevent the later browser flow.
    pendingCustomMcpAuthorizations.set(connector.name, pending)
    let authorizationStarted = false
    try {
      const prepared = await getPhiEngine().mcp.prepareRemoteAuth({
        name: connector.name,
        attemptId: pending.attemptId
      })
      if (pending.cancelled) throw new Error('Authorization cancelled')
      const current = readCustomRemoteMcpConnector(connector.name, AGENT_DIR)
      if (
        !prepared ||
        prepared.serverUrl !== pending.serverUrl ||
        customMcpConfigDigest(current) !== pending.configDigest
      ) {
        throw new Error('Connector configuration changed. Authorize again.')
      }
      const authorizationUrl = customMcpAuthUrl(prepared.authorizationUrl)
      pending.authorizationOrigin = authorizationUrl.origin
      pending.authorizationPath = authorizationUrl.pathname
      authorizationStarted = true
      await getPhiEngine().mcp.authorizeRemote({
        name: connector.name,
        attemptId: pending.attemptId,
        serverUrl: pending.serverUrl
      })
    } finally {
      if (pendingCustomMcpAuthorizations.get(connector.name) === pending)
        pendingCustomMcpAuthorizations.delete(connector.name)
      if (!authorizationStarted) {
        await getPhiEngine()
          .mcp.cancelRemoteAuth({ name: connector.name, attemptId: pending.attemptId })
          .catch(() => undefined)
      }
    }
  })
  ipcMain.handle('mcp:cancelRemoteAuth', async (_, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid Connector name')
    const key = name.trim()
    const pending = pendingCustomMcpAuthorizations.get(key)
    if (!pending) return
    pending.cancelled = true
    await getPhiEngine().mcp.cancelRemoteAuth({
      name: key,
      attemptId: pending.attemptId
    })
  })

  ipcMain.handle('wrappers:getPlan', async (_, planId: string) => readWrapperPlan(planId))
  ipcMain.handle('wrappers:retargetPlan', async (_, request: WrapperRetargetRequest) => {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some(
        (key) => !['planId', 'target', 'expectedRevision', 'confirmedLocalFallback'].includes(key)
      ) ||
      typeof request.planId !== 'string' ||
      !request.planId ||
      (request.target !== 'local' && request.target !== 'remote') ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      (request.confirmedLocalFallback !== undefined &&
        typeof request.confirmedLocalFallback !== 'boolean')
    ) {
      throw new Error('Invalid Wrapper target change request')
    }
    return retargetWrapperRunPlan(request)
  })
  ipcMain.handle(
    'wrappers:submitPlan',
    async (
      _,
      planId: string,
      heavyWorkloadAcknowledged?: boolean,
      confirmation?: WrapperSubmitConfirmation
    ) => {
      const plan = readWrapperPlan(planId)
      const selected = plan?.targetSelection
      if (selected) {
        if (
          !selected.projectLocation ||
          !['local', 'ssh'].includes(selected.projectLocation.kind)
        ) {
          throw new Error('The plan target snapshot is invalid. Create a new plan.')
        }
        if (
          !confirmation ||
          typeof confirmation !== 'object' ||
          Object.keys(confirmation).some(
            (key) =>
              ![
                'expectedRevision',
                'target',
                'projectId',
                'hostProfileId',
                'remoteRoot',
                'externalOutputRoot'
              ].includes(key)
          ) ||
          confirmation.expectedRevision !== plan.revision ||
          confirmation.target !== selected.target ||
          confirmation.projectId !== selected.projectId ||
          confirmation.hostProfileId !== selected.hostProfileId ||
          confirmation.remoteRoot !== selected.remoteRoot ||
          confirmation.externalOutputRoot !==
            (selected.target === 'remote'
              ? declaredExternalOutputRoot(selected.remoteRoot, plan.params?.outdir)
              : undefined)
        ) {
          throw new Error(
            'The plan execution target has changed. Refresh the plan card and confirm again.'
          )
        }
      }
      if (isRemoteProjectAnchorPath(currentCwd, AGENT_DIR)) {
        const manifest = findPhiManifestForSession(
          currentSessionKey,
          currentSessionPath,
          currentCwd
        )
        if (
          manifest?.projectLocation?.kind !== 'ssh' ||
          plan?.targetSelection?.projectId !== manifest.projectId ||
          plan.targetSelection.target !== 'remote'
        ) {
          throw new Error(
            'Remote projects can only submit Wrapper plans bound to their server; they will not run locally'
          )
        }
      }
      if (selected?.target === 'remote' && selected.projectLocation.kind === 'ssh') {
        const current = listProjects().find((project) => project.id === selected.projectId)
        if (current?.remoteConnection?.phase !== 'reachable') {
          throw new Error(
            current?.remoteConnection?.message ??
              'The server connection is not ready. Reconnect before submitting.'
          )
        }
      }
      try {
        return submitWrapperRunPlan(planId, {
          heavyWorkloadAcknowledged,
          externalOutputRoot: confirmation?.externalOutputRoot,
          nextflowLaunch: { builds: environmentBuilds }
        })
      } catch (error) {
        logUnexpectedError(error)
        throw error
      }
    }
  )
  ipcMain.handle('wrappers:cancelPlan', async (_, planId: string) => {
    try {
      return cancelWrapperRunPlan(planId)
    } catch (error) {
      logUnexpectedError(error)
      throw error
    }
  })
  ipcMain.handle('wrappers:listCatalog', async () => listWrapperCatalog())
  ipcMain.handle('wrappers:listCompositionCatalog', async () =>
    listWrapperCompositionCatalogStatus({ agentDir: AGENT_DIR })
  )
  ipcMain.handle('wrappers:getCompositionDag', async (_, id: string) =>
    readWrapperCompositionDag(id)
  )
  ipcMain.handle('wrappers:getCompositionModuleDetails', async (_, id: string) =>
    readWrapperModuleDetails(id)
  )
  ipcMain.handle('wrappers:addCustom', async (_, sourceDir: string) => {
    try {
      const entry = addCustomWrapper(sourceDir)
      writeAppLog({ event: 'wrapper_custom_added', metadata: { sourceDir, id: entry.manifest.id } })
      return entry
    } catch (error) {
      logUnexpectedError(error)
      writeAppLog({
        level: 'error',
        event: 'wrapper_custom_add_failed',
        metadata: { sourceDir, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })
  ipcMain.handle('wrappers:listRuns', async () => listWrapperRuns())
  ipcMain.handle('environmentBuilds:list', () => environmentBuilds.list())
  ipcMain.handle('environmentBuilds:cancel', (_event, envId: unknown) => {
    if (typeof envId !== 'string' || envId.length === 0) throw new Error('envId is required')
    environmentBuilds.cancel(envId)
  })
  ipcMain.handle('jobs:listAgents', listBackgroundAgentJobs)
  ipcMain.handle('jobs:listShell', listBackgroundShellJobs)
  ipcMain.handle('jobs:stopShell', async (_, agentSessionId: unknown, jobId: unknown) => {
    await stopBackgroundShellJob(agentSessionId, jobId)
  })
  ipcMain.handle('wrappers:getRun', async (_, runId: string) => readWrapperRun(runId))
  ipcMain.handle('wrappers:cancelRun', async (_, runId: string) => {
    try {
      // Agent-started (background) runs are owned by the job manager, not the plan executor.
      if (readWrapperRun(runId)?.origin === 'composition') {
        const cancelled = await wrapperJobs.cancel(runId)
        if (!cancelled.ok) throw new Error(cancelled.error)
        return readWrapperRun(runId)
      }
      return cancelWrapperRun(runId)
    } catch (error) {
      logUnexpectedError(error)
      throw error
    }
  })
  ipcMain.handle('wrappers:getPlanArtifact', async (_, planId: string, fileName: string) =>
    readWrapperPlanArtifact(planId, fileName)
  )
  ipcMain.handle('wrappers:exportReproducibility', async (_, runId: string) => {
    try {
      const bundle = buildWrapperReproducibilityBundle(runId)
      const window = getActiveWindow()
      const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
      const options: Electron.SaveDialogOptions = {
        title: dialogCopy.exportReproducibility,
        buttonLabel: dialogCopy.save,
        defaultPath: `phi-wrapper-${runId}-reproducibility.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      writeFileSync(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8')
      writeAppLog({ event: 'wrapper_reproducibility_exported', metadata: { runId } })
      return result.filePath
    } catch (error) {
      logUnexpectedError(error)
      writeAppLog({
        level: 'error',
        event: 'wrapper_reproducibility_export_failed',
        metadata: { runId, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })

  ipcMain.handle('persona:getAppName', async () => APP_NAME)
  ipcMain.handle('persona:isOnboarded', async () => isOnboarded())
  ipcMain.handle('persona:getMarkdown', async () => getPersonaMarkdown())
  ipcMain.handle('persona:setMarkdown', async (_, markdown: string) => {
    const target = captureCurrentRpcConfigurationTarget()
    if (target) await target.resolved()
    target?.assertCurrent()
    setPersonaMarkdown(markdown)
    await invalidateAgentSession()
    return getPersonaMarkdown()
  })
  ipcMain.handle('persona:skip', async () => {
    skipOnboarding()
  })
  ipcMain.handle('persona:completeOnboarding', async (_, description: string) => {
    const trimmedDescription = description.trim()
    if (!trimmedDescription) {
      skipOnboarding()
      return ''
    }

    const target = captureCurrentRpcConfigurationTarget()
    if (target) await target.resolved()
    target?.assertCurrent()
    let markdown: string
    try {
      markdown = await generatePersonaMarkdown(trimmedDescription, target ?? undefined)
    } catch (error) {
      target?.assertCurrent()
      logUnexpectedError(error)
      console.error('生成人设配置失败，回退为原始描述:', error)
      markdown = fallbackMarkdownFromDescription(trimmedDescription)
    }

    target?.assertCurrent()
    setPersonaMarkdown(markdown)
    await invalidateAgentSession()
    return markdown
  })

  createWindow()
  scheduleStartupPackageUpdateCheck()

  app.on('activate', function () {
    applyDockIcon()

    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on(
  'before-quit',
  createBeforeQuitHandler({
    beginShutdown: () => {
      finishStartupSplash(null)
      menuBarController?.destroy()
      menuBarController = null
      // Stop local wrapper runs; detach remote runs so the next app launch can resume watching them.
      try {
        wrapperJobs.shutdown()
      } catch {
        writeAppLog({ level: 'error', event: 'wrapper_shutdown_failed' })
      }
      try {
        if (preventSleepBlockerId !== null && powerSaveBlocker.isStarted(preventSleepBlockerId)) {
          powerSaveBlocker.stop(preventSleepBlockerId)
          preventSleepBlockerId = null
        }
      } catch {
        writeAppLog({ level: 'error', event: 'power_blocker_cleanup_failed' })
      }
    },
    cleanup: async () => {
      await Promise.all([
        cleanupMainWindowRuntime(),
        safeCleanupStep('environment_scan_cleanup_failed', () => backgroundEnvironment.dispose())
      ])
    },
    quit: () => app.quit(),
    timeoutMs: APP_QUIT_CLEANUP_TIMEOUT_MS
  })
)

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
