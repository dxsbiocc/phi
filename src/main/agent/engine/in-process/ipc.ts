import { randomUUID } from 'node:crypto'
import { RemoteWorkspaceReadResult } from '../../remote-workspace-read'
import {
  readRemoteSkillResource,
  type RemoteReadableSkill
} from '../../content/remote-skill-resource'
import { HostRequestContext, HostResponse, UnknownRecord, toJsonSafe } from './common'
import { pendingHostRequests } from './state'

export function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(toJsonSafe(value))}\n`)
}

export function sendEvent(event: string, payload: unknown, extra: UnknownRecord = {}): void {
  send({
    type: 'event',
    event,
    payload,
    ...extra
  })
}

export function isHostResponse(value: unknown): value is HostResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'hostResponse' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

export function requestHost(
  method: string,
  params: unknown,
  context?: HostRequestContext
): Promise<unknown> {
  const id = randomUUID()
  send({
    type: 'hostRequest',
    id,
    method,
    params,
    ...(context ? { context } : {})
  })
  return new Promise<unknown>((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject })
  })
}

export function readLoadedSkillResource(
  path: string,
  skills: readonly RemoteReadableSkill[],
  remoteProject?: { sessionId: string; projectId: string }
): RemoteWorkspaceReadResult | Promise<RemoteWorkspaceReadResult> {
  return readRemoteSkillResource(path, skills, {
    ...(remoteProject
      ? {
          readRemote: async (uri: string) =>
            (await requestHost('remoteSkills.readResource', {
              sessionId: remoteProject.sessionId,
              projectId: remoteProject.projectId,
              path: uri
            })) as RemoteWorkspaceReadResult
        }
      : {})
  })
}

export function handleHostResponse(response: HostResponse): void {
  const pending = pendingHostRequests.get(response.id)
  if (!pending) return
  pendingHostRequests.delete(response.id)
  if (response.ok) {
    pending.resolve(response.result)
  } else {
    const error = new Error(response.error)
    if (response.stack) error.stack = response.stack
    pending.reject(error)
  }
}
