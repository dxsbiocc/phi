import type { CreateAgentSessionResult } from '../runtime/runtime-adapter'
import type { PhiSessionManifest } from './session-store'
import { SessionLifecycle, StaleSessionError } from './session-lifecycle'

export interface ModelSelectionTarget {
  key: string
  phiSessionId: string | undefined
  rpc: boolean
  assertCurrent(): void
  resolved(): Promise<CreateAgentSessionResult | null>
}

export interface ModelSelectionTargetDependencies {
  getCurrentSessionKey: () => string
  getCurrentCwd: () => string
  resolveSessionKeyAlias: (sessionKey: string) => string
  getPhiSessionIdForKey: (sessionKey: string) => string | undefined
  findPhiSessionById: (sessionId: string) => PhiSessionManifest | null
  getCurrentLifecycle: () => SessionLifecycle<CreateAgentSessionResult>
  sameCanonicalSessionKey: (left: string, right: string) => boolean
  hasActivePromptRun: (sessionKey: string) => boolean
  getActiveSessionRun: (sessionId: string) => unknown
}

export function captureCurrentSelectionTarget(
  dependencies: ModelSelectionTargetDependencies
): ModelSelectionTarget {
  const key = dependencies.resolveSessionKeyAlias(dependencies.getCurrentSessionKey())
  const cwd = dependencies.getCurrentCwd()
  const phiSessionId = dependencies.getPhiSessionIdForKey(key)
  const manifest = phiSessionId ? dependencies.findPhiSessionById(phiSessionId) : null
  const lifecycle = dependencies.getCurrentLifecycle()
  const generation = lifecycle.currentGeneration
  const record = lifecycle.currentRecord
  const rpc = Boolean(manifest?.runtimeRef || manifest?.projectLocation?.kind === 'ssh')
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
    const latest = phiSessionId ? dependencies.findPhiSessionById(phiSessionId) : null
    if (
      !dependencies.sameCanonicalSessionKey(key, dependencies.getCurrentSessionKey()) ||
      dependencies.getCurrentCwd() !== cwd ||
      dependencies.getPhiSessionIdForKey(dependencies.getCurrentSessionKey()) !== phiSessionId ||
      dependencies.getCurrentLifecycle() !== lifecycle ||
      !lifecycle.isCurrentGeneration(generation) ||
      lifecycle.currentRecord !== record ||
      identity(latest) !== initialIdentity
    )
      throw new StaleSessionError()
    if (
      rpc &&
      (dependencies.hasActivePromptRun(key) ||
        (phiSessionId && dependencies.getActiveSessionRun(phiSessionId)))
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
