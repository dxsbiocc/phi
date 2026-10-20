import {
  findPhiSessionByRuntimePath,
  listPhiSessions,
  readSessionEvents,
  type PhiSessionManifest
} from './session-store'

export function readPhiTimelineMessages(
  runtimeSessionPath: string | null | undefined,
  cwd: string,
  phiSessionId?: string
): unknown[] {
  const manifestsById = new Map<string, PhiSessionManifest>()
  if (runtimeSessionPath) {
    for (const manifest of listPhiSessions()) {
      if (manifest.cwd === cwd && manifest.runtimeSessionPath === runtimeSessionPath) {
        manifestsById.set(manifest.sessionId, manifest)
      }
    }
  }
  if (phiSessionId) {
    const manifest = listPhiSessions().find((session) => session.sessionId === phiSessionId)
    if (manifest) {
      manifestsById.set(manifest.sessionId, manifest)
    }
  } else if (runtimeSessionPath && manifestsById.size === 0) {
    const manifest = findPhiSessionByRuntimePath(runtimeSessionPath, cwd)
    if (manifest) {
      manifestsById.set(manifest.sessionId, manifest)
    }
  }
  const manifests = [...manifestsById.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )
  if (manifests.length === 0) return []
  const events = manifests
    .flatMap((manifest) => readSessionEvents(manifest.sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const hasPhiText = events.some(
    (event) => event.type === 'user_message' || event.type === 'assistant_message_finalized'
  )
  return events.map((event) => ({
    ...event,
    ...(hasPhiText ? { preferPhiTimeline: true } : {}),
    source: 'phi'
  }))
}
