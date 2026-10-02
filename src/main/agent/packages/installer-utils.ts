import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, win32 } from 'node:path'

import type { LocalRegistry, PackageSourceMetadata } from './installer-types'
import type { PackageType } from './manifest'

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

export function isSourceMetadata(value: unknown): value is PackageSourceMetadata {
  return (
    isRecord(value) &&
    typeof value.registry === 'string' &&
    typeof value.id === 'string' &&
    (value.type === 'skill' ||
      value.type === 'plugin' ||
      value.type === 'wrapper' ||
      value.type === 'mcp') &&
    typeof value.version === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.installedAt === 'string' &&
    (value.installedBy === 'user' || value.installedBy === 'dependency')
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
