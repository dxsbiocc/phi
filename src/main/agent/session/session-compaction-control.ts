import type {
  AutoCompactionOverrides,
  AutoCompactionSettingsPatch,
  CurrentAutoCompactionSettings,
  ManualCompactionOutcome,
  ManualCompactionTarget
} from '../../../shared/contextUsageTypes'
import { errorMessage } from '../../../shared/errorCodes'
import { IPC } from '../../../shared/ipcChannels'
import type { PermissionMode } from '../projects'
import { readRpcCompactionPolicy } from '../engine/in-process-engine'
import {
  readAutoCompactionDefaults,
  type CreateAgentSessionResult
} from '../runtime/runtime-adapter'
import {
  appendSessionEvent,
  findPhiSessionById,
  updateSessionManifest,
  type PhiSessionManifest,
  type StoredSessionEvent
} from './session-store'
import { phiOnlySessionPath } from './sessions'
import type { CurrentSessionPayload } from './current-session-reads'
import type { SessionSnapshot } from './session-lifecycle'

interface SessionControlTarget {
  current: CurrentSessionPayload
  rpc: boolean
  assertCurrent(): void
  acceptManual(): void
  resolved(snapshot?: SessionSnapshot): Promise<CreateAgentSessionResult | null>
}

interface ManualCompactionOperation {
  session?: CreateAgentSessionResult['session']
  cancelled: boolean
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

export interface SessionCompactionControlOptions {
  workspace: { agentDir: string }
  state: {
    getCurrentPayload: () => CurrentSessionPayload
    getCurrentSessionKey: () => string
    getCurrentSessionPath: () => string | undefined
    getCurrentCwd: () => string
    getCurrentPermissionMode: () => PermissionMode
    manualCompactionIds: PhiSessionSetTable
    manualCompactionOperations: PhiSessionTable<ManualCompactionOperation>
  }
  sessions: {
    findPhiManifestForSession: (
      sessionKey: string,
      path: string | undefined,
      cwd: string
    ) => PhiSessionManifest | null
    runtimeSessionPathForSnapshot: (
      sessionKey: string,
      snapshot: SessionSnapshot
    ) => string | undefined
    ensurePhiSessionId: (
      sessionKey: string,
      snapshot: SessionSnapshot & { permissionMode: PermissionMode }
    ) => string
    hasActivePromptRun: (sessionKey: string) => boolean
    captureSessionControlTarget: (
      sessionKey: string,
      phiSessionId: string,
      manual?: boolean,
      requireIdle?: boolean
    ) => SessionControlTarget
    getSessionGeneration: (sessionKey: string) => number
  }
  events: {
    sendToAllWindows: (channel: string, ...args: unknown[]) => void
    notifySessionChanged: () => void
    logUnexpectedError: (error: unknown) => void
    flushPendingContinuations: (phiSessionId: string, runWasCancelled: boolean) => void
  }
}

function currentAutoCompactionContext(
  target: unknown,
  options: SessionCompactionControlOptions
): {
  current: CurrentSessionPayload
  manifest: PhiSessionManifest | null
  sessionKey: string
} {
  const current = options.state.getCurrentPayload()
  const requested = target as Partial<ManualCompactionTarget> | null
  if (
    !requested ||
    requested.sessionPath !== current.path ||
    (requested.phiSessionId ?? null) !== (current.phiSessionId ?? null) ||
    requested.sessionGeneration !== current.sessionGeneration
  ) {
    throw new Error('会话已切换，请重新打开自动压缩设置')
  }
  const sessionKey = options.state.getCurrentSessionKey()
  const manifest = options.sessions.findPhiManifestForSession(
    sessionKey,
    current.path ?? undefined,
    current.cwd
  )
  return { current, manifest, sessionKey }
}

function autoCompactionSettingsFromDefaults(
  current: CurrentSessionPayload,
  defaults: Awaited<ReturnType<typeof readAutoCompactionDefaults>>
): CurrentAutoCompactionSettings {
  return {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration,
    enabled: defaults.enabled,
    thresholdPercent: defaults.thresholdPercent,
    defaults,
    overrides: {}
  }
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

// eslint-disable-next-line complexity -- Preserves the settings fallback precedence verbatim.
export async function getCurrentAutoCompactionSettings(
  target: unknown,
  options: SessionCompactionControlOptions
): Promise<CurrentAutoCompactionSettings> {
  const { current, manifest, sessionKey } = currentAutoCompactionContext(target, options)
  if (!manifest) {
    return autoCompactionSettingsFromDefaults(
      current,
      await readAutoCompactionDefaults(current.cwd, options.workspace.agentDir)
    )
  }
  const captured = options.sessions.captureSessionControlTarget(
    sessionKey,
    manifest.sessionId,
    false,
    false
  )
  const ready = await captured.resolved()
  const receipt =
    captured.rpc && ready ? await ready.session.getAutoCompactionSettings?.(captured) : undefined
  captured.assertCurrent()
  const defaults =
    receipt?.defaults ??
    (captured.rpc
      ? (await readRpcCompactionPolicy(options.workspace.agentDir, manifest.autoCompaction ?? {}))
          .defaults
      : await readAutoCompactionDefaults(current.cwd, options.workspace.agentDir))
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

// eslint-disable-next-line complexity -- Preserves null-reset and remote receipt semantics verbatim.
export async function setCurrentAutoCompactionSettings(
  target: unknown,
  value: unknown,
  options: SessionCompactionControlOptions
): Promise<CurrentAutoCompactionSettings> {
  const located = currentAutoCompactionContext(target, options)
  let manifest = located.manifest
  if (!manifest) {
    const phiSessionId = options.sessions.ensurePhiSessionId(located.sessionKey, {
      path: options.state.getCurrentSessionPath(),
      cwd: options.state.getCurrentCwd(),
      permissionMode: options.state.getCurrentPermissionMode()
    })
    manifest = findPhiSessionById(phiSessionId)
  }
  if (!manifest) throw new Error('当前会话尚未建立设置记录')
  const current = options.state.getCurrentPayload()
  const sessionKey = options.state.getCurrentSessionKey()
  const captured = options.sessions.captureSessionControlTarget(sessionKey, manifest.sessionId)
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
      : (await readRpcCompactionPolicy(options.workspace.agentDir, overrides)).defaults
    : await readAutoCompactionDefaults(current.cwd, options.workspace.agentDir)
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
  options.events.notifySessionChanged()
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

// eslint-disable-next-line complexity, max-lines-per-function -- Preserves manual compaction lifecycle and event ordering.
export async function compactCurrentSession(
  target: unknown,
  options: SessionCompactionControlOptions
): Promise<ManualCompactionOutcome> {
  const current = options.state.getCurrentPayload()
  const requested = target as Partial<ManualCompactionTarget> | null
  if (
    !requested ||
    requested.sessionPath !== current.path ||
    (requested.phiSessionId ?? null) !== (current.phiSessionId ?? null) ||
    requested.sessionGeneration !== current.sessionGeneration
  ) {
    throw new Error('会话已切换，请重新打开压缩操作')
  }
  const sessionKey = options.state.getCurrentSessionKey()
  const snapshot: SessionSnapshot & { permissionMode: PermissionMode } = {
    path: options.state.getCurrentSessionPath(),
    cwd: options.state.getCurrentCwd(),
    permissionMode: options.state.getCurrentPermissionMode()
  }
  if (options.sessions.hasActivePromptRun(sessionKey))
    throw new Error('请等待当前会话运行结束后再压缩')
  const manifest = options.sessions.findPhiManifestForSession(
    sessionKey,
    snapshot.path,
    snapshot.cwd
  )
  if (
    !options.sessions.runtimeSessionPathForSnapshot(sessionKey, snapshot) &&
    !(manifest?.projectLocation?.kind === 'ssh' && manifest.runtimeRef)
  ) {
    throw new Error('当前会话暂无可压缩的历史')
  }

  const phiSessionId = options.sessions.ensurePhiSessionId(sessionKey, snapshot)
  if (options.state.manualCompactionIds.has(phiSessionId)) throw new Error('上下文压缩正在进行')
  const captured = options.sessions.captureSessionControlTarget(sessionKey, phiSessionId, true)
  let finish!: () => void
  const operation: ManualCompactionOperation = {
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
  options.state.manualCompactionIds.add(phiSessionId)
  options.state.manualCompactionOperations.set(phiSessionId, operation)
  const sessionPath = phiOnlySessionPath(phiSessionId)
  const sessionGeneration = options.sessions.getSessionGeneration(sessionKey)
  const broadcast = (event: StoredSessionEvent): void => {
    options.events.sendToAllWindows(IPC.agent.event, {
      source: 'phi',
      ...event,
      phiSessionId,
      sessionPath,
      sessionGeneration,
      cwd: snapshot.cwd
    })
    options.events.notifySessionChanged()
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
      const failureMessage = errorMessage(error)
      try {
        broadcast(
          appendSessionEvent(phiSessionId, {
            type: 'context_compaction_failed',
            action: 'manual',
            reason: 'user',
            errorMessage: failureMessage.slice(0, 500)
          })
        )
      } catch (persistError) {
        options.events.logUnexpectedError(persistError)
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
    options.state.manualCompactionOperations.delete(phiSessionId)
    options.state.manualCompactionIds.delete(phiSessionId)
    finish()
    options.events.flushPendingContinuations(phiSessionId, false)
  }
}
