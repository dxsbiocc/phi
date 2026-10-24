import type { PhiEngine, PhiHostRequestContext } from '../engine/types'

interface ActiveWorkModeRun {
  phiSessionId: string
  runId: string
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
    if (!run || run.cancelled) throw new Error('Automatic work mode run is no longer active')
    const manifest = deps.findPhiSessionById(run.phiSessionId)
    if (manifest?.workMode !== 'auto' || manifest.projectLocation?.kind === 'ssh') {
      throw new Error('Automatic work mode is not active')
    }
    const stored = deps.appendSessionEvent(run.phiSessionId, {
      type: 'work_mode_selected',
      runId: run.runId,
      ...input
    })
    deps.broadcastSessionTimelineEvent(run.phiSessionId, stored)
    deps.notifySessionChanged()
    return { ok: true }
  })
}
