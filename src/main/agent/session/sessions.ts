import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import {
  createRuntimeSessionManager,
  listRuntimeSessions,
  openRuntimeSessionManager,
  type RuntimeSessionManager,
  type SessionInfo
} from '../runtime/runtime-adapter'
import { getPhiWorkspaceDir } from '../runtime-paths'
import {
  deletePhiSession,
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  listPhiSessions,
  readSessionEvents,
  updateSessionManifest,
  type LastRunOutcome,
  type PhiSessionManifest,
  type SessionStatus,
  type UnreadKind
} from './session-store'
import { messageContentTitleText } from '../../../shared/sessionTitle'

// Fixed cwd for ad-hoc conversations (not tied to a project) — independent of how
// Electron happens to be launched (double-clicked vs `electron-vite dev` from some
// arbitrary shell cwd) so they always land in one stable place instead of being
// scattered across per-launch-cwd folders. Projects use their own working directory
// as cwd instead (see projects.ts).
export const WORKSPACE_DIR = getPhiWorkspaceDir()
const PHI_ONLY_SESSION_PREFIX = 'phi-session:'

function ensureDirExists(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function phiOnlySessionPath(sessionId: string): string {
  return `${PHI_ONLY_SESSION_PREFIX}${sessionId}`
}

export function phiSessionIdFromPath(path: string): string | null {
  if (!path.startsWith(PHI_ONLY_SESSION_PREFIX)) return null
  const sessionId = path.slice(PHI_ONLY_SESSION_PREFIX.length)
  return sessionId.length > 0 ? sessionId : null
}

export function isPhiOnlySessionPath(path: string | undefined | null): boolean {
  return typeof path === 'string' && phiSessionIdFromPath(path) !== null
}

export interface SessionSummary {
  path: string
  id: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  phiSessionId?: string
  status: SessionStatus
  unreadKind: UnreadKind | null
  lastRunOutcome?: LastRunOutcome
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

function toSummary(info: SessionInfo): SessionSummary {
  return {
    path: info.path,
    id: info.id,
    name: info.name,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
    status: 'idle',
    unreadKind: null
  }
}

function summaryPathForManifest(manifest: PhiSessionManifest): string {
  return phiOnlySessionPath(manifest.sessionId)
}

function titleFromManifest(manifest: PhiSessionManifest): string | undefined {
  const title = messageContentTitleText(manifest.title)
  return title || undefined
}

function firstUserMessageFromManifest(manifest: PhiSessionManifest): string {
  const title = titleFromManifest(manifest)
  if (title) return title
  return firstUserMessageContentFromManifest(manifest)
}

function firstUserMessageContentFromManifest(manifest: PhiSessionManifest): string {
  const userEvent = readSessionEvents(manifest.sessionId).find(
    (event) => event.type === 'user_message' && typeof event.content === 'string'
  )
  return typeof userEvent?.content === 'string' ? messageContentTitleText(userEvent.content) : ''
}

function phiOnlySummary(manifest: PhiSessionManifest): SessionSummary {
  const firstMessage = firstUserMessageFromManifest(manifest)
  return {
    path: summaryPathForManifest(manifest),
    id: manifest.sessionId,
    name: titleFromManifest(manifest),
    created: manifest.createdAt,
    modified: manifest.lastActivityAt,
    messageCount: manifest.messageCount,
    firstMessage,
    phiSessionId: manifest.sessionId,
    status: manifest.status,
    unreadKind: manifest.unreadKind,
    lastRunOutcome: manifest.lastRunOutcome,
    currentRunId: manifest.currentRunId,
    currentRunStartedAt: manifest.currentRunStartedAt,
    lastActivityAt: manifest.lastActivityAt
  }
}

function isEmptyUnnamedSession(info: SessionInfo, manifest?: PhiSessionManifest): boolean {
  if (info.messageCount > 0) return false
  if (info.name?.trim()) return false
  if (manifest?.title?.trim()) return false
  if (manifest && (manifest.status !== 'idle' || manifest.unreadKind !== null)) return false
  if (manifest?.currentRunId) return false
  return true
}

function runtimeManifestGroups(
  manifests: PhiSessionManifest[],
  cwd: string
): Map<string, PhiSessionManifest[]> {
  const groups = new Map<string, PhiSessionManifest[]>()
  for (const manifest of manifests) {
    if (manifest.cwd !== cwd || !manifest.runtimeSessionPath) continue
    const group = groups.get(manifest.runtimeSessionPath) ?? []
    group.push(manifest)
    groups.set(manifest.runtimeSessionPath, group)
  }
  return groups
}

function statusPriority(manifest: PhiSessionManifest): number {
  if (manifest.status === 'needs_approval' || manifest.unreadKind === 'approval') return 5
  if (manifest.status === 'needs_input' || manifest.unreadKind === 'input') return 5
  if (manifest.status === 'running') return 4
  if (manifest.status === 'failed' || manifest.unreadKind === 'failed') return 3
  if (manifest.status === 'completed_unread' || manifest.unreadKind === 'completed') return 2
  return 1
}

function selectRuntimeManifest(manifests: PhiSessionManifest[]): PhiSessionManifest | undefined {
  return [...manifests].sort((left, right) => {
    const priority = statusPriority(right) - statusPriority(left)
    if (priority !== 0) return priority
    return right.lastActivityAt.localeCompare(left.lastActivityAt)
  })[0]
}

function earliestCreatedAt(manifests: PhiSessionManifest[]): string | undefined {
  return manifests
    .map((manifest) => manifest.createdAt)
    .sort((left, right) => left.localeCompare(right))[0]
}

function latestActivityAt(manifests: PhiSessionManifest[]): string | undefined {
  return manifests
    .map((manifest) => manifest.lastActivityAt)
    .sort((left, right) => right.localeCompare(left))[0]
}

export function mergePhiSessionState(
  infos: SessionInfo[],
  manifests: PhiSessionManifest[],
  cwd: string
): SessionSummary[] {
  const linkedManifests = manifests
  const manifestsByRuntimePath = runtimeManifestGroups(linkedManifests, cwd)

  const runtimeSummaries = infos.flatMap((info) => {
    const summary = toSummary(info)
    const runtimeManifests = manifestsByRuntimePath.get(info.path) ?? []
    const manifest = selectRuntimeManifest(runtimeManifests)
    if (isEmptyUnnamedSession(info, manifest)) return []
    if (!manifest) return [summary]

    const latestActivity = latestActivityAt(runtimeManifests) ?? manifest.lastActivityAt
    const created = earliestCreatedAt(runtimeManifests) ?? manifest.createdAt
    const firstMessage = firstUserMessageFromManifest(manifest) || summary.firstMessage
    return [
      {
        ...summary,
        path: summaryPathForManifest(manifest),
        id: manifest.sessionId,
        name: titleFromManifest(manifest) ?? summary.name,
        firstMessage,
        phiSessionId: manifest.sessionId,
        created,
        status: manifest.status,
        unreadKind: manifest.unreadKind,
        lastRunOutcome: manifest.lastRunOutcome,
        currentRunId: manifest.currentRunId,
        currentRunStartedAt: manifest.currentRunStartedAt,
        lastActivityAt: latestActivity,
        modified: latestActivity > summary.modified ? latestActivity : summary.modified
      }
    ]
  })

  const runtimeManifestIds = new Set(
    [...manifestsByRuntimePath.values()].flat().map((manifest) => manifest.sessionId)
  )
  const phiOnlySummaries = linkedManifests
    .filter(
      (manifest) =>
        manifest.cwd === cwd &&
        !manifest.runtimeSessionPath &&
        !runtimeManifestIds.has(manifest.sessionId)
    )
    .map(phiOnlySummary)

  return [...runtimeSummaries, ...phiOnlySummaries].sort((a, b) =>
    b.created.localeCompare(a.created)
  )
}

export async function listSessions(cwd: string = WORKSPACE_DIR): Promise<SessionSummary[]> {
  ensureDirExists(cwd)
  const infos = await listRuntimeSessions(cwd)
  return mergePhiSessionState(infos, listPhiSessions(), cwd)
}

export function acknowledgeSession(path: string, cwd: string): SessionSummary | null {
  const phiSessionId = phiSessionIdFromPath(path)
  const manifest = phiSessionId
    ? findPhiSessionById(phiSessionId)
    : findPhiSessionByRuntimePath(path, cwd)
  if (!manifest) return null
  if (manifest.status === 'needs_approval' || manifest.status === 'needs_input') return null
  if (manifest.unreadKind !== 'completed' && manifest.unreadKind !== 'failed') return null

  const nextStatus =
    manifest.unreadKind === 'failed' ? 'failed' : manifest.currentRunId ? manifest.status : 'idle'
  const updated = updateSessionManifest(manifest.sessionId, {
    status: nextStatus,
    unreadKind: null
  })

  return {
    path: phiSessionId ? phiOnlySessionPath(phiSessionId) : path,
    id: phiSessionId ?? path,
    created: updated.createdAt,
    modified: updated.lastActivityAt,
    messageCount: updated.messageCount,
    firstMessage: firstUserMessageFromManifest(updated),
    phiSessionId: updated.sessionId,
    status: updated.status,
    unreadKind: updated.unreadKind,
    lastRunOutcome: updated.lastRunOutcome,
    currentRunId: updated.currentRunId,
    currentRunStartedAt: updated.currentRunStartedAt,
    lastActivityAt: updated.lastActivityAt
  }
}

export function createSessionManager(cwd: string, path?: string): RuntimeSessionManager {
  ensureDirExists(cwd)
  return path
    ? {
        kind: 'open',
        cwd,
        path,
        getCwd: () => cwd,
        getSessionFile: () => path,
        appendSessionInfo: (name: string) => {
          void renameSession(path, name)
        },
        setSessionName: async (name: string) => {
          await renameSession(path, name)
          return true
        }
      }
    : createRuntimeSessionManager(cwd)
}

export function deleteSession(path: string): void {
  const phiSessionId = phiSessionIdFromPath(path)
  if (phiSessionId) {
    const manifest = findPhiSessionById(phiSessionId)
    if (manifest?.runtimeSessionPath && existsSync(manifest.runtimeSessionPath)) {
      unlinkSync(manifest.runtimeSessionPath)
    }
    deletePhiSession(phiSessionId)
    return
  }
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

export async function renameSession(path: string, name: string): Promise<void> {
  const phiSessionId = phiSessionIdFromPath(path)
  if (phiSessionId) {
    updateSessionManifest(phiSessionId, { title: name })
    return
  }
  const manager = await openRuntimeSessionManager(path)
  await manager.setSessionName(name, 'user')
}
