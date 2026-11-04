import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { isTeamPackError, teamPackError } from './errors'
import { writeAtomic } from './files'
import { assertRelease, assertTeamId } from './validation'

export const ADMIN_STATE_FILE = 'admin-state.json'

const MAX_STATE_BYTES = 1024 * 1024
const STATE_KEYS = ['keyId', 'latestRelease', 'storeDir', 'teamId', 'version', 'withdrawnReleases']

export interface AdminTeamState {
  version: 1
  teamId: string
  keyId: string
  storeDir: string | null
  latestRelease: number | null
  withdrawnReleases: number[]
}

export function readAdminState(directory: string): AdminTeamState {
  const path = join(directory, ADMIN_STATE_FILE)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_STATE_BYTES) {
      throw teamPackError('INVALID_FORMAT', '团队管理员状态文件无效')
    }
    return parseAdminState(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法读取团队管理员状态', error)
  }
}

export function writeAdminState(directory: string, state: AdminTeamState): void {
  const parsed = parseAdminState(state)
  try {
    writeAtomic(
      join(directory, ADMIN_STATE_FILE),
      Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`),
      0o600
    )
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法写入团队管理员状态', error)
  }
}

function parseAdminState(value: unknown): AdminTeamState {
  if (!isRecord(value)) throw teamPackError('INVALID_FORMAT', '团队管理员状态格式无效')
  assertExactStateKeys(value)
  if (value.version !== 1) throw teamPackError('INVALID_FORMAT', '团队管理员状态版本无效')
  assertTeamId(value.teamId)
  const keyId = parseKeyId(value.keyId)
  const storeDir = parseStoreDir(value.storeDir)
  const latestRelease = parseLatestRelease(value.latestRelease)
  const withdrawnReleases = parseWithdrawnReleases(value.withdrawnReleases, latestRelease)
  return { version: 1, teamId: value.teamId, keyId, storeDir, latestRelease, withdrawnReleases }
}

function assertExactStateKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort()
  if (keys.length !== STATE_KEYS.length || keys.some((key, index) => key !== STATE_KEYS[index])) {
    throw teamPackError('INVALID_FORMAT', '团队管理员状态包含未知字段')
  }
}

function parseKeyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) {
    throw teamPackError('INVALID_FORMAT', '团队管理员状态公钥指纹无效')
  }
  return value
}

function parseStoreDir(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw teamPackError('INVALID_FORMAT', '团队管理员发布目录无效')
  }
  return value
}

function parseLatestRelease(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw teamPackError('INVALID_FORMAT', '团队管理员最新版本无效')
  }
  return value as number
}

function parseWithdrawnReleases(value: unknown, latestRelease: number | null): number[] {
  if (!Array.isArray(value)) {
    throw teamPackError('INVALID_FORMAT', '团队管理员撤回版本无效')
  }
  const releases = value.map((release) => {
    assertRelease(release)
    if (latestRelease === null || release > latestRelease) {
      throw teamPackError('INVALID_FORMAT', '团队管理员撤回版本晚于最新版本')
    }
    return release
  })
  if (
    new Set(releases).size !== releases.length ||
    releases.some((release, index) => index > 0 && release <= releases[index - 1]!)
  ) {
    throw teamPackError('INVALID_FORMAT', '团队管理员撤回版本必须有序且不重复')
  }
  return releases
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
