import type { BackgroundAgentJob } from '../../../shared/backgroundJobTypes'
import { isRecord } from '../../../shared/guards'
import { messageContentTitleText } from '../../../shared/sessionTitle'
import { writeAppLog } from '../app-logger'
import { getPhiEngine } from '../engine/in-process-engine'
import { readColdChildRuns } from '../session/child-run-recovery'
import { parseRuntimeReference, type RemoteOmpScope } from '../session/runtime-reference'
import {
  findPhiSessionById,
  listPhiSessions,
  type PhiSessionManifest
} from '../session/session-store'
import { phiOnlySessionPath } from '../session/sessions'

interface JobOrigin {
  phiSessionId: string
  cwd: string
}

export interface BackgroundAgentJobListingOptions {
  agentDir: string
  resolveRecoverableJobOrigin: (originSessionId: string | undefined) => JobOrigin | undefined
  currentRuntimeOriginScope: (manifest: PhiSessionManifest) => RemoteOmpScope | undefined
  optionalStringField: (record: Record<string, unknown>, key: string) => string | undefined
}

// eslint-disable-next-line complexity -- Preserves the existing strict worker-record validation.
function liveBackgroundAgentJob(
  value: unknown,
  options: BackgroundAgentJobListingOptions
): BackgroundAgentJob[] {
  if (!isRecord(value)) return []
  const agentSessionId = options.optionalStringField(value, 'agentSessionId')
  const agentRunId = options.optionalStringField(value, 'agentRunId')
  const agentName = options.optionalStringField(value, 'agentName')
  const state = value.state
  const startedAt = value.startedAt
  if (
    !agentSessionId ||
    !agentRunId ||
    !agentName ||
    (state !== 'queued' &&
      state !== 'running' &&
      state !== 'done' &&
      state !== 'error' &&
      state !== 'cancelled') ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt)
  )
    return []
  const origin = options.resolveRecoverableJobOrigin(agentSessionId)
  if (!origin) return []
  const manifest = findPhiSessionById(origin.phiSessionId)
  if (!manifest) return []
  return [
    {
      agentSessionId,
      agentRunId,
      sessionId: origin.phiSessionId,
      sessionPath: phiOnlySessionPath(origin.phiSessionId),
      sessionTitle: messageContentTitleText(manifest.title) || '新对话',
      agentName,
      task: (options.optionalStringField(value, 'task') ?? '').slice(0, 300),
      state,
      background: value.background === true,
      startedAt: new Date(startedAt).toISOString(),
      ...(typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
        ? { completedAt: new Date(value.completedAt).toISOString() }
        : {}),
      ...(options.optionalStringField(value, 'lastStep')
        ? { lastStep: options.optionalStringField(value, 'lastStep')?.slice(0, 160) }
        : {}),
      ...(typeof value.toolCalls === 'number' && Number.isFinite(value.toolCalls)
        ? { toolCalls: Math.max(0, Math.trunc(value.toolCalls)) }
        : {}),
      ...(options.optionalStringField(value, 'toolCallId')
        ? { toolCallId: options.optionalStringField(value, 'toolCallId') }
        : {})
    }
  ]
}

function coldBackgroundAgentJobsForManifest(
  manifest: PhiSessionManifest,
  liveIds: ReadonlySet<string>,
  options: BackgroundAgentJobListingOptions
): BackgroundAgentJob[] {
  if (!manifest.runtimeRef) return []
  try {
    const scope = options.currentRuntimeOriginScope(manifest)
    if (!scope) return []
    const reference = parseRuntimeReference(manifest.runtimeRef, manifest.sessionId)
    return readColdChildRuns(
      { phiSessionId: manifest.sessionId, reference },
      options.agentDir
    ).flatMap((run): BackgroundAgentJob[] => {
      if (!run.background || liveIds.has(`${manifest.sessionId}:${run.id}`)) return []
      return [
        {
          agentSessionId: '',
          agentRunId: run.id,
          sessionId: manifest.sessionId,
          sessionPath: phiOnlySessionPath(manifest.sessionId),
          sessionTitle: messageContentTitleText(manifest.title) || '新对话',
          agentName: run.agent,
          task: '',
          state:
            run.status === 'completed'
              ? 'done'
              : run.status === 'failed'
                ? 'error'
                : run.status === 'aborted'
                  ? 'cancelled'
                  : 'interrupted',
          background: true,
          canControl: false,
          historyAvailable: false,
          startedAt: new Date(run.startedAt).toISOString(),
          ...(run.completedAt !== undefined
            ? { completedAt: new Date(run.completedAt).toISOString() }
            : {})
        }
      ]
    })
  } catch {
    writeAppLog({
      level: 'error',
      event: 'child_recovery_metadata_unavailable',
      sessionId: manifest.sessionId
    })
    return []
  }
}

export async function listBackgroundAgentJobs(
  options: BackgroundAgentJobListingOptions
): Promise<BackgroundAgentJob[]> {
  const raw = await getPhiEngine().agentRuns.list({})
  if (!Array.isArray(raw)) throw new Error('后台 Agent 状态暂时不可用')
  const live = raw.flatMap((value) => liveBackgroundAgentJob(value, options))
  // Only a successful live listing establishes absence. Persisted records never grant control.
  const liveIds = new Set(live.map((run) => `${run.sessionId}:${run.agentRunId}`))
  const cold = listPhiSessions().flatMap((manifest) =>
    coldBackgroundAgentJobsForManifest(manifest, liveIds, options)
  )
  return [...live, ...cold]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 50)
}
