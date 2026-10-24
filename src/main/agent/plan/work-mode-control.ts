import type { ProjectLocation } from '../../../shared/projectLocation'
import {
  fieldsFromMode,
  type SessionMode,
  type SessionModeFields
} from '../../../shared/sessionMode'
import { validateSessionPermissionModeUpdate } from '../session/permission-mode-control'

const SESSION_MODES = new Set<SessionMode>(['auto', 'ask', 'plan', 'plan_execute', 'full'])

export function validateSessionMode(mode: unknown): SessionMode {
  if (typeof mode !== 'string' || !SESSION_MODES.has(mode as SessionMode)) {
    throw new Error('会话模式无效')
  }
  return mode as SessionMode
}

export function validateSessionModeUpdate(
  mode: unknown,
  target: unknown,
  current: {
    path: string | null
    phiSessionId?: string
    sessionGeneration: number
    projectLocation?: ProjectLocation
  }
): SessionModeFields {
  const sessionMode = validateSessionMode(mode)
  const fields = fieldsFromMode(sessionMode)
  validateSessionPermissionModeUpdate(fields.permissionMode, target, current)
  if (
    current.projectLocation?.kind === 'ssh' &&
    (sessionMode === 'plan' || sessionMode === 'plan_execute')
  ) {
    throw new Error('远程项目暂不支持计划评审')
  }
  return fields
}

export function planModeRequest(
  sessionId: string,
  workMode: SessionModeFields['workMode']
): { sessionId: string; execute?: true } | undefined {
  if (workMode === 'plan') return { sessionId }
  if (workMode === 'plan_execute') return { sessionId, execute: true }
  return undefined
}

interface WorkModeCurrent {
  path: string | null
  phiSessionId?: string
  sessionGeneration: number
  projectLocation?: ProjectLocation
  workMode: SessionModeFields['workMode']
}

export interface WorkModeActivity {
  hasActivePlanWork(sessionId: string): boolean
  hasActiveAgentRuns(sessionId: string): Promise<boolean>
}

export interface WorkModeControlDeps<TCurrent extends WorkModeCurrent, TRecord> {
  state: {
    getCurrentSessionKey(): string
    getCurrentSessionPath(): string | undefined
    getCurrentCwd(): string
    setCurrentPermissionMode(mode: SessionModeFields['permissionMode']): void
    sessionPermissionModes: { set(key: string, mode: SessionModeFields['permissionMode']): void }
  }
  reads: { getCurrentSessionPayload(): TCurrent }
  identity: {
    resolveSessionKeyAlias(key: string): string
    getPhiSessionIdForKey(key: string): string | undefined
    findPhiManifestForSession(key: string, path: string, cwd: string): { sessionId: string } | null
  }
  lifecycle: {
    getLifecycleForKey(key: string): { advance(): TRecord }
    cleanupSessionRecord(record: TRecord, options: { cancelApprovals: boolean }): Promise<void>
  }
  status: {
    runnerGetActiveRun(sessionId: string): unknown
    activePromptEntries(): Array<[string, { phiSessionId: string }]>
    notifySessionChanged(): void
  }
  activity: WorkModeActivity
  updateManifest(sessionId: string, fields: SessionModeFields): void
}

const ACTIVE_WORK_ERROR = '计划或后台智能体仍在运行，请先暂停或等待结束后再切换模式'

function currentPhiSessionId<TCurrent extends WorkModeCurrent, TRecord>(
  deps: WorkModeControlDeps<TCurrent, TRecord>
): string | undefined {
  const key = deps.state.getCurrentSessionKey()
  const path = deps.state.getCurrentSessionPath()
  return (
    deps.identity.getPhiSessionIdForKey(key) ??
    (path
      ? deps.identity.findPhiManifestForSession(key, path, deps.state.getCurrentCwd())?.sessionId
      : undefined)
  )
}

function hasImmediateActiveWork<TCurrent extends WorkModeCurrent, TRecord>(
  deps: WorkModeControlDeps<TCurrent, TRecord>,
  sessionId: string
): boolean {
  return Boolean(
    deps.status.runnerGetActiveRun(sessionId) ||
    deps.status.activePromptEntries().some(([, run]) => run.phiSessionId === sessionId) ||
    deps.activity.hasActivePlanWork(sessionId)
  )
}

export function createWorkModeControl<TCurrent extends WorkModeCurrent, TRecord>(
  deps: WorkModeControlDeps<TCurrent, TRecord>
): { update(mode: unknown, target: unknown): Promise<TCurrent> } {
  return {
    update: async (mode, target) => {
      const current = deps.reads.getCurrentSessionPayload()
      const fields = validateSessionModeUpdate(mode, target, current)
      const sessionId = currentPhiSessionId(deps)
      if (!sessionId) throw new Error('会话模式只能用于 Phi 会话')
      const workModeChanged = fields.workMode !== current.workMode
      if (workModeChanged) {
        if (
          hasImmediateActiveWork(deps, sessionId) ||
          (await deps.activity.hasActiveAgentRuns(sessionId)) ||
          hasImmediateActiveWork(deps, sessionId)
        ) {
          throw new Error(ACTIVE_WORK_ERROR)
        }
        validateSessionModeUpdate(mode, target, deps.reads.getCurrentSessionPayload())
      }
      const key = deps.state.getCurrentSessionKey()
      deps.updateManifest(sessionId, fields)
      deps.state.setCurrentPermissionMode(fields.permissionMode)
      deps.state.sessionPermissionModes.set(
        deps.identity.resolveSessionKeyAlias(key),
        fields.permissionMode
      )
      if (workModeChanged) {
        const record = deps.lifecycle.getLifecycleForKey(key).advance()
        await deps.lifecycle.cleanupSessionRecord(record, { cancelApprovals: true })
      }
      deps.status.notifySessionChanged()
      return deps.reads.getCurrentSessionPayload()
    }
  }
}
