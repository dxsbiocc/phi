import type { AgentRunFinishedEvent } from '../shared/agentRunNotice'
import { officeAvailabilityArgument } from '../shared/officeAvailability'
import {
  sanitizeOfficeTargetInput,
  type OfficePromptTargetFailure,
  type OfficeTargetInput
} from '../shared/officeProtocol'
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
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
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
import type { BrowserActionApprovalPrompt } from './browser/browser-approval'
import { BrowserToolHostCoordinator } from './agent/browser/browser-tool-host'
import { TerminalIpcCoordinator, registerTerminalRendererIpc } from './terminal/terminal-ipc'
import { TerminalDraftService } from './terminal/terminal-command-draft'
import { buildTerminalDraftSessionFactory } from './terminal/terminal-draft-session'
import { TerminalManager } from './terminal/terminal-manager'
import {
  createOfficeService,
  type OfficeOpenRequest,
  type OfficeService
} from './agent/office/office-service'
import { OfficeIpcCoordinator, registerOfficeRendererIpc } from './agent/office/office-ipc'
import { chooseOfficeSaveAsTarget } from './agent/office/office-save-as-dialog'
import {
  OfficeExportIpcFlow,
  registerOfficeExportRendererIpc
} from './agent/office/office-export-ipc'
import { chooseOfficeExportTarget } from './agent/office/office-export-dialog'
import { installOfficeWebviewSecurity } from './agent/office/office-webview'
import { officeAvailabilityCache } from './agent/office/office-availability'
import {
  filterOfficeSkillForAvailability,
  initializePhiOfficeSkillDefault
} from './agent/office/office-skill-enablement'
import { officeTestHooksEnabled } from './agent/office/office-test-hooks'
import { prepareOfficePromptSubmission } from './agent/office/office-prompt-target'
import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler,
  createOfficeReadHostHandler,
  parseOfficeWriteRequest
} from './agent/office/office-tool-host'
import {
  createOfficeDeliverHostHandler,
  parseOfficeDeliverInput
} from './agent/office/office-deliver-tool-host'
import type { OfficeDeliveryResult } from './agent/office/office-deliver'
import type { OfficeWriteRequest } from './agent/office/office-write'
import { officeToolApproval } from './agent/office/office-tools'
import {
  OfficeApplyApprovalRegistry,
  formatOfficeApplyApprovalSummary,
  officeApplyApprovalDigest,
  type OfficeApplyApprovalInput
} from './agent/office/office-approval'
import {
  OfficeDeliverApprovalRegistry,
  formatOfficeDeliverApprovalSummary,
  officeDeliverApprovalDigest,
  type OfficeDeliverApprovalInput
} from './agent/office/office-deliver-approval'
import { resolveTerminalWorkspace } from './terminal/terminal-workspace'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import semver from 'semver'
import { createAgentSession } from './agent/session/session-manager'
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
  updateProjectRemoteConnection,
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
  listAvailableRemoteHostProfiles,
  saveRemoteHostProfile
} from './agent/remote-hosts'
import { listOpenSshHosts } from './agent/ssh-config-discovery'
import { saveOpenSshHost } from './agent/ssh-config-editor'
import { sshConfigHostId, type OpenSshHostInput } from '../shared/remoteHostProfile'
import { remoteDoctor } from './agent/remote-doctor'
import { createCursorH2Bridge } from './agent/cursor-h2-bridge'
import { installRemoteNextflow } from './agent/remote-nextflow-install'
import { RemoteProjectConnectionTracker } from './agent/remote-project-connection'
import { createCheckedRemoteProject } from './agent/remote-project-create'
import { loadRemoteProjectInstructions } from './agent/remote-project-instructions'
import {
  remoteBashApprovalScope,
  resolveRemoteBashContext,
  resolveRemoteWorkspacePath
} from './agent/remote-workspace-boundary'
import { readRemoteWorkspacePath } from './agent/remote-workspace-read'
import {
  listRemoteWorkspaceDirectory,
  previewRemoteWorkspaceFile
} from './agent/remote-workspace-file-ui'
import { remoteGlob, remoteGrep } from './agent/remote-workspace-search'
import { RemoteWorkspaceBashManager, type RemoteBashRequest } from './agent/remote-workspace-bash'
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
import type { ProjectLocation, RemoteProjectCreateInput } from '../shared/projectLocation'
import { renderMoleculeSvg } from './molecule-renderer'
import {
  bashApprovalDigest,
  editApprovalDigest,
  cancelToolApprovals,
  createApprovalExtension,
  requestToolApproval,
  resolveToolApproval,
  writeApprovalDigest
} from './agent/tool-approval'
import { createEnvironmentBuilds } from './agent/content/environment-builds'
import { bindAgentSession } from './agent/content/environment-gate'
import {
  createSkillHost,
  type ConfirmBuildRequest,
  type PresentArtifactsRequest
} from './agent/content/skill-host'
import { getRuntimeRoot } from './agent/envs/runtime'
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
  getBundledSkillsDir,
  openRuntimeSessionManager,
  readAutoCompactionDefaults,
  type ModelRuntime,
  type RuntimeModel,
  type RuntimeResourceLoader
} from './agent/runtime/runtime-adapter'
import { installPlugin as installDeveloperPlugin, listPlugins, removePlugin } from './agent/plugins'
import { installBundledPlugins } from './agent/plugins/bundled-install'
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
import { readPluginRegistry, writePluginRegistry } from './agent/plugins/store'
import { getEnablementSnapshot, migrateEnablementFromHistory, setEnabled } from './agent/enablement'
import {
  addKnownRegistry,
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
  readRegistry as readPackageRegistry,
  removeKnownRegistry,
  type PackageUpdate,
  uninstallPackage as uninstallRegistryPackage
} from './agent/packages/installer'
import {
  addRemoteMcpConnector,
  connectorEnvironmentBuildAction,
  disableFeaturedApiKeyAutoDiscovery,
  installCatalogConnector,
  listConnectorCatalog,
  mcpOAuthAuthorizationOrigin,
  refreshPersistedManagedStdioServers,
  removeRemoteMcpConnector,
  setMcpConnectorEnabled,
  setMcpPackageEnabled,
  uninstallCatalogConnector
} from './agent/mcp-connectors'
import {
  API_KEY_CONNECTOR_IDS,
  apiKeyConnector,
  clearFeaturedMcpApiKey,
  isFeaturedMcpApiKeyInstalled,
  readFeaturedMcpApiKey,
  setFeaturedMcpApiKey
} from './agent/mcp-key-credentials'
import { McpApiKeyValidationError, validateFeaturedMcpApiKey } from './agent/mcp-key-validation'
import { scriptToolName, validateSkill } from './agent/content/skill'
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
import { wrapperJobHostHandlers } from './agent/wrappers/composition/job-host-handlers'
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
import { loadRemoteWrapperAgent } from './agent/agents/remote-wrapper-agent'
import { BackgroundAgentApprovalTracker } from './agent/agents/background-approval'
import { buildAgentLeaderPrompt } from './agent/agents/leader-prompt'
import {
  continuationPrompt,
  shouldContinueAfterAgentRun,
  type ContinuationEvent
} from './agent/agents/run-continue'
import { agentRunHostHandlers } from './agent/agents/run-host'
import { buildWrapperReproducibilityBundle } from './agent/wrappers/reproducibility'
import { retargetWrapperRunPlan } from './agent/wrappers/plans'
import { cancelWrapperRun, cancelWrapperRunPlan, submitWrapperRunPlan } from './agent/wrappers/runs'
import {
  listWrapperRuns,
  readWrapperPlan,
  readWrapperPlanArtifact,
  readWrapperRun
} from './agent/wrappers/store'
import { formatDiagnostics, type DiagnosticsSnapshot } from './agent/diagnostics'
import { LOG_RETENTION_DAYS, cleanupOldLogs, getPhiLogDir, writeAppLog } from './agent/app-logger'
import { readAppSettings, updateAppSettings } from './agent/app-settings'
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
  dismissEnvironmentSummary,
  getEnvironment,
  listManagedEnvironments,
  redetectEnvironment,
  setEnvironmentToolPath
} from './agent/environment'
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
import { AnalysisNotebookToolExecutor } from './agent/notebook/notebook-tool-executor'
import { getOmpBridge } from './agent/omp/omp-bridge'
import {
  validateOfficePresentedFile,
  validatePresentedFiles
} from './agent/deliverables/present-files'
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
  listPhiSessions
} from './agent/session/session-store'
import {
  updateNotebookCell,
  type JsonObject,
  type NotebookDocument
} from '../shared/notebookDocument'
import { messageContentTitleText } from '../shared/sessionTitle'
import type { AgentUserInteractionQuestion } from '../shared/agentInteractionTypes'
import { createBeforeQuitHandler } from './app-quit'
import icon from '../../resources/icon.png?asset'

const APP_NAME = 'Phi'
// OfficeCLI may need 5 s to flush and another 2 s for a polite SIGTERM; preview teardown runs first.
const APP_QUIT_CLEANUP_TIMEOUT_MS = 2_000
// Office's share of the quit budget; the global cap must not grow for any one feature.
const OFFICE_QUIT_DEADLINE_MS = 1_200
const APP_ID = 'com.electron.app'
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

let mainWindow: BrowserWindow | null = null
let mainWindowCleanupStarted = false
type BrowserRegistryLifecycle = 'idle' | 'disposing' | 'failed'
let browserWorkspaceRegistry: BrowserWorkspaceRegistry | null = null
let browserWorkspaceRegistryLifecycle: BrowserRegistryLifecycle = 'idle'
let browserWorkspaceRegistryDisposal: Promise<void> | null = null
let terminalManager: TerminalManager | null = null
let terminalDraftService: TerminalDraftService | null = null
let mainWindowCleanupPromise: Promise<void> | null = null

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
          isRemoteAnchor: (path) => isRemoteProjectAnchorPath(path, AGENT_DIR)
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

function currentOfficeContext():
  (Omit<OfficeOpenRequest, 'sourcePath'> & { outputRoot: string }) | undefined {
  const current = getCurrentSessionPayload()
  if (!current.phiSessionId) return undefined
  const pathScope = currentLocalPathScope()
  return {
    sessionId: current.phiSessionId,
    projectId: current.projectId ?? null,
    ...(current.projectLocation ? { projectLocation: current.projectLocation } : {}),
    allowRoots: localFileAllowRoots({
      agentDir: resolve(AGENT_DIR),
      sessionCwd: pathScope.cwd,
      sessionCwdRealPath: pathScope.cwdRealPath,
      projectRoots: listLocalProjectAllowRoots()
    }),
    outputRoot: pathScope.cwdRealPath ?? pathScope.cwd
  }
}

function registerOfficeIpc(): void {
  if (!officeAvailabilityCache.get().enabled) return
  officeService = getOfficeService()
  const testHooksEnabled = officeTestHooksEnabled(app.isPackaged)
  registerOfficeRendererIpc(
    ipcMain,
    new OfficeIpcCoordinator({
      service: officeService,
      getTrustedRenderer: () => {
        const window = mainWindow
        return window && !window.isDestroyed() ? window.webContents : null
      },
      resolveContext: currentOfficeContext,
      chooseSaveAsTarget: (input) =>
        chooseOfficeSaveAsTarget(input, {
          testHooksEnabled,
          isPackaged: app.isPackaged,
          // Automated Electron smoke cannot drive a native save sheet; packaged builds ignore it.
          smokePath: testHooksEnabled ? process.env.PHI_OFFICE_SMOKE_SAVE_AS_PATH : undefined,
          getWindow: () => mainWindow ?? undefined,
          showSaveDialog: async (window, options) => {
            const electronOptions: Electron.SaveDialogOptions = {
              title: options.title,
              defaultPath: options.defaultPath,
              filters: options.filters.map((filter) => ({
                name: filter.name,
                extensions: [...filter.extensions]
              }))
            }
            return window
              ? dialog.showSaveDialog(window as BrowserWindow, electronOptions)
              : dialog.showSaveDialog(electronOptions)
          }
        }),
      revealPath: (path) => shell.showItemInFolder(assertRevealPathAllowed(path))
    })
  )
  registerOfficeExportRendererIpc(
    ipcMain,
    new OfficeExportIpcFlow({
      service: officeService,
      getTrustedRenderer: () => {
        const window = mainWindow
        return window && !window.isDestroyed() ? window.webContents : null
      },
      resolveContext: currentOfficeContext,
      chooseExportTarget: (input) =>
        chooseOfficeExportTarget(input, {
          testHooksEnabled,
          isPackaged: app.isPackaged,
          smokePath: testHooksEnabled
            ? input.format === 'csv'
              ? process.env.PHI_OFFICE_SMOKE_EXPORT_CSV_PATH
              : process.env.PHI_OFFICE_SMOKE_EXPORT_TSV_PATH
            : undefined,
          getWindow: () => mainWindow ?? undefined,
          showSaveDialog: async (window, options) => {
            const electronOptions: Electron.SaveDialogOptions = {
              title: options.title,
              defaultPath: options.defaultPath,
              filters: options.filters.map((filter) => ({
                name: filter.name,
                extensions: [...filter.extensions]
              }))
            }
            return window
              ? dialog.showSaveDialog(window as BrowserWindow, electronOptions)
              : dialog.showSaveDialog(electronOptions)
          }
        })
    })
  )
}

function loadPackageRegistries(): ReturnType<typeof loadKnownRegistryIndexes> {
  return loadKnownRegistryIndexes({ agentDir: AGENT_DIR })
}

function packageUpdateViews(updates: readonly PackageUpdate[]): PackageUpdate[] {
  return [...updates]
}

function refreshCachedPackageUpdates(): PackageUpdate[] {
  const loaded = loadPackageRegistries()
  cachedPackageUpdates = listPackageUpdates(loaded.registries, {
    agentDir: AGENT_DIR,
    appVersion: app.getVersion()
  })
  return cachedPackageUpdates
}

function scheduleStartupPackageUpdateCheck(): void {
  setImmediate(() => {
    try {
      const updates = refreshCachedPackageUpdates()
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
  officeTarget?: OfficeTargetInput | null
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
const selectedModel: ModelSelection | null = null
// Default is deliberately 'high', not the SDK's own default of 'off': many models
// (e.g. DeepSeek V4 Pro) only enable reasoning output at 'high'/'max', and this app
// wants that reasoning visible in the UI out of the box rather than silently absent.
const selectedThinkingLevel: ThinkingLevel = 'high'
let currentSessionKey = createSessionKey(undefined, currentCwd, freshSessionCounter)
let officeService: OfficeService | null = null
let officeDescribeHostHandler: ReturnType<typeof createOfficeDescribeHostHandler> | null = null

function getOfficeService(): OfficeService {
  const runtime = officeAvailabilityCache.getRuntime()
  officeService ??= createOfficeService({ detectRuntime: async () => runtime })
  return officeService
}
const officeApplyApprovals = new OfficeApplyApprovalRegistry()
const officeDeliverApprovals = new OfficeDeliverApprovalRegistry()
let sessionSwitchRequest = 0
const promptQueues = new Map<string, Promise<void>>()
const promptGenerations = new Map<string, number>()
const activePromptRuns = new Map<string, PromptRun>()
const manualCompactionIds = new Set<string>()
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
  const key = remoteBashApprovalKey(request.sessionId, request.toolCallId)
  const approved = approvedRemoteBashCalls.get(key)
  approvedRemoteBashCalls.delete(key)
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
  const key = remoteBashApprovalKey(request.sessionId, request.toolCallId)
  const approved = approvedRemoteWriteCalls.get(key)
  approvedRemoteWriteCalls.delete(key)
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
  const key = remoteBashApprovalKey(request.sessionId, request.toolCallId)
  const approved = approvedRemoteEditCalls.get(key)
  approvedRemoteEditCalls.delete(key)
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

function officeApprovalInput(request: OfficeWriteRequest): OfficeApplyApprovalInput {
  return {
    operation: officeApprovalOperation(request.operation),
    baseRevision: request.baseRevision
  }
}

function officeApprovalOperation(
  operation: OfficeWriteRequest['operation']
): OfficeApplyApprovalInput['operation'] {
  if (
    operation.type === 'add_slide' ||
    operation.type === 'set_slide_text' ||
    operation.type === 'add_paragraph' ||
    operation.type === 'set_paragraph_text'
  ) {
    return officeDocumentApprovalOperation(operation)
  }
  return officeWorkbookApprovalOperation(operation)
}

function officeDocumentApprovalOperation(
  operation: Extract<
    OfficeWriteRequest['operation'],
    { type: 'add_slide' | 'set_slide_text' | 'add_paragraph' | 'set_paragraph_text' }
  >
): OfficeApplyApprovalInput['operation'] {
  if (operation.type === 'add_slide') {
    return {
      type: 'add_slide',
      title: operation.title,
      ...(operation.body === undefined ? {} : { body: operation.body }),
      ...(operation.position ? { position: operation.position } : {})
    }
  }
  if (operation.type === 'set_slide_text') {
    return {
      type: 'set_slide_text',
      slideId: operation.slideId,
      elementId: operation.elementId,
      text: operation.text,
      ...(operation.expectedText === undefined ? {} : { expectedText: operation.expectedText })
    }
  }
  if (operation.type === 'add_paragraph') {
    return {
      type: 'add_paragraph',
      text: operation.text,
      ...(operation.position ? { position: operation.position } : {})
    }
  }
  return {
    type: 'set_paragraph_text',
    paraId: operation.paraId,
    text: operation.text,
    ...(operation.expectedText === undefined ? {} : { expectedText: operation.expectedText })
  }
}

function officeWorkbookApprovalOperation(
  operation: Exclude<
    OfficeWriteRequest['operation'],
    { type: 'add_slide' | 'set_slide_text' | 'add_paragraph' | 'set_paragraph_text' }
  >
): OfficeApplyApprovalInput['operation'] {
  if (operation.type === 'add_sheet') {
    return {
      type: 'add_sheet',
      name: operation.name
    }
  }
  if (operation.type === 'set_range') {
    return {
      type: 'set_range',
      sheet: operation.sheet,
      range: operation.range,
      values: operation.values
    }
  }
  if (operation.type === 'set_formula') {
    return {
      type: 'set_formula',
      sheet: operation.sheet,
      cell: operation.cell,
      formula: operation.formula
    }
  }
  if (operation.type === 'format_range') {
    return {
      type: 'format_range',
      sheet: operation.sheet,
      range: operation.range,
      format: operation.format
    }
  }
  return {
    type: 'set_cell',
    sheet: operation.sheet,
    cell: operation.cell,
    value: operation.value
  }
}

function authorizeOfficeWrite(
  runId: string,
  toolCallId: string | undefined,
  request: OfficeWriteRequest
): boolean {
  const run = [...activePromptRuns.values()].find(
    (candidate) => candidate.runId === runId && !candidate.cancelled
  )
  const manifest = run ? findPhiSessionById(run.phiSessionId) : undefined
  if (!manifest) return false
  if (manifest.permissionMode !== 'ask') return true
  return Boolean(
    toolCallId && officeApplyApprovals.consume(runId, toolCallId, officeApprovalInput(request))
  )
}

function authorizeOfficeDelivery(
  runId: string,
  toolCallId: string,
  input: OfficeDeliverApprovalInput
): boolean {
  const run = activeOfficePromptRun(runId)
  const manifest = run ? findPhiSessionById(run.phiSessionId) : undefined
  if (!manifest) return false
  if (manifest.permissionMode !== 'ask') return true
  return officeDeliverApprovals.consume(runId, toolCallId, input)
}

function activeOfficePromptRun(runId: string): PromptRun | undefined {
  return [...activePromptRuns.values()].find(
    (candidate) => candidate.runId === runId && !candidate.cancelled
  )
}

function officeDeliveryRunContext(runId: string): {
  readonly run: PromptRun
  readonly cwdRealPath: string
  readonly remote: boolean
} {
  const run = activeOfficePromptRun(runId)
  if (!run) throw Object.assign(new Error('Office run is unavailable'), { code: 'no_target' })
  const manifest = findPhiSessionById(run.phiSessionId)
  const project = run.projectId ? getProject(run.projectId) : undefined
  const cwdRealPath =
    manifest?.cwdRealPath ?? project?.workingDirectoryRealPath ?? realpathSync(run.cwd)
  const remote = manifest?.projectLocation?.kind === 'ssh' || project?.location.kind === 'ssh'
  return { run, cwdRealPath, remote }
}

function officeDeliveryChecks(result: OfficeDeliveryResult): {
  schema: 'passed'
  content: 'passed'
  samples: number
  pageCount?: number
} {
  const content = result.checks.find((check) => check.name === `${result.kind}_content`)
  if (!result.checks.some((check) => check.name === 'schema') || !content) {
    throw Object.assign(new Error('Office delivery checks are incomplete'), {
      code: 'delivery_check_failed'
    })
  }
  return {
    schema: 'passed',
    content: 'passed',
    samples: content.sampled ?? 0,
    ...(content.pageCount === undefined ? {} : { pageCount: content.pageCount })
  }
}

function publicOfficeDeliveryResult(result: OfficeDeliveryResult): Record<string, unknown> {
  return {
    fileName: result.fileName,
    outputPath: result.outputPath,
    kind: result.kind,
    revision: result.revision,
    sha256: result.sha256,
    size: result.size,
    warnings: result.warnings,
    checks: officeDeliveryChecks(result),
    ...(result.deduplicated ? { deduplicated: true } : {})
  }
}

async function deliverOfficeOutputFromRun(
  runId: string,
  input: OfficeDeliverApprovalInput,
  operationId: string
): Promise<Record<string, unknown>> {
  const context = officeDeliveryRunContext(runId)
  officeService = getOfficeService()
  const artifactId = officeService.resolveRunTarget(runId).artifactId
  let presentedFile: PresentedFile | undefined
  const result = await officeService.deliverDocument(
    runId,
    context.run.cwd,
    context.cwdRealPath,
    input.outputName,
    {
      operationId,
      remote: context.remote,
      authorize: () => authorizeOfficeDelivery(runId, operationId, input),
      validatePresentation: (delivery) => {
        presentedFile = validateOfficePresentedFile(context.run.cwd, {
          path: delivery.absolutePath,
          artifactId,
          outputId: delivery.outputId,
          kind: delivery.kind,
          revision: delivery.revision,
          sha256: delivery.sha256,
          warnings: [...delivery.warnings].slice(0, 8),
          checks: officeDeliveryChecks(delivery)
        })
      }
    }
  )
  if (!presentedFile) {
    throw Object.assign(new Error('Office presentation validation did not complete'), {
      code: 'delivery_check_failed'
    })
  }
  ensureOfficeDeliveryPresented(context.run, operationId, presentedFile)
  return publicOfficeDeliveryResult(result)
}

function ensureOfficeDeliveryPresented(
  run: PromptRun,
  operationId: string,
  file: PresentedFile
): void {
  const identity = file.office
  if (!identity) throw new Error('Office delivery metadata is missing')
  const exists = readSessionEvents(run.phiSessionId).some((event) =>
    sessionEventHasOfficeOutput(event, identity)
  )
  if (!exists) recordPresentedFiles(run, operationId, [file])
}

function sessionEventHasOfficeOutput(
  event: StoredSessionEvent,
  identity: NonNullable<PresentedFile['office']>
): boolean {
  if (event.type !== 'files_presented' || !Array.isArray(event.files)) return false
  return event.files.some((value) => {
    if (!isRecord(value) || !isRecord(value.office)) return false
    return (
      value.office.artifactId === identity.artifactId &&
      value.office.outputId === identity.outputId &&
      value.office.kind === identity.kind &&
      value.office.revision === identity.revision &&
      value.office.sha256 === identity.sha256
    )
  })
}

async function prepareOfficeToolApproval(
  sessionKey: string,
  toolName: string,
  input: Record<string, unknown>,
  event: { toolCallId?: string; agentRunId?: string }
): Promise<{ summary: string; approvalDigest?: string; skipApproval?: boolean } | undefined> {
  if (toolName === 'office_deliver') {
    return prepareOfficeDeliveryApproval(sessionKey, input, event)
  }
  if (toolName !== 'office_apply') return undefined
  if (!officeDescribeHostHandler) throw new Error('Office 写入审批暂不可用')
  const request = parseOfficeWriteRequest(input)
  const activeRun = getActivePromptRun(sessionKey)
  const originSessionId = activeRun?.session?.runtimeSessionId
  const trustedRunId =
    event.agentRunId ??
    (originSessionId ? resolveActiveOfficeRun(originSessionId)?.runId : undefined)
  if (trustedRunId && event.toolCallId) {
    officeService = getOfficeService()
    const bypass =
      typeof officeService.shouldBypassWriteApproval === 'function'
        ? await officeService.shouldBypassWriteApproval(trustedRunId, request, event.toolCallId)
        : request.operation.type === 'set_cell' &&
          (await officeService.shouldBypassCellEditApproval(
            trustedRunId,
            {
              sheet: request.operation.sheet,
              cell: request.operation.cell,
              value: request.operation.value,
              baseRevision: request.baseRevision
            },
            event.toolCallId
          ))
    if (bypass) {
      return { summary: '', skipApproval: true }
    }
  }
  const described = await officeDescribeHostHandler(input, {
    ...(originSessionId ? { originSessionId } : {}),
    ...(event.agentRunId ? { agentRunId: event.agentRunId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {})
  })
  if (!described.ok) throw new Error(described.error.message)
  const approvalInput = officeApprovalInput(request)
  return {
    summary: formatOfficeApplyApprovalSummary(described.value),
    approvalDigest: officeApplyApprovalDigest(approvalInput)
  }
}

async function prepareOfficeDeliveryApproval(
  sessionKey: string,
  value: Record<string, unknown>,
  event: { toolCallId?: string; agentRunId?: string }
): Promise<{ summary: string; approvalDigest?: string; skipApproval?: boolean }> {
  const input = parseOfficeDeliverInput(value)
  const activeRun = getActivePromptRun(sessionKey)
  const originSessionId = activeRun?.session?.runtimeSessionId
  const runId =
    event.agentRunId ??
    (originSessionId ? resolveActiveOfficeRun(originSessionId)?.runId : undefined)
  if (!runId || !event.toolCallId) throw new Error('Office 交付审批暂不可用')
  const context = officeDeliveryRunContext(runId)
  officeService = getOfficeService()
  if (
    await officeService.shouldBypassDeliverApproval(
      runId,
      context.run.cwd,
      context.cwdRealPath,
      input.outputName,
      event.toolCallId
    )
  ) {
    return { summary: '', skipApproval: true }
  }
  const description = await officeService.describeDelivery(
    runId,
    context.run.cwd,
    context.cwdRealPath,
    input.outputName,
    event.toolCallId
  )
  return {
    summary: formatOfficeDeliverApprovalSummary(description),
    approvalDigest: officeDeliverApprovalDigest(input)
  }
}

function resolveActiveOfficeRun(originSessionId: string): { runId: string } | undefined {
  const run = findActivePromptRunByRuntimeSessionId(originSessionId)
  return run && !run.cancelled ? { runId: run.runId } : undefined
}

function clearOfficeRunTarget(runId: string): boolean {
  officeApplyApprovals.clearRun(runId)
  officeDeliverApprovals.clearRun(runId)
  return officeService?.clearRunTarget(runId) ?? false
}

function isActiveOfficeApprovalRun(runId: string): boolean {
  const run = [...activePromptRuns.values()].find((candidate) => candidate.runId === runId)
  return Boolean(run && !run.cancelled)
}

const phiSessionIdsByKey = new Map<string, string>()
const loadedSkillNamesBySession = new Map<string, string[]>()
const sessionKeyAliases = new Map<string, string>()
const sessionModelSelections = new Map<string, ModelSelection>()
const sessionThinkingLevels = new Map<string, ThinkingLevel>()
const sessionPermissionModes = new Map<string, PermissionMode>()
const recentErrorSummaries: string[] = []
let preventSleepBlockerId: number | null = null
const backgroundAgentApprovals = new BackgroundAgentApprovalTracker({
  readManifest: findPhiSessionById,
  appendEvent: appendSessionEvent,
  updateManifest: updateSessionManifest,
  onEvent: (sessionId, event) =>
    sendRunEventToWindow({ source: 'phi', ...event, phiSessionId: sessionId }),
  onChange: notifySessionChanged
})
const runnerRegistry = new SessionRunnerRegistry({
  onSessionEvent: broadcastSessionTimelineEvent,
  onRunSettled: (sessionId) => backgroundAgentApprovals.afterParentRunSettled(sessionId)
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
const environmentBuilds = createEnvironmentBuilds({
  root: getRuntimeRoot(),
  onChange: (build) => {
    sendToAllWindows('environmentBuilds:changed', build)
  }
})
const managedEnvironmentActions = createManagedEnvironmentActions({
  root: getRuntimeRoot(),
  agentDir: AGENT_DIR,
  builds: environmentBuilds,
  catalog: (projectDir) =>
    listManagedEnvironments({
      ...(projectDir ? { projectDir } : {}),
      builds: environmentBuilds.list()
    })
})
// The notebook server joins builds started elsewhere (chat prompt or the environment panel).
const jupyterServerRegistry = new JupyterServerRegistry({ managed: { builds: environmentBuilds } })
const notebookSessionRegistry = new AnalysisNotebookSessionRegistry({
  getConnection: (projectCwd) => jupyterServerRegistry.connection(projectCwd)
})
const notebookExecutor = new AnalysisNotebookExecutor()
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
getOmpBridge().registerHostHandler('notebookTool.execute', (params) =>
  notebookToolExecutor.execute(params as Parameters<typeof notebookToolExecutor.execute>[0])
)
const skillHost = createSkillHost({
  listSkillDirs: async (cwd) => {
    const skills = await listSkills(cwd)
    return skills.map((skill) => dirname(skill.filePath))
  },
  builds: environmentBuilds,
  confirmBuild: (request) => confirmEnvironmentBuild(request),
  presentArtifacts: (request) => presentScriptArtifacts(request)
})

function phiPluginListItems(): PhiPluginListItem[] {
  return listInstalledPlugins({ agentDir: AGENT_DIR }).map((plugin) => ({
    id: plugin.id,
    version: plugin.version,
    title: plugin.manifest.title,
    summary: plugin.manifest.summary,
    enabled: plugin.enabled,
    source: plugin.source,
    installedAt: plugin.installedAt,
    directory: plugin.dir,
    agents: plugin.agents.map((agent) => agent.name).sort(),
    skills: plugin.skills.map((skill) => skill.name).sort(),
    scriptTools: plugin.skills
      .flatMap((skill) =>
        (skill.phi?.scripts ?? []).map((script) => scriptToolName(plugin.toolPrefix, script.name))
      )
      .sort(),
    environments: Object.keys(plugin.environments)
      .sort()
      .map((name) => ({ name, ref: `plugin:${name}` }))
  }))
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
getOmpBridge().registerHostHandler('skills.scriptTools', (params) => skillHost.scriptTools(params))
getOmpBridge().registerHostHandler('skills.run', (params) => skillHost.run(params))
getOmpBridge().registerHostHandler('skills.scriptTool', (params) => skillHost.scriptTool(params))
getOmpBridge().registerHostHandler('skills.cancel', (params) => skillHost.cancel(params))
getOmpBridge().registerHostHandler('environments.bindSession', (params) =>
  bindAgentSession(params, {
    builds: environmentBuilds,
    confirmBuild: (request) => confirmEnvironmentBuild(request)
  })
)
getOmpBridge().registerHostHandler('environments.request', (params) =>
  requestProjectEnvironment(params, {
    root: getRuntimeRoot(),
    builds: environmentBuilds,
    confirm: (request) => confirmEnvironmentRequest(request)
  })
)
getOmpBridge().registerHostHandler('agentInteraction.request', handleAgentInteractionRequest)
getOmpBridge().registerHostHandler(
  'settings.nextActionSuggestionsEnabled',
  () => readAppSettings().nextActionSuggestionsEnabled
)
const cursorH2Bridge = createCursorH2Bridge()
getOmpBridge().registerHostHandler('cursorBridge.ensure', async () => ({
  baseUrl: await cursorH2Bridge.ensure()
}))
getOmpBridge().registerHostHandler('planReview.request', handlePlanReviewRequest)
getOmpBridge().registerHostHandler('deliverables.present', handlePresentFilesRequest)
getOmpBridge().registerHostHandler('mcp.openAuthUrl', async (params) => {
  const request = params as { id?: unknown; url?: unknown } | null
  if (typeof request?.id !== 'string' || typeof request.url !== 'string') {
    throw new Error('授权地址无效')
  }
  const catalogConnector = listConnectorCatalog({
    agentDir: AGENT_DIR,
    appVersion: app.getVersion(),
    runtimeRoot: getRuntimeRoot(),
    registryDirs: loadPackageRegistries().registries.map((registry) => registry.dir)
  }).find((entry) => entry.id === request.id)
  const authorizationOrigin = catalogConnector?.url
    ? mcpOAuthAuthorizationOrigin(request.id, catalogConnector.url)
    : undefined
  if (!authorizationOrigin) throw new Error('授权地址无效')
  const url = new URL(request.url)
  if (url.origin !== authorizationOrigin || url.username || url.password) {
    throw new Error('授权地址与连接器不匹配')
  }
  await shell.openExternal(url.toString())
})
getOmpBridge().registerHostHandler('mcp.featuredApiKey', (params) => {
  const id = (params as { id?: unknown } | null)?.id
  if (typeof id !== 'string') throw new Error('连接器标识无效')
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
    await getOmpBridge().request('mcp.syncFeaturedApiKeys', { id })
  } catch {
    // The worker may still hold the previous key. Stop it so a failed sync cannot
    // leave a revoked or rotated credential usable in an existing session.
    writeAppLog({ event: 'mcp_api_key_session_sync_failed', metadata: { connectorId: id } })
    await getOmpBridge().stop()
    throw new Error('本地修改已保存，但运行中的会话同步失败并已停止；请重新打开对话后重试')
  }
}
const remoteConnectionTracker = new RemoteProjectConnectionTracker()
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
getOmpBridge().registerHostHandler('remoteWorkspace.resolvePath', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    resolveRemoteWorkspacePath(params)
  )
)
getOmpBridge().registerHostHandler('remoteWorkspace.resolveBashContext', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    resolveRemoteBashContext(params)
  )
)
const remoteReadBasis = new RemoteWorkspaceReadBasis()
getOmpBridge().registerHostHandler('remoteWorkspace.read', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    readRemoteWorkspacePath(params, {
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
getOmpBridge().registerHostHandler('remoteWorkspace.glob', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () => remoteGlob(params))
)
getOmpBridge().registerHostHandler('remoteWorkspace.grep', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () => remoteGrep(params))
)
const remoteBashManager = new RemoteWorkspaceBashManager({ beforeRun: requireRemoteBashApproval })
const remoteMutationManager = new RemoteWorkspaceMutationManager({
  basis: remoteReadBasis,
  beforeWrite: requireRemoteWriteApproval,
  beforeEdit: requireRemoteEditApproval
})
getOmpBridge().registerHostHandler('remoteWorkspace.write', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteMutationManager.write(params)
  )
)
getOmpBridge().registerHostHandler('remoteWorkspace.cancelWrite', (params) =>
  remoteMutationManager.cancel(params)
)
getOmpBridge().registerHostHandler('remoteWorkspace.edit', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteMutationManager.edit(params)
  )
)
getOmpBridge().registerHostHandler('remoteWorkspace.cancelEdit', (params) =>
  remoteMutationManager.cancel(params)
)
getOmpBridge().registerHostHandler('remoteWorkspace.bash', (params) =>
  remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteBashManager.run(params)
  )
)
getOmpBridge().registerHostHandler('remoteWorkspace.cancelBash', (params) =>
  remoteBashManager.cancel(params)
)

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
    const origin = resolveOriginSession(originSessionId)
    const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
    if (!manifest) return undefined
    return manifest.projectId ? getProject(manifest.projectId) : null
  },
  // A remote run goes to the HPC connection saved on the project the chat belongs to; a run
  // being resumed after a restart names its project and connection itself.
  resolveRemoteTarget: ({ originSessionId, projectId, connectionId }) => {
    const origin = resolveOriginSession(originSessionId)
    const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
    const project = projectId
      ? getProject(projectId)
      : manifest?.projectId
        ? getProject(manifest.projectId)
        : undefined
    return resolveProjectRemoteTarget(project, connectionId)
  },
  checkRemoteEnvironment: async ({ project, resolved, profile }) => {
    const hostProfileId =
      project.location.kind === 'ssh'
        ? project.location.hostProfileId
        : project.remoteConnections?.find((connection) => connection.id === resolved.connectionId)
            ?.hostProfileId
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
        ...(hpc.nextflowBin ? { nextflowBin: hpc.nextflowBin } : {})
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
for (const [method, handler] of Object.entries(wrapperJobHostHandlers(wrapperJobs))) {
  getOmpBridge().registerHostHandler(method, handler)
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

const browserToolHostCoordinator = new BrowserToolHostCoordinator({
  resolveActiveRun: (originSessionId) => {
    const run = findActivePromptRunByRuntimeSessionId(originSessionId)
    return run ? { runId: run.runId, cancelled: run.cancelled } : undefined
  },
  executeAgent: (params, signal) => browserIpcCoordinator.executeAgent(params, signal)
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

getOmpBridge().registerHostHandler('browser.execute', (params) =>
  browserToolHostCoordinator.execute(params)
)
getOmpBridge().registerHostHandler('browser.cancel', (params) =>
  browserToolHostCoordinator.cancel(params)
)
function registerOfficeAgentHostHandlers(): void {
  if (!officeAvailabilityCache.get().enabled) return
  getOmpBridge().registerHostHandler(
    'office.read',
    createOfficeReadHostHandler({
      resolveActiveRun: resolveActiveOfficeRun,
      readRange: (runId, params) => {
        officeService = getOfficeService()
        return officeService.readRange(runId, params)
      }
    })
  )
  officeDescribeHostHandler = createOfficeDescribeHostHandler({
    resolveActiveRun: resolveActiveOfficeRun,
    describeCellEdit: (runId, params) => {
      officeService = getOfficeService()
      return officeService.describeCellEdit(runId, params)
    },
    describeWriteRequest: (runId, request) => {
      officeService = getOfficeService()
      return officeService.describeWriteRequest(runId, request)
    }
  })
  getOmpBridge().registerHostHandler('office.describe', officeDescribeHostHandler)
  getOmpBridge().registerHostHandler(
    'office.apply',
    createOfficeApplyHostHandler({
      resolveActiveRun: resolveActiveOfficeRun,
      authorizeWrite: authorizeOfficeWrite,
      applyCellEdit: (runId, params, options) => {
        officeService = getOfficeService()
        return officeService.applyCellEdit(runId, params, options)
      },
      applyWriteRequest: (runId, request, options) => {
        officeService = getOfficeService()
        return officeService.applyWriteRequest(runId, request, options)
      }
    })
  )
  getOmpBridge().registerHostHandler(
    'office.deliver',
    createOfficeDeliverHostHandler({
      resolveActiveRun: resolveActiveOfficeRun,
      deliver: deliverOfficeOutputFromRun
    })
  )
}

async function listBackgroundAgentJobs(): Promise<BackgroundAgentJob[]> {
  const raw = await getOmpBridge().request<unknown>('agentRuns.list', {})
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((value): BackgroundAgentJob[] => {
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
      const origin = resolveOriginSession(agentSessionId)
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
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 50)
}

const SHELL_JOB_STATES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])

async function listBackgroundShellJobs(): Promise<BackgroundShellJob[]> {
  const raw = await getOmpBridge().request<unknown>('shellJobs.list', {})
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
  const result = await getOmpBridge().request<{ ok?: boolean }>('shellJobs.cancel', {
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
  if (status.state === 'lost' && run.remote?.projectId) {
    remoteConnectionTracker.noteRemoteRunLost(run.remote.projectId)
  }
  return deliverWrapperRunFinished(run, status, {
    resolveSession: resolveOriginSession,
    appendToSession: (phiSessionId, event) => appendSessionEvent(phiSessionId, { ...event }),
    sendToWindow: sendRunEventToWindow,
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    continueConversation: continueConversationAfterWrapperRun,
    showOsNotification: showRunNotification
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
  getOmpBridge().registerHostHandler(method, handler)
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
    rememberErrorSummary(error)
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
  await getOmpBridge().request(method, {
    sessionId: agentSessionId,
    runId: agentRunId,
    ...(message !== undefined ? { message } : {})
  })
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
): { run: PromptRun; toolCallId: string } {
  if (!runtimeSessionId || !toolCallId || toolCallId.length > 200) {
    throw new Error('Invalid file delivery request')
  }
  const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
  if (!run || run.cancelled) throw new Error('No active conversation for file delivery')
  const manifest = findPhiSessionById(run.phiSessionId)
  const project = run.projectId ? getProject(run.projectId) : undefined
  if (manifest?.projectLocation?.kind === 'ssh' || project?.location.kind === 'ssh') {
    throw new Error('Remote project file delivery is not available')
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

function handlePresentFilesRequest(params: unknown): {
  files: ReturnType<typeof validatePresentedFiles>
} {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = optionalStringField(record, 'runtimeSessionId')
  const toolCallId = optionalStringField(record, 'toolCallId')
  const { run, toolCallId: callId } = presentableRun(runtimeSessionId, toolCallId)
  const files = validatePresentedFiles(run.cwd, record.files)
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

async function handleAgentInteractionRequest(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = optionalStringField(record, 'runtimeSessionId')
  const questions = interactionQuestionsField(record.questions)
  if (!runtimeSessionId || questions.length === 0) {
    throw new Error('Invalid user interaction request')
  }

  const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
  if (!run) {
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
    window
  )
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

function notebookCellMetadataWithExecutionDuration(
  metadata: JsonObject,
  execution: { startedAt: string; completedAt: string }
): JsonObject {
  const startedAt = Date.parse(execution.startedAt)
  const completedAt = Date.parse(execution.completedAt)
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : 0
  const phiMetadata =
    metadata.phi && typeof metadata.phi === 'object' && !Array.isArray(metadata.phi)
      ? (metadata.phi as JsonObject)
      : {}
  return {
    ...metadata,
    phi: {
      ...phiMetadata,
      executionStartedAt: execution.startedAt,
      executionCompletedAt: execution.completedAt,
      executionDurationMs: durationMs
    }
  }
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

function rememberErrorSummary(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  recentErrorSummaries.unshift(message.slice(0, 500))
  recentErrorSummaries.splice(20)
  writeAppLog({
    level: 'error',
    event: 'error_summary',
    metadata: { message }
  })
}

async function settledValue<T>(fallback: T, load: () => Promise<T> | T): Promise<T> {
  try {
    return await load()
  } catch (error) {
    rememberErrorSummary(error)
    return fallback
  }
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

function assistantTextFromEventSummary(
  summary: Record<string, unknown>,
  currentText: string
): string {
  const message = summary.message as { role?: string } | undefined
  const assistantMessageEvent = summary.assistantMessageEvent as
    | {
        type?: unknown
        delta?: unknown
        message?: unknown
        partial?: unknown
        error?: unknown
        content?: unknown
      }
    | undefined

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

function assistantErrorMessageFromEventSummary(summary: Record<string, unknown>): string | null {
  const assistantMessageEvent = summary.assistantMessageEvent as
    { type?: unknown; error?: unknown } | undefined
  if (summary.type === 'message_update' && assistantMessageEvent?.type === 'error') {
    const error = assistantMessageEvent.error
    const message = assistantErrorText(error, { allowContent: true })
    return message ? redactSensitiveText(message) : '请求失败'
  }

  const message = summary.message as
    { role?: string; stopReason?: unknown; errorMessage?: unknown } | undefined
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

function notebookCompletionCandidatesFromEventSummary(summary: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = []
  const assistantMessageEvent = summary.assistantMessageEvent as
    | {
        type?: unknown
        data?: unknown
        value?: unknown
        content?: unknown
        delta?: unknown
        result?: unknown
        output?: unknown
        outputs?: unknown
        message?: unknown
        partial?: unknown
        error?: unknown
      }
    | undefined
  if (summary.type === 'message_update' && assistantMessageEvent) {
    candidates.push(assistantMessageEvent)
    if (assistantMessageEvent.message) candidates.push(assistantMessageEvent.message)
    if (assistantMessageEvent.partial) candidates.push(assistantMessageEvent.partial)
    if (assistantMessageEvent.error) candidates.push(assistantMessageEvent.error)
    if (assistantMessageEvent.data) candidates.push(assistantMessageEvent.data)
    if (assistantMessageEvent.value) candidates.push(assistantMessageEvent.value)
    if (assistantMessageEvent.content) candidates.push(assistantMessageEvent.content)
    if (assistantMessageEvent.delta) candidates.push(assistantMessageEvent.delta)
    if (assistantMessageEvent.result) candidates.push(assistantMessageEvent.result)
    if (assistantMessageEvent.output) candidates.push(assistantMessageEvent.output)
    if (assistantMessageEvent.outputs) candidates.push(assistantMessageEvent.outputs)
  }

  const message = summary.message as { role?: string } | undefined
  if (summary.type === 'message_end' && message?.role === 'assistant') {
    candidates.push(message)
  }

  candidates.push(...assistantMessagesFrom(summary.messages))
  candidates.push(...assistantMessagesFrom(summary.result))

  return candidates
}

type NotebookCompletionSelection = {
  cells: AnalysisNotebookGeneratedCell[]
  text: string
  score: number
}

function notebookCompletionCandidateText(candidate: unknown): string {
  if (typeof candidate === 'string') return candidate.trim()
  return extractAssistantText(candidate).trim() || extractMessageText(candidate).trim()
}

function notebookCompletionCellsScore(cells: AnalysisNotebookGeneratedCell[]): number {
  const sourceLength = generatedNotebookCellsSource(cells).trim().length
  const codeCellCount = cells.filter((cell) => cell.cellType === 'code').length
  return sourceLength + cells.length * 1000 + codeCellCount * 1500
}

function chooseNotebookCompletion(
  candidates: unknown[],
  language: string,
  parseCompletion: (candidate: unknown, defaultLanguage: string) => AnalysisNotebookGeneratedCell[]
): NotebookCompletionSelection | null {
  let best: NotebookCompletionSelection | null = null
  for (const candidate of candidates) {
    const cells = parseCompletion(candidate, language)
    if (cells.length === 0) continue

    const text = notebookCompletionCandidateText(candidate)
    const score = notebookCompletionCellsScore(cells)
    if (!best || score > best.score || (score === best.score && text.length > best.text.length)) {
      best = { cells, text, score }
    }
  }
  return best
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
function withEventTimestamp(summary: Record<string, unknown>): Record<string, unknown> {
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

function persistSessionEvent(
  run: PromptRun,
  summary: Record<string, unknown>
): Record<string, unknown> {
  const withRunId = (event: Record<string, unknown>): Record<string, unknown> =>
    typeof event.runId === 'string' ? event : { ...event, runId: run.runId }

  const notice = persistSdkCompactionNotice(run.phiSessionId, run.runId, summary)
  if (notice) return notice

  if (summary.type === 'auto_compaction_start' && typeof summary.action === 'string') {
    if (typeof summary.reason === 'string') {
      run.compactionReasons.set(summary.action, summary.reason)
    }
    return withRunId(summary)
  }

  if (summary.type === 'auto_compaction_end' && typeof summary.action === 'string') {
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
    const result = summary.result as
      { summary?: unknown; shortSummary?: unknown; tokensBefore?: unknown } | undefined
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

  if (
    summary.type === 'message_start' &&
    (summary.message as { role?: string } | undefined)?.role === 'assistant'
  ) {
    run.thinkingBlocks.clear()
    run.thinkingBlockStartedAtMs.clear()
    return withRunId(summary)
  }

  if (
    summary.type === 'message_update' &&
    (summary.message as { role?: string } | undefined)?.role === 'assistant'
  ) {
    const assistantMessageEvent = summary.assistantMessageEvent as
      { type?: string; delta?: unknown; contentIndex?: unknown } | undefined
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

  if (
    summary.type === 'message_end' &&
    (summary.message as { role?: string } | undefined)?.role === 'assistant'
  ) {
    const assistantMessage = summary.message as { stopReason?: unknown; errorMessage?: unknown }
    if (assistantMessage?.stopReason === 'error') {
      const errorMessage =
        typeof assistantMessage.errorMessage === 'string'
          ? redactSensitiveText(assistantMessage.errorMessage)
          : '请求失败'
      persistCompletedThinkingBlocks(run, summary)
      if (!run.stoppingPermanentProviderError) run.recordedFailureMessage = errorMessage
      return withRunId(summary)
    }

    persistAssistantContentInOrder(run, summary)
    return withRunId({ ...summary, message: browserSafeAssistantMessage(summary.message) })
  }

  if (
    summary.type === 'message_end' &&
    (summary.message as { role?: string } | undefined)?.role === 'toolResult'
  ) {
    const result = summary.message as {
      toolCallId?: unknown
      content?: unknown
      isError?: unknown
    }
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
    ...(notebookDetails ? { details: notebookDetails } : {}),
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
  const officeTarget = Object.hasOwn(record, 'officeTarget')
    ? (sanitizeOfficeTargetInput(record.officeTarget) ?? null)
    : undefined
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
    ...(record.planMode === true ? { planMode: true } : {}),
    ...(officeTarget !== undefined ? { officeTarget } : {})
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
    rememberErrorSummary(error)
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
    rememberErrorSummary(error)
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
async function submitPromptRun(input: SubmitPromptInput): Promise<
  | {
      path: string | null
      phiSessionId?: string
      sessionGeneration: number
    }
  | OfficePromptTargetFailure
  | null
> {
  const normalizedText = input.text
  const promptTarget = input.promptTarget
  const runSessionKey = resolveSessionKeyAlias(input.sessionKey)
  const runLifecycle = getLifecycleForKey(runSessionKey)
  const runSessionGeneration = runLifecycle.currentGeneration
  const runSnapshot = input.snapshot
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
  if (manualCompactionIds.has(phiSessionId)) {
    throw new Error('上下文压缩正在进行，请稍后发送消息')
  }
  const stableSessionPath = phiOnlySessionPath(phiSessionId)
  const runId = createRunId()
  if (hasActivePromptRun(runSessionKey)) {
    throw new Error('会话正在运行')
  }
  const officePreparation =
    promptTarget?.officeTarget !== undefined
      ? await prepareOfficePromptSubmission(
          promptTarget.officeTarget,
          {
            runId,
            sessionId: phiSessionId,
            projectId: project?.id ?? null
          },
          officeService,
          () => advancePromptGeneration(runSessionKey)
        )
      : { ok: true as const, value: advancePromptGeneration(runSessionKey) }
  if (!officePreparation.ok) return officePreparation
  // A real user message starts the automatic wake-up count over only after preflight succeeds.
  if (!input.automatic) automaticContinuations.delete(phiSessionId)
  const runGeneration = officePreparation.value
  let storedImages: ReturnType<typeof persistPromptImages> = []
  try {
    storedImages = input.images?.length ? persistPromptImages(phiSessionId, input.images) : []
  } catch (error) {
    clearOfficeRunTarget(runId)
    throw error
  }
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
    clearOfficeRunTarget(runId)
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
      if (
        project?.location?.kind === 'ssh' ||
        isRemoteProjectAnchorPath(runSnapshot.cwd, AGENT_DIR)
      ) {
        loadedSkills = []
      } else {
        try {
          loadedSkills = filterOfficeSkillForAvailability(
            (await listSkills(runSnapshot.cwd)).filter((skill) => skill.enabled),
            officeAvailabilityCache.get().enabled
          )
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

        await applyNextRunConfiguration(session, runSessionKey, runSnapshot)
        if (input.planMode) {
          await getOmpBridge().request('session.plan.enter', {
            sessionId: session.runtimeSessionId
          })
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
          await session.prompt(normalizedText, {
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
                  rememberErrorSummary(error)
                  console.error('Failed to abort stale prompt:', error)
                })
                throw new StaleSessionError()
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
          rememberErrorSummary(error)
        }
      }
    }
    return promptRun.cancelled ? null : promptResult
  })
  promptRun.done = run
  setPromptQueue(
    runSessionKey,
    run.then(
      () => {
        clearOfficeRunTarget(runId)
        deleteActivePromptRun(runSessionKey, promptRun)
        notifySessionChanged()
        flushPendingContinuations(phiSessionId, promptRun.cancelled)
      },
      () => {
        clearOfficeRunTarget(runId)
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
  return manifest?.model ?? projectForSession(sessionKey, snapshot)?.defaultModel ?? selectedModel
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
  if (sessionPermissionModes.has(canonicalKey)) {
    return sessionPermissionModes.get(canonicalKey) ?? 'auto'
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  return (
    manifest?.permissionMode ?? projectForSession(sessionKey, snapshot)?.permissionMode ?? 'auto'
  )
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
    ...(model ? { model } : {}),
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
  const model = project?.defaultModel ?? selectedModel
  const sessionTitle = messageContentTitleText(title)
  const session = createPhiSession({
    kind: project ? 'project' : 'ordinary',
    projectId: project?.id ?? null,
    cwd,
    cwdRealPath: project?.workingDirectoryRealPath ?? cwd,
    ...(sessionTitle ? { title: sessionTitle } : {}),
    permissionMode,
    ...(model ? { model } : {}),
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
  const session = createPhiSession({
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd,
    cwdRealPath: cwd,
    permissionMode: project.permissionMode,
    ...(project.defaultModel ? { model: project.defaultModel } : {}),
    ...(project.defaultThinkingLevel ? { thinkingLevel: project.defaultThinkingLevel } : {})
  })
  const path = phiOnlySessionPath(session.sessionId)
  const key = createPhiSessionKey(session.sessionId, cwd)
  linkPhiManagedSessionKey(key, cwd, session.sessionId)
  sessionPermissionModes.set(resolveSessionKeyAlias(key), project.permissionMode)
  return { path, sessionId: session.sessionId, cwd, permissionMode: project.permissionMode }
}

// Turns a free-text description of the desired assistant into a persona markdown file
// by asking the agent itself to write it, in a throwaway session (noTools + in-memory
// history) so it doesn't touch the user's real chat or leave tool-call side effects.
async function generatePersonaMarkdown(description: string): Promise<string> {
  const runtime = await getAuthManager().getRuntime()
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
}): Promise<AnalysisNotebookContextReference[] | undefined> {
  const references = [...(input.references ?? [])]
  if (!notebookLanguageSupportsKernelIntrospection(input.language)) return references
  const variableNames = notebookAiVariableNamesFromInput(input.prompt, references)
  if (variableNames.length === 0) return references
  const target = notebookSessionRegistry.executionTarget(input.projectCwd, input.notebookPath)
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
}): Promise<NotebookCompletionSelection | null> {
  let assistantText = ''
  let errorMessage = ''
  const candidates: unknown[] = []
  const { session } = await createAgentSession(input.sessionOptions, (summary) => {
    assistantText = assistantTextFromEventSummary(summary, assistantText)
    candidates.push(...notebookCompletionCandidatesFromEventSummary(summary))
    errorMessage = assistantErrorMessageFromEventSummary(summary) ?? errorMessage
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

    const lastAssistantMessage = [...session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    return chooseNotebookCompletion(
      [...candidates, assistantText.trim(), lastAssistantMessage],
      input.language,
      parseFinalGeneratedNotebookCompletion
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
  const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
  const runtime = await getAuthManager().getRuntime()
  const modelSelection = input.model ?? workspace.project?.defaultModel ?? selectedModel
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
    references: input.references
  })
  const sessionOptions = {
    modelRuntime: runtime,
    cwd: workspace.workingDirectory,
    noTools: 'all' as const,
    thinkingLevel: workspace.project?.defaultThinkingLevel ?? selectedThinkingLevel,
    sessionManager: createInMemoryRuntimeSessionManager(workspace.workingDirectory),
    ...(resolvedModel ? { model: resolvedModel.model } : {})
  }
  let eventAssistantText = ''
  let eventErrorMessage = ''
  const eventCompletionCandidates: unknown[] = []
  let lastProgressSource = ''
  const emitProgress = (): void => {
    if (!input.requestId || !onProgress) return
    const selectedCompletion = chooseNotebookCompletion(
      [...eventCompletionCandidates, eventAssistantText.trim()],
      language,
      parseGeneratedNotebookCompletionSnapshot
    )
    if (!selectedCompletion || selectedCompletion.cells.length === 0) return
    const source = generatedNotebookCellsSource(selectedCompletion.cells)
    if (source === lastProgressSource) return
    lastProgressSource = source
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
    eventAssistantText = assistantTextFromEventSummary(summary, eventAssistantText)
    eventCompletionCandidates.push(...notebookCompletionCandidatesFromEventSummary(summary))
    eventErrorMessage = assistantErrorMessageFromEventSummary(summary) ?? eventErrorMessage
    emitProgress()
  })

  try {
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
    const candidates = [
      ...eventCompletionCandidates,
      eventAssistantText.trim(),
      lastAssistantMessage
    ]
    const selectedCompletion = chooseNotebookCompletion(
      candidates,
      language,
      parseFinalGeneratedNotebookCompletion
    )
    let assistantText = selectedCompletion?.text || eventAssistantText.trim()
    assistantText ||= extractAssistantText(lastAssistantMessage).trim()
    let cells = selectedCompletion?.cells ?? []
    let completionText = assistantText
    if (cells.length === 0) {
      const repairedCompletion = await repairNotebookGenerationCompletion({
        sessionOptions,
        language,
        notebookPath: file.relativePath,
        insertionIndex,
        references,
        userPrompt: prompt,
        nearbyContext,
        otherCellContext,
        invalidOutput: assistantText
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
    return { source, language, cells }
  } finally {
    await session.dispose()
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

function isLocalFilePathAllowed(
  target: string,
  scope: LocalPathScope = currentLocalPathScope(),
  projectRoots: readonly string[] = []
): boolean {
  if (isRemoteProjectAnchorPath(target, AGENT_DIR)) return false
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

function assertRevealPathAllowed(filePath: string): string {
  return assertLocalFilePathAllowed(filePath, '显示')
}

type LocalPathStatPayload = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

function localPathStatScope(cwd: unknown): LocalPathScope | null {
  const rawCwd = typeof cwd === 'string' && cwd.trim() ? cwd : currentCwd
  const requestedCwd = resolve(rawCwd)
  if (requestedCwd === resolve(currentCwd)) return currentLocalPathScope()

  const project = getProjectByCwd(rawCwd)
  if (!project) return null

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

function statLocalPath(filePath: string, scope: LocalPathScope): LocalPathStatPayload {
  const missing = { path: filePath, kind: 'missing' as const }
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return missing

  const target = resolve(filePath)
  if (!isLocalFilePathAllowed(target, scope)) return missing

  try {
    const realTarget = realpathSync(target)
    if (!isLocalFilePathAllowed(realTarget, scope)) return missing

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
  const scope = localPathStatScope(cwd)
  if (!scope) return missingLocalPathStats(limitedPaths)

  return limitedPaths.map((path) => statLocalPath(path, scope))
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
  const target = assertLocalFilePathAllowed(filePath, '预览', { resolveSymlinks: true })
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
  await session.abort()
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
        rememberErrorSummary(error)
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
  if (!runtimeSessionPathForSnapshot(sessionKey, snapshot)) {
    return { ...identity, usage: null }
  }

  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
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

async function getCurrentAutoCompactionSettings(
  target: unknown
): Promise<CurrentAutoCompactionSettings> {
  const { current, manifest } = currentAutoCompactionManifest(target)
  const defaults = await readAutoCompactionDefaults(
    manifest.projectLocation?.kind === 'ssh' ? AGENT_DIR : current.cwd,
    AGENT_DIR
  )
  const latestManifest = currentAutoCompactionManifest(target).manifest
  const overrides = latestManifest.autoCompaction ?? {}
  return {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration,
    enabled: overrides.enabled ?? defaults.enabled,
    thresholdPercent: overrides.thresholdPercent ?? defaults.thresholdPercent,
    defaults,
    overrides
  }
}

async function setCurrentAutoCompactionSettings(
  target: unknown,
  value: unknown
): Promise<CurrentAutoCompactionSettings> {
  const { manifest, sessionKey } = currentAutoCompactionManifest(target)
  if (hasActivePromptRun(sessionKey) || manualCompactionIds.has(manifest.sessionId)) {
    throw new Error('请等待当前会话运行结束后再修改自动压缩设置')
  }
  const patch = autoCompactionSettingsPatch(value)
  const overrides: AutoCompactionOverrides = { ...(manifest.autoCompaction ?? {}) }
  if (patch.enabled === null) delete overrides.enabled
  else if (patch.enabled !== undefined) overrides.enabled = patch.enabled
  if (patch.thresholdPercent === null) delete overrides.thresholdPercent
  else if (patch.thresholdPercent !== undefined) {
    overrides.thresholdPercent = patch.thresholdPercent
  }
  const lifecycle = getLifecycleForKey(sessionKey)
  const record = lifecycle.currentRecord
  const pending = Symbol('pending')
  const ready = record ? await Promise.race([record.promise, Promise.resolve(pending)]) : pending
  if (ready !== pending && record && lifecycle.isCurrent(record)) {
    await ready.session.setAutoCompactionSettings(overrides)
  }
  updateSessionManifest(manifest.sessionId, {
    autoCompaction: Object.keys(overrides).length > 0 ? overrides : undefined
  })
  notifySessionChanged()
  return getCurrentAutoCompactionSettings(target)
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
  if (!runtimeSessionPathForSnapshot(sessionKey, snapshot)) {
    throw new Error('当前会话暂无可压缩的历史')
  }
  if (hasActivePromptRun(sessionKey)) throw new Error('请等待当前会话运行结束后再压缩')

  const phiSessionId = ensurePhiSessionId(sessionKey, snapshot)
  if (manualCompactionIds.has(phiSessionId)) throw new Error('上下文压缩正在进行')
  manualCompactionIds.add(phiSessionId)
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
    const { session } = await getAgentSession(sessionKey, snapshot)
    let result: Awaited<ReturnType<typeof session.compact>>
    try {
      result = await session.compact()
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
        rememberErrorSummary(persistError)
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
    manualCompactionIds.delete(phiSessionId)
    flushPendingContinuations(phiSessionId, false)
  }
}

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

async function createDiagnosticsText(): Promise<string> {
  const currentSnapshot: SessionSnapshot = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  }
  const [providers, projects, sessions, skills, mcpServers, plugins, selected, thinking, runtime] =
    await Promise.all([
      settledValue([], () => getAuthManager().getProviderStatuses()),
      settledValue([], () => listProjects()),
      settledValue([], () => listSessions()),
      settledValue([], () =>
        isRemoteResourceScope() ? listGlobalSkills() : listSkills(currentCwd)
      ),
      settledValue([], () =>
        isRemoteResourceScope() ? listGlobalMcpServers() : listMcpServers(currentCwd)
      ),
      settledValue([], () => listPlugins()),
      settledValue(null, () => resolveSessionModelSelection(currentSessionKey, currentSnapshot)),
      settledValue(selectedThinkingLevel, () =>
        resolveSessionThinkingLevel(currentSessionKey, currentSnapshot)
      ),
      settledValue(null, () => getAuthManager().getRuntime())
    ])
  const models = runtime ? runtime.getModels() : []
  const phiSessionId =
    getPhiSessionIdForKey(currentSessionKey) ??
    (currentSessionPath
      ? findPhiSessionByRuntimePath(currentSessionPath, currentCwd)?.sessionId
      : undefined)
  const currentSummary = currentSessionPath
    ? sessions.find((session) => session.path === currentSessionPath)
    : undefined
  const activeRun = phiSessionId ? getActivePromptRun(currentSessionKey) : undefined
  const snapshot: DiagnosticsSnapshot = {
    generatedAt: new Date().toISOString(),
    app: {
      name: APP_NAME,
      version: app.getVersion()
    },
    platform: {
      os: process.platform,
      node: process.versions.node,
      electron: process.versions.electron
    },
    currentSession: {
      path: currentSessionPath ?? null,
      ...(phiSessionId ? { phiSessionId } : {}),
      cwd: getCurrentSessionPayload().displayCwd,
      permissionMode: currentPermissionMode,
      status: currentSummary?.status,
      unreadKind: currentSummary?.unreadKind,
      activeRunId: activeRun?.runId
    },
    model: {
      selected,
      thinkingLevel: thinking,
      availableCount: models.length
    },
    providers,
    projects,
    sessions,
    skills,
    mcpServers,
    plugins,
    activeRunCount: activePromptRuns.size,
    logs: {
      directory: getPhiLogDir(),
      retentionDays: LOG_RETENTION_DAYS
    },
    recentErrors: recentErrorSummaries
  }
  return formatDiagnostics(snapshot)
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
    clearOfficeRunTarget(activePromptRun.runId)
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
  clearOfficeRunTarget(run.runId)
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
  const runs = [...activePromptRuns.values()]
  for (const [sessionKey, run] of activePromptRuns) {
    advancePromptGeneration(sessionKey)
    run.cancelled = true
    clearOfficeRunTarget(run.runId)
    cancelBrowserRun(run)
  }
  const browserCleanup = Promise.all(runs.map((run) => cleanupBrowserRunTabs(run)))
  runnerRegistry.stopAll()
  cancelPendingRunWaits()
  const runtimeAbort = Promise.all(
    runs.map(async (run) => {
      if (!run.session) return
      await abortSessionWithoutCancellingApprovals(run.session)
    })
  ).then(() => undefined)
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

function cleanupMainWindowRuntime(): Promise<void> {
  if (mainWindowCleanupPromise) return mainWindowCleanupPromise
  mainWindowCleanupStarted = true
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
      safeCleanupStep('office_cleanup_failed', () =>
        officeService?.dispose({ deadlineMs: OFFICE_QUIT_DEADLINE_MS })
      ),
      safeCleanupStep('notebook_watcher_cleanup_failed', () => notebookFileWatcher.dispose()),
      safeCleanupStep('jupyter_cleanup_failed', () => jupyterServerRegistry.disposeAll()),
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
  }
): Promise<AgentSessionResult> {
  const lifecycle = getLifecycleForKey(sessionKey)
  const record = lifecycle.getOrCreate(
    snapshot,
    async (creationSnapshot, generation) => {
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      await waitForSessionCleanup(creationSnapshot)
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
      const remoteContextFiles = remoteProject
        ? await loadRemoteProjectInstructions(remoteProject.location)
        : null
      const runtime = await getAuthManager().getRuntime()
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      const modelSelection = resolveSessionModelSelection(sessionKey, creationSnapshot)
      const resolvedModel = modelSelection
        ? resolveRuntimeModelSelection(runtime, modelSelection)
        : null
      const model = resolvedModel?.model
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
      const thinkingLevel = resolveSessionThinkingLevel(sessionKey, creationSnapshot)
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
      const remoteWrapperAgent = remoteProject
        ? loadRemoteWrapperAgent(getBundledAgentsDir())
        : undefined
      const agentScan = remoteProject
        ? { agents: remoteWrapperAgent ? [remoteWrapperAgent] : [], diagnostics: [] }
        : discoverPhiAgents({
            cwd: creationSnapshot.cwd,
            agentDir: AGENT_DIR,
            bundledDir: getBundledAgentsDir()
          })
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
      const shouldLoadBundledSkills = !remoteProject && existsSync(getBundledSkillsDir())
      const extensionFactories =
        remoteProject || creationSnapshot.permissionMode === 'ask'
          ? [
              createApprovalExtension({
                signal: sessionAbortController.signal,
                classifyTool: (toolName, input) =>
                  officeToolApproval(toolName) ?? skillHost.approvalFor(toolName, input),
                prepareClassifiedToolApproval: (toolName, input, _context, event) =>
                  prepareOfficeToolApproval(sessionKey, toolName, input, event),
                ...(remoteProject
                  ? {
                      shouldGate: () =>
                        findPhiSessionById(sessionManifest?.sessionId ?? '')?.permissionMode ===
                        'ask'
                    }
                  : {}),
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
                      request.toolName === 'office_apply' &&
                      request.runId &&
                      request.toolCallId &&
                      request.approvalDigest &&
                      isActiveOfficeApprovalRun(request.runId)
                    ) {
                      officeApplyApprovals.grant(
                        request.runId,
                        request.toolCallId,
                        request.approvalDigest
                      )
                    }
                    if (
                      request.toolName === 'office_deliver' &&
                      request.runId &&
                      request.toolCallId &&
                      request.approvalDigest &&
                      isActiveOfficeApprovalRun(request.runId)
                    ) {
                      officeDeliverApprovals.grant(
                        request.runId,
                        request.toolCallId,
                        request.approvalDigest
                      )
                    }
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
        remoteProject ||
        shouldLoadBundledSkills ||
        appendSystemPrompt.length > 0 ||
        extensionFactories.length > 0
      ) {
        resourceLoader = createRuntimeResourceLoader({
          cwd: remoteProject ? AGENT_DIR : creationSnapshot.cwd,
          agentDir: AGENT_DIR,
          ...(remoteProject
            ? {
                noExtensions: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true
              }
            : {}),
          ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
          ...(extensionFactories.length > 0 ? { extensionFactories } : {})
        })
        await resourceLoader.reload()
      }
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }

      const result = await createAgentSession({
        modelRuntime: runtime,
        thinkingLevel,
        ...(sessionManifest?.autoCompaction
          ? { autoCompaction: sessionManifest.autoCompaction }
          : {}),
        cwd: creationSnapshot.cwd,
        sessionManager: createSessionManager(
          creationSnapshot.cwd,
          runtimeSessionPathForSnapshot(sessionKey, creationSnapshot)
        ),
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(agentScan.agents.length > 0 ? { phiAgents: agentScan.agents } : {}),
        projectBound: Boolean(project),
        officeEnabled: officeAvailabilityCache.get().enabled,
        ...(remoteProject
          ? {
              remoteProject: {
                ...remoteProject,
                phiSessionId: sessionManifest?.sessionId ?? '',
                contextFiles: remoteContextFiles ?? []
              }
            }
          : {}),
        personaMarkdown: getPersonaMarkdown(),
        ...(model ? { model } : {})
      })
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
            rememberErrorSummary(error)
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
  session.setThinkingLevel(resolveSessionThinkingLevel(sessionKey, snapshot))
}

function createWindow(): void {
  mainWindowCleanupStarted = false
  mainWindowCleanupPromise = null
  const officeAvailability = officeAvailabilityCache.get()

  // Create the browser window.
  const window = new BrowserWindow({
    title: APP_NAME,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: true,
    autoHideMenuBar: true,
    transparent: false,
    // macOS titleBarStyle paints a system sidebar material behind the left pane.
    // Use a frameless window and opt the traffic lights back in so the renderer
    // owns every background pixel.
    ...(process.platform === 'darwin' ? { frame: false } : {}),
    backgroundMaterial: 'none',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B262D' : '#FFFFFF',
    icon: appIcon,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      webviewTag: officeAvailability.enabled,
      additionalArguments: [officeAvailabilityArgument(officeAvailability)]
    }
  })
  mainWindow = window

  window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0B262D' : '#FFFFFF')
  window.webContents.setBackgroundThrottling(false)
  if (officeAvailability.enabled) {
    installOfficeWebviewSecurity(
      window.webContents,
      (url) => officeService?.ownsPreviewUrl(url) === true
    )
  }
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

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', () => {
    void cleanupMainWindowRuntime()
  })

  window.on('closed', () => {
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
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

registerNotebookOutputScheme()

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  installNotebookOutputProtocol()
  applyDockIcon()

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
  const officeAvailabilityInitialization = officeAvailabilityCache.initialize({
    userEnabled: readAppSettings().officeEnabled,
    forcedDisabled: process.env.PHI_OFFICE === '0',
    onUnavailable: (reason) => {
      writeAppLog({ level: 'warn', event: 'office_runtime_unavailable', metadata: { reason } })
    }
  })
  const bundledSkillNames = (() => {
    try {
      return readdirSync(getBundledSkillsDir(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  })()
  migrateEnablementFromHistory(bundledSkillNames, { agentDir: AGENT_DIR })
  const officeAvailability = await officeAvailabilityInitialization
  initializePhiOfficeSkillDefault(officeAvailability.enabled, { agentDir: AGENT_DIR })
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
  // Bundled plugins: install missing ones before agent scans (a file copy), then upgrade in
  // the background, because an upgrade may first build the new environment it switches to.
  const bundledPluginOptions = async (): Promise<Parameters<typeof installBundledPlugins>[0]> => ({
    agentDir: AGENT_DIR,
    runtimeRoot: getRuntimeRoot(),
    names: await installedPluginNamespace(),
    build: (descriptor, options) => environmentBuilds.start(descriptor, options)
  })
  const logBundledPlugins = (result: Awaited<ReturnType<typeof installBundledPlugins>>): void => {
    if (result.errors.length === 0) return
    writeAppLog({
      level: 'error',
      event: 'phi_plugin_bundled_install_failed',
      metadata: {
        errors: result.errors.map((problem) => phiPluginProblemView(problem).displayMessage)
      }
    })
  }
  const logBundledPluginError = (error: unknown): void => {
    writeAppLog({
      level: 'error',
      event: 'phi_plugin_bundled_install_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  // The plugin namespace scans skills of the current folder; on a fresh account the
  // no-project task folder does not exist until the first session creates it.
  mkdirSync(currentCwd, { recursive: true })
  try {
    logBundledPlugins(
      await installBundledPlugins({ ...(await bundledPluginOptions()), phase: 'install' })
    )
  } catch (error) {
    logBundledPluginError(error)
  }
  void bundledPluginOptions()
    .then((options) => installBundledPlugins({ ...options, phase: 'upgrade' }))
    .then(logBundledPlugins)
    .catch(logBundledPluginError)
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
  registerOfficeAgentHostHandlers()
  registerOfficeIpc()
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
    return window.isFullScreen()
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
  ipcMain.handle('files:pickInput', async () => {
    if (isRemoteProjectAnchorPath(currentCwd, AGENT_DIR)) {
      throw new Error('远程项目文件选择暂不可用；不会打开本机会话目录')
    }
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      defaultPath: currentCwd || undefined,
      properties: ['openFile', 'openDirectory', 'multiSelections']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('files:preview', async (_, filePath: string) => {
    return createFilePreview(filePath)
  })
  ipcMain.handle('remoteWorkspace:preview', async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      previewRemoteWorkspaceFile(request)
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
    const checked = validateWrapperResultDownloadRequest(request)
    const { requestId } = checked
    if (wrapperResultDownloads.has(requestId)) throw new Error('Wrapper 下载请求 ID 正在使用')
    const name = basename(checked.path!)
    const window = BrowserWindow.fromWebContents?.(event.sender) ?? getActiveWindow()
    const options: Electron.SaveDialogOptions = {
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
  ipcMain.handle('wrapperResults:cancelDownload', async (_, requestId: unknown) => {
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
  ipcMain.handle('diagnostics:copy', async () => {
    const text = await createDiagnosticsText()
    clipboard.writeText(text)
    writeAppLog({ event: 'diagnostics_copied' })
    return text
  })

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

  ipcMain.handle('settings:get', async () => readAppSettings())
  ipcMain.handle('settings:update', async (_, patch: unknown) => {
    const settings = updateAppSettings(patch)
    syncPreventSleepBlocker()
    return settings
  })
  ipcMain.handle('settings:webSearch:get', async () =>
    getOmpBridge().request('settings.webSearch.get', { agentDir: AGENT_DIR })
  )
  ipcMain.handle('settings:webSearch:update', async (_, patch: unknown) =>
    getOmpBridge().request('settings.webSearch.update', { agentDir: AGENT_DIR, patch })
  )
  ipcMain.handle('settings:webSearch:searxngEngines', async () =>
    getOmpBridge().request('settings.webSearch.searxngEngines', { agentDir: AGENT_DIR })
  )
  ipcMain.handle('settings:webSearch:apiKey:set', async (_, providerId: unknown, key: unknown) =>
    getOmpBridge().request('settings.webSearch.apiKey.set', {
      agentDir: AGENT_DIR,
      providerId,
      key
    })
  )
  ipcMain.handle('settings:webSearch:apiKey:clear', async (_, providerId: unknown) =>
    getOmpBridge().request('settings.webSearch.apiKey.clear', { agentDir: AGENT_DIR, providerId })
  )

  ipcMain.handle('environment:get', async () => getEnvironment())
  ipcMain.handle('environment:redetect', async () => redetectEnvironment())
  ipcMain.handle('environment:dismissSummary', async () => dismissEnvironmentSummary())
  ipcMain.handle('environment:setToolPath', async (_, toolId: unknown, path: unknown) => {
    if (typeof toolId !== 'string' || !toolId.trim()) {
      throw new Error('工具 id 无效')
    }
    if (path !== null && typeof path !== 'string') {
      throw new Error('工具路径必须是字符串或 null')
    }
    return setEnvironmentToolPath(toolId as Parameters<typeof setEnvironmentToolPath>[0], path)
  })
  ipcMain.handle('environment:pickBinary', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择工具可执行文件',
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('managedEnvironments:list', async (_, projectCwd: unknown) => {
    try {
      return await managedEnvironmentActions.list(projectCwd)
    } catch (error) {
      throw new Error(`读取托管环境失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
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
  ipcMain.handle('models:select', async (_, providerId: string, modelId: string) => {
    const runtime = await getAuthManager().getRuntime()
    const resolved = resolveRuntimeModelSelection(runtime, { providerId, modelId })
    if (!resolved || resolved.migratedFrom) {
      throw new Error(`未知模型: ${providerId}/${modelId}`)
    }
    const model = resolved.model

    const nextModel = { providerId, modelId }
    sessionModelSelections.set(resolveSessionKeyAlias(currentSessionKey), nextModel)
    const phiSessionId = getPhiSessionIdForKey(currentSessionKey)
    if (phiSessionId) {
      updateSessionManifest(phiSessionId, { model: nextModel })
    }
    if (hasActivePromptRun(currentSessionKey)) {
      return
    }
    const current = await getCurrentResolvedSession()
    if (current) {
      const { session } = current
      await session.setModel(model)
    }
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

    const current = await getCurrentResolvedSession()
    if (!current) return null

    const { session } = current
    const model = session.model
    return model ? { providerId: model.provider, modelId: model.id } : null
  })

  ipcMain.handle('thinking:select', async (_, level: ThinkingLevel) => {
    sessionThinkingLevels.set(resolveSessionKeyAlias(currentSessionKey), level)
    const phiSessionId = getPhiSessionIdForKey(currentSessionKey)
    if (phiSessionId) {
      updateSessionManifest(phiSessionId, { thinkingLevel: level })
    }
    if (hasActivePromptRun(currentSessionKey)) {
      return
    }
    const current = await getCurrentResolvedSession()
    if (current) {
      const { session } = current
      session.setThinkingLevel(level)
    }
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
  ipcMain.handle('sessions:current', async () => getCurrentSessionPayloadWithMessages())
  ipcMain.handle('sessions:contextUsage', async () => getCurrentContextUsage())
  ipcMain.handle('sessions:autoCompactionSettings', async (_, target: unknown) =>
    getCurrentAutoCompactionSettings(target)
  )
  ipcMain.handle(
    'sessions:autoCompactionSettings:set',
    async (_, target: unknown, patch: unknown) => setCurrentAutoCompactionSettings(target, patch)
  )
  ipcMain.handle('sessions:compact', async (_, target: unknown) => compactCurrentSession(target))
  ipcMain.handle('sessions:updatePermissionMode', async (_, permissionMode: PermissionMode) => {
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
    if (!hasActivePromptRun(currentSessionKey)) {
      await invalidateAgentSession()
    }
    notifySessionChanged()
    return getCurrentSessionPayload()
  })
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
    const result = await getOmpBridge().request<{ path: string }>('sessions.fork', {
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
    if (manifest?.sessionId && officeService) {
      await officeService.closeSession(manifest.sessionId).catch((error) => {
        writeAppLog({ level: 'error', event: 'office_session_cleanup_failed' })
        throw error
      })
    }
    // Session-private drafts and their registries are deleted here; Save As copies are project
    // files and intentionally remain outside this tree. Draft garbage collection is out of scope.
    deleteSession(path)
    if (manifest) loadedSkillNamesBySession.delete(manifest.sessionId)
  })
  ipcMain.handle('sessions:rename', async (_, path: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    if (isPhiOnlySessionPath(path)) {
      await renameSession(path, trimmedName)
      return
    }
    const current = await getCurrentResolvedSession()
    if (currentSessionPath === path && current) {
      const { session } = current
      await session.sessionManager.setSessionName(trimmedName, 'user')
      return
    }
    await renameSession(path, trimmedName)
  })
  ipcMain.handle('sessions:export', async (_, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('会话编号无效')
    const manifest = findPhiSessionById(sessionId)
    if (!manifest) throw new Error('会话不存在')
    if (runnerRegistry.getActiveRun(sessionId)) throw new Error('请等待会话运行结束后再导出')
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择会话导出的目标文件夹',
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
    const options: Electron.OpenDialogOptions = {
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
    deleteProject(id)
  })
  ipcMain.handle(
    'projects:updatePermissionMode',
    async (_, id: string, permissionMode: PermissionMode) => {
      const project = updateProjectPermissionMode(id, permissionMode)
      if (project.location?.kind === 'ssh') {
        for (const manifest of listPhiSessions()) {
          if (manifest.projectId === id) {
            updateSessionManifest(manifest.sessionId, { permissionMode })
          }
        }
        const selected = findPhiManifestForSession(
          currentSessionKey,
          currentSessionPath,
          currentCwd
        )
        if (selected?.projectId === id) {
          currentPermissionMode = permissionMode
          sessionPermissionModes.set(resolveSessionKeyAlias(currentSessionKey), permissionMode)
          notifySessionChanged()
        }
      }
      if (project.location?.kind !== 'ssh' && project.workingDirectory === currentCwd) {
        currentPermissionMode = project.permissionMode
        await invalidateAgentSession()
      }
      return project
    }
  )
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
  ipcMain.handle('projects:listRemoteHosts', async () => listAvailableRemoteHostProfiles())
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
    return profile
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
      return saveRemoteHostProfile(input)
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
    deleteRemoteHostProfile(id)
  })
  ipcMain.handle(
    'remote:doctor',
    async (_, hostProfileId: unknown, remotePath: unknown, options: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (remotePath !== undefined && typeof remotePath !== 'string') {
        throw new Error('远程目录路径无效')
      }
      return remoteDoctor(hostProfileId, remotePath, options as RemoteDoctorOptions)
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
      updateProjectRemoteConnection(id, connectionId, patch)
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
    return remoteConnectionTracker.check(sessionId, projectId)
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
    const registry = listProjectNotebooks(workspace.workingDirectory)
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
    return initializeProjectAnalysis(workspace.workingDirectory)
  })
  ipcMain.handle('analysis:openNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = notebookFileWatcher.watch(workspace.workingDirectory, notebookPath)
    activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
    notebookToolExecutor.syncDraft({
      cwd: workspace.workingDirectory,
      path: file.path,
      document: file.document,
      savedRevision: file.savedRevision,
      source: 'renderer'
    })
    return file
  })
  ipcMain.handle(
    'analysis:saveNotebook',
    async (_, cwd: string, input: SaveProjectNotebookInput) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = saveProjectNotebook(workspace.workingDirectory, input)
      notebookFileWatcher.noteLocalWrite(workspace.workingDirectory, file)
      activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
      notebookToolExecutor.syncDraft({
        cwd: workspace.workingDirectory,
        path: file.path,
        document: file.document,
        savedRevision: file.savedRevision,
        source: 'renderer'
      })
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
      const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
      activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
      return notebookToolExecutor.syncDraft({
        cwd: workspace.workingDirectory,
        path: file.path,
        document,
        savedRevision,
        source: 'renderer'
      })
    }
  )
  ipcMain.handle('analysis:createNotebook', async (_, cwd: string, relativePath?: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = createProjectNotebook(workspace.workingDirectory, relativePath)
    notebookFileWatcher.watchFile(workspace.workingDirectory, file)
    activeNotebookPathByProjectCwd.set(workspace.workingDirectory, file.path)
    return file
  })
  ipcMain.handle('analysis:closeNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
    await notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
    if (activeNotebookPathByProjectCwd.get(workspace.workingDirectory) === file.path) {
      activeNotebookPathByProjectCwd.delete(workspace.workingDirectory)
    }
    notebookFileWatcher.unwatchFile(workspace.workingDirectory, file)
    return closeProjectNotebook(workspace.workingDirectory, notebookPath)
  })
  ipcMain.handle('analysis:deleteNotebook', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
    await notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
    if (activeNotebookPathByProjectCwd.get(workspace.workingDirectory) === file.path) {
      activeNotebookPathByProjectCwd.delete(workspace.workingDirectory)
    }
    notebookFileWatcher.unwatchFile(workspace.workingDirectory, file)
    return deleteProjectNotebook(workspace.workingDirectory, notebookPath)
  })
  ipcMain.handle('analysis:listKernels', async (_, cwd?: string) => {
    if (cwd) {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        return detectConfiguredAnalysisKernels()
      }
    }
    return detectConfiguredAnalysisKernels()
  })
  ipcMain.handle('analysis:jupyterStatus', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      return stoppedJupyterStatus(cwd, '请选择一个已添加的项目或当前 workspace')
    }
    return jupyterServerRegistry.status(workspace.workingDirectory)
  })
  ipcMain.handle('analysis:jupyterRuntimeStatus', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      return emptyAnalysisRuntimeStatus(cwd, '请选择一个已添加的项目或当前 workspace')
    }
    return {
      server: jupyterServerRegistry.status(workspace.workingDirectory),
      notebooks: notebookSessionRegistry.projectSummary(workspace.workingDirectory)
    }
  })
  ipcMain.handle('analysis:startJupyter', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    return jupyterServerRegistry.start(workspace.workingDirectory)
  })
  ipcMain.handle('analysis:stopJupyter', async (_, cwd: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    await notebookSessionRegistry.closeProject(workspace.workingDirectory)
    notebookFileWatcher.unwatchProject(workspace.workingDirectory)
    return jupyterServerRegistry.stop(workspace.workingDirectory)
  })
  ipcMain.handle(
    'analysis:notebookSessionStatus',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
      return notebookSessionRegistry.status({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: detectConfiguredAnalysisKernels()
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
      const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
      return notebookSessionRegistry.ensureSession({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: detectConfiguredAnalysisKernels()
      })
    }
  )
  ipcMain.handle('analysis:closeNotebookSession', async (_, cwd: string, notebookPath: string) => {
    const workspace = resolveAnalysisWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
    return notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
  })
  ipcMain.handle(
    'analysis:interruptNotebookExecution',
    async (_, cwd: string, notebookPath: string) => {
      const workspace = resolveAnalysisWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
      return notebookSessionRegistry.interruptSession(workspace.workingDirectory, file.path)
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
      const file = openProjectNotebook(workspace.workingDirectory, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      const cursorPosition = Number.isFinite(input.cursorPosition)
        ? Math.max(0, Math.min(input.cursorPosition, input.source.length))
        : 0
      if (!cell || cell.cellType !== 'code') {
        return emptyNotebookCompletionResult(cursorPosition, 'Notebook cell is not a code cell')
      }

      const staticCompletion = isPythonNotebookDocument(input.document)
        ? completeNotebookPythonStaticCompletion({
            projectCwd: workspace.workingDirectory,
            source: input.source,
            cursorPosition
          })
        : null
      const target = notebookSessionRegistry.executionTarget(workspace.workingDirectory, file.path)
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
      openProjectNotebook(workspace.workingDirectory, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      if (!cell || cell.cellType !== 'code') {
        return {
          source: input.source,
          changed: false,
          formatter: 'none' as const,
          message: 'Notebook cell is not a code cell'
        }
      }

      return formatNotebookCellSource({
        projectCwd: workspace.workingDirectory,
        source: input.source,
        language: input.language,
        lineLength: input.lineLength
      })
    }
  )
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
      const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
      const kernels = detectConfiguredAnalysisKernels()
      let sessionStatus = await notebookSessionRegistry.ensureSession({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels
      })
      let target = notebookSessionRegistry.executionTarget(workspace.workingDirectory, file.path)
      if (!target) {
        await ensureJupyterServerReady(workspace.workingDirectory)
        sessionStatus = await notebookSessionRegistry.ensureSession({
          projectCwd: workspace.workingDirectory,
          notebookPath: file.path,
          document,
          kernels
        })
        target = notebookSessionRegistry.executionTarget(workspace.workingDirectory, file.path)
      }
      if (!target) {
        throw new Error(sessionStatus.message ?? '请先连接 notebook kernel')
      }

      const cell = document.cells.find((item) => item.id === cellId)
      if (!cell) {
        throw new Error(`Notebook cell not found: ${cellId}`)
      }

      notebookSessionRegistry.updateSessionState(
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
        notebookToolExecutor.syncDraft({
          cwd: workspace.workingDirectory,
          path: file.path,
          document: nextDocument,
          source: 'renderer'
        })
        const nextSessionStatus =
          notebookSessionRegistry.updateSessionState(
            workspace.workingDirectory,
            file.path,
            execution.state === 'error' ? 'error' : 'idle',
            execution.state === 'error' ? 'Cell 执行出错' : 'Cell 执行完成'
          ) ?? sessionStatus
        return {
          ...execution,
          document: nextDocument,
          sessionStatus: nextSessionStatus
        }
      } catch (error) {
        notebookSessionRegistry.updateSessionState(
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

  ipcMain.handle('plugins:list', async () => listPlugins())
  ipcMain.handle('plugins:install', async (_, source: string) => {
    try {
      const list = await installDeveloperPlugin(source)
      writeAppLog({ event: 'plugin_installed', metadata: { source } })
      await invalidateAgentSession()
      return list
    } catch (error) {
      rememberErrorSummary(error)
      writeAppLog({
        level: 'error',
        event: 'plugin_install_failed',
        metadata: { source, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })
  ipcMain.handle('plugins:remove', async (_, source: string) => {
    try {
      const list = await removePlugin(source)
      writeAppLog({ event: 'plugin_removed', metadata: { source } })
      await invalidateAgentSession()
      return list
    } catch (error) {
      rememberErrorSummary(error)
      writeAppLog({
        level: 'error',
        event: 'plugin_remove_failed',
        metadata: { source, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })
  ipcMain.handle('phiPlugins:list', async () => phiPluginListItems())
  ipcMain.handle('phiPlugins:pickDirectory', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择 Phi 插件目录',
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
          phiPluginProblemView({ level: 'error', path: 'path', message: '请选择有效的插件目录' })
        ]
      } satisfies PhiPluginInstallPreview
    }
    try {
      return phiPluginInstallPreview(path)
    } catch (error) {
      rememberErrorSummary(error)
      return {
        ok: false,
        path,
        problems: [
          phiPluginProblemView({
            level: 'error',
            path: 'preview',
            message: `插件检查失败：${error instanceof Error ? error.message : String(error)}`
          })
        ]
      } satisfies PhiPluginInstallPreview
    }
  })
  ipcMain.handle('phiPlugins:installFromDirectory', async (_, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return failedPhiPluginMutation('path', '请选择有效的插件目录')
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
          `已安装 ${existing.id} ${existing.version}；请选择更高版本进行升级`
        )
      }
      if (result.ok) await invalidateAgentSession()
      return phiPluginMutation(result)
    } catch (error) {
      rememberErrorSummary(error)
      return failedPhiPluginMutation(
        'install',
        `插件安装失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('phiPlugins:setEnabled', async (_, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || typeof enabled !== 'boolean') {
      return failedPhiPluginMutation('request', '插件标识或启用状态无效')
    }
    try {
      const result = setPluginEnabled(id, enabled, {
        agentDir: AGENT_DIR,
        names: await installedPluginNamespace()
      })
      return phiPluginMutation(result)
    } catch (error) {
      rememberErrorSummary(error)
      return failedPhiPluginMutation(
        'enabled',
        `插件状态更新失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('phiPlugins:uninstall', async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      return failedPhiPluginMutation('id', '插件标识无效')
    }
    try {
      const result = uninstallPhiPlugin(id, {
        agentDir: AGENT_DIR,
        runtimeRoot: getRuntimeRoot()
      })
      if (result.ok) await invalidateAgentSession()
      return phiPluginMutation(result)
    } catch (error) {
      rememberErrorSummary(error)
      return failedPhiPluginMutation(
        'uninstall',
        `插件卸载失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('packages:pickRegistryDirectory', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择本地技能目录',
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('packages:pickArchive', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入软件包',
      properties: ['openFile'],
      filters: [{ name: 'Phi 软件包', extensions: ['tar.gz'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('packages:listRegistries', async () => {
    const result = listKnownRegistries({ agentDir: AGENT_DIR })
    if (result.error) {
      writeAppLog({
        level: 'warn',
        event: 'package_registries_invalid',
        metadata: { error: result.error }
      })
    }
    return result.registries
  })
  ipcMain.handle('packages:removeRegistry', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('软件源标识无效')
    removeKnownRegistry(id, { agentDir: AGENT_DIR })
    return listKnownRegistries({ agentDir: AGENT_DIR }).registries
  })
  ipcMain.handle('packages:registry', async (_, dir: unknown) => {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new Error('注册表目录无效')
    }
    try {
      const registry = readPackageRegistry(dir)
      addKnownRegistry(registry.dir, { agentDir: AGENT_DIR })
      return registry
    } catch (error) {
      throw new Error(
        `读取软件包注册表失败：${error instanceof Error ? error.message : String(error)}`
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
        throw new Error('软件包安装计划参数无效')
      }
      try {
        const registry = readPackageRegistry(dir)
        addKnownRegistry(registry.dir, { agentDir: AGENT_DIR })
        return planRegistryInstall(
          registry,
          { type, id, ...(version ? { version } : {}) },
          { agentDir: AGENT_DIR, appVersion: app.getVersion() }
        )
      } catch (error) {
        throw new Error(
          `生成软件包安装计划失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )
  ipcMain.handle(
    'packages:install',
    async (_, dir: unknown, type: unknown, id: unknown, version?: unknown) => {
      if (
        typeof dir !== 'string' ||
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0 ||
        (version !== undefined && typeof version !== 'string')
      ) {
        throw new Error('软件包安装参数无效')
      }
      try {
        const registry = readPackageRegistry(dir)
        addKnownRegistry(registry.dir, { agentDir: AGENT_DIR })
        const installedBefore = new Set(
          listRegistryPackages({ agentDir: AGENT_DIR }).map((item) => `${item.type}:${item.id}`)
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
        throw new Error(`安装软件包失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  )
  ipcMain.handle('packages:uninstall', async (_, type: unknown, id: unknown) => {
    if (
      (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
      typeof id !== 'string' ||
      id.length === 0
    ) {
      throw new Error('软件包卸载参数无效')
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
      throw new Error(`卸载软件包失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ipcMain.handle('packages:listInstalled', async () => {
    try {
      return listRegistryPackages({ agentDir: AGENT_DIR })
    } catch (error) {
      throw new Error(
        `读取已安装软件包失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('packages:previewImport', async (_, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('离线软件包路径无效')
    try {
      return previewOfflinePackageImport(path, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        registries: loadPackageRegistries().registries
      })
    } catch (error) {
      throw new Error(
        `读取离线软件包失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
  ipcMain.handle('packages:import', async (_, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('离线软件包路径无效')
    const installedBefore = new Set(
      listRegistryPackages({ agentDir: AGENT_DIR }).map((item) => `${item.type}:${item.id}`)
    )
    try {
      const result = await importOfflinePackage(path, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        runtimeRoot: getRuntimeRoot(),
        registries: loadPackageRegistries().registries,
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
        if (!installedBefore.has(`${installed.type}:${installed.id}`) && installed.type === 'mcp') {
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
      throw new Error(`导入软件包失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ipcMain.handle('packages:listUpdates', async () =>
    packageUpdateViews(refreshCachedPackageUpdates())
  )
  ipcMain.handle('packages:applyUpdate', async (_, type: unknown, id: unknown) => {
    if (
      (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
      typeof id !== 'string' ||
      id.length === 0
    ) {
      throw new Error('软件包更新参数无效')
    }
    const loaded = loadPackageRegistries()
    const updates = listPackageUpdates(loaded.registries, {
      agentDir: AGENT_DIR,
      appVersion: app.getVersion()
    })
    const update = updates.find((candidate) => candidate.type === type && candidate.id === id)
    if (!update) throw new Error(`没有可用更新：${type}:${id}`)
    const result = await applyPackageUpdate(update, loaded.registries, {
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
  ipcMain.handle('packages:applyAllUpdates', async () => {
    const loaded = loadPackageRegistries()
    const updates = listPackageUpdates(loaded.registries, {
      agentDir: AGENT_DIR,
      appVersion: app.getVersion()
    })
    const result = await applyPackageUpdates(updates, loaded.registries, {
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
  ipcMain.handle('enablement:get', async (_, projectCwd?: unknown) => {
    if (projectCwd !== undefined && typeof projectCwd !== 'string') {
      throw new Error('项目目录无效')
    }
    if (typeof projectCwd === 'string' && isRemoteResourceScope(projectCwd)) {
      throw new Error('远程项目 Skills 暂不可用')
    }
    return getEnablementSnapshot({
      agentDir: AGENT_DIR,
      ...(typeof projectCwd === 'string' && projectCwd.length > 0 ? { projectDir: projectCwd } : {})
    })
  })
  ipcMain.handle('enablement:set', async (_, item: unknown, value: unknown, scope: unknown) => {
    if (!isEnablementItemKey(item)) throw new Error('启用项目标识无效')
    if (typeof value !== 'boolean' && value !== null) throw new Error('启用值无效')
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
          result.errors.map((problem) => problem.message).join('; ') || '插件启用状态无效'
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
  ipcMain.handle('skills:list', async (_, cwd?: string) => {
    const remote = isRemoteResourceScope(cwd)
    const skills = remote ? await listGlobalSkills() : await listSkills(cwd ?? currentCwd)
    return filterOfficeSkillForAvailability(
      skills,
      officeAvailabilityCache.get().enabled && !remote
    )
  })
  ipcMain.handle('skills:read', async (_, filePath: string, cwd?: string) => {
    if (isRemoteResourceScope(cwd)) {
      return readGlobalSkillContent(filePath)
    }
    return readSkillContent(filePath, cwd ?? currentCwd)
  })
  ipcMain.handle(
    'skills:setDisabled',
    async (_, filePath: string, disabled: boolean, cwd?: string) => {
      if (isRemoteResourceScope(cwd)) {
        throw new Error('远程项目 Skills 暂不可用')
      }
      return filterOfficeSkillForAvailability(
        await setSkillDisabled(filePath, Boolean(disabled), cwd ?? currentCwd),
        officeAvailabilityCache.get().enabled
      )
    }
  )
  ipcMain.handle('skills:delete', async (_, filePath: string, cwd?: string) => {
    if (isRemoteResourceScope(cwd)) {
      throw new Error('远程项目 Skills 暂不可用')
    }
    return filterOfficeSkillForAvailability(
      await deleteSkill(filePath, cwd ?? currentCwd),
      officeAvailabilityCache.get().enabled
    )
  })
  ipcMain.handle('agents:list', async (_, cwd?: string) =>
    isRemoteResourceScope(cwd) ? [] : listPromptAgents(cwd ?? currentCwd)
  )
  const connectorCatalog = (): ReturnType<typeof listConnectorCatalog> =>
    listConnectorCatalog({
      agentDir: AGENT_DIR,
      appVersion: app.getVersion(),
      runtimeRoot: getRuntimeRoot(),
      registryDirs: loadPackageRegistries().registries.map((registry) => registry.dir)
    })
  ipcMain.handle('mcp:listServers', async (_, cwd?: string) => {
    const servers = await (isRemoteResourceScope(cwd)
      ? listGlobalMcpServers()
      : listMcpServers(cwd ?? currentCwd))
    const catalog = connectorCatalog()
    return servers.map((server) => {
      const connector = catalog.find(
        (entry) =>
          entry.id === server.packageId || (server.url !== undefined && entry.url === server.url)
      )
      return connector
        ? {
            ...server,
            connectorId: connector.id,
            category: connector.category,
            title: connector.name
          }
        : server
    })
  })
  ipcMain.handle('mcp:listConnectorCatalog', async () => connectorCatalog())
  ipcMain.handle(
    'mcp:installConnector',
    async (_, id: unknown, version?: unknown, registryDir?: unknown) => {
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        (version !== undefined && typeof version !== 'string') ||
        (registryDir !== undefined && typeof registryDir !== 'string')
      ) {
        throw new Error('连接器安装参数无效')
      }
      const connector = connectorCatalog().find(
        (entry) =>
          entry.id === id &&
          (version === undefined || entry.version === version) &&
          (registryDir === undefined || entry.registryDir === registryDir)
      )
      if (!connector?.registryDir) throw new Error(`连接器目录中找不到 ${id}`)
      if (connector.unavailableReason) throw new Error(connector.unavailableReason)
      const result = await installCatalogConnector(
        connector.registryDir,
        connector.id,
        connector.version,
        {
          agentDir: AGENT_DIR,
          appVersion: app.getVersion(),
          runtimeRoot: getRuntimeRoot()
        }
      )
      setEnabled(`mcp:${connector.id}`, true, { agentDir: AGENT_DIR })
      setMcpPackageEnabled(connector.id, true, AGENT_DIR)
      await invalidateAgentSession()
      return result
    }
  )
  ipcMain.handle('mcp:uninstallConnector', async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('连接器标识无效')
    const result = uninstallCatalogConnector(id, {
      agentDir: AGENT_DIR,
      runtimeRoot: getRuntimeRoot()
    })
    setEnabled(`mcp:${id}`, null, { agentDir: AGENT_DIR })
    await invalidateAgentSession()
    return result
  })
  ipcMain.handle('mcp:buildConnectorEnvironment', async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('连接器标识无效')
    const action = connectorEnvironmentBuildAction(id, {
      agentDir: AGENT_DIR
    })
    const handle = await environmentBuilds.start(action.descriptor, action.options)
    const refreshed = refreshPersistedManagedStdioServers({
      agentDir: AGENT_DIR,
      runtimeRoot: getRuntimeRoot()
    })
    const failure = refreshed.failures.find((entry) => entry.name === id)
    if (failure) throw failure.error
    return { envId: handle.envId }
  })
  ipcMain.handle('mcp:addRemoteConnector', async (_, name: string, url: string) => {
    addRemoteMcpConnector(name, url)
    await syncFeaturedMcpApiKeySessions(name)
  })
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
      setMcpConnectorEnabled(
        name,
        Boolean(enabled),
        typeof sourcePath === 'string' ? sourcePath : undefined
      )
      try {
        await getOmpBridge().request('mcp.applyConnectorEnabled', { name })
      } catch (error) {
        if (!API_KEY_CONNECTOR_IDS.some((id) => id === name)) throw error
        writeAppLog({ event: 'mcp_api_key_session_sync_failed', metadata: { connectorId: name } })
        await getOmpBridge().stop()
        throw new Error('本地修改已保存，但运行中的会话同步失败并已停止；请重新打开对话后重试')
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
    if (typeof id !== 'string') throw new Error('连接器标识无效')
    const connector = connectorCatalog().find((entry) => entry.id === id)
    if (!connector?.url) throw new Error('连接器目录中找不到远程连接器')
    return getOmpBridge().request<string[]>('mcp.featuredTools', {
      id,
      url: connector.url,
      auth: connector.auth
    })
  })
  ipcMain.handle('mcp:featuredAuthStatus', async (_, id: string) => {
    const connector = connectorCatalog().find((entry) => entry.id === id)
    if (!connector?.url || !mcpOAuthAuthorizationOrigin(id, connector.url)) {
      throw new Error('该连接器尚不支持登录状态查询')
    }
    return getOmpBridge().request<boolean>('mcp.featuredAuthStatus', { id, url: connector.url })
  })
  ipcMain.handle('mcp:authorizeFeatured', async (_, id: string) => {
    const connector = connectorCatalog().find((entry) => entry.id === id)
    if (!connector?.url || !mcpOAuthAuthorizationOrigin(id, connector.url)) {
      throw new Error('该连接器尚不支持 OAuth 授权')
    }
    await getOmpBridge().request('mcp.authorizeFeatured', { id, url: connector.url })
  })
  ipcMain.handle('mcp:cancelFeaturedAuth', async (_, id: string) => {
    if (typeof id !== 'string' || !id) return
    await getOmpBridge().request('mcp.cancelFeaturedAuth', { id })
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
      throw new Error('Wrapper 目标变更请求无效')
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
          throw new Error('计划目标快照无效，请重新创建计划。')
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
          throw new Error('计划执行目标已变化，请刷新计划卡后重新确认。')
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
          throw new Error('远程项目只能提交绑定本项目服务器的 Wrapper 计划；不会在本机执行')
        }
      }
      if (selected?.target === 'remote' && selected.projectLocation.kind === 'ssh') {
        const current = listProjects().find((project) => project.id === selected.projectId)
        if (current?.remoteConnection?.phase !== 'reachable') {
          throw new Error(
            current?.remoteConnection?.message ?? '服务器连接尚未就绪，请重连后再提交。'
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
        rememberErrorSummary(error)
        throw error
      }
    }
  )
  ipcMain.handle('wrappers:cancelPlan', async (_, planId: string) => {
    try {
      return cancelWrapperRunPlan(planId)
    } catch (error) {
      rememberErrorSummary(error)
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
      rememberErrorSummary(error)
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
      rememberErrorSummary(error)
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
      const options: Electron.SaveDialogOptions = {
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
      rememberErrorSummary(error)
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

    let markdown: string
    try {
      markdown = await generatePersonaMarkdown(trimmedDescription)
    } catch (error) {
      rememberErrorSummary(error)
      console.error('生成人设配置失败，回退为原始描述:', error)
      markdown = fallbackMarkdownFromDescription(trimmedDescription)
    }

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
    cleanup: cleanupMainWindowRuntime,
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
