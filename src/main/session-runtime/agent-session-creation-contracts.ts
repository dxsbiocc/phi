import type { RuntimeRecoveryModelSelection } from '../../shared/runtimeRecoveryTypes'
import type { RuntimeSelectionControl } from '../agent/engine/types'
import type { ModelSelection, Project } from '../agent/projects'
import type {
  InlineExtension,
  ModelRuntime,
  RuntimeModel,
  RuntimeSessionManager
} from '../agent/runtime/runtime-adapter'
import type {
  SessionCreationApprovalContext,
  SessionCreationApprovalDependencies
} from '../agent/session/session-creation-approvals'
import type { SessionCreationModelResolution } from '../agent/session/session-creation-model'
import {
  buildSessionCreationOptions,
  type SessionCreationOptions,
  type SessionCreationOptionsInput
} from '../agent/session/session-creation-options'
import type {
  SessionCreationContext,
  SessionCreationContextDependencies
} from '../agent/session/session-creation-context'
import {
  assembleSessionCreationResources,
  createSessionCreationResourceLookup,
  discoverLocalSessionCreationAgents,
  emptySessionCreationAgentScan,
  loadRemoteSessionCreationAgents,
  loadRemoteSessionCreationMcp,
  loadRemoteSessionCreationSkills,
  sessionCreationAgentDiagnosticLog
} from '../agent/session/session-creation-resources'
import type { SessionLifecycle, SessionSnapshot } from '../agent/session/session-lifecycle'
import type {
  PhiSessionManifest,
  appendSessionEvent,
  updateSessionManifest
} from '../agent/session/session-store'
import type { SessionState } from '../app-state/session-state'
import type { SessionKeyRegistry } from '../app-state/session-key-registry'
import type { SessionLifecycleRegistry } from '../app-state/session-lifecycle-registry'
import type { PromptRunRegistry } from '../app-state/prompt-run-registry'
import type { SessionPreferenceTable } from '../app-state/session-preferences'
import type { SessionResolution } from './session-resolution'
import type { SessionOrigins } from './session-origins'

export interface CreationPromptRun {
  phiSessionId: string
  runId: string
  cancelled: boolean
}

export interface CreationSession {
  runtimeSessionId: string
  sessionFile?: string
  abort(options?: { preserveApprovals?: boolean }): Promise<void>
  dispose(): Promise<void>
}

export interface CreationResult<TSession extends CreationSession> {
  session: TSession
}

export interface SessionCreationRuntime {
  thinkingLevel: SessionCreationOptionsInput['thinkingLevel']
  abortController: AbortController
}

export interface SessionCreationModelPhase {
  resolution: SessionCreationModelResolution
  runtime: SessionCreationRuntime
}

export interface BeginSessionCreationInput<TResult> {
  sessionKey: string
  snapshot: SessionSnapshot
  generation: number
  lifecycle: SessionLifecycle<TResult>
  control?: RuntimeSelectionControl
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
}

export interface AgentSessionCreationRequest<TResult> {
  sessionKey: string
  lifecycle: SessionLifecycle<TResult>
  control?: RuntimeSelectionControl
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
}

export interface AgentSessionCreationServices {
  emptyAgentScan: typeof emptySessionCreationAgentScan
  discoverLocalAgents: typeof discoverLocalSessionCreationAgents
  loadRemoteAgents: typeof loadRemoteSessionCreationAgents
  loadRemoteSkills: typeof loadRemoteSessionCreationSkills
  loadRemoteMcp: typeof loadRemoteSessionCreationMcp
  createResourceLookup: typeof createSessionCreationResourceLookup
  assembleResources: typeof assembleSessionCreationResources
  diagnosticLog: typeof sessionCreationAgentDiagnosticLog
  buildOptions: typeof buildSessionCreationOptions
}

export function createDefaultAgentSessionCreationServices(): AgentSessionCreationServices {
  return {
    emptyAgentScan: emptySessionCreationAgentScan,
    discoverLocalAgents: discoverLocalSessionCreationAgents,
    loadRemoteAgents: loadRemoteSessionCreationAgents,
    loadRemoteSkills: loadRemoteSessionCreationSkills,
    loadRemoteMcp: loadRemoteSessionCreationMcp,
    createResourceLookup: createSessionCreationResourceLookup,
    assembleResources: assembleSessionCreationResources,
    diagnosticLog: sessionCreationAgentDiagnosticLog,
    buildOptions: buildSessionCreationOptions
  }
}

export interface AgentSessionCreationDeps<
  TPromptRun extends CreationPromptRun,
  TResult extends CreationResult<TSession>,
  TSession extends CreationSession = TResult['session']
> {
  workspace: {
    agentDir: string
    getPersonaMarkdown(): string
    getBundledAgentsDir(): string
  }
  state: {
    sessionState: Pick<
      SessionState,
      'sessionKey' | 'sessionPath' | 'cwd' | 'permissionMode' | 'updateCreatedSessionPath'
    >
    sessionKeys: Pick<
      SessionKeyRegistry,
      'canonicalize' | 'phiSessionIdFor' | 'recordOrigin' | 'sameCanonical'
    >
    lifecycles: Pick<
      SessionLifecycleRegistry<TResult>,
      'forKey' | 'waitForCleanup' | 'installAbortController'
    >
    promptRuns: Pick<PromptRunRegistry<TPromptRun>, 'generationFor' | 'activeRun'>
    modelSelections: Pick<SessionPreferenceTable<ModelSelection | null>, 'set'>
  }
  context: SessionCreationContextDependencies
  sessions: {
    resolution: Pick<
      SessionResolution,
      'resolveSessionModelSelection' | 'resolveSessionThinkingLevel'
    >
    origins: Pick<SessionOrigins, 'currentRuntimeOriginScope'>
    findById(sessionId: string): PhiSessionManifest | null
    updateManifest: typeof updateSessionManifest
    appendEvent: typeof appendSessionEvent
    runtimeSessionPathForSnapshot(sessionKey: string, snapshot: SessionSnapshot): string | undefined
    uiSessionPathForKey(sessionKey: string, fallbackPath: string | undefined): string | null
    linkPromptRunRuntimeSessionPath(
      sessionKey: string,
      cwd: string,
      run: TPromptRun,
      session: TSession
    ): void
    linkMaterializedRuntimeSessionPath(
      sessionKey: string,
      cwd: string,
      sessionFile: string | undefined,
      phiSessionId?: string
    ): void
    notifySessionChanged(): void
  }
  runtime: {
    getModelRuntime(): Promise<ModelRuntime>
    resolveRuntimeModelSelection(
      runtime: ModelRuntime,
      selection: ModelSelection
    ): SessionCreationModelResolution['resolvedModel']
    selectionThinking(
      model: RuntimeModel,
      desired: SessionCreationOptionsInput['thinkingLevel']
    ): { phi: SessionCreationOptionsInput['thinkingLevel'] }
    createSessionManager(cwd: string, path?: string): RuntimeSessionManager
    createRemoteSessionManager(
      cwd: string,
      phiSessionId: string,
      recover: boolean
    ): RuntimeSessionManager
    createAgentSession(
      options: SessionCreationOptions,
      onEvent: undefined,
      control?: RuntimeSelectionControl
    ): Promise<TResult>
    ownsRemoteRuntimeSession(runtimeSessionId: string): boolean
    projectRemoteRuntimeRoot(project: Project): { configured: string }
    requireProject(projectId: string): Project
    loadRemoteProjectInstructions(
      location: Extract<Project['location'], { kind: 'ssh' }>
    ): Promise<Array<{ path: string; content: string }> | null>
  }
  resources: {
    notebook: {
      getProjectByCwd(cwd: string): Project | undefined
      status(cwd: string): { state: string; hasEndpoint: boolean; port?: number }
      activePath(cwd: string): string | undefined
      list(
        cwd: string,
        options: { maxDepth: number; maxEntries: number; maxNotebooks: number }
      ): {
        notebooks: Array<{ path: string; relativePath: string }>
        truncated: boolean
      }
    }
    createApprovalExtensions(
      context: SessionCreationApprovalContext,
      dependencies: SessionCreationApprovalDependencies
    ): InlineExtension[]
    approvalDependencies: SessionCreationApprovalDependencies
    writeAppLog(entry: ReturnType<typeof sessionCreationAgentDiagnosticLog>): void
  }
  linking: {
    recordRuntimeOrigin(
      origin: {
        runtimeSessionId: string
        phiSessionId: string
        projectId: string | null
        cwd: string
        remoteScope?: ReturnType<SessionOrigins['currentRuntimeOriginScope']>
        configuredRuntimeRoot?: string
      },
      agentDir: string
    ): void
  }
  events: {
    publish(payload: Record<string, unknown>): void
    subscribeToCreatedSession(context: SessionCreationContext, result: TResult): void
  }
  cleanup: {
    getSessionControllerKey(snapshot: SessionSnapshot, generation: number): string
    abortAndDisposeSession(session: TSession, options: { cancelApprovals: boolean }): Promise<void>
    abortSessionWithoutCancellingApprovals(session: TSession): Promise<void>
    logUnexpectedError(error: unknown): void
  }
  services?: AgentSessionCreationServices
}

export interface AgentSessionCreation<TResult> {
  getAgentSession(
    sessionKey?: string,
    snapshot?: SessionSnapshot,
    control?: RuntimeSelectionControl,
    remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
  ): Promise<TResult>
}
