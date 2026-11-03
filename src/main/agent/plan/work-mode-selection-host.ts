import type { PhiEngine, PhiHostRequestContext } from '../engine/types'
import { getSessionDir } from '../session/session-store'
import {
  writePendingRemoteAutoPlan,
  type PendingRemoteAutoPlan
} from '../session/pending-remote-auto-plan'

interface ActiveWorkModeRun {
  phiSessionId: string
  runId: string
  sessionGeneration?: number
  cancelled: boolean
}

interface WorkModeManifest {
  workMode?: string
  projectLocation?: { kind: string }
}

export interface WorkModeSelectionHostDeps<StoredEvent> {
  host: PhiEngine['host']
  findActivePromptRunByRuntimeSessionId(runtimeSessionId: string): ActiveWorkModeRun | null
  findPhiSessionById(sessionId: string): WorkModeManifest | null | undefined
  appendSessionEvent(
    sessionId: string,
    event: { type: 'work_mode_selected'; runId: string; execute: boolean; reason: string }
  ): StoredEvent
  broadcastSessionTimelineEvent(sessionId: string, event: StoredEvent): void
  notifySessionChanged(): void
  persistPendingRemoteAutoPlan?(marker: PendingRemoteAutoPlan): void
}

function selectionInput(params: unknown): { execute: boolean; reason: string } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Invalid automatic work mode selection')
  }
  const { execute, reason } = params as Record<string, unknown>
  const normalizedReason = typeof reason === 'string' ? reason.trim() : ''
  if (
    typeof execute !== 'boolean' ||
    !normalizedReason ||
    Array.from(normalizedReason).length > 200
  ) {
    throw new Error('Invalid automatic work mode selection')
  }
  return { execute, reason: normalizedReason }
}

function runtimeSessionId(context: PhiHostRequestContext): string {
  if (!context.originSessionId) throw new Error('Automatic work mode has no session')
  return context.originSessionId
}

export function registerWorkModeSelectionHost<StoredEvent>(
  deps: WorkModeSelectionHostDeps<StoredEvent>
): () => void {
  return deps.host.register('workMode.selected', (params, context) => {
    const input = selectionInput(params)
    const run = deps.findActivePromptRunByRuntimeSessionId(runtimeSessionId(context))
    if (!run || run.cancelled || context.signal?.aborted)
      throw new Error('Automatic work mode run is no longer active')
    const manifest = deps.findPhiSessionById(run.phiSessionId)
    // A kernel session keeps its plan in the kernel on either host; only the RPC route needs
    // the pending marker and the remote proofs.
    const remote = manifest?.projectLocation?.kind === 'ssh' && context.kernelOrigin !== true
    if (
      manifest?.workMode !== 'auto' ||
      (remote &&
        (context.remoteOriginAuthenticated !== true ||
          context.agentRunId !== run.runId ||
          typeof context.toolCallId !== 'string' ||
          !context.toolCallId ||
          !Number.isSafeInteger(run.sessionGeneration)))
    ) {
      throw new Error('Automatic work mode is not active')
    }
    if (remote) {
      const marker: PendingRemoteAutoPlan = {
        version: 1,
        phiSessionId: run.phiSessionId,
        runId: run.runId,
        sessionGeneration: run.sessionGeneration!,
        mode: input.execute ? 'plan_execute' : 'plan'
      }
      if (deps.persistPendingRemoteAutoPlan) deps.persistPendingRemoteAutoPlan(marker)
      else writePendingRemoteAutoPlan(getSessionDir(run.phiSessionId), marker)
    }
    const stored = deps.appendSessionEvent(run.phiSessionId, {
      type: 'work_mode_selected',
      runId: run.runId,
      ...input
    })
    deps.broadcastSessionTimelineEvent(run.phiSessionId, stored)
    deps.notifySessionChanged()
    return { ok: true, mode: input.execute ? 'plan_execute' : 'plan', reason: input.reason }
  })
}
