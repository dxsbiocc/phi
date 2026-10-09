import type {
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootHardError,
  RemoteRuntimeRootHardErrorCode,
  RemoteRuntimeRootWarning
} from '../../../shared/remoteRuntimeRootTypes'
import {
  RUNTIME_ROOT_CHECK_END_SENTINEL,
  RUNTIME_ROOT_CHECK_START_SENTINEL
} from './runtime-root-check-script'

export const DEFAULT_REMOTE_RUNTIME_ROOT_LOW_SPACE_KIB = 15 * 1024 * 1024
export const DEFAULT_REMOTE_RUNTIME_ROOT_HIGH_DISK_USE_PERCENT = 90

export interface RemoteRuntimeRootParseOptions {
  lowSpaceKiB?: number
  highDiskUsePercent?: number
  now?: () => Date
}

type ParsedRows = ReadonlyMap<string, string>

const COMPLETE_CHECK_KEYS = [
  'path.expanded',
  'path.exists',
  'path.ancestor',
  'path.ancestor_writable',
  'path.owned',
  'path.group_or_other_writable',
  'path.symlink',
  'path.executable',
  'fs.type',
  'fs.available_kib',
  'fs.disk_use_percent',
  'fs.inode_use_percent',
  'fs.shared'
] as const

function emptyResult(
  configured: string,
  status: RemoteRuntimeRootCheckResult['status'],
  now: () => Date
): RemoteRuntimeRootCheckResult {
  return {
    configured,
    checkedAt: now().toISOString(),
    status,
    expandedPath: null,
    exists: null,
    nearestExistingAncestor: null,
    ancestorWritable: null,
    ownedByCurrentUser: null,
    groupOrOtherWritable: null,
    hasSymlink: null,
    fsType: null,
    availableKiB: null,
    diskUsePercent: null,
    inodeUsePercent: null,
    executable: null,
    sharedFilesystem: null,
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: []
  }
}

function sentinelRows(output: string): ParsedRows | undefined {
  const start = output.lastIndexOf(RUNTIME_ROOT_CHECK_START_SENTINEL)
  const end = start < 0 ? -1 : output.indexOf(RUNTIME_ROOT_CHECK_END_SENTINEL, start)
  if (start < 0 || end < 0) return undefined
  const body = output.slice(start + RUNTIME_ROOT_CHECK_START_SENTINEL.length, end)
  const entries = body.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const separator = line.indexOf('=')
    return separator <= 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]]
  })
  return new Map(entries)
}

function boolValue(value: string | undefined): boolean | null {
  return value === '1' ? true : value === '0' ? false : null
}

function numberValue(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function hardErrors(rows: ParsedRows): readonly RemoteRuntimeRootHardError[] {
  const code = rows.get('hard.error') as RemoteRuntimeRootHardErrorCode | undefined
  const messages: Readonly<Record<RemoteRuntimeRootHardErrorCode, string>> = {
    'invalid-configured-root': '运行时根目录写法无效，请使用绝对路径或以 ~/ 开头的路径。',
    'unable-to-expand': '无法在远端展开并规范化运行时根目录。',
    'ancestor-not-writable': '最近的已存在祖先目录不可写，无法在此创建运行时目录。'
  }
  return code && messages[code] ? [{ code, message: messages[code] }] : []
}

function hasCompleteCheckRows(rows: ParsedRows): boolean {
  return COMPLETE_CHECK_KEYS.every((key) => rows.has(key))
}

function warning(
  code: RemoteRuntimeRootWarning['code'],
  message: string,
  consequence: string
): RemoteRuntimeRootWarning {
  return { code, message, consequence }
}

function collectWarnings(
  result: RemoteRuntimeRootCheckResult,
  options: RemoteRuntimeRootParseOptions
): readonly RemoteRuntimeRootWarning[] {
  const warnings: RemoteRuntimeRootWarning[] = []
  if (result.ownedByCurrentUser === false)
    warnings.push(
      warning('not-owned', '该位置不归当前登录用户所有。', '权限可能被所有者更改，导致环境失效。')
    )
  if (result.groupOrOtherWritable)
    warnings.push(
      warning(
        'group-or-other-writable',
        '该位置允许组内或其他用户写入。',
        '其他用户可能修改受管环境内容。'
      )
    )
  if (result.hasSymlink)
    warnings.push(
      warning('symlink', '路径中包含符号链接。', '链接目标变化后，运行时可能指向不同位置。')
    )
  const lowSpace = options.lowSpaceKiB ?? DEFAULT_REMOTE_RUNTIME_ROOT_LOW_SPACE_KIB
  if (result.availableKiB !== null && result.availableKiB < lowSpace)
    warnings.push(
      warning('low-space', '该文件系统剩余空间偏少。', '环境下载或构建可能因空间耗尽而失败。')
    )
  const highUse = options.highDiskUsePercent ?? DEFAULT_REMOTE_RUNTIME_ROOT_HIGH_DISK_USE_PERCENT
  if (result.diskUsePercent !== null && result.diskUsePercent >= highUse)
    warnings.push(
      warning('high-disk-use', '该文件系统磁盘使用率较高。', '后续环境更新可能更容易遇到空间不足。')
    )
  if (result.executable === false)
    warnings.push(
      warning('noexec', '该位置无法执行临时探针脚本。', '受管环境中的可执行文件将无法直接运行。')
    )
  if (result.sharedFilesystem)
    warnings.push(
      warning(
        'shared-filesystem-info',
        '该位置位于共享文件系统。',
        '计算节点可见性仍需后续探针作业确认。'
      )
    )
  return warnings
}

function checkedResult(
  configured: string,
  rows: ParsedRows,
  options: RemoteRuntimeRootParseOptions
): RemoteRuntimeRootCheckResult {
  const now = options.now ?? (() => new Date())
  const result: RemoteRuntimeRootCheckResult = {
    ...emptyResult(configured, 'checked', now),
    expandedPath: rows.get('path.expanded') ?? null,
    exists: boolValue(rows.get('path.exists')),
    nearestExistingAncestor: rows.get('path.ancestor') ?? null,
    ancestorWritable: boolValue(rows.get('path.ancestor_writable')),
    ownedByCurrentUser: boolValue(rows.get('path.owned')),
    groupOrOtherWritable: boolValue(rows.get('path.group_or_other_writable')),
    hasSymlink: boolValue(rows.get('path.symlink')),
    fsType: rows.get('fs.type') === 'unknown' ? null : (rows.get('fs.type') ?? null),
    availableKiB: numberValue(rows.get('fs.available_kib')),
    diskUsePercent: numberValue(rows.get('fs.disk_use_percent')),
    inodeUsePercent: numberValue(rows.get('fs.inode_use_percent')),
    executable: boolValue(rows.get('path.executable')),
    sharedFilesystem: boolValue(rows.get('fs.shared')),
    hardErrors: hardErrors(rows)
  }
  return { ...result, warnings: collectWarnings(result, options) }
}

export function parseRemoteRuntimeRootCheck(
  output: string,
  configured: string,
  options: RemoteRuntimeRootParseOptions = {}
): RemoteRuntimeRootCheckResult {
  const now = options.now ?? (() => new Date())
  const rows = sentinelRows(output)
  if (!rows || rows.get('probe.complete') !== '1') return emptyResult(configured, 'incomplete', now)
  if (!hasCompleteCheckRows(rows) && hardErrors(rows).length === 0)
    return emptyResult(configured, 'incomplete', now)
  return checkedResult(configured, rows, options)
}

export function remoteRuntimeRootCheckFailure(
  configured: string,
  status: 'timed-out' | 'failed',
  now: () => Date = () => new Date()
): RemoteRuntimeRootCheckResult {
  return emptyResult(configured, status, now)
}
