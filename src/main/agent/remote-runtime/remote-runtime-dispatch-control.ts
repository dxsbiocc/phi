import { isRecord } from '../../../shared/guards'
import type { PhiHostRequestContext } from '../engine/types'
import type { RemoteRuntimeDispatchControl } from './controller'
import type { RemoteSkillResourceOwner } from './skill-service'

interface RemoteRuntimeOrigin {
  phiSessionId: string
}

interface RemoteRuntimeRun {
  signal: AbortSignal
}

interface RemoteWorkspaceBinding {
  cacheKey: string
}

export interface RemoteRuntimeDispatchControlDeps {
  fields: {
    optionalStringField(record: Record<string, unknown>, key: string): string | undefined
  }
  sessions: {
    resolveOriginSession(runtimeSessionId: string): RemoteRuntimeOrigin | undefined
    getActiveRun(sessionId: string): RemoteRuntimeRun | null | undefined
    ownsRemoteRuntimeSession(runtimeSessionId: string): boolean
  }
  workspace: {
    resolveBinding(input: { sessionId: string; projectId: string }): RemoteWorkspaceBinding
  }
  engine: {
    resourceOwner(
      runtimeSessionId: string,
      agentRunId: string
    ): RemoteSkillResourceOwner | undefined
  }
}

function dispatchControl(
  params: unknown,
  context: PhiHostRequestContext,
  deps: RemoteRuntimeDispatchControlDeps
): RemoteRuntimeDispatchControl | undefined {
  if (
    !isRecord(params) ||
    (!Object.hasOwn(params, 'remoteSessionId') && !Object.hasOwn(params, 'projectId'))
  )
    return undefined
  const runtimeId = deps.fields.optionalStringField(params, 'runtimeSessionId')
  const sessionId = deps.fields.optionalStringField(params, 'remoteSessionId')
  const projectId = deps.fields.optionalStringField(params, 'projectId')
  if (
    !runtimeId ||
    !sessionId ||
    !projectId ||
    context.originSessionId !== runtimeId ||
    deps.sessions.resolveOriginSession(runtimeId)?.phiSessionId !== sessionId
  )
    throw new Error('远程资源请求的来源会话无效；没有回退到本机执行。')
  const binding = deps.workspace.resolveBinding({ sessionId, projectId })
  const run = deps.sessions.getActiveRun(sessionId)
  const childId = deps.sessions.ownsRemoteRuntimeSession(runtimeId) ? context.agentRunId : undefined
  const readResourceOwner = (): RemoteSkillResourceOwner | undefined => {
    if (!childId) return undefined
    const owner = deps.engine.resourceOwner(runtimeId, childId)
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
      (!childId && context.signal && (!run || deps.sessions.getActiveRun(sessionId) !== run)) ||
      deps.sessions.resolveOriginSession(runtimeId)?.phiSessionId !== sessionId ||
      deps.workspace.resolveBinding({ sessionId, projectId }).cacheKey !== binding.cacheKey
    )
      throw new Error('远程资源运行或项目绑定已改变；没有回退到本机执行。')
  }
  beforeDispatch()
  return { signal: context.signal, beforeDispatch, ...(resourceOwner ? { resourceOwner } : {}) }
}

function cancellation(
  params: unknown,
  context: PhiHostRequestContext,
  deps: RemoteRuntimeDispatchControlDeps
): boolean {
  if (
    !isRecord(params) ||
    (!Object.hasOwn(params, 'remoteSessionId') && !Object.hasOwn(params, 'projectId'))
  )
    return false
  const runtimeId = deps.fields.optionalStringField(params, 'runtimeSessionId')
  if (
    !runtimeId ||
    context.originSessionId !== runtimeId ||
    deps.sessions.resolveOriginSession(runtimeId)?.phiSessionId !== params.remoteSessionId
  )
    throw new Error('远程资源取消请求的来源会话无效')
  return true
}

export function createRemoteRuntimeDispatchControl(deps: RemoteRuntimeDispatchControlDeps): {
  remoteRuntimeDispatchControl(
    params: unknown,
    context: PhiHostRequestContext
  ): RemoteRuntimeDispatchControl | undefined
  isRemoteRuntimeCancellation(params: unknown, context: PhiHostRequestContext): boolean
} {
  return {
    remoteRuntimeDispatchControl: (params, context) => dispatchControl(params, context, deps),
    isRemoteRuntimeCancellation: (params, context) => cancellation(params, context, deps)
  }
}
