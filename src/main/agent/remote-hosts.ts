import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SSH_CONFIG_HOST_ID_PREFIX, sshConfigHostId } from '../../shared/remoteHostProfile'

import { getPhiAgentDir } from './runtime-paths'
import { discoverOpenSshAliases } from './ssh-config-discovery'
import {
  validateHostAlias,
  validateRemoteConnectionOverrides,
  type RemoteConnectionConfig
} from './wrappers/remote-ssh-session'

const HOSTS_FILE = 'ssh-hosts.json'

/** Phi-owned reference to a host already configured in the user's OpenSSH setup. */
export interface RemoteHostProfile {
  id: string
  label: string
  hostAlias: string
  user?: string
  port?: number
  identityFile?: string
  source?: 'ssh-config'
}

export function sshConfigHostProfileId(alias: string): string {
  return sshConfigHostId(validateHostAlias(alias))
}

function configAliasFromProfileId(id: string): string | undefined {
  if (!id.startsWith(SSH_CONFIG_HOST_ID_PREFIX)) return undefined
  try {
    return validateHostAlias(id.slice(SSH_CONFIG_HOST_ID_PREFIX.length))
  } catch {
    return undefined
  }
}

function filePath(agentDir: string): string {
  return join(agentDir, HOSTS_FILE)
}

export function listRemoteHostProfiles(agentDir = getPhiAgentDir()): RemoteHostProfile[] {
  if (!existsSync(filePath(agentDir))) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath(agentDir), 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item): RemoteHostProfile[] => {
      if (typeof item !== 'object' || item === null) return []
      const entry = item as Record<string, unknown>
      if (
        typeof entry.id !== 'string' ||
        typeof entry.label !== 'string' ||
        typeof entry.hostAlias !== 'string' ||
        (entry.user !== undefined && typeof entry.user !== 'string') ||
        (entry.port !== undefined && typeof entry.port !== 'number') ||
        (entry.identityFile !== undefined && typeof entry.identityFile !== 'string')
      )
        return []
      try {
        const hostAlias = validateHostAlias(entry.hostAlias)
        const overrides = validateRemoteConnectionOverrides({
          user: entry.user,
          port: entry.port,
          identityFile: entry.identityFile
        } as Pick<RemoteConnectionConfig, 'user' | 'port' | 'identityFile'>)
        return [{ id: entry.id, label: entry.label, hostAlias, ...overrides }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** Existing OpenSSH aliases are immediately selectable, with no Phi registration step. */
export function listAvailableRemoteHostProfiles(
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfile[] {
  const saved = listRemoteHostProfiles(agentDir)
  const savedByAlias = new Map(saved.map((profile) => [profile.hostAlias, profile]))
  const aliases = discoverOpenSshAliases(sshConfigPath)
  const discovered = aliases.map((alias): RemoteHostProfile => {
    const stored = savedByAlias.get(alias)
    if (stored) {
      return stored.id === sshConfigHostProfileId(alias)
        ? { ...stored, source: 'ssh-config' }
        : stored
    }
    return {
      id: sshConfigHostProfileId(alias),
      label: alias,
      hostAlias: alias,
      source: 'ssh-config'
    }
  })
  const aliasesSet = new Set(aliases)
  return [
    ...discovered,
    ...saved.filter(
      (profile) => !aliasesSet.has(profile.hostAlias) && !configAliasFromProfileId(profile.id)
    )
  ]
}

export function getRemoteHostProfile(
  id: string,
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfile | undefined {
  const saved = listRemoteHostProfiles(agentDir).find((host) => host.id === id)
  const alias = configAliasFromProfileId(id)
  if (!alias) return saved
  if (!discoverOpenSshAliases(sshConfigPath).includes(alias)) return undefined
  return saved
    ? { ...saved, source: 'ssh-config' }
    : { id, label: alias, hostAlias: alias, source: 'ssh-config' }
}

export function saveRemoteHostProfile(
  input: {
    id?: string
    label: string
    hostAlias: string
    user?: string
    port?: number
    identityFile?: string
  },
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfile {
  const label = input.label.trim()
  if (!label) throw new Error('请填写服务器名称')
  const hostAlias = validateHostAlias(input.hostAlias.trim())
  const overrides = validateRemoteConnectionOverrides(input)
  const hosts = listRemoteHostProfiles(agentDir)
  const configuredAlias = input.id ? configAliasFromProfileId(input.id) : undefined
  if (
    !input.id &&
    (sshConfigPath !== undefined || agentDir === getPhiAgentDir()) &&
    discoverOpenSshAliases(sshConfigPath).includes(hostAlias)
  ) {
    throw new Error('该主机已在 SSH 配置中，可直接使用；如需覆盖参数，请编辑列表中的主机')
  }
  if (
    configuredAlias &&
    (configuredAlias !== hostAlias ||
      !discoverOpenSshAliases(sshConfigPath).includes(configuredAlias))
  ) {
    throw new Error('SSH 配置主机已变化；请重新读取服务器列表')
  }
  if (hosts.some((host) => host.hostAlias === hostAlias && host.id !== input.id)) {
    throw new Error(`SSH 主机别名已存在: ${hostAlias}`)
  }
  if (input.id && !configuredAlias && !hosts.some((host) => host.id === input.id)) {
    throw new Error('服务器档案不存在')
  }
  const profile = { id: input.id ?? randomUUID(), label, hostAlias, ...overrides }
  const next = hosts.filter((host) => host.id !== profile.id)
  next.push(profile)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(filePath(agentDir), `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  return configuredAlias ? { ...profile, source: 'ssh-config' } : profile
}

export function remoteConnectionConfigForProfile(
  profile: RemoteHostProfile
): RemoteConnectionConfig {
  return {
    host: profile.hostAlias,
    ...validateRemoteConnectionOverrides(profile)
  }
}

export function deleteRemoteHostProfile(id: string, agentDir = getPhiAgentDir()): void {
  const hosts = listRemoteHostProfiles(agentDir)
  if (!hosts.some((host) => host.id === id)) return
  writeFileSync(
    filePath(agentDir),
    `${JSON.stringify(
      hosts.filter((host) => host.id !== id),
      null,
      2
    )}\n`,
    'utf-8'
  )
}
