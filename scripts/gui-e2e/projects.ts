import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RemoteProject } from './types'

interface StoredProject {
  id?: unknown
  name?: unknown
  workingDirectory?: unknown
  location?: { kind?: unknown; hostProfileId?: unknown }
}

interface StoredHost {
  id?: unknown
  label?: unknown
  hostAlias?: unknown
}

function readArray(path: string): unknown[] {
  if (!existsSync(path)) return []
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function hostAliases(phiDir: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const value of readArray(join(phiDir, 'ssh-hosts.json'))) {
    const host = value as StoredHost
    if (typeof host.id !== 'string') continue
    if (typeof host.hostAlias === 'string') result.set(host.id, host.hostAlias)
    else if (typeof host.label === 'string') result.set(host.id, host.label)
  }
  return result
}

function aliasFromProfile(id: string, aliases: Map<string, string>): string {
  if (aliases.has(id)) return aliases.get(id)!
  return id.startsWith('ssh-config:') ? id.slice('ssh-config:'.length) : id
}

export function readRemoteProjects(home: string): RemoteProject[] {
  const phiDir = join(home, '.phi')
  const aliases = hostAliases(phiDir)
  return readArray(join(phiDir, 'projects.json')).flatMap((value): RemoteProject[] => {
    const project = value as StoredProject
    const hostProfileId = project.location?.hostProfileId
    if (
      project.location?.kind !== 'ssh' ||
      typeof hostProfileId !== 'string' ||
      typeof project.id !== 'string' ||
      typeof project.name !== 'string' ||
      typeof project.workingDirectory !== 'string'
    ) {
      return []
    }
    return [
      {
        id: project.id,
        name: project.name,
        workingDirectory: project.workingDirectory,
        hostAlias: aliasFromProfile(hostProfileId, aliases),
        hostProfileId
      }
    ]
  })
}

export function matchServerProjects(
  projects: RemoteProject[],
  serverNames: string[]
): RemoteProject[] {
  return serverNames.flatMap((name) => {
    const normalized = name.toLocaleLowerCase()
    const match = projects.find(
      (project) =>
        project.name.toLocaleLowerCase() === normalized ||
        project.hostAlias.toLocaleLowerCase() === normalized
    )
    return match ? [match] : []
  })
}
