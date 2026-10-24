import type { PhiSessionManifest } from '../../session/session-store'
import { findPhiSessionById, getSessionDir } from '../../session/session-store'
import { RuntimeReferenceError } from '../../session/runtime-reference'
import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../../remote-workspace-boundary'
import type { AutoCompactionOverrides } from '../../../../shared/contextUsageTypes'
import type { PhiRuntimeRef } from '../../session/runtime-reference'
import { join } from 'node:path'
import { accessSync, constants, lstatSync } from 'node:fs'
import type { WorkMode } from '../../../../shared/sessionMode'
import {
  rpcPromptPolicy,
  type FacadePromptContext,
  type RpcPromptPolicy
} from '../phi-extension/lib/rpc-prompt-policy'
import { filterPersonaContextFile } from '../phi-extension/lib/phi-main-system-prompt'

export function facadePromptContextMatches(
  selected: FacadePromptContext,
  requested: Pick<FacadePromptContext, 'personaMarkdown' | 'contextFiles'>,
  agentDir: string
): boolean {
  return (
    (selected.personaMarkdown ?? '') === (requested.personaMarkdown ?? '') &&
    JSON.stringify(selected.contextFiles.map(({ path, content }) => [path, content])) ===
      JSON.stringify(requested.contextFiles.map(({ path, content }) => [path, content])) &&
    (selected.personaPath === undefined || selected.personaPath === join(agentDir, 'AGENTS.md'))
  )
}
import { remotePlanModeAllowed } from './facade-plan-review-tool'
import {
  effectiveRecoveredRemoteAutoMode,
  readPendingRemoteAutoPlan
} from '../../session/pending-remote-auto-plan'

/** Captures the host-owned pending phase independently from the saved manifest mode. */
export function recoveredFacadeAutoPolicy(
  input: PhiSessionManifest,
  directory = getSessionDir(input.sessionId)
): {
  readonly mode: WorkMode
  readonly tainted: boolean
  assertCurrent(): void
  generation(): { mode: WorkMode; tainted: boolean }
  adoptSelection(runId: string, mode: 'plan' | 'plan_execute'): void
} {
  const phiSessionId = input.sessionId
  const savedMode = input.workMode ?? (input.permissionMode === 'auto' ? 'auto' : 'direct')
  const directoryReady = (): boolean => {
    try {
      if (!lstatSync(directory).isDirectory()) return false
      accessSync(directory, constants.R_OK | constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (!directoryReady())
    return {
      mode: 'plan',
      tainted: true,
      generation() {
        return { mode: 'plan', tainted: true }
      },
      assertCurrent() {
        if (directoryReady())
          throw new RuntimeReferenceError('STALE_GENERATION', '远程会话目录状态已改变')
      },
      adoptSelection() {
        throw new RuntimeReferenceError('STALE_GENERATION', '远程会话目录不可用')
      }
    }
  const first = readPendingRemoteAutoPlan(directory)
  const exact =
    first.state === 'pending' &&
    first.marker.phiSessionId === phiSessionId &&
    first.marker.runId === input.currentRunId
  const recovered = effectiveRecoveredRemoteAutoMode({
    directory,
    phiSessionId,
    runId: input.currentRunId ?? '',
    sessionGeneration: exact ? first.marker.sessionGeneration : -1,
    savedMode
  })
  if (JSON.stringify(readPendingRemoteAutoPlan(directory)) !== JSON.stringify(first))
    throw new RuntimeReferenceError('STALE_GENERATION', '远程自动计划标记在读取期间改变')
  let expected = JSON.stringify(first)
  return {
    ...recovered,
    assertCurrent() {
      if (!directoryReady() || JSON.stringify(readPendingRemoteAutoPlan(directory)) !== expected)
        throw new RuntimeReferenceError('STALE_GENERATION', '远程自动计划标记已改变')
    },
    generation() {
      this.assertCurrent()
      const current = readPendingRemoteAutoPlan(directory)
      const exactCurrent =
        current.state === 'pending' &&
        current.marker.phiSessionId === phiSessionId &&
        current.marker.runId === input.currentRunId
      const mode = effectiveRecoveredRemoteAutoMode({
        directory,
        phiSessionId,
        runId: input.currentRunId ?? '',
        sessionGeneration: exactCurrent ? current.marker.sessionGeneration : -1,
        savedMode
      })
      this.assertCurrent()
      return mode
    },
    adoptSelection(runId, mode) {
      if (expected !== JSON.stringify({ state: 'none' }))
        throw new RuntimeReferenceError('STALE_GENERATION', '远程自动计划阶段已存在')
      const next = readPendingRemoteAutoPlan(directory)
      if (
        next.state !== 'pending' ||
        next.marker.phiSessionId !== phiSessionId ||
        next.marker.runId !== runId ||
        next.marker.mode !== mode
      )
        throw new RuntimeReferenceError('STALE_GENERATION', '远程自动计划标记与当前运行不符')
      expected = JSON.stringify(next)
    }
  }
}

export function recoveredFacadeModeAllowed(
  policy: Pick<ReturnType<typeof recoveredFacadeAutoPolicy>, 'mode' | 'tainted'>,
  flags: { remotePlanExecutionEnabled?: boolean; remotePlanDraftEnabled?: boolean }
): boolean {
  return (
    policy.tainted ||
    remotePlanModeAllowed(
      policy.mode,
      flags.remotePlanExecutionEnabled,
      flags.remotePlanDraftEnabled
    )
  )
}

export function trustedFacadePromptPolicy(input: {
  readonly promptContext: FacadePromptContext
  readonly agentDir: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly binding: RemoteWorkspaceHostBinding
  readonly workMode: WorkMode
}): Readonly<RpcPromptPolicy> {
  const { promptContext, agentDir, phiSessionId, projectId, binding, workMode } = input
  return rpcPromptPolicy({
    ...promptContext,
    contextFiles: filterPersonaContextFile(
      { agentsFiles: [...promptContext.contextFiles] },
      join(agentDir, 'AGENTS.md')
    ).agentsFiles,
    schema: 1,
    nonce: 'preflight',
    phiSessionId,
    projectId,
    projectRoot: binding.canonicalRoot,
    contextRoot: binding.remoteRoot,
    hostAlias: binding.hostAlias,
    workMode,
    generation: 1
  })
}

/** Creation awaits may not silently adopt a changed saved session policy. */
export function sameFacadeSessionPolicy(
  current: PhiSessionManifest,
  captured: PhiSessionManifest
): boolean {
  const snapshot = (session: PhiSessionManifest): string =>
    JSON.stringify([
      session.cwd,
      session.cwdRealPath,
      session.projectLocation,
      session.model,
      session.thinkingLevel,
      session.workMode,
      session.permissionMode,
      session.title,
      session.runtimeRef,
      session.runtimeRecoveryError
    ])
  return snapshot(current) === snapshot(captured)
}

/** Recheck mutable policy and host binding at every remote authority boundary. */
export function assertFacadeAdoptionPolicy(input: {
  readonly phiSessionId: string
  readonly projectId: string
  readonly initial: PhiSessionManifest
  readonly expectedModel: PhiSessionManifest['model']
  readonly expectedThinking: PhiSessionManifest['thinkingLevel']
  readonly expectedAuto: AutoCompactionOverrides
  readonly expectedTitle: string | undefined
  readonly bindingHash: string
  readonly hashBinding: (binding: RemoteWorkspaceHostBinding) => string
  readonly assertCurrent: () => void
}): void {
  input.assertCurrent()
  const latest = findPhiSessionById(input.phiSessionId)
  if (
    !latest ||
    JSON.stringify(latest.model) !== JSON.stringify(input.expectedModel) ||
    latest.thinkingLevel !== input.expectedThinking ||
    latest.workMode !== input.initial.workMode ||
    latest.permissionMode !== input.initial.permissionMode ||
    JSON.stringify(latest.autoCompaction ?? {}) !== JSON.stringify(input.expectedAuto)
  )
    throw new RuntimeReferenceError('STALE_GENERATION', '远程证明期间模型策略已改变')
  if (latest.title !== input.expectedTitle)
    throw new RuntimeReferenceError('STALE_GENERATION', '远程会话名称策略已改变')
  if (latest.cwd !== input.initial.cwd || latest.cwdRealPath !== input.initial.cwdRealPath)
    throw new RuntimeReferenceError('STALE_GENERATION', '远程会话锚点已改变')
  const binding = resolveRemoteWorkspaceHostBinding({
    sessionId: input.phiSessionId,
    projectId: input.projectId
  })
  if (input.hashBinding(binding) !== input.bindingHash)
    throw new RuntimeReferenceError('HOST_IDENTITY_CHANGED', '远程证明期间主机绑定已改变')
}

/** A host tool must still belong to the exact live RPC generation that registered it. */
export function assertFacadeRuntimeOwner(input: {
  readonly owner: () => unknown
  readonly current: () => unknown
  readonly epoch: number
  readonly currentEpoch: () => number
  readonly unavailable: () => boolean
  readonly assertPolicy: () => void
}): void {
  input.assertPolicy()
  if (
    !input.owner() ||
    input.current() !== input.owner() ||
    input.epoch !== input.currentEpoch() ||
    input.unavailable()
  )
    throw new RuntimeReferenceError('STALE_GENERATION', '远程计划工具所属代次已改变')
}

export function facadeRuntimeOwnerIsCurrent(
  input: Parameters<typeof assertFacadeRuntimeOwner>[0] & {
    readonly reference: () => PhiRuntimeRef | undefined
    readonly snapshotReference: () => PhiRuntimeRef
  }
): boolean {
  try {
    assertFacadeRuntimeOwner(input)
    const attached = input.reference()
    if (!attached) return false
    const current = input.snapshotReference()
    return (
      attached.ompSessionId === current.ompSessionId &&
      attached.durableSessionKey === current.durableSessionKey &&
      attached.bindingHash === current.bindingHash &&
      attached.projectId === current.projectId &&
      attached.projectRoot === current.projectRoot
    )
  } catch {
    return false
  }
}
