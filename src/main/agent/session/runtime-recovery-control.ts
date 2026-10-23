import { createHash } from 'node:crypto'

import type {
  RuntimeRecoveryIssue,
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryState,
  RuntimeRecoverySummary,
  RuntimeRecoveryTarget
} from '../../../shared/runtimeRecoveryTypes'
import { getAuthManager } from '../auth-manager'
import { getPhiEngine, ownsRemoteRuntimeSession } from '../engine/in-process-engine'
import { facadeBindingHash } from '../engine/rpc/facade-session-driver'
import { RemoteRecoveryError, describeRemoteRecoveryFailure } from '../engine/rpc/session-recovery'
import type { ModelSelection, PermissionMode, Project } from '../projects'
import { getProject } from '../projects'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from '../remote-hosts'
import { resolveRemoteWorkspaceHostBinding } from '../remote-workspace-boundary'
import type {
  CreateAgentSessionResult,
  ModelRuntime,
  RuntimeModel
} from '../runtime/runtime-adapter'
import type { RuntimeSelectionControl } from '../engine/types'
import type { ThinkingLevel } from '../runtime/model-thinking-levels'
import { buildRuntimeRecoverySummary } from './recovery-summary'
import {
  createRuntimeRecoveryController,
  runtimeRecoveryMessage,
  type RuntimeRecoveryScope
} from './runtime-recovery-ipc'
import {
  assertRuntimeReferenceProject,
  assertRuntimeScope,
  parseRuntimeReference,
  RuntimeReferenceError
} from './runtime-reference'
import {
  appendSessionEvent,
  findPhiSessionById,
  readSessionEvents,
  type PhiSessionManifest
} from './session-store'
import {
  StaleSessionError,
  type SessionLifecycle,
  type SessionLifecycleRecord,
  type SessionSnapshot
} from './session-lifecycle'
import type { CurrentSessionPayload } from './current-session-reads'
import type { SessionPreferenceTable } from '../../app-state/session-preferences'

interface RuntimeRecoveryOperation {
  controller: AbortController
  done: Promise<void>
}

interface PhiSessionTable<T> {
  get(phiSessionId: string): T | undefined
  set(phiSessionId: string, value: T): void
  has(phiSessionId: string): boolean
  delete(phiSessionId: string): boolean
}

interface PhiSessionSetTable {
  has(phiSessionId: string): boolean
  add(phiSessionId: string): void
  delete(phiSessionId: string): boolean
}

export interface RuntimeRecoveryControlOptions {
  state: {
    getCurrentPayload: () => CurrentSessionPayload
    getCurrentSessionKey: () => string
    getCurrentSessionPath: () => string | undefined
    getCurrentCwd: () => string
    getCurrentPermissionMode: () => PermissionMode
    runtimeRecoveryOperations: PhiSessionTable<RuntimeRecoveryOperation>
    runtimeRecoveryFailures: PhiSessionTable<RuntimeRecoveryIssue>
    manualCompactionIds: PhiSessionSetTable
    sessionModelSelections: SessionPreferenceTable<ModelSelection | null>
    sessionThinkingLevels: SessionPreferenceTable<ThinkingLevel>
  }
  identity: {
    resolveSessionKeyAlias: (sessionKey: string) => string
    sameCanonicalSessionKey: (left: string, right: string) => boolean
    getPromptGeneration: (sessionKey: string) => number
    advancePromptGeneration: (sessionKey: string) => number
  }
  lifecycle: {
    getLifecycleForKey: (sessionKey: string) => SessionLifecycle<CreateAgentSessionResult>
    hasActivePromptRun: (sessionKey: string) => boolean
    runnerGetActiveRun: (sessionId: string) => unknown
    cleanupSessionRecord: (
      record: SessionLifecycleRecord<CreateAgentSessionResult> | null
    ) => Promise<void>
    getAgentSession: (
      sessionKey: string,
      snapshot: SessionSnapshot,
      control?: RuntimeSelectionControl,
      options?: { replacementModel?: RuntimeRecoveryModelSelection }
    ) => Promise<CreateAgentSessionResult>
  }
  projects: {
    projectRemoteRuntimeRoot: (project: Project) => { configured: unknown }
  }
  models: {
    resolveRuntimeModelSelection: (
      runtime: ModelRuntime,
      selection: ModelSelection
    ) => { model: RuntimeModel; selection: ModelSelection; migratedFrom?: ModelSelection } | null
  }
  sessions: {
    createRemoteManagedSession: (projectId: string) => {
      path: string
      sessionId: string
      cwd: string
      permissionMode: PermissionMode
    }
    disposeAndSwitchSession: (
      path: string,
      cwd: string,
      permissionMode: PermissionMode
    ) => Promise<{ sessionGeneration: number }>
  }
  events: { notifySessionChanged: () => void }
}

interface MainRuntimeRecoveryScope extends RuntimeRecoveryScope {
  readonly manifest: PhiSessionManifest
  readonly key: string
  readonly snapshot: SessionSnapshot & { permissionMode: PermissionMode }
  attach(replacement?: RuntimeRecoveryModelSelection): Promise<RuntimeRecoveryState>
}

// eslint-disable-next-line complexity, max-lines-per-function -- Preserves recovery binding and staleness checks verbatim.
async function captureRuntimeRecoveryScope(
  target: RuntimeRecoveryTarget,
  options: RuntimeRecoveryControlOptions
): Promise<MainRuntimeRecoveryScope> {
  const current = options.state.getCurrentPayload()
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
  const key = options.identity.resolveSessionKeyAlias(options.state.getCurrentSessionKey())
  const snapshot = {
    path: options.state.getCurrentSessionPath(),
    cwd: options.state.getCurrentCwd(),
    permissionMode: options.state.getCurrentPermissionMode()
  }
  const lifecycle = options.lifecycle.getLifecycleForKey(key)
  let generation = lifecycle.currentGeneration
  let record = lifecycle.currentRecord
  let promptGeneration = options.identity.getPromptGeneration(key)
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
      project?.location.kind === 'ssh'
        ? options.projects.projectRemoteRuntimeRoot(project).configured
        : null
    ])
  }
  const projectBinding = readProject()
  // eslint-disable-next-line complexity -- Every binding component participates in the stale fence.
  const assertCurrent = (): void => {
    const latest = findPhiSessionById(target.sessionId)
    if (
      (selected &&
        (!options.identity.sameCanonicalSessionKey(key, options.state.getCurrentSessionKey()) ||
          options.state.getCurrentCwd() !== snapshot.cwd)) ||
      options.lifecycle.getLifecycleForKey(key) !== lifecycle ||
      !lifecycle.isCurrentGeneration(generation) ||
      lifecycle.currentRecord !== record ||
      options.identity.getPromptGeneration(key) !== promptGeneration ||
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
      options.lifecycle.hasActivePromptRun(key) ||
      options.lifecycle.runnerGetActiveRun(target.sessionId) ||
      options.state.manualCompactionIds.has(target.sessionId) ||
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
    options.state.runtimeRecoveryFailures.get(target.sessionId) ??
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
  if (manifest.model && !busy() && !options.state.runtimeRecoveryOperations.has(target.sessionId)) {
    const runtime = await getAuthManager().getRuntime()
    assertCurrent()
    const saved = options.models.resolveRuntimeModelSelection(runtime, manifest.model)
    if (!saved || saved.migratedFrom) issue = 'model-unavailable'
  }
  const state: RuntimeRecoveryState = {
    target,
    phase: live
      ? 'connected'
      : busy() || options.state.runtimeRecoveryOperations.has(target.sessionId)
        ? 'busy'
        : manifest.runtimeRef || manifest.runtimeRecoveryError
          ? 'recovery-required'
          : 'not-started',
    issue,
    message: runtimeRecoveryMessage(issue),
    canResume: !live && !busy() && validReference,
    canContinueFromSummary:
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
      options.state.runtimeRecoveryOperations.set(target.sessionId, { controller, done })
      try {
        const previous = lifecycle.advance()
        generation = lifecycle.currentGeneration
        record = lifecycle.currentRecord
        options.identity.advancePromptGeneration(key)
        promptGeneration = options.identity.getPromptGeneration(key)
        selected = false
        options.events.notifySessionChanged()
        await options.lifecycle.cleanupSessionRecord(previous)
        assertCurrent()
        controller.signal.throwIfAborted()
        const creating = options.lifecycle.getAgentSession(
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
          options.state.sessionModelSelections.set(
            options.identity.resolveSessionKeyAlias(key),
            confirmed.model
          )
        if (confirmed?.thinkingLevel === undefined)
          options.state.sessionThinkingLevels.delete(options.identity.resolveSessionKeyAlias(key))
        else
          options.state.sessionThinkingLevels.set(
            options.identity.resolveSessionKeyAlias(key),
            confirmed.thinkingLevel
          )
        options.state.runtimeRecoveryFailures.delete(target.sessionId)
        options.events.notifySessionChanged()
        return {
          ...state,
          target: { ...target, sessionGeneration: generation },
          phase: 'connected',
          issue: undefined,
          message: '原会话已恢复，未重发消息或任务。',
          canResume: false
        }
      } catch (error) {
        options.state.runtimeRecoveryFailures.set(
          target.sessionId,
          describeRemoteRecoveryFailure(error).issue
        )
        options.events.notifySessionChanged()
        throw error
      } finally {
        options.state.runtimeRecoveryOperations.delete(target.sessionId)
        finish()
        options.events.notifySessionChanged()
      }
    }
  }
  return scope
}

export function createMainRuntimeRecoveryController(
  options: RuntimeRecoveryControlOptions
): ReturnType<typeof createRuntimeRecoveryController<MainRuntimeRecoveryScope>> {
  return createRuntimeRecoveryController<MainRuntimeRecoveryScope>({
    capture: (target) => captureRuntimeRecoveryScope(target, options),
    resolveModel: async (selection, scope) => {
      const runtime = await getAuthManager().getRuntime()
      scope.assertCurrent()
      const resolved = options.models.resolveRuntimeModelSelection(runtime, selection)
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
      const created = options.sessions.createRemoteManagedSession(scope.manifest.projectId!)
      appendSessionEvent(created.sessionId, {
        type: 'runtime_recovery_summary',
        content: summary.content,
        provenance: summary.provenance,
        contentSha256: createHash('sha256').update(summary.content).digest('hex')
      })
      const switched = await options.sessions.disposeAndSwitchSession(
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
}
