import type { PhiSessionManifest } from '../session/session-store'

export const MAX_AGENT_STEER_LENGTH = 4000

interface AgentRunControlDependencies {
  resolveRecoverableJobOrigin: (
    agentSessionId: string
  ) => { phiSessionId: string; cwd: string } | undefined
  findPhiSessionById: (sessionId: string) => PhiSessionManifest | null
  ownsRemoteRuntimeSession: (sessionId: string) => boolean
  resolveOriginSession: (
    agentSessionId: string
  ) => { phiSessionId: string; cwd: string } | undefined
  hasEngineSession: (sessionId: string) => boolean
  currentRuntimeOriginScope: (manifest: PhiSessionManifest) => unknown
  steer: (params: { sessionId: string; runId: string; message: string }) => Promise<unknown>
  stop: (params: { sessionId: string; runId: string }) => Promise<unknown>
}

// eslint-disable-next-line complexity -- Preserves the remote ownership validation order.
export async function requestAgentRunControl(
  dependencies: AgentRunControlDependencies,
  method: 'agentRun.steer' | 'agentRun.stop',
  agentSessionId: unknown,
  agentRunId: unknown,
  message?: string
): Promise<void> {
  if (typeof agentSessionId !== 'string' || !agentSessionId) throw new Error('缺少 Agent 会话')
  if (typeof agentRunId !== 'string' || !agentRunId) throw new Error('缺少 Agent 运行编号')
  const origin = dependencies.resolveRecoverableJobOrigin(agentSessionId)
  const manifest = origin ? dependencies.findPhiSessionById(origin.phiSessionId) : null
  if (
    manifest?.projectLocation?.kind === 'ssh' ||
    manifest?.runtimeRef ||
    manifest?.runtimeRecoveryError
  ) {
    if (
      !dependencies.ownsRemoteRuntimeSession(agentSessionId) ||
      dependencies.resolveOriginSession(agentSessionId)?.phiSessionId !== manifest.sessionId ||
      !dependencies.hasEngineSession(agentSessionId) ||
      !dependencies.currentRuntimeOriginScope(manifest)
    )
      throw new Error('远程专家任务当前没有可控制的连接；旧任务不会在本机重新启动。')
  }
  const params = {
    sessionId: agentSessionId,
    runId: agentRunId,
    ...(message !== undefined ? { message } : {})
  }
  if (method === 'agentRun.steer')
    await dependencies.steer(params as { sessionId: string; runId: string; message: string })
  else await dependencies.stop(params)
}

interface AgentSteerPersistenceDependencies {
  resolveOriginSession: (
    agentSessionId: string
  ) => { phiSessionId: string; cwd: string } | undefined
  appendSessionEvent: (
    phiSessionId: string,
    event: {
      type: 'agent_execution_steered'
      toolCallId: string
      agentRunId?: string
      text: string
    }
  ) => Record<string, unknown>
  redactSensitiveText: (text: string) => string
  sendRunEventToWindow: (event: Record<string, unknown>) => void
  logUnexpectedError: (error: unknown) => void
}

export function recordAgentSteer(
  dependencies: AgentSteerPersistenceDependencies,
  agentSessionId: unknown,
  agentRunId: unknown,
  toolCallId: unknown,
  text: string
): void {
  if (typeof toolCallId !== 'string' || !toolCallId) return
  try {
    const origin = dependencies.resolveOriginSession(
      typeof agentSessionId === 'string' ? agentSessionId : ''
    )
    if (!origin) return
    const stored = dependencies.appendSessionEvent(origin.phiSessionId, {
      type: 'agent_execution_steered',
      toolCallId,
      ...(typeof agentRunId === 'string' ? { agentRunId } : {}),
      text: dependencies.redactSensitiveText(text)
    })
    dependencies.sendRunEventToWindow({
      source: 'phi',
      ...stored,
      phiSessionId: origin.phiSessionId,
      cwd: origin.cwd
    })
  } catch (error) {
    dependencies.logUnexpectedError(error)
  }
}
