import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import type { McpConnectorSetupProgress } from '../../../shared/mcpConnectorCatalog'

const PHASES = new Set([
  'downloading',
  'installing',
  'environment',
  'starting',
  'ready',
  'installed',
  'removed',
  'failed'
])
const ACTIVE = new Set(['downloading', 'installing', 'environment', 'starting'])
const MAX_BYTES = 2 * 1024 * 1024
const MAX_RECORDS = 256

export function loadConnectorSetups(path: string, now: () => string): McpConnectorSetupProgress[] {
  if (!existsSync(path)) return []
  try {
    const bytes = boundedStateBytes(path)
    const document: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      !isRecord(document) ||
      document.version !== 1 ||
      !Array.isArray(document.records) ||
      document.records.length > MAX_RECORDS
    )
      throw new Error('invalid setup state')
    const ids = new Set<string>()
    return document.records.map((value: unknown): McpConnectorSetupProgress => {
      const progress = parseProgress(value)
      if (!progress || ids.has(progress.id)) throw new Error('invalid setup record')
      ids.add(progress.id)
      if (!isActivePhase(progress.phase)) return progress
      return {
        ...progress,
        failedPhase: progress.phase,
        phase: 'failed',
        revision: progress.revision + 1,
        updatedAt: now(),
        error: '上次设置已中断，请重试。'
      }
    })
  } catch {
    renameSync(path, `${path}.corrupt-${randomUUID()}`)
    return []
  }
}

function boundedStateBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('setup state exceeds limit')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('setup state changed during read')
      offset += count
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error('setup state grew during read')
    return bytes
  } finally {
    closeSync(fd)
  }
}

function isActivePhase(
  phase: McpConnectorSetupProgress['phase']
): phase is 'downloading' | 'installing' | 'environment' | 'starting' {
  return ACTIVE.has(phase)
}

export function saveConnectorSetups(
  path: string,
  records: readonly McpConnectorSetupProgress[]
): void {
  // Tool discovery is refreshed after restart; persist lifecycle state rather than cached schemas.
  const selected = [...records]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_RECORDS)
    .map((record) => {
      const saved = { ...record }
      delete saved.toolNames
      if (saved.error) saved.error = saved.error.slice(0, 1024)
      if (saved.detail) saved.detail = saved.detail.slice(0, 4096)
      return saved
    })
  const bytes = JSON.stringify({ version: 1, records: selected })
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('连接器状态超过保存限制')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, bytes, { mode: 0o600 })
  renameSync(temporary, path)
}

function parseProgress(value: unknown): McpConnectorSetupProgress | undefined {
  if (!isRecord(value)) return undefined
  const valid =
    typeof value.id === 'string' &&
    /^[a-z][a-z0-9-]{1,63}$/.test(value.id) &&
    typeof value.phase === 'string' &&
    PHASES.has(value.phase) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.failedPhase === undefined ||
      (typeof value.failedPhase === 'string' &&
        PHASES.has(value.failedPhase) &&
        value.failedPhase !== 'failed')) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && value.error.length <= 1024)) &&
    (value.detail === undefined ||
      (typeof value.detail === 'string' && value.detail.length <= 4096)) &&
    (value.operationId === undefined ||
      (typeof value.operationId === 'string' && /^[0-9a-f-]{36}$/.test(value.operationId)))
  if (!valid) return undefined
  const progress: McpConnectorSetupProgress = {
    id: value.id as string,
    phase: value.phase as McpConnectorSetupProgress['phase'],
    revision: value.revision as number,
    updatedAt: value.updatedAt as string,
    ...(value.failedPhase === undefined
      ? {}
      : {
          failedPhase: value.failedPhase as Exclude<McpConnectorSetupProgress['phase'], 'failed'>
        }),
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    ...(value.operationId === undefined ? {} : { operationId: value.operationId as string })
  }
  if (value.kind === 'local-stdio') progress.kind = value.kind
  if (typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 128)
    progress.title = value.title
  if (typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)))
    progress.startedAt = value.startedAt
  if (typeof value.summary === 'string' && value.summary.length <= 4096)
    progress.summary = value.summary
  return progress
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
