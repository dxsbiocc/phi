import type { CurrentContextUsage } from '../../../shared/contextUsageTypes'
import type { ProjectLocation } from '../../../shared/projectLocation'
import type { PermissionMode } from '../projects'
import { RemoteMetadataBusyError } from '../engine/rpc/runtime-metadata-control'
import type { CreateAgentSessionResult } from '../runtime/runtime-adapter'
import type { PhiSessionManifest } from './session-store'
import {
  isStaleSessionError,
  type SessionLifecycle,
  type SessionSnapshot
} from './session-lifecycle'
import type { LastRunOutcome, SessionStatus, UnreadKind } from './session-store'
import { readPhiTimelineMessages } from './phi-timeline-messages'

export type CurrentSessionPayload = {
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

export interface CurrentContextUsageOptions {
  getCurrentPayload: () => CurrentSessionPayload
  getCurrentSessionKey: () => string
  getCurrentSessionPath: () => string | undefined
  getCurrentCwd: () => string
  getCurrentPermissionMode: () => PermissionMode
  findPhiManifestForSession: (
    sessionKey: string,
    path: string | undefined,
    cwd: string
  ) => PhiSessionManifest | null
  runtimeSessionPathForSnapshot: (
    sessionKey: string,
    snapshot: SessionSnapshot
  ) => string | undefined
  getCurrentLifecycle: () => SessionLifecycle<CreateAgentSessionResult>
  getAgentSession: (
    sessionKey: string,
    snapshot: SessionSnapshot
  ) => Promise<CreateAgentSessionResult>
}

export interface CurrentSessionPayloadMessagesOptions {
  getCurrentPayload: () => CurrentSessionPayload
  getCurrentSessionKey: () => string
  getPhiSessionIdForKey: (sessionKey: string) => string | undefined
  getCurrentLifecycle: () => SessionLifecycle<CreateAgentSessionResult>
  getCurrentResolvedSession: () => Promise<CreateAgentSessionResult | null>
}

async function getCurrentResolvedSessionIfReady(
  getCurrentLifecycle: () => SessionLifecycle<CreateAgentSessionResult>
): Promise<CreateAgentSessionResult | null> {
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

export async function getCurrentContextUsage(
  options: CurrentContextUsageOptions
): Promise<CurrentContextUsage> {
  const current = options.getCurrentPayload()
  const identity = {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration
  }
  const sessionKey = options.getCurrentSessionKey()
  const snapshot: SessionSnapshot = {
    path: options.getCurrentSessionPath(),
    cwd: options.getCurrentCwd(),
    permissionMode: options.getCurrentPermissionMode()
  }
  const manifest = options.findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  const remote = manifest?.projectLocation?.kind === 'ssh'
  if (
    !options.runtimeSessionPathForSnapshot(sessionKey, snapshot) &&
    !(remote && manifest?.runtimeRef)
  ) {
    return { ...identity, usage: null }
  }

  if (
    remote &&
    (current.status === 'running' ||
      current.status === 'needs_approval' ||
      current.status === 'needs_input')
  )
    return { ...identity, usage: null }

  const result = remote
    ? await getCurrentResolvedSessionIfReady(options.getCurrentLifecycle)
    : await options.getAgentSession(sessionKey, snapshot)
  if (!result) return { ...identity, usage: null }
  let usage: CurrentContextUsage['usage']
  try {
    usage = await result.session.getContextUsage()
  } catch (error) {
    if (remote && error instanceof RemoteMetadataBusyError) return { ...identity, usage: null }
    throw error
  }
  const latest = options.getCurrentPayload()
  if (
    latest.path !== identity.sessionPath ||
    (latest.phiSessionId ?? null) !== identity.phiSessionId ||
    latest.sessionGeneration !== identity.sessionGeneration
  ) {
    return { ...identity, usage: null }
  }
  return { ...identity, usage }
}

export async function getCurrentSessionPayloadWithMessages(
  options: CurrentSessionPayloadMessagesOptions
): Promise<CurrentSessionPayload & { messages: unknown[] }> {
  const payload = options.getCurrentPayload()
  const phiSessionId =
    payload.phiSessionId ?? options.getPhiSessionIdForKey(options.getCurrentSessionKey())
  if (!payload.path && !phiSessionId) {
    return { ...payload, messages: [] }
  }

  const current = payload.path
    ? phiSessionId
      ? await getCurrentResolvedSessionIfReady(options.getCurrentLifecycle)
      : await options.getCurrentResolvedSession()
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
