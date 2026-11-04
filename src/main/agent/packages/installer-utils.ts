import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, win32 } from 'node:path'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'
import { isLegacyPackageRegistry } from '../../../shared/packageSourceIds'
import type {
  InstalledTeamResourceSource,
  LocalRegistry,
  PackageSourceMetadata,
  RegistryTrustTier,
  TeamResourceOrigin
} from './installer-types'
import type { PackageType } from './manifest'

// Historical import surface for the packages module; the definitions now live in src/shared.
export { errorMessage, isRecord }
export { isLegacyPackageRegistry as isLegacyBuiltinRegistry }

type ReadablePackageSourceMetadata = Omit<PackageSourceMetadata, 'trust'> & {
  trust?: RegistryTrustTier
}

export function assertSafePackagePath(path: string): void {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    normalized.startsWith('//') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`不安全的软件包路径: ${path}`)
  }
}

export function localArchivePath(registry: LocalRegistry, archive: string): string {
  if (/^https:\/\//i.test(archive)) throw new Error('当前仅支持本地目录注册表，不支持远程归档')
  assertSafePackagePath(archive)
  const path = resolve(registry.dir, ...archive.split('/'))
  const relativePath = relative(registry.dir, path)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`注册表归档路径不安全: ${archive}`)
  }
  return path
}

export function packageKey(value: { type: PackageType; id: string }): string {
  return `${value.type}:${value.id}`
}

export function packageVersionKey(value: {
  type: PackageType
  id: string
  version: string
}): string {
  return `${packageKey(value)}@${value.version}`
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function isSourceMetadata(value: unknown): value is ReadablePackageSourceMetadata {
  return isBaseSourceMetadata(value) && validTeamSourceMetadata(value.teamSource)
}

function isBaseSourceMetadata(value: unknown): value is ReadablePackageSourceMetadata {
  return (
    isRecord(value) &&
    typeof value.registry === 'string' &&
    typeof value.id === 'string' &&
    isPackageType(value.type) &&
    typeof value.version === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.installedAt === 'string' &&
    (value.installedBy === 'user' || value.installedBy === 'dependency') &&
    (value.trust === undefined ||
      value.trust === 'builtin' ||
      value.trust === 'official' ||
      value.trust === 'imported')
  )
}

function isPackageType(value: unknown): value is PackageType {
  return value === 'skill' || value === 'plugin' || value === 'wrapper' || value === 'mcp'
}

function validTeamSourceMetadata(value: unknown): boolean {
  return value === undefined || isInstalledTeamResourceSource(value)
}

function isInstalledTeamResourceSource(value: unknown): value is InstalledTeamResourceSource {
  return (
    isRecord(value) &&
    isTeamResourceOrigin(value) &&
    typeof value.release === 'number' &&
    Number.isSafeInteger(value.release) &&
    value.release >= 1 &&
    (value.sharing === 'team-only' || value.sharing === 'forwardable') &&
    (value.originalSource === undefined || isTeamResourceOrigin(value.originalSource))
  )
}

function isTeamResourceOrigin(value: unknown): value is TeamResourceOrigin {
  return (
    isRecord(value) &&
    typeof value.teamId === 'string' &&
    /^[a-z][a-z0-9-]{1,63}$/.test(value.teamId) &&
    typeof value.teamName === 'string' &&
    value.teamName.trim() === value.teamName &&
    value.teamName.length >= 1 &&
    value.teamName.length <= 100 &&
    ![...value.teamName].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) &&
    typeof value.teamKeyId === 'string' &&
    /^[a-f0-9]{16}$/.test(value.teamKeyId)
  )
}

export function normalizeSourceMetadata(value: unknown): PackageSourceMetadata | undefined {
  if (!isSourceMetadata(value)) return undefined
  return {
    ...value,
    trust: value.trust ?? legacySourceTrust(value.registry)
  }
}

export function legacySourceTrust(registry: string): RegistryTrustTier {
  return isLegacyPackageRegistry(registry) ? 'builtin' : 'imported'
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
