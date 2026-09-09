import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import {
  createRuntimeSessionManager,
  listRuntimeSessions,
  openRuntimeSessionManager,
  type RuntimeSessionManager,
  type SessionInfo
} from './runtime-adapter'
import { getPhiWorkspaceDir } from './runtime-paths'
import {
  findPhiSessionByRuntimePath,
  listPhiSessions,
  updateSessionManifest,
  type LastRunOutcome,
  type PhiSessionManifest,
  type SessionStatus,
  type UnreadKind
} from './session-store'

// Fixed cwd for ad-hoc conversations (not tied to a project) — independent of how
// Electron happens to be launched (double-clicked vs `electron-vite dev` from some
// arbitrary shell cwd) so they always land in one stable place instead of being
// scattered across per-launch-cwd folders. Projects use their own working directory
// as cwd instead (see projects.ts).
export const WORKSPACE_DIR = getPhiWorkspaceDir()

function ensureDirExists(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
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

function isEmptyUnnamedSession(info: SessionInfo, manifest?: PhiSessionManifest): boolean {
  if (info.messageCount > 0) return false
  if (info.name?.trim()) return false
  if (manifest?.title?.trim()) return false
  if (manifest && (manifest.status !== 'idle' || manifest.unreadKind !== null)) return false
  if (manifest?.currentRunId) return false
  return true
}

export function mergePhiSessionState(
  infos: SessionInfo[],
  manifests: PhiSessionManifest[],
  cwd: string
): SessionSummary[] {
  const manifestsByRuntimePath = new Map(
    manifests
      .filter((manifest) => manifest.cwd === cwd && manifest.runtimeSessionPath)
      .map((manifest) => [manifest.runtimeSessionPath as string, manifest])
  )

  return infos
    .flatMap((info) => {
      const summary = toSummary(info)
      const manifest = manifestsByRuntimePath.get(info.path)
      if (isEmptyUnnamedSession(info, manifest)) return []
      if (!manifest) return [summary]

      return [
        {
          ...summary,
          phiSessionId: manifest.sessionId,
          created: manifest.createdAt,
          status: manifest.status,
          unreadKind: manifest.unreadKind,
          lastRunOutcome: manifest.lastRunOutcome,
          currentRunId: manifest.currentRunId,
          currentRunStartedAt: manifest.currentRunStartedAt,
          lastActivityAt: manifest.lastActivityAt,
          modified:
            manifest.lastActivityAt > summary.modified ? manifest.lastActivityAt : summary.modified
        }
      ]
    })
    .sort((a, b) => b.created.localeCompare(a.created))
}

export async function listSessions(cwd: string = WORKSPACE_DIR): Promise<SessionSummary[]> {
  ensureDirExists(cwd)
  const infos = await listRuntimeSessions(cwd)
  return mergePhiSessionState(infos, listPhiSessions(), cwd)
}

export function acknowledgeSession(path: string, cwd: string): SessionSummary | null {
  const manifest = findPhiSessionByRuntimePath(path, cwd)
  if (!manifest) return null
  if (manifest.status === 'needs_approval') return null
  if (manifest.unreadKind !== 'completed' && manifest.unreadKind !== 'failed') return null

  const nextStatus =
    manifest.unreadKind === 'failed' ? 'failed' : manifest.currentRunId ? manifest.status : 'idle'
  const updated = updateSessionManifest(manifest.sessionId, {
    status: nextStatus,
    unreadKind: null
  })

  return {
    path,
    id: path,
    created: updated.createdAt,
    modified: updated.lastActivityAt,
    messageCount: updated.messageCount,
    firstMessage: updated.title ?? '',
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
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

export async function renameSession(path: string, name: string): Promise<void> {
  const manager = await openRuntimeSessionManager(path)
  await manager.setSessionName(name, 'user')
}
