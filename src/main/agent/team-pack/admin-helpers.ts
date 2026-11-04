import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { listInstalledPackages } from '../packages/installed'
import type {
  InstalledPackage,
  TeamResourceMetadata,
  TeamResourceOrigin,
  TeamResourceSharing
} from '../packages/installer-types'
import { packageKey } from '../packages/installer-utils'
import type { PackageType } from '../packages/manifest'
import type { AdminTeamListItem, CreatedAdminTeam, TeamPackageSelection } from './admin-service'
import { isTeamPackError, teamPackError } from './errors'
import { writeAtomic } from './files'
import { readTeamRoster, TEAM_ROSTER_FILE_NAME } from './roster'
import { listTeamSources } from './team-source-storage'

const SNAPSHOTS_DIRECTORY = 'registry-snapshots'
const SUPPORTED_PACKAGE_TYPES = new Set<PackageType>(['skill', 'plugin', 'wrapper', 'mcp'])

export interface ResolvedTeamPackageSelection {
  installed: InstalledPackage
  resource: TeamResourceMetadata
}

export function resolveSelections(
  agentDir: string,
  teamId: string,
  selections: readonly TeamPackageSelection[]
): ResolvedTeamPackageSelection[] {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw teamPackError('INVALID_FORMAT', '团队发布至少需要选择一个已安装资源')
  }
  const identities = new Set<string>()
  for (const selection of selections) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw teamPackError('INVALID_FORMAT', '团队发布资源选择格式无效')
    }
    if (!SUPPORTED_PACKAGE_TYPES.has(selection.type)) {
      throw teamPackError('INVALID_FORMAT', `不支持的团队发布资源类型: ${String(selection.type)}`)
    }
    if (typeof selection.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(selection.id)) {
      throw teamPackError('INVALID_FORMAT', '团队发布资源标识格式无效')
    }
    if (
      selection.sharing !== undefined &&
      selection.sharing !== 'team-only' &&
      selection.sharing !== 'forwardable'
    ) {
      throw teamPackError('INVALID_FORMAT', '团队发布资源转发标记无效')
    }
    const identity = `${selection.type}:${selection.id}`
    if (identities.has(identity)) {
      throw teamPackError('INVALID_FORMAT', `团队发布资源选择重复: ${identity}`)
    }
    identities.add(identity)
  }

  const installed = listInstalledPackages({ agentDir })
  const teamSources = listTeamSources(agentDir)
  return selections.map((selection) => {
    const found = installed.find((item) => item.type === selection.type && item.id === selection.id)
    if (!found) {
      throw teamPackError(
        'INVALID_FORMAT',
        `找不到当前已安装的团队发布资源: ${selection.type}:${selection.id}`
      )
    }
    const source = installedTeamSource(found, teamSources)
    if (source && source.teamId !== teamId && source.sharing === 'team-only') {
      throw teamPackError(
        'INVALID_FORMAT',
        `资源 ${selection.type}:${selection.id} 仅限来源团队使用，不能转发`
      )
    }
    const originalSource = originalResourceSource(source, teamId)
    return {
      installed: found,
      resource: {
        sharing: selection.sharing ?? 'team-only',
        ...(originalSource ? { originalSource } : {})
      }
    }
  })
}

function installedTeamSource(
  installed: InstalledPackage,
  sources: ReturnType<typeof listTeamSources>
):
  | (TeamResourceOrigin & { sharing: TeamResourceSharing; originalSource?: TeamResourceOrigin })
  | null {
  if (installed.teamSource) return installed.teamSource
  const source = sources.find((candidate) => candidate.id === installed.registry)
  if (!source) return null
  const status = source.status as typeof source.status & {
    resources?: Record<string, TeamResourceMetadata>
  }
  const metadata = status.resources?.[packageKey(installed)]
  return {
    teamId: source.teamId,
    teamName: source.teamName,
    teamKeyId: source.teamKeyId,
    sharing: metadata?.sharing ?? 'team-only',
    ...(metadata?.originalSource ? { originalSource: metadata.originalSource } : {})
  }
}

function originalResourceSource(
  source: ReturnType<typeof installedTeamSource>,
  currentTeamId: string
): TeamResourceOrigin | undefined {
  if (!source) return undefined
  if (source.originalSource) return source.originalSource
  if (source.teamId === currentTeamId) return undefined
  return {
    teamId: source.teamId,
    teamName: source.teamName,
    teamKeyId: source.teamKeyId
  }
}

export function initializeRoster(directory: string): void {
  writeAtomic(
    join(directory, TEAM_ROSTER_FILE_NAME),
    Buffer.from(`${JSON.stringify({ version: 1, members: [], releases: [] }, null, 2)}\n`),
    0o600
  )
  readTeamRoster(directory)
}

export function createdTeamResult(publicMaterial: {
  teamId: string
  name: string
  keyId: string
}): CreatedAdminTeam {
  return {
    ...teamListItem(publicMaterial),
    backupRequired: true,
    warning: '必须备份团队签名密钥；密钥丢失后只能重新创建团队。'
  }
}

export function teamListItem(publicMaterial: {
  teamId: string
  name: string
  keyId: string
}): AdminTeamListItem {
  return {
    teamId: publicMaterial.teamId,
    name: publicMaterial.name,
    publicKeyFingerprint: publicMaterial.keyId
  }
}

export function secureDirectory(path: string): void {
  try {
    chmodSync(path, 0o700)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法保护团队管理员目录', error)
  }
}

export function assertPlainDirectory(path: string, label: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw teamPackError('INVALID_FORMAT', `${label}必须是非符号链接目录`)
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', `无法读取${label}`, error)
  }
}

export function pendingSnapshotDirectory(teamDirectory: string): string {
  const root = join(teamDirectory, SNAPSHOTS_DIRECTORY)
  mkdirSync(root, { recursive: true })
  return join(root, `.pending-${process.pid}-${randomUUID()}`)
}

export function snapshotDirectory(teamDirectory: string, release: number): string {
  return join(teamDirectory, SNAPSHOTS_DIRECTORY, String(release))
}

export function absoluteStoreDirectory(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw teamPackError('INVALID_FORMAT', '团队发布目录必须是绝对路径')
  }
  return resolve(value)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
