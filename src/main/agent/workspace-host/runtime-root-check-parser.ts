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
  'path.write_capacity',
  'fs.type',
  'fs.available_kib',
  'fs.disk_use_percent',
  'fs.inode_use_percent',
  'fs.shared',
  'cache.entry_count'
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
    writeCapacity: null,
    sharedFilesystem: null,
    packageCache: { entryCount: null, bytes: null },
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
    'invalid-configured-root':
      'Invalid runtime root path. Use an absolute path or one starting with ~/.',
    'unable-to-expand': 'Unable to expand and normalize the runtime root on the server.',
    'ancestor-not-writable':
      'The nearest existing ancestor directory is not writable. The runtime directory cannot be created here.',
    'write-capacity-exhausted':
      'Disk space or the file count quota is exhausted at this server location. In Settings → Remote Hosts, move the runtime directory to a location with space, such as the workspace filesystem, or remove old environments.'
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
      warning(
        'not-owned',
        'This location is not owned by the current user.',
        'The owner could change permissions and make the environment unusable.'
      )
    )
  if (result.groupOrOtherWritable)
    warnings.push(
      warning(
        'group-or-other-writable',
        'This location is writable by the group or other users.',
        'Other users could modify the managed environment.'
      )
    )
  if (result.hasSymlink)
    warnings.push(
      warning(
        'symlink',
        'The path contains a symlink.',
        'A changed symlink target could redirect the runtime to another location.'
      )
    )
  const lowSpace = options.lowSpaceKiB ?? DEFAULT_REMOTE_RUNTIME_ROOT_LOW_SPACE_KIB
  if (result.availableKiB !== null && result.availableKiB < lowSpace)
    warnings.push(
      warning(
        'low-space',
        'This filesystem has little free space.',
        'Environment downloads or builds could fail if space runs out.'
      )
    )
  const highUse = options.highDiskUsePercent ?? DEFAULT_REMOTE_RUNTIME_ROOT_HIGH_DISK_USE_PERCENT
  if (result.diskUsePercent !== null && result.diskUsePercent >= highUse)
    warnings.push(
      warning(
        'high-disk-use',
        'Disk usage is high on this filesystem.',
        'Future environment updates may run out of space.'
      )
    )
  if (result.executable === false)
    warnings.push(
      warning(
        'noexec',
        'A temporary probe script cannot execute at this location.',
        'Executables in managed environments cannot run directly.'
      )
    )
  if (result.sharedFilesystem)
    warnings.push(
      warning(
        'shared-filesystem-info',
        'This location is on a shared filesystem.',
        'A later probe job must confirm visibility from compute nodes.'
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
    writeCapacity: writeCapacityValue(rows.get('path.write_capacity')),
    sharedFilesystem: boolValue(rows.get('fs.shared')),
    packageCache: {
      entryCount: numberValue(rows.get('cache.entry_count')),
      bytes: numberValue(rows.get('cache.bytes'))
    },
    hardErrors: hardErrors(rows)
  }
  return { ...result, warnings: collectWarnings(result, options) }
}

function writeCapacityValue(
  value: string | undefined
): RemoteRuntimeRootCheckResult['writeCapacity'] {
  return value === 'ok' ||
    value === 'quota-exceeded' ||
    value === 'no-space' ||
    value === 'read-only' ||
    value === 'other'
    ? value
    : null
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
