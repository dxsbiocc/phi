import { IPC } from '../shared/ipcChannels'
import {
  registerRuntimeSessionOrigin,
  resolveRuntimeSessionOrigin
} from './agent/session/runtime-origin-store'
import type { AgentRunFinishedEvent } from '../shared/agentRunNotice'
import type {
  PhiAgentEvent,
  PhiAgentEventSummary,
  RuntimeSelectionControl
} from './agent/engine/types'
import type {
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryIssue
} from '../shared/runtimeRecoveryTypes'
import { readRuntimeRecoverySummarySeed } from './agent/session/recovery-summary'
import {
  parseRuntimeReference,
  assertRuntimeReferenceProject,
  assertRuntimeScope
} from './agent/session/runtime-reference'
import { facadeBindingHash } from './agent/engine/rpc/facade-session-driver'
import { selectionThinking } from './agent/engine/rpc/runtime-selection-control'
import { isPhiEventType, isPhiMessageUpdateSummary } from './agent/engine/events'
import type { WrapperRunFinishedEvent } from '../shared/wrapperRunNotice'
import { shouldBlockHtmlReportNavigation } from '../shared/htmlReportPreview'
import {
  installNotebookOutputProtocol,
  registerNotebookOutputScheme
} from './agent/notebook/notebook-output-protocol'
import type { WrapperRun } from '../shared/wrapperTypes'
import './agent-env'
import { createMainWindowStartup } from './window-startup'
import { registerWorkspaceFileIpc } from './workspace-file-ipc'
import { registerAnalysisIpc } from './ipc/analysis-ipc'
import { registerGithubSourceIpc } from './ipc/github-sources-ipc'
import {
  registerPackageCatalogIpc,
  registerPackageOperationsIpc,
  registerResourceCatalogIpc
} from './ipc/packages-ipc'
import { registerPhiPluginIpc } from './ipc/phi-plugins-ipc'
import { registerSkillsIpc } from './ipc/skills-ipc'
import { registerMcpIpc, type PendingCustomMcpAuthorization } from './ipc/mcp-ipc'
import { registerEnvironmentBuildsIpc } from './ipc/environment-builds-ipc'
import { registerJobsIpc } from './ipc/jobs-ipc'
import {
  registerWrapperInputUploadIpc,
  registerWrapperPlanIpc,
  registerWrapperRunIpc
} from './ipc/wrappers-ipc'
import { registerWrapperResultsIpc, type WrapperResultDownloads } from './ipc/wrapper-results-ipc'
import {
  registerRemoteProjectUploadControlIpc,
  registerRemoteProjectUploadListIpc,
  registerRemoteProjectUploadPreparationIpc
} from './ipc/remote-project-uploads-ipc'
import { registerRemoteWorkspaceIpc } from './ipc/remote-workspace-ipc'
import { registerRemoteIpc } from './ipc/remote-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import {
  registerAgentInteractionIpc,
  registerAgentPromptIpc,
  registerAgentRunControlIpc,
  type AgentIpcOptions
} from './ipc/agent-ipc'
import { registerAgentsIpc } from './ipc/agents-ipc'
import { registerModelsIpc } from './ipc/models-ipc'
import { registerThinkingIpc } from './ipc/thinking-ipc'
import { registerToolIpc } from './ipc/tool-ipc'
import { registerSessionsIpc } from './ipc/sessions-ipc'
import { registerSystemIpc } from './ipc/system-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerMenuBarIpc } from './ipc/menu-bar-ipc'
import {
  registerFileBrowsingIpc,
  registerFileOpenIpc,
  registerFilePickerIpc,
  registerFilePreviewIpc,
  type FilesIpcOptions
} from './ipc/files-ipc'
import { registerWebLinkIpc } from './ipc/web-link-ipc'
import { registerRemoteJupyterJobsIpc } from './ipc/remote-jupyter-jobs-ipc'
import { registerMoleculesIpc } from './ipc/molecules-ipc'
import { registerWorkspaceChangesIpc } from './ipc/workspace-changes-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerAppIpc } from './ipc/app-ipc'
import { registerSettingsIpc } from './ipc/settings-ipc'
import { registerEnvironmentIpc } from './ipc/environment-ipc'
import { registerManagedEnvironmentsIpc } from './ipc/managed-environments-ipc'
import { registerPersonaIpc } from './ipc/persona-ipc'
import {
  registerProjectsIpc,
  registerProjectsRemoteHostsIpc,
  registerProjectsSessionsIpc,
  type ProjectsIpcOptions
} from './ipc/projects-ipc'
import { nativeUiCopy } from './native-ui-copy'
import { createStartupSplashWindow, dismissStartupSplashWindow } from './startup-splash'
import { createMacMenuBar } from './menu-bar'
import type { MenuBarAction } from '../shared/menuBarTypes'
import type { IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
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
import type { BrowserActionApprovalPrompt } from './browser/browser-approval'
import { BrowserToolHostCoordinator } from './agent/browser/browser-tool-host'
import { TerminalIpcCoordinator, registerTerminalRendererIpc } from './terminal/terminal-ipc'
import { TerminalDraftService } from './terminal/terminal-command-draft'
import { buildTerminalDraftSessionFactory } from './terminal/terminal-draft-session'
import { TerminalManager } from './terminal/terminal-manager'
import { resolveTerminalWorkspace } from './terminal/terminal-workspace'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createAgentSession } from './agent/session/session-manager'
import type { ThinkingLevel } from './agent/runtime/model-thinking-levels'
import {
  alignCurrentSessionToPromptTarget,
  parsePromptTarget,
  type PromptTargetInput,
  type PromptTargetControlOptions
} from './agent/session/prompt-target-control'
import {
  getCurrentContextUsage,
  getCurrentSessionPayloadWithMessages,
  type CurrentContextUsageOptions,
  type CurrentSessionPayload,
  type CurrentSessionPayloadMessagesOptions
} from './agent/session/current-session-reads'
import {
  compactCurrentSession,
  getCurrentAutoCompactionSettings,
  setCurrentAutoCompactionSettings,
  type SessionCompactionControlOptions
} from './agent/session/session-compaction-control'
import { getAuthManager } from './agent/auth-manager'
import { getPersonaMarkdown } from './agent/persona-manager'
import { generatePersonaMarkdown as generatePersonaMarkdownForIpc } from './agent/persona-generation'
import {
  createSessionManager,
  isPhiOnlySessionPath,
  phiOnlySessionPath,
  phiSessionIdFromPath,
  renameSession
} from './agent/session/sessions'
import {
  assertProjectPathAvailable,
  getProject,
  getProjectByCwd,
  listProjects,
  subscribeRemoteProjectConnection,
  type PermissionMode,
  type ModelSelection,
  type Project
} from './agent/projects'
import { isPathInsideRoot } from './agent/local-file-access'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './agent/remote-hosts'
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
import { createSkippedMcpNotifier } from './agent/mcp/skipped-notice'
import { createDesktopMcpAdapter } from './agent/engine/rpc/desktop-mcp-adapter'
import { RemoteLibraryService } from './agent/engine/rpc/remote-library-service'
import { resolveRemoteBaseEnvironment } from './agent/remote-runtime/base-environment'
import { resolveProjectRuntimeRoot } from './agent/remote-runtime/project-runtime-root'
import {
  openRemoteRuntimeWorkspace,
  type RemoteRuntimeTarget
} from './agent/remote-runtime/workspace'
import { remoteDoctor } from './agent/remote-doctor'
import { createCursorH2Bridge } from './agent/cursor-h2-bridge'
import { RemoteProjectConnectionTracker } from './agent/remote-project-connection'
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
import type { ProjectLocation } from '../shared/projectLocation'
import {
  bashApprovalDigest,
  editApprovalDigest,
  cancelToolApprovals,
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
  type RemoteProjectSkillCatalog,
  type RemoteProjectSkillContext
} from './agent/content/remote-project-skill-service'
import {
  loadRemoteProjectMcpCatalog,
  type RemoteProjectMcpCatalog
} from './agent/mcp/remote-project-mcp-service'
import { getRuntimeRoot } from './agent/envs/runtime'
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
  getBundledAgentsDir,
  openRuntimeSessionManager,
  type Skill as RuntimeSkill,
  type ModelRuntime,
  type RuntimeModel
} from './agent/runtime/runtime-adapter'
import { loadedPlugins, type PluginNamespace } from './agent/plugins/loader'
import { readPluginRegistry, writePluginRegistry } from './agent/plugins/store'
import { getEnablementSnapshot, migrateEnablementFromHistory, setEnabled } from './agent/enablement'
import {
  cleanupStalePackageStaging,
  listPackageUpdates,
  loadKnownRegistryIndexes,
  type PackageUpdate
} from './agent/packages/installer'
import { prepareContentPackageInstall } from './agent/packages/content-source'
import type { InstallerOptions } from './agent/packages/installer-types'
import type { PackageType } from './agent/packages/manifest'
import { syncPreferredOfficialRegistry } from './agent/packages/official-website-registry'
import { syncOfficialConnectorRegistry } from './agent/packages/official-connector-registry'
import {
  listConnectorCatalog,
  mcpOAuthAuthorizationOrigin,
  readCustomRemoteMcpConnector,
  refreshPersistedManagedStdioServers
} from './agent/mcp-connectors'
import {
  apiKeyConnector,
  isFeaturedMcpApiKeyInstalled,
  readFeaturedMcpApiKey
} from './agent/mcp-key-credentials'
import { validateSkill } from './agent/content/skill'
import {
  listGlobalMcpServers,
  listGlobalSkills,
  listSkills,
  readGlobalSkillContent
} from './agent/resources'
import { migrateLegacyCustomWrappers } from './agent/wrappers/catalog'
import { resetWrapperCompositionCatalogCache } from './agent/wrappers/composition/discovery'
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
import { createWrapperResultReadControl } from './agent/wrappers/remote-result-read-control'
import { discoverPhiAgents, type PhiAgentDiscoveryResult } from './agent/agents/discovery'
import { loadRemoteAgentCatalog } from './agent/agents/remote-agent-service'
import { BackgroundAgentApprovalTracker } from './agent/agents/background-approval'
import {
  assembleSessionCreationResources,
  createSessionCreationResourceLookup,
  discoverLocalSessionCreationAgents,
  emptySessionCreationAgentScan,
  loadRemoteSessionCreationAgents,
  loadRemoteSessionCreationMcp,
  loadRemoteSessionCreationSkills,
  sessionCreationAgentDiagnosticLog,
  type SessionCreationResources
} from './agent/session/session-creation-resources'
import {
  createSessionCreationApprovalDependencies,
  createSessionCreationExtensionFactories
} from './agent/session/session-creation-approvals'
import {
  resolveSessionCreationModel,
  type SessionCreationModelResolution
} from './agent/session/session-creation-model'
import {
  buildSessionCreationOptions,
  type SessionCreationOptions
} from './agent/session/session-creation-options'
import {
  resolveSessionCreationOwnership,
  SessionCreationContext,
  type SessionCreationContextDependencies
} from './agent/session/session-creation-context'
import {
  continuationPrompt,
  shouldContinueAfterAgentRun,
  type ContinuationEvent
} from './agent/agents/run-continue'
import { agentRunHostHandlers } from './agent/agents/run-host'
import { connectRemoteSshSession } from './agent/wrappers/remote-ssh-session'
import { readWrapperRun } from './agent/wrappers/store'
import { listBackgroundAgentJobs } from './agent/jobs/background-agent-job-listing'
import {
  listBackgroundShellJobs,
  stopBackgroundShellJob
} from './agent/jobs/background-shell-job-operations'
import { cleanupOldLogs, writeAppLog } from './agent/app-logger'
import {
  configureSystemUiLanguage,
  readAppSettings,
  readLastSelectedModel,
  writeLastSelectedModel
} from './agent/app-settings'
import { isSecretMetadataKey, redactSensitiveText } from './agent/redaction'
import { listProjectNotebooks } from './agent/notebook/analysis-notebooks'
import { AnalysisNotebookFileWatcher } from './agent/notebook/analysis-notebook-watch'
import { getCustomToolPath } from './agent/environment'
import { createBackgroundEnvironment } from './agent/environment/background'
import { JupyterServerRegistry } from './agent/notebook/analysis-jupyter-server'
import { AnalysisNotebookExecutor } from './agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from './agent/notebook/analysis-jupyter-sessions'
import { AnalysisNotebookToolExecutor } from './agent/notebook/notebook-tool-executor'
import {
  createRemoteAnalysisNotebookBackend,
  type RemoteAnalysisNotebookBackend
} from './agent/notebook/remote-analysis-notebook-backend'
import {
  AnalysisNotebookOperations,
  type AnalysisWorkspaceContext
} from './agent/notebook/analysis-notebook-operations'
import { AnalysisNotebookCodeGenerator } from './agent/notebook/analysis-notebook-code-generator'
import { NotebookToolHostRouter } from './agent/notebook/notebook-tool-host-router'
import { getPhiEngine, ownsRemoteRuntimeSession } from './agent/engine/in-process-engine'
import {
  installAppRemoteSessionRouting,
  createAppRemoteSessionManager,
  type AppRemoteSessionRoutingOptions
} from './agent/remote-session-routing'
import { RemoteJupyterStartJobs } from './agent/notebook/remote-jupyter-start-jobs'
import { normalizeProjectMemorySettings } from '../shared/projectMemoryTypes'
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
import {
  executePromptRun as executePromptRunWithDeps,
  type PromptRunExecutionDeps,
  type PromptRunResult
} from './agent/session/prompt-run-execution'
import {
  persistSessionEvent as persistSessionEventWithDeps,
  type SessionEventPersistenceDeps
} from './agent/session/session-event-persistence'
import {
  beginWorkspaceChangeCapture,
  finishWorkspaceChangeCapture
} from './agent/session/workspace-changes'
import { persistWorkspaceDiff } from './agent/session/workspace-diffs'
import { createLocalFileAccessControl } from './local-file-access-control'
import { createLocalFileIcons } from './local-file-icons'
import { createLocalFilePreviews } from './local-file-previews'
import { SessionTitleGenerator } from './agent/session/session-title-generation'
import { persistPromptImages } from './agent/session/prompt-images'
import type { PromptImageInput } from '../shared/promptImageTypes'
import {
  appendSessionEvent,
  createPhiSession,
  createRunId,
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  persistToolOutput,
  readSessionEvents,
  recoverInterruptedPhiSessions,
  updateSessionManifest,
  type PhiSessionManifest,
  listPhiSessions,
  type StoredSessionEvent
} from './agent/session/session-store'
import type { NotebookDocument } from '../shared/notebookDocument'
import { messageContentTitleText } from '../shared/sessionTitle'
import type { AgentUserInteractionQuestion } from '../shared/agentInteractionTypes'
import { createBeforeQuitHandler } from './app-quit'
import { createMainRuntimeContext } from './app-state/main-runtime-context'
import icon from '../../resources/icon.png?asset'

import { isRecord } from '../shared/guards'
import { errorMessage } from '../shared/errorCodes'
// Compatibility boundary: Electron derives userData and macOS "Phi Safe Storage" from this name.
const APP_NAME = 'Phi'
const APP_QUIT_CLEANUP_TIMEOUT_MS = 2_000
const APP_ID = 'cn.phiscience.phi'
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 860
const MIN_WINDOW_HEIGHT = 560
const appIcon = nativeImage.createFromPath(icon)

// Set by agent-env.ts before this module's own top-level code runs.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR as string

app.setName(APP_NAME)

function applyDockIcon(): void {
  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon)
  }
}

const mainWindowStartups = new WeakMap<BrowserWindow, ReturnType<typeof createMainWindowStartup>>()

function showMainWindowFromMenuBar(): void {
  const mainWindow = runtime.window.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const window = runtime.window.mainWindow
  if (!window || window.isDestroyed()) return
  const splash = runtime.window.startupSplashWindow
  if (splash && !splash.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

function queueMenuBarAction(action: MenuBarAction): void {
  runtime.window.queueMenuBarAction(action)
  showMainWindowFromMenuBar()
}

function hideMainWindowFromMenuBar(): void {
  const mainWindow = runtime.window.mainWindow
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
}

function requireMainWindowRenderer(event: IpcMainInvokeEvent): BrowserWindow {
  const window = runtime.window.mainWindow
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

function finishStartupSplash(window: BrowserWindow | null): void {
  const splash = runtime.window.takeStartupSplashWindow()
  if (!window) {
    if (splash && !splash.isDestroyed()) splash.close()
    return
  }
  dismissStartupSplashWindow(splash, window)
}

function sendMainWindowFullscreenState(window: BrowserWindow, fullscreen: boolean): void {
  if (
    runtime.window.mainWindow !== window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return
  }
  window.webContents.send(IPC.window.fullscreenChanged, fullscreen)
}
const browserCheckpointStore = new FileSystemBrowserCheckpointStore({ agentDir: AGENT_DIR })

function browserPolicyContext(): { applicationOrigins?: string[] } {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  return rendererUrl ? { applicationOrigins: [rendererUrl] } : {}
}

function getBrowserWorkspaceRegistry(): BrowserWorkspaceRegistry {
  if (
    runtime.window.cleanupStarted ||
    runtime.workspaceServices.browserWorkspaceRegistryLifecycle !== 'idle'
  ) {
    throw new Error('Browser workspace is unavailable')
  }
  let registry = runtime.workspaceServices.browserWorkspaceRegistry
  if (!registry) {
    registry = new BrowserWorkspaceRegistry({
      engineFactory: () =>
        new ElectronBrowserEngine({
          WebContentsView,
          getOwningWindow: () => {
            const window = runtime.window.mainWindow
            return window && !window.isDestroyed() ? window : null
          },
          policyContext: browserPolicyContext()
        }),
      policyContext: browserPolicyContext(),
      checkpointStore: browserCheckpointStore,
      openExternal: (url) => shell.openExternal(url),
      approveAgentAction: requestBrowserActionApproval
    })
    runtime.workspaceServices.setBrowserWorkspaceRegistry(registry)
    const current = getCurrentSessionPayload()
    void registry.setActiveSession(current.phiSessionId ?? null).catch(() => {
      writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
    })
  }
  return registry
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
      const window = runtime.window.mainWindow
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
      sendToAllWindows(IPC.tool.approvalCancelled, request.requestId)
    }
  })
}

function cleanupBrowserWorkspaceRegistry(): Promise<void> {
  const registry = runtime.workspaceServices.browserWorkspaceRegistry
  if (!registry) {
    return runtime.workspaceServices.browserWorkspaceRegistryDisposal ?? Promise.resolve()
  }
  if (runtime.workspaceServices.browserWorkspaceRegistryLifecycle !== 'idle') {
    return runtime.workspaceServices.browserWorkspaceRegistryDisposal ?? Promise.resolve()
  }
  runtime.workspaceServices.markBrowserWorkspaceRegistryDisposing()
  let disposal: Promise<void>
  try {
    disposal = registry.disposeAll()
  } catch {
    runtime.workspaceServices.markBrowserWorkspaceRegistryDisposalFailed()
    writeAppLog({ level: 'error', event: 'browser_registry_cleanup_failed' })
    return Promise.resolve()
  }
  runtime.workspaceServices.setBrowserWorkspaceRegistryDisposal(disposal)
  void disposal.then(
    () => {
      runtime.workspaceServices.completeBrowserWorkspaceRegistryDisposal(registry, disposal)
    },
    () => {
      if (!runtime.workspaceServices.failBrowserWorkspaceRegistryDisposal(registry, disposal))
        return
      writeAppLog({ level: 'error', event: 'browser_registry_cleanup_failed' })
    }
  )
  return disposal
}

function getTerminalManager(): TerminalManager {
  if (runtime.window.cleanupStarted) throw new Error('Terminal manager is unavailable')
  let manager = runtime.workspaceServices.terminalManager
  if (!manager) {
    manager = new TerminalManager({
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
          runtime.workspaceServices.terminalDraftService?.terminalClosed(event.snapshot.terminalId)
        }
        terminalIpcCoordinator.sendEvent(event)
      }
    })
    runtime.workspaceServices.setTerminalManager(manager)
  }
  return manager
}

function getTerminalDraftService(): TerminalDraftService {
  if (runtime.window.cleanupStarted) throw new Error('Terminal draft service is unavailable')
  let draftService = runtime.workspaceServices.terminalDraftService
  if (!draftService) {
    draftService = new TerminalDraftService({
      createSession: buildTerminalDraftSessionFactory({
        createAgentSession,
        createSessionManager: createInMemoryRuntimeSessionManager,
        resolveSession: async (context) => {
          const modelRuntime = await getAuthManager().getRuntime()
          const project = context.workspaceKey.startsWith('project:')
            ? getProject(context.workspaceKey.slice('project:'.length))
            : undefined
          const modelSelection = project?.defaultModel ?? sessionState.selectedModel
          const model = modelSelection
            ? resolveRuntimeModelSelection(modelRuntime, modelSelection)?.model
            : undefined
          return {
            modelRuntime,
            model,
            thinkingLevel: project?.defaultThinkingLevel ?? selectedThinkingLevel
          }
        }
      }),
      manager: getTerminalManager()
    })
    runtime.workspaceServices.setTerminalDraftService(draftService)
  }
  return draftService
}

async function disposeTerminalManager(): Promise<void> {
  const { draftService, manager } = runtime.workspaceServices.takeTerminalServices()
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
    const window = runtime.window.mainWindow
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
    const window = runtime.window.mainWindow
    return window && !window.isDestroyed() ? window.webContents : null
  }
})

// The desktop uses Chromium networking so the operating system's proxy settings also
// apply to catalog metadata and package archives. The transport remains usable in Node/tests.
const officialRegistryFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init)

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
      errors: [...loaded.errors, `Phi 官网其他模块：${errorMessage(error)}`]
    }
  }
}

function packageUpdateViews(updates: readonly PackageUpdate[]): PackageUpdate[] {
  return [...updates]
}

async function refreshCachedPackageUpdates(): Promise<PackageUpdate[]> {
  const loaded = await loadPackageRegistries()
  runtime.caches.replaceCachedPackageUpdates(
    listPackageUpdates(loaded.registries, {
      agentDir: AGENT_DIR,
      appVersion: app.getVersion()
    })
  )
  return runtime.caches.cachedPackageUpdates
}

function scheduleStartupPackageUpdateCheck(): void {
  setImmediate(async () => {
    try {
      const updates = await refreshCachedPackageUpdates()
      const mainWindow = runtime.window.mainWindow
      if (updates.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.packages.updatesAvailable, packageUpdateViews(updates))
      }
    } catch (error) {
      writeAppLog({
        level: 'warn',
        event: 'package_update_check_failed',
        metadata: { error: errorMessage(error) }
      })
    }
  })
}

const TOOL_OUTPUT_INLINE_LIMIT = 20000
const MAX_RUN_DIFF_BYTES = 2 * 1024 * 1024
const KIMI_CODE_REPLACEMENT_MODEL_IDS = [
  'kimi-for-coding',
  'k3',
  'k3-256k',
  'kimi-for-coding-highspeed'
] as const

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

const sessionLifecycles = new Map<string, SessionLifecycle<AgentSessionResult>>()
const sessionAbortControllers = new Map<string, AbortController>()
const cleanupBarriersByPath = new Map<string, Promise<void>>()
const unknownPathCleanupBarriers = new Set<Promise<void>>()

function getNoProjectTaskFolder(): string {
  return readAppSettings(AGENT_DIR).noProjectTaskFolder
}

function currentRemoteAnalysisProject(
  targetCwd: string
): { project: Project; sessionId: string } | null {
  const manifest = findPhiManifestForSession(
    sessionState.sessionKey,
    sessionState.sessionPath,
    sessionState.cwd
  )
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
  const targetCwd = cwd ?? sessionState.cwd
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

  const currentCwdRealPath = getProjectByCwd(sessionState.cwd)
    ? null
    : realDirectoryPath(sessionState.cwd)
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

// The session file currently active in the UI. undefined = a fresh, not-yet-persisted
// chat (nothing appended to it yet, so no file exists and it won't show in the sidebar
// until the first prompt). Distinct from invalidating the session object below: switching
// this is a user-visible "change conversation" action, while invalidation just rebuilds
// the in-memory AgentSession (e.g. after an auth/model/persona change) against whatever
// conversation was already active.
const initialFreshSessionCounter = 0
// Working directory for the active conversation. A plain "对话" (conversation) uses the
// user-configurable no-project task folder; a "项目" (project) uses its own folder and
// carries a permission mode gating bash/edit/write tool calls (see tool-approval.ts).
const initialSessionCwd = getNoProjectTaskFolder()
const initialSelectedModel = readLastSelectedModel()
// Default is deliberately 'high', not the SDK's own default of 'off': many models
// (e.g. DeepSeek V4 Pro) only enable reasoning output at 'high'/'max', and this app
// wants that reasoning visible in the UI out of the box rather than silently absent.
const selectedThinkingLevel: ThinkingLevel = 'high'
const runtime = createMainRuntimeContext({
  session: {
    freshSessionCounter: initialFreshSessionCounter,
    cwd: initialSessionCwd,
    selectedModel: initialSelectedModel,
    sessionKey: createSessionKey(undefined, initialSessionCwd, initialFreshSessionCounter)
  }
})
const { session: sessionState } = runtime
const promptQueues = new Map<string, Promise<void>>()
const promptGenerations = new Map<string, number>()
const activePromptRuns = new Map<string, PromptRun>()
const runtimeRecoveryOperations = new Map<
  string,
  { controller: AbortController; done: Promise<void> }
>()
const runtimeRecoveryFailures = new Map<string, RuntimeRecoveryIssue>()
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
const skippedMcpNotifier = createSkippedMcpNotifier({
  append: appendSessionEvent,
  readEvents: readSessionEvents,
  broadcast: broadcastSessionTimelineEvent
})
// Main-only internal migration gate; renderer session input cannot enable this route.
const remoteOmpRpcEnabled = process.env.PHI_REMOTE_OMP_RPC === '1'
installAppRemoteSessionRouting({
  enabled: remoteOmpRpcEnabled,
  ...(process.env.PHI_REMOTE_STARTUP_DIAGNOSTICS === '1'
    ? {
        startupDiagnostics: ({ phiSessionId, status, totalMs, steps }) =>
          writeAppLog({
            event: 'remote_session_startup_profile',
            sessionId: phiSessionId,
            metadata: { status, totalMs, steps }
          })
      }
    : {}),
  onRunTakeover: ({ sessionId, message }) => {
    const stored = appendSessionEvent(sessionId, {
      type: 'remote_run_stopped',
      noticeLevel: 'warning',
      noticeText: message
    })
    broadcastSessionTimelineEvent(sessionId, stored)
  },
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
        const window = runtime.window.mainWindow
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
  const blockerId = runtime.caches.preventSleepBlockerId
  if (shouldBlock && blockerId === null) {
    runtime.caches.setPreventSleepBlockerId(powerSaveBlocker.start('prevent-app-suspension'))
    return
  }
  if (!shouldBlock && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId)
    }
    runtime.caches.clearPreventSleepBlockerId()
  }
}
const backgroundEnvironment = createBackgroundEnvironment({ agentDir: AGENT_DIR })
const environmentBuilds = createEnvironmentBuilds({
  root: getRuntimeRoot(),
  build: (root, descriptor, options) =>
    buildEnvironment(root, descriptor, { ...options, fetch: officialRegistryFetch }),
  onChange: (build) => {
    sendToAllWindows(IPC.environmentBuilds.changed, build)
  }
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
const analysisNotebookOperations = new AnalysisNotebookOperations({
  remoteNotebookBackend,
  notebookSessionRegistry,
  notebookToolExecutor,
  notebookFileWatcher,
  notifyAnalysisNotebookFileChanged
})
const analysisNotebookCodeGenerator = new AnalysisNotebookCodeGenerator({
  agentDir: AGENT_DIR,
  notebooks: {
    resolveWorkspaceByCwd: resolveAnalysisWorkspaceByCwd,
    remoteBackendFor: (workspace) => analysisNotebookOperations.remoteBackendFor(workspace),
    openFile: (workspace, notebookPath, watch) =>
      analysisNotebookOperations.openFile(workspace, notebookPath, watch),
    sessions: (workspace) => analysisNotebookOperations.sessions(workspace)
  },
  notebookSessionRegistry,
  notebookExecutor,
  models: {
    selected: () => sessionState.selectedModel,
    thinkingLevel: () => selectedThinkingLevel,
    resolve: resolveRuntimeModelSelection,
    label: modelSelectionLabel
  },
  messages: {
    extractAssistantText,
    assistantErrorMessageFromEventSummary
  }
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
  return notebookToolHostRouter.execute(request, {
    signal: context?.signal,
    beforeDispatch,
    ...(identity && context
      ? {
          approveRemoteJupyterStart: (info) => approveRemoteJupyterStart(identity, info, context)
        }
      : {})
  })
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
  // The same skill name can come from several global sources; tool schemas need unique names.
  const allowedSkills = [
    ...new Set([
      ...catalog.sources.map((skill) => skill.name),
      ...globals
        .filter((skill) => skill.enabled && !projectNames.has(skill.name))
        .map((skill) => skill.name)
    ])
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
    skippedMcpNotifier.notify(identity.sessionId, mcp?.skipped ?? [])
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

async function installedPluginNamespace(projectDir?: string): Promise<PluginNamespace> {
  const resourceCwd = projectDir ?? sessionState.cwd
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
    sendToAllWindows(IPC.packages.resourcesChanged)
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
  sendToAllWindows(IPC.remoteProjectUploads.changed, job)
})
remoteJupyterStartJobs.subscribe((job) => {
  sendToAllWindows(IPC.remoteJupyterJobs.changed, job)
})
const wrapperResultReadControl = createWrapperResultReadControl({
  observeRemote: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
  remoteRequestProjectId
})
const wrapperResultDownloads: WrapperResultDownloads = new Map()
subscribeRemoteProjectConnection((projectId, state) => {
  sendToAllWindows(IPC.projects.remoteConnectionChanged, { projectId, state })
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
wrapperJobs.onChange((runId) => sendToAllWindows(IPC.wrappers.runsChanged, { runId }))

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
  return phiSessionId ? { phiSessionId, cwd: origin?.cwd ?? sessionState.cwd } : undefined
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
    await runtime.workspaceServices.browserWorkspaceRegistry?.disposeRun(
      run.phiSessionId,
      run.runId
    )
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
const backgroundAgentJobListingOptions = {
  agentDir: AGENT_DIR,
  resolveRecoverableJobOrigin,
  currentRuntimeOriginScope,
  optionalStringField
}
const backgroundShellJobOperationsOptions = { resolveOriginSession, optionalStringField }
const backgroundJobOperations = {
  listAgentJobs: () => listBackgroundAgentJobs(backgroundAgentJobListingOptions),
  listShellJobs: () => listBackgroundShellJobs(backgroundShellJobOperationsOptions),
  stopShellJob: stopBackgroundShellJob
}

function sendRunEventToWindow(payload: Record<string, unknown>): void {
  sendToWindow(getActiveWindow(), IPC.agent.event, {
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
  const approved = await confirmHostToolApproval(
    runtimeSessionId,
    'capability_install',
    summary,
    context
  )
  capabilityHost.assertCurrent(context)
  return approved
}

/** Starting a server on the user's host: ask mode prompts once; auto mode follows the exec-class policy. */
async function approveRemoteJupyterStart(
  identity: { runtimeSessionId: string; sessionId: string },
  info: { serverLabel: string; projectName: string },
  context: import('./agent/engine/types').PhiHostRequestContext
): Promise<boolean> {
  const manifest = findPhiSessionById(identity.sessionId)
  if (!manifest) throw new Error('远程 Jupyter 启动审批所属会话不可用')
  // Starting a server process uses shared resources: ask in every permission mode.
  const approved = await confirmHostToolApproval(
    identity.runtimeSessionId,
    'remote_jupyter_start',
    `启动远程 Jupyter（会占用服务器资源）\n服务器：${info.serverLabel}\n项目：${info.projectName}`,
    context
  )
  context.signal?.throwIfAborted()
  return approved
}

async function confirmHostToolApproval(
  runtimeSessionId: string,
  toolName: string,
  summary: string,
  context: import('./agent/engine/types').PhiHostRequestContext
): Promise<boolean> {
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
    toolName,
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
    sendToAllWindows(IPC.tool.approvalCancelled, request.requestId)
  }
  notifySessionChanged()
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
  sendToWindow(targetWindow, IPC.agent.event, {
    source: 'phi',
    ...event,
    phiSessionId: run.phiSessionId,
    sessionGeneration: run.sessionGeneration,
    sessionPath: run.sessionPath ?? run.session?.sessionFile ?? null,
    cwd: run.cwd
  })
}

function logUnexpectedError(error: unknown): void {
  const message = errorMessage(error)
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

const sessionEventPersistenceDeps: SessionEventPersistenceDeps = {
  storage: {
    appendSessionEvent,
    persistToolOutput,
    toolOutputInlineLimit: TOOL_OUTPUT_INLINE_LIMIT
  },
  shared: {
    createdAtFromSummary,
    extractAssistantText,
    persistSdkCompactionNotice,
    persistSdkShakeEvent,
    redactStructuredValue
  }
}

function persistSessionEvent(run: PromptRun, summary: PhiAgentEvent): Record<string, unknown> {
  return persistSessionEventWithDeps(run, summary, sessionEventPersistenceDeps)
}

function createSessionKey(
  path: string | undefined,
  cwd: string,
  freshId = sessionState.freshSessionCounter
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
  sessionState.linkPhiManagedSessionKey(sessionKey, stablePath, stableKey, sameCanonicalSessionKey)
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
  sessionState.linkMaterializedSessionKey(sessionKey, materializedKey, sameCanonicalSessionKey)
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
  return getLifecycleForKey(sessionState.sessionKey)
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
        error: errorMessage(error)
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

interface ResolvedPromptRunTarget {
  input: SubmitPromptInput
  normalizedText: string
  promptTarget: PromptTargetInput | null
  runSessionKey: string
  runLifecycle: SessionLifecycle<AgentSessionResult>
  runSessionGeneration: number
  runSnapshot: SessionSnapshot & { permissionMode: PermissionMode }
  automaticModelSelection: boolean
  project: Project | undefined
}

interface AdmittedPromptRun extends ResolvedPromptRunTarget {
  phiSessionId: string
  stableSessionPath: string
  runId: string
}

interface PromptRunContext extends AdmittedPromptRun {
  runGeneration: number
  storedImages: ReturnType<typeof persistPromptImages>
  otherActiveProjectRuns: number
  promptRun: PromptRun
}

function resolvePromptRunTarget(input: SubmitPromptInput): ResolvedPromptRunTarget {
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
  return {
    input,
    normalizedText,
    promptTarget,
    runSessionKey,
    runLifecycle,
    runSessionGeneration,
    runSnapshot,
    automaticModelSelection,
    project
  }
}

function admitPromptRun(target: ResolvedPromptRunTarget): AdmittedPromptRun {
  const phiSessionId = ensurePhiSessionId(
    target.runSessionKey,
    target.runSnapshot,
    target.normalizedText || (target.input.images?.length ? '图片' : undefined)
  )
  if (runtimeRecoveryOperations.has(phiSessionId))
    throw new Error('会话正在恢复，请等待恢复操作结束')
  if (manualCompactionIds.has(phiSessionId)) {
    throw new Error('上下文压缩正在进行，请稍后发送消息')
  }
  const stableSessionPath = phiOnlySessionPath(phiSessionId)
  const runId = createRunId()
  if (hasActivePromptRun(target.runSessionKey)) {
    throw new Error('会话正在运行')
  }
  return { ...target, phiSessionId, stableSessionPath, runId }
}

function allocatePromptRun(admission: AdmittedPromptRun): PromptRunContext {
  const runGeneration = advancePromptGeneration(admission.runSessionKey)
  // A real user message starts the automatic wake-up count over only after preflight succeeds.
  if (!admission.input.automatic) automaticContinuations.delete(admission.phiSessionId)
  const storedImages = admission.input.images?.length
    ? persistPromptImages(admission.phiSessionId, admission.input.images)
    : []
  const otherActiveProjectRuns = admission.project
    ? countOtherActiveProjectRuns(admission.project.id, admission.runSessionKey)
    : 0
  const promptRun: PromptRun = {
    sessionKey: admission.runSessionKey,
    phiSessionId: admission.phiSessionId,
    runId: admission.runId,
    cwd: admission.runSnapshot.cwd,
    ...(admission.project ? { projectId: admission.project.id } : {}),
    generation: runGeneration,
    sessionGeneration: admission.runSessionGeneration,
    cancelled: false,
    thinkingBlocks: new Map(),
    thinkingBlockStartedAtMs: new Map(),
    compactionReasons: new Map(),
    agentToolCallIds: new Set(),
    sdkToolCallIds: new Set(),
    browserSdkToolCallIds: new Set(),
    persistedToolCallIds: new Set(),
    pendingProviderToolCalls: new Map(),
    sessionPath: admission.stableSessionPath
  }
  setActivePromptRun(admission.runSessionKey, promptRun)
  return { ...admission, runGeneration, storedImages, otherActiveProjectRuns, promptRun }
}

function preparePromptRunForQueue(context: PromptRunContext): void {
  const { input, phiSessionId, runId, normalizedText, promptTarget, storedImages, promptRun } =
    context
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
    deleteActivePromptRun(context.runSessionKey, promptRun)
    throw error
  }
  if (context.otherActiveProjectRuns > 0 && !input.automatic) {
    notifyProjectParallelRun(
      context.runSessionGeneration,
      context.stableSessionPath,
      context.runSnapshot.cwd,
      context.otherActiveProjectRuns
    )
  }
}

const promptRunExecutionDeps: PromptRunExecutionDeps<PromptRunContext> = {
  lifecycle: { getPromptGeneration },
  session: {
    getAgentSession,
    applyNextRunConfiguration,
    abortSession,
    abortSessionWithoutCancellingApprovals,
    linkRuntimeSessionPath: (context, session) => {
      linkPromptRunRuntimeSessionPath(
        context.runSessionKey,
        context.runSnapshot.cwd,
        context.promptRun,
        session
      )
    },
    recordMaterialization: (context) => {
      sessionState.recordPromptRunMaterialization(
        context.runSessionKey,
        context.stableSessionPath,
        sameCanonicalSessionKey
      )
    }
  },
  models: { selectableRuntimeModels },
  timeline: { broadcastSessionTimelineEvent, logUnexpectedError }
}

function startPromptRegistryRun(
  context: PromptRunContext,
  loadedSkills: string[],
  setPromptResult: (result: PromptRunResult) => void
): ReturnType<typeof runnerRegistry.startRun> {
  return runnerRegistry.startRun({
    sessionId: context.phiSessionId,
    runId: context.runId,
    loadedSkills,
    getRecordedFailure: () => context.promptRun.recordedFailureMessage,
    execute: ({ signal }) =>
      executePromptRunWithDeps(context, promptRunExecutionDeps, signal, setPromptResult)
  })
}

function persistPromptRunWorkspaceChanges(
  context: PromptRunContext,
  changes: Awaited<ReturnType<typeof finishWorkspaceChangeCapture>>
): void {
  if (changes && (changes.files.length > 0 || changes.truncated)) {
    try {
      const stored = appendSessionEvent(context.phiSessionId, {
        type: 'workspace_changes',
        runId: context.runId,
        ...changes
      })
      broadcastSessionTimelineEvent(context.phiSessionId, stored)
    } catch (error) {
      logUnexpectedError(error)
    }
  }
}

async function runQueuedPrompt(context: PromptRunContext): Promise<PromptRunResult> {
  let promptResult: PromptRunResult = null
  if (
    context.promptRun.cancelled ||
    context.promptRun.generation !== getPromptGeneration(context.runSessionKey) ||
    !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration)
  ) {
    return null
  }

  const changeBaseline =
    context.project?.location?.kind === 'ssh'
      ? null
      : await beginWorkspaceChangeCapture(context.runSnapshot.cwd)

  let loadedSkills = loadedSkillNamesBySession.get(context.phiSessionId)
  if (!loadedSkills) {
    try {
      loadedSkills = (
        isRemoteResourceScope(context.runSnapshot.cwd)
          ? await listRemoteProjectSkills(context.runSnapshot.cwd)
          : await listSkills(context.runSnapshot.cwd)
      )
        .filter((skill) => skill.enabled)
        .map((skill) => skill.name)
        .sort()
    } catch (error) {
      loadedSkills = []
      writeAppLog({
        event: 'session_loaded_skills_unavailable',
        level: 'warn',
        sessionId: context.phiSessionId,
        metadata: { error: errorMessage(error) }
      })
    }
    loadedSkillNamesBySession.set(context.phiSessionId, loadedSkills)
  }

  const registryRun = startPromptRegistryRun(context, loadedSkills, (result) => {
    promptResult = result
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
        const ref = persistWorkspaceDiff(context.phiSessionId, patch)
        if (ref) savedDiffBytes += ref.bytes
        return ref
      }
    })
    persistPromptRunWorkspaceChanges(context, changes)
  }
  return context.promptRun.cancelled ? null : promptResult
}

function trackPromptRunSettlement(context: PromptRunContext, run: Promise<PromptRunResult>): void {
  context.promptRun.done = run
  setPromptQueue(
    context.runSessionKey,
    run.then(
      (result) => {
        deleteActivePromptRun(context.runSessionKey, context.promptRun)
        notifySessionChanged()
        flushPendingContinuations(context.phiSessionId, context.promptRun.cancelled)
        if (result && !context.promptRun.cancelled && !context.promptRun.recordedFailureMessage) {
          scheduleAutomaticSessionTitle(context.phiSessionId)
        }
      },
      () => {
        deleteActivePromptRun(context.runSessionKey, context.promptRun)
        notifySessionChanged()
        flushPendingContinuations(context.phiSessionId, context.promptRun.cancelled)
      }
    )
  )
}

/**
 * Runs one prompt in the conversation `sessionKey`. It does not depend on which
 * conversation is on screen, so it also serves prompts for a conversation in the
 * background. The `agent:prompt` handler and automatic continuation both use it.
 */
async function submitPromptRun(input: SubmitPromptInput): Promise<PromptRunResult> {
  const target = resolvePromptRunTarget(input)
  const admission = admitPromptRun(target)
  const context = allocatePromptRun(admission)
  preparePromptRunForQueue(context)
  // Serialize prompts per session: duplicate/overlapping IPC invokes must
  // never run session.prompt() concurrently within the same conversation.
  const run = getPromptQueue(context.runSessionKey).then(() => runQueuedPrompt(context))
  trackPromptRunSettlement(context, run)
  return run
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
  return projectForSession(sessionKey, snapshot)?.defaultModel ?? sessionState.selectedModel ?? null
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
  const model =
    sessionState.selectedModel !== undefined
      ? sessionState.selectedModel
      : (project?.defaultModel ?? null)
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
    sessionState.selectedModel !== undefined &&
    !(remoteOmpRpcEnabled && sessionState.selectedModel === null)
      ? sessionState.selectedModel
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

// The title model follows the conversation: its explicit selection, or else the model the
// live session already resolved. An explicit selection that no longer resolves is an error.
async function resolveSessionTitleModel(
  key: string,
  selection: ModelSelection | null,
  signal: AbortSignal
): Promise<{ modelRuntime: ModelRuntime; model: RuntimeModel | undefined }> {
  const modelRuntime = await getAuthManager().getRuntime()
  signal.throwIfAborted()
  let model = selection ? resolveRuntimeModelSelection(modelRuntime, selection)?.model : undefined
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
  return { modelRuntime, model }
}

function getSessionTitleGenerator(): SessionTitleGenerator {
  if (runtime.window.cleanupStarted) throw new Error('标题生成服务已关闭')
  const cachedGenerator = runtime.caches.sessionTitleGenerator
  if (cachedGenerator) return cachedGenerator
  const generator = new SessionTitleGenerator({
    request: async ({ sessionPath, prompt, signal }) => {
      const { manifest } = sessionTitleContext(sessionPath)
      const key = createPhiSessionKey(manifest.sessionId, manifest.cwd)
      const selection = resolveSessionModelSelection(key, {
        path: sessionPath,
        cwd: manifest.cwd,
        permissionMode: manifest.permissionMode
      })
      const { modelRuntime, model } = await resolveSessionTitleModel(key, selection, signal)
      const cwd = getNoProjectTaskFolder()
      let streamedText = ''
      let replyFailed = false
      const { session } = await createAgentSession(
        {
          cwd,
          modelRuntime,
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
  runtime.caches.setSessionTitleGenerator(generator)
  return generator
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
  if (sessionState.sessionPath === path && current) {
    await current.session.sessionManager.setSessionName(name, source)
  } else {
    await renameSession(path, name)
  }
}

function scheduleAutomaticSessionTitle(sessionId: string): void {
  if (runtime.window.cleanupStarted || automaticTitleJobs.has(sessionId)) return
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
    if (!title || runtime.window.cleanupStarted) return
    await enqueueSessionTitleWrite(path, async () => {
      if (runtime.window.cleanupStarted) return
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

function isUsableWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

function isDisposedFrameSendError(error: unknown): boolean {
  const message = errorMessage(error)
  return (
    message.includes('Render frame was disposed before WebFrameMain could be accessed') ||
    message.includes('Object has been destroyed')
  )
}

function isExpectedShutdownCleanupError(error: unknown): boolean {
  const message = errorMessage(error)
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
  sendToAllWindows(IPC.tool.approvalCancelled)
}

function notifyAgentUserInteractionsCancelled(): void {
  sendToAllWindows(IPC.agent.interactionCancelled)
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
  sendToAllWindows(IPC.analysis.notebookDraftChanged, change)
}

function notifyAnalysisNotebookFileChanged(change: unknown): void {
  sendToAllWindows(IPC.analysis.notebookFileChanged, change)
}

function isRemoteResourceScope(cwd?: string): boolean {
  return (
    isRemoteProjectAnchorPath(sessionState.cwd, AGENT_DIR) ||
    (typeof cwd === 'string' && isRemoteProjectAnchorPath(cwd, AGENT_DIR))
  )
}

function remoteSkillProjectContext(cwd?: string): RemoteProjectSkillContext {
  const target = cwd ?? sessionState.cwd
  const remote =
    currentRemoteAnalysisProject(target) ?? currentRemoteAnalysisProject(sessionState.cwd)
  if (!remote) throw new Error('远程项目 Skill 请求缺少有效的当前项目会话')
  return {
    sessionId: remote.sessionId,
    projectId: remote.project.id,
    cwd: target,
    agentDir: AGENT_DIR
  }
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

function cancelPendingToolApprovals(scope?: { sessionId: string; runId: string }): void {
  const cancelled = cancelToolApprovals(scope) ?? []
  if (!scope) {
    notifyToolApprovalsCancelled()
    return
  }
  for (const request of cancelled) {
    sendToAllWindows(IPC.tool.approvalCancelled, request.requestId)
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
        !(runtime.window.cleanupStarted && isExpectedShutdownCleanupError(error))
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
          !sameCanonicalSessionKey(key, sessionState.sessionKey) ||
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

function getCurrentSessionPayload(): CurrentSessionPayload {
  sessionState.refreshPermissionMode(resolveSessionPermissionMode)
  const manifest = findPhiManifestForSession(
    sessionState.sessionKey,
    sessionState.sessionPath,
    sessionState.cwd
  )
  const phiSessionId = manifest?.sessionId ?? getPhiSessionIdForKey(sessionState.sessionKey)
  const path = phiSessionId ? phiOnlySessionPath(phiSessionId) : (sessionState.sessionPath ?? null)
  const project = manifest?.projectId
    ? getProject(manifest.projectId)
    : getProjectByCwd(sessionState.cwd)
  const projectLocation = manifest?.projectLocation ?? project?.location
  return {
    path,
    ...(phiSessionId ? { phiSessionId } : {}),
    cwd: sessionState.cwd,
    displayCwd: projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : sessionState.cwd,
    ...(manifest?.projectId || project?.id
      ? { projectId: manifest?.projectId ?? project?.id }
      : {}),
    ...(projectLocation ? { projectLocation } : {}),
    sessionGeneration: getCurrentLifecycle().currentGeneration,
    permissionMode: sessionState.permissionMode,
    ...getSessionStatusPayload(sessionState.sessionKey, sessionState.sessionPath, sessionState.cwd)
  }
}

function notifySessionChanged(): void {
  const payload = getCurrentSessionPayload()
  void runtime.workspaceServices.browserWorkspaceRegistry
    ?.setActiveSession(payload.phiSessionId ?? null)
    .catch(() => {
      writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
    })
  sendToAllWindows(IPC.sessions.changed, payload)
}

function notifyProjectParallelRun(
  sessionGeneration: number,
  sessionPath: string | undefined,
  cwd: string,
  activeCount: number
): void {
  const window = getActiveWindow()
  sendToWindow(window, IPC.agent.event, {
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

async function invalidateAgentSession(): Promise<void> {
  const phiSessionId = getPhiSessionIdForKey(sessionState.sessionKey)
  if (phiSessionId) loadedSkillNamesBySession.delete(phiSessionId)
  const lifecycle = getCurrentLifecycle()
  const previous = lifecycle.advance()
  advancePromptGeneration(sessionState.sessionKey)
  const activePromptRun = getActivePromptRun(sessionState.sessionKey)
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
  return runtime.window.beginCleanup(
    () => runtime.caches.disposeSessionTitleGenerator(),
    async () => {
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
    }
  )
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
  sessionState.switchTo(path, cwd, permissionMode, {
    createSessionKey,
    resolveSessionPermissionMode,
    resolveSessionKeyAlias,
    sessionPermissionModes
  })
  const target = getCurrentSessionPayload()
  try {
    await runtime.workspaceServices.browserWorkspaceRegistry?.setActiveSession(
      target.phiSessionId ?? null
    )
  } catch {
    writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
  }
  if (options.notify !== false) {
    notifySessionChanged()
  }
  return target
}

const sessionCreationContextDependencies: SessionCreationContextDependencies = {
  getPromptGeneration,
  getActiveRun: getActivePromptRun,
  findManifest: findPhiManifestForSession,
  getProject,
  getProjectByCwd,
  normalizeMemory: normalizeProjectMemorySettings,
  remoteBinding: (input) => resolveRemoteWorkspaceHostBinding(input).cacheKey
}

interface SessionCreationRuntime {
  thinkingLevel: ThinkingLevel | undefined
  abortController: AbortController
}

interface SessionCreationModelPhase {
  resolution: SessionCreationModelResolution
  runtime: SessionCreationRuntime
}

interface BeginSessionCreationInput {
  sessionKey: string
  snapshot: SessionSnapshot
  generation: number
  lifecycle: SessionLifecycle<AgentSessionResult>
  control?: RuntimeSelectionControl
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
}

function createSessionCreationContext(input: BeginSessionCreationInput): SessionCreationContext {
  const ownership = resolveSessionCreationOwnership(
    {
      sessionKey: input.sessionKey,
      snapshot: input.snapshot,
      generation: input.generation,
      lifecycle: input.lifecycle,
      control: input.control,
      agentDir: AGENT_DIR
    },
    sessionCreationContextDependencies
  )
  return new SessionCreationContext({
    ...input,
    ...ownership,
    dependencies: sessionCreationContextDependencies
  })
}

function resolveSessionCreationRoute(context: SessionCreationContext): boolean {
  const useRpc = remoteOmpRpcEnabled && context.remoteProject !== null
  if (context.sessionManifest?.runtimeRef && !useRpc) {
    throw new Error('此会话属于远程 RPC 运行时，请启用对应运行路径后显式恢复')
  }
  return useRpc
}

function recordSessionCreationModelMigration(
  context: SessionCreationContext,
  resolvedModel: SessionCreationModelResolution['resolvedModel']
): void {
  if (!resolvedModel?.migratedFrom) return
  sessionModelSelections.set(resolveSessionKeyAlias(context.sessionKey), resolvedModel.selection)
  const run = getActivePromptRun(context.sessionKey)
  const phiSessionId = run?.phiSessionId ?? getPhiSessionIdForKey(context.sessionKey)
  if (!phiSessionId) return
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
  const sessionPath = uiSessionPathForKey(context.sessionKey, context.snapshot.path)
  sendToWindow(targetWindow, IPC.agent.event, {
    ...stored,
    phiSessionId,
    sessionGeneration: context.generation,
    sessionPath,
    cwd: context.snapshot.cwd
  })
}

function prepareSessionCreationRuntime(
  context: SessionCreationContext,
  useRpc: boolean,
  model: RuntimeModel | undefined
): SessionCreationRuntime {
  const desiredThinking = resolveSessionThinkingLevel(context.sessionKey, context.snapshot)
  const thinkingLevel =
    useRpc && model ? selectionThinking(model, desiredThinking).phi : desiredThinking
  const abortController = new AbortController()
  sessionAbortControllers.set(
    getSessionControllerKey(context.snapshot, context.generation),
    abortController
  )
  return { thinkingLevel, abortController }
}

function prepareSessionCreationModelPhase(
  context: SessionCreationContext,
  useRpc: boolean,
  modelRuntime: ModelRuntime
): SessionCreationModelPhase {
  const modelSelection =
    context.remoteRecovery?.replacementModel ??
    resolveSessionModelSelection(context.sessionKey, context.snapshot)
  const resolution = resolveSessionCreationModel(
    {
      useRpc,
      remoteRecovery: Boolean(context.remoteRecovery),
      hasRuntimeRef: Boolean(context.sessionManifest?.runtimeRef),
      modelRuntime,
      modelSelection
    },
    { resolve: resolveRuntimeModelSelection }
  )
  recordSessionCreationModelMigration(context, resolution.resolvedModel)
  return {
    resolution,
    runtime: prepareSessionCreationRuntime(context, useRpc, resolution.model)
  }
}

const sessionCreationApprovalDependencies = createSessionCreationApprovalDependencies({
  classifyLocal: (toolName, input) => skillHost.approvalFor(toolName, input),
  classifyRemote: (toolName, input) => remoteRuntimeController.approvalFor(toolName, input),
  permissionMode: resolveSessionPermissionMode,
  remoteHost: getRemoteHostProfile,
  remoteScope: remoteBashApprovalScope,
  activeRun: getActivePromptRun,
  sessionPath: phiOnlySessionPath,
  background: {
    backgroundRequested: (request) => backgroundAgentApprovals.requested(request),
    backgroundResolved: (approvalId, decision) =>
      backgroundAgentApprovals.resolved(approvalId, decision)
  },
  runner: {
    requested: (sessionId, approvalId, metadata) =>
      runnerRegistry.markNeedsApproval(sessionId, approvalId, metadata),
    approved: (sessionId, approvalId) => runnerRegistry.markApprovalApproved(sessionId, approvalId),
    denied: (sessionId, approvalId) => runnerRegistry.markApprovalDenied(sessionId, approvalId),
    cancelled: (sessionId, approvalId) =>
      runnerRegistry.markApprovalCancelled(sessionId, approvalId)
  },
  key: remoteBashApprovalKey,
  bash: approvedRemoteBashCalls,
  write: approvedRemoteWriteCalls,
  edit: approvedRemoteEditCalls
})

function sessionCreationExtensionFactories(
  context: SessionCreationContext,
  useRpc: boolean,
  abortController: AbortController
): ReturnType<typeof createSessionCreationExtensionFactories> {
  return createSessionCreationExtensionFactories(
    {
      useRpc,
      signal: abortController.signal,
      sessionKey: context.sessionKey,
      snapshot: context.snapshot,
      generation: context.generation,
      sessionManifestId: context.sessionManifest?.sessionId,
      project: context.project,
      remoteProject: context.remoteProject
    },
    sessionCreationApprovalDependencies
  )
}

interface SessionCreationResourcePhase {
  context: SessionCreationContext
  useRpc: boolean
  creationRuntime: SessionCreationRuntime
  notebookPrompt: string | null
  agentScan: PhiAgentDiscoveryResult
  remoteSkillCatalog: RemoteProjectSkillCatalog | undefined
  remoteContextFiles: SessionCreationResources['remoteContextFiles']
  remoteMcpCatalog: RemoteProjectMcpCatalog | undefined
}

function assembleSessionCreationResourcePhase(
  input: SessionCreationResourcePhase
): SessionCreationResources {
  const { context } = input
  return assembleSessionCreationResources({
    useRpc: input.useRpc,
    remoteProject: context.remoteProject !== null,
    cwd: context.snapshot.cwd,
    agentDir: AGENT_DIR,
    notebookPrompt: input.notebookPrompt,
    agentScan: input.agentScan,
    remoteSkillCatalog: input.remoteSkillCatalog,
    remoteMcpCatalog: input.remoteMcpCatalog,
    remoteContextFiles: input.remoteContextFiles,
    personaMarkdown: getPersonaMarkdown(),
    extensionFactories: () =>
      sessionCreationExtensionFactories(
        context,
        input.useRpc,
        input.creationRuntime.abortController
      ),
    onDiagnostic: (diagnostic) => writeAppLog(sessionCreationAgentDiagnosticLog(diagnostic)),
    remoteProjectSkills: remoteRuntimeSkillDefinitions
  })
}

function prebindRemoteSessionCreation(
  context: SessionCreationContext,
  useRpc: boolean,
  model: RuntimeModel | undefined,
  thinkingLevel: ThinkingLevel | undefined
): void {
  if (!useRpc || !context.sessionManifest || context.sessionManifest.runtimeRef || !model) return
  const latest = findPhiSessionById(context.sessionManifest.sessionId)
  if (
    !latest ||
    latest.runtimeRef ||
    JSON.stringify(latest.model) !== JSON.stringify(context.sessionManifest.model) ||
    latest.thinkingLevel !== context.sessionManifest.thinkingLevel
  ) {
    throw new StaleSessionError()
  }
  if (latest.thinkingLevel !== thinkingLevel) {
    updateSessionManifest(context.sessionManifest.sessionId, { thinkingLevel })
  }
}

function sessionCreationManager(
  context: SessionCreationContext,
  useRpc: boolean
): import('./agent/runtime/runtime-adapter').RuntimeSessionManager {
  return useRpc
    ? createAppRemoteSessionManager(
        context.snapshot.cwd,
        context.sessionManifest!.sessionId,
        Boolean(context.sessionManifest?.runtimeRef)
      )
    : createSessionManager(
        context.snapshot.cwd,
        runtimeSessionPathForSnapshot(context.sessionKey, context.snapshot)
      )
}

function prepareSessionCreationOptions(
  context: SessionCreationContext,
  useRpc: boolean,
  modelPhase: SessionCreationModelPhase,
  resources: SessionCreationResources
): SessionCreationOptions {
  prebindRemoteSessionCreation(
    context,
    useRpc,
    modelPhase.resolution.model,
    modelPhase.runtime.thinkingLevel
  )
  return buildSessionCreationOptions({
    remoteRecovery: context.remoteRecovery,
    modelRuntime: modelPhase.resolution.modelRuntime,
    model: modelPhase.resolution.model,
    thinkingLevel: modelPhase.runtime.thinkingLevel,
    autoCompaction: context.sessionManifest?.autoCompaction,
    cwd: context.snapshot.cwd,
    sessionManager: sessionCreationManager(context, useRpc),
    resourceLoader: resources.resourceLoader,
    phiAgents: resources.agentScan.agents,
    remoteProjectMcpServers: useRpc ? undefined : resources.remoteMcpCatalog?.runtimeServers,
    projectBound: Boolean(context.project),
    memory: context.project?.memory,
    remoteRuntimeRoot:
      context.remoteProject && context.project
        ? projectRemoteRuntimeRoot(context.project)
        : undefined,
    remoteProject: context.remoteProject,
    phiSessionId: context.sessionManifest?.sessionId ?? '',
    remoteContextFiles: resources.remoteContextFiles ?? [],
    personaMarkdown: resources.personaMarkdown
  })
}

function registerCreatedSessionOrigin(
  context: SessionCreationContext,
  result: AgentSessionResult
): void {
  context.assertCurrent(true)
  const phiSessionId =
    context.sessionManifest?.sessionId ?? getPhiSessionIdForKey(context.sessionKey)
  const confirmed = phiSessionId ? findPhiSessionById(phiSessionId) : null
  if (
    !confirmed ||
    (confirmed.projectLocation?.kind === 'ssh' &&
      !ownsRemoteRuntimeSession(result.session.runtimeSessionId))
  ) {
    return
  }
  const remoteScope =
    confirmed.projectLocation?.kind === 'ssh' ? currentRuntimeOriginScope(confirmed) : undefined
  if (confirmed.projectLocation?.kind === 'ssh' && !remoteScope) {
    throw new Error('远程运行来源尚未验证')
  }
  registerRuntimeSessionOrigin(
    {
      runtimeSessionId: result.session.runtimeSessionId,
      phiSessionId: confirmed.sessionId,
      projectId: confirmed.projectId ?? null,
      cwd: confirmed.cwd,
      ...(remoteScope
        ? {
            remoteScope,
            configuredRuntimeRoot: projectRemoteRuntimeRoot(requireProject(confirmed.projectId!))
              .configured
          }
        : {})
    },
    AGENT_DIR
  )
}

function linkCreatedSession(context: SessionCreationContext, result: AgentSessionResult): void {
  if (typeof result.session.runtimeSessionId === 'string') {
    runtimeSessionOrigins.set(result.session.runtimeSessionId, {
      sessionKey: context.sessionKey,
      cwd: context.snapshot.cwd
    })
  }
  const run = getActivePromptRun(context.sessionKey)
  if (run) {
    linkPromptRunRuntimeSessionPath(context.sessionKey, context.snapshot.cwd, run, result.session)
  } else {
    linkMaterializedRuntimeSessionPath(
      context.sessionKey,
      context.snapshot.cwd,
      result.session.sessionFile
    )
  }
  sessionState.updateCreatedSessionPath(
    context.sessionKey,
    context.generation,
    context.snapshot.path,
    {
      isCurrentGeneration: (candidateGeneration) =>
        context.lifecycle.isCurrentGeneration(candidateGeneration),
      sameCanonicalSessionKey,
      uiSessionPathForKey,
      notifySessionChanged
    }
  )
}

function stopCreatedSessionForPermanentProviderError(
  run: PromptRun | undefined,
  summary: ReturnType<typeof withEventTimestamp>,
  session: AgentSessionInstance
): void {
  if (
    run &&
    summary.type === 'auto_retry_start' &&
    isPermanentProviderRegionError(summary.errorMessage) &&
    !run.stoppingPermanentProviderError
  ) {
    run.stoppingPermanentProviderError = true
    run.recordedFailureMessage = redactSensitiveText(summary.errorMessage)
    void abortSessionWithoutCancellingApprovals(session).catch((error) => {
      logUnexpectedError(error)
    })
  }
}

type AgentSessionSubscriptionEvent = Parameters<Parameters<AgentSessionInstance['subscribe']>[0]>[0]

function handleCreatedSessionEvent(
  context: SessionCreationContext,
  result: AgentSessionResult,
  rawSummary: AgentSessionSubscriptionEvent
): void {
  if (!context.lifecycle.isCurrentGeneration(context.generation)) return
  const summary = withEventTimestamp(rawSummary)
  const run = getActivePromptRun(context.sessionKey)
  stopCreatedSessionForPermanentProviderError(run, summary, result.session)
  const phiSessionId = run?.phiSessionId ?? getPhiSessionIdForKey(context.sessionKey)
  const persistedSummary = run
    ? persistSessionEvent(run, summary)
    : phiSessionId
      ? (persistSdkCompactionNotice(phiSessionId, undefined, summary) ??
        persistSdkShakeEvent(phiSessionId, undefined, summary) ??
        summary)
      : summary
  const targetWindow = getActiveWindow()
  sendToWindow(targetWindow, IPC.agent.event, {
    ...persistedSummary,
    ...(phiSessionId ? { phiSessionId } : {}),
    sessionGeneration: context.generation,
    sessionPath: phiSessionId
      ? phiOnlySessionPath(phiSessionId)
      : (result.session.sessionFile ?? context.snapshot.path ?? null),
    cwd: context.snapshot.cwd
  })
}

function subscribeToCreatedSession(
  context: SessionCreationContext,
  result: AgentSessionResult
): void {
  result.session.subscribe((rawSummary) => {
    handleCreatedSessionEvent(context, result, rawSummary)
  })
}

interface AgentSessionCreationRequest {
  sessionKey: string
  lifecycle: SessionLifecycle<AgentSessionResult>
  control?: RuntimeSelectionControl
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
}

function beginAgentSessionCreation(
  request: AgentSessionCreationRequest,
  snapshot: SessionSnapshot,
  generation: number
): SessionCreationContext {
  return createSessionCreationContext({
    sessionKey: request.sessionKey,
    snapshot,
    generation,
    lifecycle: request.lifecycle,
    control: request.control,
    remoteRecovery: request.remoteRecovery
  })
}

function createPreparedAgentSession(
  context: SessionCreationContext,
  useRpc: boolean,
  modelPhase: SessionCreationModelPhase,
  resources: SessionCreationResources
): Promise<AgentSessionResult> {
  return createAgentSession(
    prepareSessionCreationOptions(context, useRpc, modelPhase, resources),
    undefined,
    context.control
  )
}

async function coordinateAgentSessionCreation(
  request: AgentSessionCreationRequest,
  creationSnapshot: SessionSnapshot,
  generation: number
): Promise<AgentSessionResult> {
  const context = beginAgentSessionCreation(request, creationSnapshot, generation)
  context.assertCurrent()
  await waitForSessionCleanup(context.snapshot)
  context.assertCurrent()
  const useRpc = resolveSessionCreationRoute(context)
  const remoteContextFiles = context.remoteProject
    ? await loadRemoteProjectInstructions(context.remoteProject.location)
    : null
  context.assertCurrent()
  const modelRuntime = await getAuthManager().getRuntime()
  context.assertCurrent()
  const modelPhase = prepareSessionCreationModelPhase(context, useRpc, modelRuntime)
  const notebookPrompt = context.remoteProject
    ? null
    : notebookAgentRuntimePrompt(context.snapshot.cwd)
  const resourceLookup = createSessionCreationResourceLookup(
    context.sessionManifest?.sessionId,
    context.remoteProject?.projectId,
    context.snapshot.cwd,
    AGENT_DIR
  )
  const agentScan = useRpc
    ? emptySessionCreationAgentScan()
    : context.remoteProject
      ? await loadRemoteSessionCreationAgents(resourceLookup, getBundledAgentsDir)
      : discoverLocalSessionCreationAgents(resourceLookup, getBundledAgentsDir)
  context.assertCurrent()
  const remoteSkillCatalog = context.remoteProject
    ? await loadRemoteSessionCreationSkills(resourceLookup)
    : undefined
  context.assertCurrent()
  const remoteMcpCatalog = context.remoteProject
    ? await loadRemoteSessionCreationMcp(resourceLookup)
    : undefined
  context.assertCurrent()
  const resources = assembleSessionCreationResourcePhase({
    context,
    useRpc,
    creationRuntime: modelPhase.runtime,
    notebookPrompt,
    agentScan,
    remoteSkillCatalog,
    remoteContextFiles,
    remoteMcpCatalog
  })
  if (resources.resourceLoader) await resources.resourceLoader.reload()
  context.assertCurrent()
  const result = await createPreparedAgentSession(context, useRpc, modelPhase, resources)
  try {
    registerCreatedSessionOrigin(context, result)
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
  linkCreatedSession(context, result)
  subscribeToCreatedSession(context, result)
  return result
}

async function getAgentSession(
  sessionKey: string = sessionState.sessionKey,
  snapshot: SessionSnapshot = {
    path: sessionState.sessionPath,
    cwd: sessionState.cwd,
    permissionMode: sessionState.permissionMode
  },
  control?: RuntimeSelectionControl,
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
): Promise<AgentSessionResult> {
  const lifecycle = getLifecycleForKey(sessionKey)
  const creationRequest = { sessionKey, lifecycle, control, remoteRecovery }
  const record = lifecycle.getOrCreate(
    snapshot,
    (creationSnapshot, generation) =>
      coordinateAgentSessionCreation(creationRequest, creationSnapshot, generation),
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

function createWindow(): void {
  runtime.window.resetCleanup()

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
  runtime.window.setMainWindow(window)

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
    runtime.window.clearMainWindow(window)
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
  runtime.window.setMenuBarController(
    createMacMenuBar({
      getUiLanguage: () => readAppSettings().uiLanguage,
      openWindow: showMainWindowFromMenuBar,
      queueAction: queueMenuBarAction,
      hideWindow: hideMainWindowFromMenuBar,
      canHideWindow: () => {
        const mainWindow = runtime.window.mainWindow
        return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
      },
      quit: () => app.quit()
    })
  )
  const startupSplashWindow = await createStartupSplashWindow(
    (options) => new BrowserWindow(options),
    appIcon.isEmpty() ? '' : appIcon.toDataURL(),
    Date.now,
    readAppSettings().uiLanguage
  )
  runtime.window.setStartupSplashWindow(startupSplashWindow)

  const removedLogs = cleanupOldLogs()
  try {
    cleanupStalePackageStaging({ agentDir: AGENT_DIR })
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'package_staging_cleanup_failed',
      metadata: { error: errorMessage(error) }
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
      metadata: { error: errorMessage(error) }
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
      metadata: { error: errorMessage(error) }
    })
  }
  // Domain packages are installed only after a catalog choice. Core runtime assets remain bundled.
  mkdirSync(sessionState.cwd, { recursive: true })
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
      metadata: { error: errorMessage(error) }
    })
  }
  // Fire-and-forget: resumes remote Slurm and detached runs left mid-flight by
  // the previous app session (see executor-slurm-reconcile.ts's doc comment).
  // Must never block startup — a network hiccup here shouldn't delay the window.
  void reconcileRemoteWrapperRuns().catch((error: unknown) => {
    writeAppLog({
      level: 'error',
      event: 'wrapper_remote_run_reconcile_failed',
      metadata: { error: errorMessage(error) }
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
      metadata: { error: errorMessage(error) }
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
        metadata: { error: errorMessage(error) }
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
  registerSystemIpc({ ipcMain })
  registerBrowserRendererIpc(ipcMain, browserIpcCoordinator)
  registerTerminalRendererIpc(ipcMain, terminalIpcCoordinator)
  registerSshBootstrapIpc(
    ipcMain,
    () => runtime.window.mainWindow?.webContents ?? null,
    createDefaultSshBootstrapCoordinator()
  )
  registerRemoteMicromambaIpc(ipcMain)
  registerRemoteRipgrepIpc(ipcMain)
  registerWindowIpc({
    ipcMain,
    getActiveWindow,
    requireMainWindowRenderer,
    getWindowStartup: (window) => mainWindowStartups.get(window)
  })
  registerMenuBarIpc({
    ipcMain,
    requireMainWindowRenderer,
    consumePendingAction: () => runtime.window.consumeMenuBarAction()
  })
  const localFileAccess = createLocalFileAccessControl({
    agentDir: AGENT_DIR,
    getCurrentCwd: () => sessionState.cwd
  })
  const filesIpcOptions: FilesIpcOptions = {
    ipcMain,
    dialog,
    shell,
    agentDir: AGENT_DIR,
    getCurrentCwd: () => sessionState.cwd,
    getActiveWindow,
    getUiLanguage: () => readAppSettings().uiLanguage,
    access: localFileAccess,
    previews: createLocalFilePreviews(localFileAccess),
    icons: createLocalFileIcons({
      access: localFileAccess,
      getMacLaunchServicesHandlers: () => runtime.caches.macLaunchServicesHandlers,
      setMacLaunchServicesHandlers: (handlers) =>
        runtime.caches.setMacLaunchServicesHandlers(handlers),
      getFileIcon: (path) => app.getFileIcon(path, { size: 'normal' })
    })
  }
  registerFileOpenIpc(filesIpcOptions)
  registerResourceCatalogIpc(ipcMain)
  registerWebLinkIpc({
    ipcMain,
    requireMainWindowRenderer
  })
  registerFilePickerIpc(filesIpcOptions)
  const remoteProjectUploadsIpcOptions = { ipcMain, uploads: remoteProjectUploads }
  registerRemoteProjectUploadPreparationIpc(remoteProjectUploadsIpcOptions)
  registerRemoteProjectUploadListIpc(remoteProjectUploadsIpcOptions)
  registerRemoteJupyterJobsIpc({ ipcMain, jobs: remoteJupyterStartJobs })
  registerRemoteProjectUploadControlIpc(remoteProjectUploadsIpcOptions)
  const wrappersIpcOptions = {
    ipcMain,
    lifecycle: { logUnexpectedError },
    workspace: { agentDir: AGENT_DIR },
    session: {
      getCurrent: () => ({
        key: sessionState.sessionKey,
        path: sessionState.sessionPath,
        cwd: sessionState.cwd
      }),
      findPhiManifestForSession
    },
    execution: { environmentBuilds, wrapperJobs },
    uploads: remoteProjectUploads,
    windows: { getActiveWindow }
  }
  registerWrapperInputUploadIpc(wrappersIpcOptions)
  registerWorkspaceFileIpc({
    ipcMain,
    dialog,
    shell,
    getUiLanguage: () => readAppSettings().uiLanguage,
    requireRenderer: requireMainWindowRenderer,
    requireLocalWorkspaceRoot: (rootPath) => {
      if (
        isRemoteResourceScope() ||
        resolve(rootPath) !== resolve(sessionState.cwd) ||
        isRemoteProjectAnchorPath(rootPath, AGENT_DIR)
      ) {
        throw new Error('只能修改当前本地工作区中的文件')
      }
    },
    observeRemote: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
    downloads: wrapperResultDownloads
  })
  registerFilePreviewIpc(filesIpcOptions)
  registerRemoteWorkspaceIpc({
    ipcMain,
    remote: {
      observe: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
      requestProjectId: remoteRequestProjectId,
      connectWorkspaceHost: connectRemoteWorkspaceHost
    }
  })
  registerWrapperResultsIpc({
    ipcMain,
    windows: { getActiveWindow, requireMainWindowRenderer },
    remote: {
      observe: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
      requestProjectId: remoteRequestProjectId
    },
    reads: wrapperResultReadControl,
    downloads: wrapperResultDownloads
  })
  registerFileBrowsingIpc(filesIpcOptions)
  registerMoleculesIpc({ ipcMain })
  const promptTargetControlOptions: PromptTargetControlOptions = {
    state: {
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      sessionPermissionModes
    },
    identity: {
      createPhiSessionKey,
      createSessionKey,
      linkPhiManagedSessionKey,
      setPhiSessionIdForKey,
      resolveSessionKeyAlias
    },
    lifecycle: {
      getLifecycleForKey,
      getCurrentLifecycle,
      disposeAndSwitchSession,
      openRuntimeSessionManager,
      resolveSessionPermissionMode
    }
  }
  const agentIpcOptions: AgentIpcOptions = {
    ipcMain,
    state: {
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      resolveSessionKeyAlias,
      runtimeSessionPath
    },
    prompt: {
      parseTarget: (input) => parsePromptTarget(input, () => sessionState.cwd),
      alignCurrentSessionToTarget: (input) =>
        alignCurrentSessionToPromptTarget(input, promptTargetControlOptions),
      submit: submitPromptRun
    },
    stop: {
      advancePromptGeneration,
      getActivePromptRun,
      getPhiSessionIdForKey,
      getRuntimeRecoveryOperation: (sessionId) => runtimeRecoveryOperations.get(sessionId),
      getManualCompactionOperation: (sessionId) => manualCompactionOperations.get(sessionId),
      stopPromptRun: (sessionKey, run, invalidateGeneration) =>
        stopPromptRun(sessionKey, run as PromptRun, invalidateGeneration)
    },
    agentRuns: {
      control: {
        resolveRecoverableJobOrigin,
        findPhiSessionById,
        ownsRemoteRuntimeSession,
        resolveOriginSession,
        hasEngineSession: (sessionId) => getPhiEngine().sessions.has(sessionId),
        currentRuntimeOriginScope,
        steer: (params) => getPhiEngine().agentRuns.steer(params),
        stop: (params) => getPhiEngine().agentRuns.stop(params)
      },
      persistence: {
        resolveOriginSession,
        appendSessionEvent: (phiSessionId, event) => appendSessionEvent(phiSessionId, event),
        redactSensitiveText,
        sendRunEventToWindow,
        logUnexpectedError
      }
    }
  }
  registerAgentPromptIpc(agentIpcOptions)
  registerWorkspaceChangesIpc({ ipcMain })
  registerAgentRunControlIpc(agentIpcOptions)

  registerAuthIpc({ ipcMain, invalidateAgentSession })

  registerAppIpc({
    ipcMain,
    getVersion: () => app.getVersion(),
    openExternal: (url) => shell.openExternal(url)
  })
  registerSettingsIpc({
    ipcMain,
    agentDir: AGENT_DIR,
    syncPreventSleepBlocker
  })

  registerEnvironmentIpc({
    ipcMain,
    environment: backgroundEnvironment,
    getActiveWindow,
    dialog,
    getUiLanguage: () => readAppSettings().uiLanguage
  })
  registerManagedEnvironmentsIpc({
    ipcMain,
    agentDir: AGENT_DIR,
    builds: environmentBuilds
  })
  const modelSelectionTarget = {
    getCurrentSessionKey: () => sessionState.sessionKey,
    getCurrentCwd: () => sessionState.cwd,
    resolveSessionKeyAlias,
    getPhiSessionIdForKey,
    findPhiSessionById,
    getCurrentLifecycle,
    sameCanonicalSessionKey,
    isRemoteOmpRpcEnabled: () => remoteOmpRpcEnabled,
    hasActivePromptRun,
    getActiveSessionRun: (sessionId: string) => runnerRegistry.getActiveRun(sessionId)
  }
  const modelSessionState = {
    getCurrentSessionPath: () => sessionState.sessionPath,
    getCurrentPermissionMode: () => sessionState.permissionMode,
    sessionModelSelections,
    sessionThinkingLevels
  }
  const modelSelectionRequests = {
    nextModelSelectionRequest: () => sessionState.nextModelSelectionRequest(),
    rememberModelSelection: (request: number, model: ModelSelection | null) =>
      sessionState.rememberModelSelection(request, model, writeLastSelectedModel)
  }
  const modelSelectionOperations = {
    resolveRuntimeModelSelection,
    resolveSessionThinkingLevel
  }
  registerModelsIpc({
    ipcMain,
    selectionTarget: modelSelectionTarget,
    sessionState: modelSessionState,
    requests: modelSelectionRequests,
    models: {
      ...modelSelectionOperations,
      selectableRuntimeModels,
      resolveSessionModelSelection
    }
  })
  registerThinkingIpc({
    ipcMain,
    selectionTarget: modelSelectionTarget,
    sessionState: {
      ...modelSessionState,
      getCurrentResolvedSession
    },
    models: modelSelectionOperations
  })

  const currentContextUsageOptions: CurrentContextUsageOptions = {
    getCurrentPayload: getCurrentSessionPayload,
    getCurrentSessionKey: () => sessionState.sessionKey,
    getCurrentSessionPath: () => sessionState.sessionPath,
    getCurrentCwd: () => sessionState.cwd,
    getCurrentPermissionMode: () => sessionState.permissionMode,
    findPhiManifestForSession,
    runtimeSessionPathForSnapshot,
    getCurrentLifecycle,
    getAgentSession
  }
  const currentSessionPayloadMessagesOptions: CurrentSessionPayloadMessagesOptions = {
    getCurrentPayload: getCurrentSessionPayload,
    getCurrentSessionKey: () => sessionState.sessionKey,
    getPhiSessionIdForKey,
    getCurrentLifecycle,
    getCurrentResolvedSession
  }
  const sessionCompactionControlOptions: SessionCompactionControlOptions = {
    workspace: { agentDir: AGENT_DIR },
    state: {
      getCurrentPayload: getCurrentSessionPayload,
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      manualCompactionIds,
      manualCompactionOperations
    },
    sessions: {
      findPhiManifestForSession,
      runtimeSessionPathForSnapshot,
      ensurePhiSessionId,
      hasActivePromptRun,
      captureSessionControlTarget,
      getSessionGeneration: (sessionKey) => getLifecycleForKey(sessionKey).currentGeneration
    },
    events: {
      sendToAllWindows,
      notifySessionChanged,
      logUnexpectedError,
      flushPendingContinuations
    }
  }
  registerSessionsIpc({
    ipcMain,
    state: {
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      setCurrentPermissionMode: (permissionMode) => sessionState.setPermissionMode(permissionMode),
      nextSessionSwitchRequest: () => sessionState.nextSessionSwitchRequest(),
      getSessionSwitchRequest: () => sessionState.sessionSwitchRequest,
      sessionPermissionModes,
      loadedSkillNamesBySession
    },
    reads: {
      getNoProjectTaskFolder,
      getCurrentSessionPayload,
      getCurrentSessionPayloadWithMessages: () =>
        getCurrentSessionPayloadWithMessages(currentSessionPayloadMessagesOptions),
      getCurrentContextUsage: () => getCurrentContextUsage(currentContextUsageOptions)
    },
    recovery: {
      state: {
        getCurrentPayload: getCurrentSessionPayload,
        getCurrentSessionKey: () => sessionState.sessionKey,
        getCurrentSessionPath: () => sessionState.sessionPath,
        getCurrentCwd: () => sessionState.cwd,
        getCurrentPermissionMode: () => sessionState.permissionMode,
        isRemoteOmpRpcEnabled: () => remoteOmpRpcEnabled,
        runtimeRecoveryOperations,
        runtimeRecoveryFailures,
        manualCompactionIds,
        sessionModelSelections,
        sessionThinkingLevels
      },
      identity: {
        resolveSessionKeyAlias,
        sameCanonicalSessionKey,
        getPromptGeneration,
        advancePromptGeneration
      },
      lifecycle: {
        getLifecycleForKey,
        hasActivePromptRun,
        runnerGetActiveRun: (sessionId) => runnerRegistry.getActiveRun(sessionId),
        cleanupSessionRecord,
        getAgentSession
      },
      projects: { projectRemoteRuntimeRoot },
      models: { resolveRuntimeModelSelection },
      sessions: { createRemoteManagedSession, disposeAndSwitchSession },
      events: { notifySessionChanged }
    },
    compaction: {
      getSettings: (target) =>
        getCurrentAutoCompactionSettings(target, sessionCompactionControlOptions),
      setSettings: (target, patch) =>
        setCurrentAutoCompactionSettings(target, patch, sessionCompactionControlOptions),
      compact: (target) => compactCurrentSession(target, sessionCompactionControlOptions)
    },
    identity: {
      createSessionKey,
      resolveSessionKeyAlias,
      setPhiSessionIdForKey,
      getPhiSessionIdForKey,
      findPhiManifestForSession,
      runtimeSessionPath
    },
    lifecycle: {
      createPhiManagedSession,
      disposeAndSwitchSession,
      openRuntimeSessionManager,
      resolveSessionPermissionMode,
      getLifecycleForKey,
      getAgentSession,
      waitForSessionCleanup
    },
    status: {
      runnerGetActiveRun: (sessionId) => runnerRegistry.getActiveRun(sessionId),
      activePromptEntries: () => [...activePromptRuns.entries()],
      stopPromptRun: (sessionKey, run) => stopPromptRun(sessionKey, run as PromptRun),
      getSessionStatusPayload,
      notifySessionChanged
    },
    remote: {
      scheduleRemoteProjectCheck,
      remoteNotebookSessionIds,
      disposeRemoteNotebookBackend
    },
    browser: {
      getRegistry: () => runtime.workspaceServices.browserWorkspaceRegistry
    },
    titles: {
      getGenerator: getSessionTitleGenerator,
      getGeneratorIfCreated: () => runtime.caches.sessionTitleGenerator,
      context: (path) => sessionTitleContext(path),
      manualRequests: manualTitleRequests,
      enqueueWrite: enqueueSessionTitleWrite,
      renameConversation
    },
    windows: { getActiveWindow, requireMainWindowRenderer }
  })
  const projectsIpcOptions: ProjectsIpcOptions = {
    ipcMain,
    windows: { getActiveWindow, requireMainWindowRenderer },
    workspace: {
      agentDir: AGENT_DIR,
      getTerminalManager: () => runtime.workspaceServices.terminalManager
    },
    projects: {
      requireProject,
      applyCurrentPermissionMode: (id, project, permissionMode) =>
        sessionState.applyProjectPermissionMode(id, project, permissionMode, {
          findPhiManifestForSession,
          resolveSessionKeyAlias,
          sessionPermissionModes,
          notifySessionChanged
        }),
      resolveRuntimeModelSelection,
      remoteRuntimeRoot: projectRemoteRuntimeRoot
    },
    sessions: {
      createLocal: createPhiManagedSession,
      createRemote: createRemoteManagedSession,
      switchTo: disposeAndSwitchSession
    },
    notebooks: { disposeRemoteBackend: disposeRemoteNotebookBackend },
    remote: {
      checkConnection: (sessionId, projectId, options) =>
        remoteConnectionTracker.check(sessionId, projectId, options),
      scheduleProjectCheck: scheduleRemoteProjectCheck
    }
  }
  registerProjectsIpc(projectsIpcOptions)
  registerMemoryIpc({
    ipcMain,
    workspace: { agentDir: AGENT_DIR },
    projects: { requireProject },
    memory: { retireProjectAdapters: retireDesktopProjectMemoryAdapters }
  })
  registerProjectsRemoteHostsIpc(projectsIpcOptions)
  registerRemoteIpc({ ipcMain })
  registerProjectsSessionsIpc(projectsIpcOptions)
  registerAnalysisIpc({
    ipcMain,
    notebooks: {
      resolveWorkspaceByCwd: resolveAnalysisWorkspaceByCwd,
      operations: analysisNotebookOperations,
      activePathByProjectCwd: activeNotebookPathByProjectCwd
    },
    jupyter: {
      getCurrentCwd: () => sessionState.cwd,
      isRemoteAnalysisCwd,
      serverRegistry: jupyterServerRegistry,
      executor: notebookExecutor,
      fileWatcher: notebookFileWatcher,
      ensureServerReady: ensureJupyterServerReady
    },
    generation: analysisNotebookCodeGenerator
  })
  registerToolIpc({ ipcMain, resolveToolApproval })
  registerAgentInteractionIpc({
    ipcMain,
    requireMainWindowRenderer,
    resolveAgentUserInteraction
  })
  registerPhiPluginIpc({
    ipcMain,
    lifecycle: { invalidateAgentSession, logUnexpectedError },
    workspace: { agentDir: AGENT_DIR },
    plugins: { installedPluginNamespace, environmentBuilds },
    windows: { getActiveWindow }
  })
  const packagesIpcOptions = {
    ipcMain,
    lifecycle: { getAppVersion: () => app.getVersion(), invalidateAgentSession },
    workspace: { agentDir: AGENT_DIR },
    windows: { getActiveWindow },
    plugins: { installedPluginNamespace, environmentBuilds },
    packages: {
      officialContentSourceOptions,
      knownContentSourceOptions,
      loadPackageRegistries
    },
    updates: {
      refreshCachedPackageUpdates,
      packageUpdateViews,
      replaceCachedPackageUpdates: (updates) => runtime.caches.replaceCachedPackageUpdates(updates)
    }
  }
  registerPackageCatalogIpc(packagesIpcOptions)
  registerGithubSourceIpc({
    ipcMain,
    workspace: { agentDir: AGENT_DIR },
    sources: { officialRegistryFetch },
    updates: {
      clearCachedPackageUpdates: () => runtime.caches.clearCachedPackageUpdates(),
      sendNoAvailableUpdates: () => {
        const mainWindow = runtime.window.mainWindow
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.packages.updatesAvailable, [])
        }
      }
    }
  })
  registerPackageOperationsIpc(packagesIpcOptions)
  registerSkillsIpc({
    ipcMain,
    lifecycle: { invalidateAgentSession },
    workspace: {
      agentDir: AGENT_DIR,
      getCurrentCwd: () => sessionState.cwd,
      isRemoteResourceScope,
      remoteSkillProjectContext,
      listRemoteProjectSkills
    },
    plugins: { installedPluginNamespace }
  })
  registerAgentsIpc({
    ipcMain,
    lifecycle: { invalidateAgentSession },
    workspace: {
      agentDir: AGENT_DIR,
      bundledDir: getBundledAgentsDir(),
      getCurrentCwd: () => sessionState.cwd,
      currentRemoteAnalysisProject,
      isRemoteResourceScope
    }
  })
  registerMcpIpc({
    ipcMain,
    lifecycle: {
      getAppVersion: () => app.getVersion(),
      invalidateAgentSession,
      sendToAllWindows
    },
    workspace: {
      agentDir: AGENT_DIR,
      getCurrentCwd: () => sessionState.cwd,
      isRemoteResourceScope,
      resolveRemoteProjectContext: remoteSkillProjectContext
    },
    packages: {
      loadPackageRegistries,
      officialContentSourceOptions,
      environmentBuilds
    },
    customAuthorization: {
      pending: pendingCustomMcpAuthorizations,
      parseUrl: customMcpAuthUrl,
      configDigest: customMcpConfigDigest
    }
  })
  registerWrapperPlanIpc(wrappersIpcOptions)
  registerEnvironmentBuildsIpc({ ipcMain, environmentBuilds })
  registerJobsIpc({ ipcMain, operations: backgroundJobOperations })
  registerWrapperRunIpc(wrappersIpcOptions)

  registerPersonaIpc({
    ipcMain,
    appName: APP_NAME,
    lifecycle: { invalidateAgentSession, logUnexpectedError },
    generation: {
      generatePersonaMarkdown: (description, control) =>
        generatePersonaMarkdownForIpc(description, control, {
          getSelectedModel: () => sessionState.selectedModel,
          getNoProjectTaskFolder,
          text: { extractAssistantText, extractMessageText, lastAssistantMessageFrom }
        })
    },
    rpc: {
      getCurrentSessionKey: () => sessionState.sessionKey,
      resolveSessionKeyAlias,
      getPhiSessionIdForKey,
      findPhiSessionById,
      isRemoteOmpRpcEnabled: () => remoteOmpRpcEnabled,
      captureSessionControlTarget
    }
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
      runtime.window.destroyMenuBarController()
      // Stop local wrapper runs; detach remote runs so the next app launch can resume watching them.
      try {
        wrapperJobs.shutdown()
      } catch {
        writeAppLog({ level: 'error', event: 'wrapper_shutdown_failed' })
      }
      try {
        const blockerId = runtime.caches.preventSleepBlockerId
        if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
          powerSaveBlocker.stop(blockerId)
          runtime.caches.clearPreventSleepBlockerId()
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
