import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

import type { ChatQueueTarget } from '../../shared/chatQueueTypes'
import { fieldsFromMode, modeFromFields } from '../../shared/sessionMode'
import type { Project } from '../agent/projects'
import { isLegacyRemoteSession } from '../agent/session/legacy-remote-session'
import type { PromptRunDestination } from '../agent/session/prompt-target-control'
import type { PhiSessionManifest } from '../agent/session/session-store'
import { phiOnlySessionPath, phiSessionIdFromPath } from '../agent/session/sessions'
import type { BoundChatQueueTarget } from './durable-chat'

export interface ChatQueueTargetOptions {
  findSession(sessionId: string): PhiSessionManifest | null
  getProject(projectId: string): Project | null | undefined
  remoteBinding(sessionId: string, projectId: string): string | undefined
  sessionKey(session: PhiSessionManifest): string
  generation(key: string): number
  draftId(): string | undefined
  resolve(target: ChatQueueTarget): PromptRunDestination | Promise<PromptRunDestination>
  materialize(destination: PromptRunDestination, title: string): string
}

function localWorkingDirectory(cwd: string): string | undefined {
  try {
    return realpathSync(cwd)
  } catch {
    return undefined
  }
}

function hostBinding(
  manifest: PhiSessionManifest,
  options: ChatQueueTargetOptions
): string | undefined {
  const project = manifest.projectId ? options.getProject(manifest.projectId) : undefined
  if (manifest.projectId && !project) return undefined
  const location = project?.location
  if (manifest.projectLocation && location?.kind !== manifest.projectLocation.kind) return undefined
  const locationKey =
    location?.kind === 'ssh'
      ? options.remoteBinding(manifest.sessionId, project!.id)
      : localWorkingDirectory(manifest.cwd)
  if (!locationKey) return undefined
  return createHash('sha256')
    .update(
      JSON.stringify([
        manifest.cwd,
        manifest.cwdRealPath,
        manifest.projectId,
        locationKey,
        location?.kind === 'local' ? [location.path, location.realPath] : null
      ])
    )
    .digest('hex')
}

export interface ChatQueueTargets {
  find(sessionId: string): BoundChatQueueTarget | null
  bind(target: ChatQueueTarget, title: string): Promise<BoundChatQueueTarget>
}

export function createChatQueueTargets(options: ChatQueueTargetOptions): ChatQueueTargets {
  const materializedDrafts = new Map<string, { sessionId: string; cwd: string }>()

  function find(sessionId: string): BoundChatQueueTarget | null {
    const manifest = options.findSession(sessionId)
    if (!manifest || isLegacyRemoteSession(manifest)) return null
    const binding = hostBinding(manifest, options)
    if (!binding) return null
    const sessionKey = options.sessionKey(manifest)
    return {
      sessionKey,
      snapshot: { path: undefined, cwd: manifest.cwd, permissionMode: manifest.permissionMode },
      scope: { conversationId: sessionId, projectId: manifest.projectId },
      path: phiOnlySessionPath(sessionId),
      binding,
      sessionGeneration: options.generation(sessionKey),
      workMode: manifest.workMode ?? fieldsFromMode(modeFromFields(manifest)).workMode
    }
  }

  function requireTarget(sessionId: string): BoundChatQueueTarget {
    const target = find(sessionId)
    if (!target) throw new Error('会话已删除或工作目录与初始项目不匹配')
    return target
  }

  // Resolve and materialize an unsaved draft synchronously before publishing its receipt.
  function bindDraft(target: ChatQueueTarget, title: string): BoundChatQueueTarget {
    const draftId = target.draftId
    if (!draftId) throw new Error('当前草稿已切换，请重新发送')
    const previous = materializedDrafts.get(draftId)
    if (previous?.cwd === target.cwd) return requireTarget(previous.sessionId)
    if (draftId !== options.draftId()) throw new Error('当前草稿已切换，请重新发送')
    const resolved = options.resolve(target)
    if (resolved instanceof Promise) throw new Error('Could not resolve the current draft.')
    const sessionId = options.materialize(resolved, title)
    if (materializedDrafts.size >= 64) {
      const oldest = materializedDrafts.keys().next().value
      if (oldest) materializedDrafts.delete(oldest)
    }
    materializedDrafts.set(draftId, { sessionId, cwd: target.cwd })
    return requireTarget(sessionId)
  }

  return {
    find,
    async bind(target, title) {
      const pathId = target.path ? phiSessionIdFromPath(target.path) : null
      if (pathId && target.phiSessionId && pathId !== target.phiSessionId) {
        throw new Error('会话目标不一致，请重新发送')
      }
      const sessionId = target.phiSessionId ?? pathId
      if (sessionId) return requireTarget(sessionId)
      if (target.path === null) return bindDraft(target, title)
      const resolved = await options.resolve(target)
      return requireTarget(options.materialize(resolved, title))
    }
  }
}
