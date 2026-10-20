import type { BackgroundShellJob } from '../../../shared/backgroundJobTypes'
import { isRecord } from '../../../shared/guards'
import { messageContentTitleText } from '../../../shared/sessionTitle'
import { getPhiEngine } from '../engine/in-process-engine'
import { findPhiSessionById } from '../session/session-store'
import { phiOnlySessionPath } from '../session/sessions'

interface JobOrigin {
  phiSessionId: string
  cwd: string
}

export interface BackgroundShellJobOperationsOptions {
  resolveOriginSession: (originSessionId: string | undefined) => JobOrigin | undefined
  optionalStringField: (record: Record<string, unknown>, key: string) => string | undefined
}

const SHELL_JOB_STATES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])

// eslint-disable-next-line complexity -- Preserves the existing strict worker-record validation.
function backgroundShellJob(
  value: unknown,
  options: BackgroundShellJobOperationsOptions
): BackgroundShellJob[] {
  if (!isRecord(value)) return []
  const agentSessionId = options.optionalStringField(value, 'agentSessionId')
  const jobId = options.optionalStringField(value, 'jobId')
  const command = options.optionalStringField(value, 'command')
  const state = value.state
  const startedAt = value.startedAt
  if (
    !agentSessionId ||
    !jobId ||
    !command ||
    typeof state !== 'string' ||
    !SHELL_JOB_STATES.has(state) ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt)
  )
    return []
  const origin = options.resolveOriginSession(agentSessionId)
  if (!origin) return []
  const manifest = findPhiSessionById(origin.phiSessionId)
  if (!manifest) return []
  const startedAtIso = new Date(startedAt).toISOString()
  const output = options.optionalStringField(value, 'output')?.slice(-160)
  return [
    {
      agentSessionId,
      jobId,
      sessionId: origin.phiSessionId,
      sessionPath: phiOnlySessionPath(origin.phiSessionId),
      sessionTitle: messageContentTitleText(manifest.title) || '新对话',
      command: command.slice(0, 300),
      state: state as BackgroundShellJob['state'],
      startedAt: startedAtIso,
      ...(state !== 'queued' && state !== 'running' ? { completedAt: startedAtIso } : {}),
      ...(output ? { output } : {})
    }
  ]
}

export async function listBackgroundShellJobs(
  options: BackgroundShellJobOperationsOptions
): Promise<BackgroundShellJob[]> {
  const raw = await getPhiEngine().shellJobs.list({})
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((value) => backgroundShellJob(value, options))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 50)
}

export async function stopBackgroundShellJob(
  agentSessionId: unknown,
  jobId: unknown
): Promise<void> {
  if (typeof agentSessionId !== 'string' || !agentSessionId) throw new Error('缺少会话')
  if (typeof jobId !== 'string' || !jobId) throw new Error('缺少后台命令编号')
  const result = await getPhiEngine().shellJobs.cancel({
    sessionId: agentSessionId,
    jobId
  })
  if (!result?.ok) throw new Error('这个后台命令已经结束')
}
